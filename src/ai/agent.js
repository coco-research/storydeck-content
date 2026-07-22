// AI assistant runner.
// Sends a compact board context + the user message to a model gateway and asks
// for a STRICT JSON action plan, then executes the plan through boardTools()
// against the local DB. The gateway supports multiple providers (OpenAI,
// Anthropic/Claude, Cursor) — see providers.js.
//
// Tests inject a fake gateway via setModelRunner() and never touch the network.

import { listStories, recallFacts } from '../db.js';
import { boardTools, toSummaryLine } from './tools.js';
import { AIError } from './errors.js';
import { runViaProvider } from './providers.js';

// Tools that mutate the board (go through the DB).
const MUTATION_ACTIONS = new Set(['add_story', 'update_story', 'complete_story', 'add_comment']);
// Tools that "run" server-side (query/store) so their results reach the user.
// remember/recall touch the memory table, not the board.
const READ_ACTIONS = new Set(['search_stories', 'get_board_summary', 'remember', 'recall']);
const VALID_FOCUS_STATUS = new Set(['all', 'todo', 'in-progress', 'blocked', 'done']);

// A client-side action: the server validates it and echoes it back for the
// frontend to apply (it filters what the user SEES — no DB change).
function normalizeFocus(args = {}) {
  const out = {};
  if (args.epic != null && String(args.epic).trim()) out.epic = String(args.epic).trim();
  const st = String(args.status || '').trim().toLowerCase();
  if (VALID_FOCUS_STATUS.has(st)) out.status = st;
  if (args.query != null && String(args.query).trim()) out.query = String(args.query).trim();
  return out;
}

export { AIError };

const SYSTEM_PROMPT = `You are the assistant for a retro terminal Kanban story board. You are AGENTIC:
you both ANSWER questions and TAKE actions on the board.

Output STRICT JSON only — no prose, no markdown fences:
{"reply": "<concise, concrete answer>", "actions": [ { "tool": "<name>", "args": { ... } } ]}

Tools (you may NOT delete or reorder):
- add_story       {task*, epic, points, urgent(bool), status(todo|in-progress|blocked|done), note}
- update_story    {id*, task, epic, points, urgent, status}
- complete_story  {id*}
- add_comment     {id*, text*}
- search_stories  {query*}                 → find stories by text (title/epic/note/comments)
- get_board_summary {}                      → counts per column, open points, and the urgent queue
- remember        {text*, kind, entity}     → store a durable fact/preference for future sessions
    kind = fact | preference | entity | pin
- recall          {query}                   → look up facts you previously remembered
- focus_board     {epic, status, query}     → filter what the user SEES on the board (no data change)
    epic  = an epic name, or "Urgent", or "All"
    status= all | todo | in-progress | blocked | done
    query = free-text search

Behaviour — BE AGENTIC, do not just talk:
- KNOWN FACTS below are durable memory. Use them to personalize answers. When the user
  states a lasting fact/preference ("X is my director", "always tag finance items CR07",
  "remember that…"), call remember so it persists. Use recall when the user asks what you know.
- ALWAYS put a real answer in "reply". When you reference stories, ENUMERATE them as
  "#<id> <short title>" (newline-separated). NEVER say "here are the stories" without listing them.
- "show / see / list / filter <X>"  → emit focus_board so the board visibly narrows, AND list the matches in "reply".
- "the urgent ones"                  → focus_board {"epic":"Urgent"} AND list them in "reply".
- counts / overview / "how many"     → get_board_summary, then answer with the numbers.
- find something by text              → search_stories.
- create / move / rename / complete / comment → the matching mutation tool(s).
- Resolve which story the user means from the CURRENT BOARD (by id or title). Never invent ids not on the board.
- Use RECENT CONVERSATION to resolve back-references: "take me there" / "that one" / "the second" / "those"
  refer to whatever you just showed or listed. e.g. after listing the urgent ones, "take me there" → focus_board {"epic":"Urgent"}.`;

// Compact snapshot of the board injected into every prompt.
function buildContext(db) {
  const all = listStories(db);
  const open = all.filter((s) => s.status !== 'done');
  const counts = {
    todo: open.filter((s) => !s.workStatus).length,
    wip: open.filter((s) => s.workStatus === 'in-progress').length,
    blocked: open.filter((s) => s.workStatus === 'blocked').length,
    done: all.length - open.length,
  };
  const lines = all.slice(0, 120).map(toSummaryLine).join('\n');
  return `CURRENT BOARD — ${all.length} stories `
    + `(todo ${counts.todo}, wip ${counts.wip}, blocked ${counts.blocked}, done ${counts.done}):\n${lines}`;
}

// Long-term memory: durable facts most relevant to this turn, injected as a
// compact block. recallFacts also reinforces the rows it returns (weight bump).
function buildKnownFacts(db, message) {
  let facts = [];
  try { facts = recallFacts(db, { query: message || '', limit: 12 }); } catch { facts = []; }
  if (!facts.length) return '';
  const lines = facts.map((f) => `- ${f.text}${f.entity ? ` (${f.entity})` : ''}`).join('\n');
  return `KNOWN FACTS (durable memory — use when relevant):\n${lines}\n\n`;
}

// Short-term memory: the last few turns so the model can resolve back-references.
function buildTranscript(history) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const turns = history.slice(-8).map((h) => {
    const role = h && h.role === 'assistant' ? 'ASSISTANT' : 'USER';
    const text = String((h && h.text) || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    return `${role}: ${text}`;
  });
  return `RECENT CONVERSATION (oldest → newest):\n${turns.join('\n')}\n\n`;
}

// Pull the first balanced JSON object out of model text.
export function extractJSON(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    } }
  }
  return null;
}

// ── model gateway (multi-provider), with a test injection hook ────────────────
let _runner = null; // (prompt, { model }) => Promise<string>  — returns raw model text
export function setModelRunner(fn) { _runner = fn; }

// Default runner delegates to the provider gateway (OpenAI / Anthropic / Cursor).
async function defaultRunner(prompt, { model }) {
  return runViaProvider(prompt, { model });
}

/**
 * Run one assistant turn. Returns { reply, actions } where actions are the
 * executed results (each with ok/id/summary). Mutations go through boardTools.
 */
export async function runAssistant({ db, message, model, history } = {}) {
  const msg = String(message || '').trim();
  if (!msg) throw new AIError('Message is required', { status: 400 });
  if (msg.length > 4000) throw new AIError('Message too long', { status: 400 });

  const now = new Date();
  const dateLine = `TODAY: ${now.toISOString().slice(0, 10)} (${now.toLocaleDateString('en-US', { weekday: 'long' })}). Resolve relative dates ("today", "Friday", "next week") against this and set due dates as YYYY-MM-DD.`;
  const prompt = `${SYSTEM_PROMPT}\n\n${dateLine}\n\n${buildContext(db)}\n\n${buildKnownFacts(db, msg)}${buildTranscript(history)}USER: ${msg}\n\nJSON:`;
  const runner = _runner || defaultRunner;
  const raw = await runner(prompt, { model });

  const plan = extractJSON(raw) || {};
  const reply = typeof plan.reply === 'string' && plan.reply.trim()
    ? plan.reply.trim()
    : (typeof raw === 'string' ? raw.trim().slice(0, 200) : '');

  const tools = boardTools(db);
  const actions = [];
  const requested = Array.isArray(plan.actions) ? plan.actions : [];
  for (const a of requested) {
    const tool = a && a.tool;
    // focus_board is applied by the client (it only changes the view).
    if (tool === 'focus_board') {
      actions.push({ ok: true, tool, focus: normalizeFocus(a.args || {}) });
      continue;
    }
    if ((MUTATION_ACTIONS.has(tool) || READ_ACTIONS.has(tool)) && typeof tools[tool] === 'function') {
      try {
        const out = tools[tool](a.args || {});
        actions.push({ ok: true, tool, ...out });
      } catch (err) {
        actions.push({ ok: false, tool, error: err.message });
      }
      continue;
    }
    actions.push({ ok: false, tool, error: 'unsupported action' });
  }

  return { reply: reply || 'done.', actions };
}

export { SYSTEM_PROMPT, buildContext, buildTranscript, buildKnownFacts };
