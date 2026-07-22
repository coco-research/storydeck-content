// Board tools exposed to the AI assistant.
// Pure handlers over a db instance — no SDK, no network, fully unit-testable.
// Permissions: add / edit / complete / comment / read. NO delete, NO reorder.

import {
  listStories,
  getStory,
  createStory,
  updateStory,
  addComment,
  rememberFact,
  recallFacts,
} from '../db.js';

const VALID_MEMORY_KINDS = new Set(['fact', 'preference', 'entity', 'pin']);

const VALID_STATES = new Set(['todo', 'in-progress', 'blocked', 'done']);

// Map the assistant's friendly "state" onto the db's status/workStatus pair.
function statePatch(state) {
  switch (state) {
    case 'done': return { status: 'done' };
    case 'in-progress': return { status: 'pending', workStatus: 'in-progress' };
    case 'blocked': return { status: 'pending', workStatus: 'blocked' };
    case 'todo': return { status: 'pending', workStatus: null };
    default: return {};
  }
}

function toSummaryLine(s) {
  const state = s.status === 'done' ? 'done' : (s.workStatus || 'todo');
  const tag = { todo: 'TODO', 'in-progress': 'WIP', blocked: 'BLKD', done: 'DONE' }[state];
  return `#${s.id} [${tag}] ${s.urgent && s.status !== 'done' ? '!! ' : ''}${s.task}`
    + (s.project ? ` · ${s.project}` : '') + ` · ${s.points}pts`
    + (s.due && s.status !== 'done' ? ` · due ${s.due}` : '');
}

/**
 * Build the tool set bound to a specific db.
 * Each handler takes a plain args object and returns a JSON-serializable result.
 */
export function boardTools(db) {
  return {
    add_story(args = {}) {
      const task = String(args.task || '').trim();
      if (!task) throw new Error('task is required');
      const state = VALID_STATES.has(args.status) ? args.status : 'todo';
      const story = createStory(db, {
        task,
        project: args.epic != null ? String(args.epic) : '',
        points: args.points,
        urgent: !!args.urgent,
        note: args.note != null ? String(args.note) : undefined,
        due: args.due != null ? String(args.due) : undefined,
        ...statePatch(state),
      });
      return { ok: true, id: story.id, story, summary: toSummaryLine(story) };
    },

    update_story(args = {}) {
      const id = Number.parseInt(args.id, 10);
      if (!Number.isFinite(id)) throw new Error('id is required');
      const patch = {};
      if (args.task != null) patch.task = String(args.task);
      if (args.epic != null) patch.project = String(args.epic);
      if (args.points != null) patch.points = args.points;
      if (args.urgent != null) patch.urgent = !!args.urgent;
      if (args.due != null) patch.due = String(args.due); // '' clears it
      if (args.status != null) {
        if (!VALID_STATES.has(args.status)) throw new Error(`invalid status: ${args.status}`);
        Object.assign(patch, statePatch(args.status));
      }
      const story = updateStory(db, id, patch);
      if (!story) throw new Error(`story #${id} not found`);
      return { ok: true, id, story, summary: toSummaryLine(story) };
    },

    complete_story(args = {}) {
      const id = Number.parseInt(args.id, 10);
      if (!Number.isFinite(id)) throw new Error('id is required');
      const story = updateStory(db, id, { status: 'done' });
      if (!story) throw new Error(`story #${id} not found`);
      return { ok: true, id, story, summary: toSummaryLine(story) };
    },

    add_comment(args = {}) {
      const id = Number.parseInt(args.id, 10);
      if (!Number.isFinite(id)) throw new Error('id is required');
      const story = addComment(db, id, args.text);
      if (!story) throw new Error(`story #${id} not found`);
      return { ok: true, id, comments: story.comments.length };
    },

    search_stories(args = {}) {
      const q = String(args.query || '').trim().toLowerCase();
      const all = listStories(db);
      const rows = q
        ? all.filter((s) => {
            const hay = [
              s.task || '',
              s.project || '',
              s.note || '',
              ...(s.comments || []).map((c) => c.text || ''),
            ].join(' ').toLowerCase();
            return hay.includes(q);
          })
        : all;
      return { count: rows.length, results: rows.slice(0, 20).map(toSummaryLine) };
    },

    get_board_summary() {
      const all = listStories(db);
      const by = (st) => all.filter((s) => (s.status === 'done' ? 'done' : (s.workStatus || 'todo')) === st);
      const urgent = all.filter((s) => s.urgent && s.status !== 'done').map(toSummaryLine);
      // Open, dated stories soonest-first so the model can answer deadline questions.
      const deadlines = all
        .filter((s) => s.due && s.status !== 'done')
        .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
        .map(toSummaryLine);
      return {
        total: all.length,
        todo: by('todo').length,
        in_progress: by('in-progress').length,
        blocked: by('blocked').length,
        done: by('done').length,
        open_points: all.filter((s) => s.status !== 'done').reduce((n, s) => n + (s.points || 0), 0),
        urgent,
        deadlines,
      };
    },

    remember(args = {}) {
      const text = String(args.text || '').trim();
      if (!text) throw new Error('text is required');
      const kind = VALID_MEMORY_KINDS.has(args.kind) ? args.kind : 'fact';
      const row = rememberFact(db, { text, kind, entity: args.entity });
      return { ok: true, id: row.id, kind: row.kind, remembered: row.text };
    },

    recall(args = {}) {
      const results = recallFacts(db, { query: args.query || '', limit: 15 });
      return { count: results.length, facts: results.map((r) => r.text) };
    },
  };
}

// JSON-schema-ish descriptors for the model. Kept next to the handlers so they stay in sync.
export const TOOL_SPECS = [
  {
    name: 'add_story',
    description: 'Create a new story on the board.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The story title / what needs doing' },
        epic: { type: 'string', description: 'Epic/project name, e.g. CR07, GitHub, Personal' },
        points: { type: 'integer', description: 'Sprint points (default 1)' },
        urgent: { type: 'boolean', description: 'Mark as urgent' },
        status: { type: 'string', enum: ['todo', 'in-progress', 'blocked', 'done'] },
        note: { type: 'string' },
        due: { type: 'string', description: 'Due date as YYYY-MM-DD (optional)' },
      },
      required: ['task'],
    },
  },
  {
    name: 'update_story',
    description: 'Edit an existing story by id (title, epic, points, urgent, status, due date).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        task: { type: 'string' },
        epic: { type: 'string' },
        points: { type: 'integer' },
        urgent: { type: 'boolean' },
        status: { type: 'string', enum: ['todo', 'in-progress', 'blocked', 'done'] },
        due: { type: 'string', description: 'Due date as YYYY-MM-DD; empty string clears it' },
      },
      required: ['id'],
    },
  },
  {
    name: 'complete_story',
    description: 'Mark a story as done by id.',
    parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'add_comment',
    description: 'Append a comment to a story by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' }, text: { type: 'string' } },
      required: ['id', 'text'],
    },
  },
  {
    name: 'search_stories',
    description: 'Search stories by text across title, epic, note, and comments.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'get_board_summary',
    description: 'Get counts by column, open points, the urgent queue, and open deadlines (soonest first).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'remember',
    description: 'Store a durable fact/preference about the user or their work for future turns.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact to remember, e.g. "Kevin is my director"' },
        kind: { type: 'string', enum: ['fact', 'preference', 'entity', 'pin'] },
        entity: { type: 'string', description: 'Optional subject, e.g. a person, vendor, or epic' },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description: 'Retrieve durable facts previously remembered, optionally filtered by a query.',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
];

export { toSummaryLine, statePatch };
