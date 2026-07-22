// Local-only HTTP server for the Stories board.
// Binds to 127.0.0.1 exclusively — refuses all non-loopback connections.
// Serves the frontend + a small JSON REST API backed by node:sqlite.
//
// Data locality: the board DB is on-device only. The SINGLE exception is the
// optional AI assistant (POST /api/chat): when used, it sends the user's message
// and a compact board snapshot through the Cursor SDK (Sonnet) to fulfill the
// request. That is the only path by which story text leaves this machine, and it
// only fires when the user actively asks the assistant something.

import './env.js'; // load .env into process.env before anything reads CURSOR_API_KEY
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  seedIfEmpty,
  listStories,
  getStory,
  createStory,
  updateStory,
  deleteStory,
  reorderStories,
  addComment,
  replaceAll,
  backup,
  DEFAULT_DB_PATH,
  ACTIVE_SEED_PATH,
} from './db.js';
import { runAssistant, AIError } from './ai/agent.js';
import { health as aiHealth } from './ai/providers.js';
import { saveConfig as saveAiKey, applyConfigToEnv } from './ai/keystore.js';
import { versionInfo } from './version.js';
import { writeRuntimeFile, runtimeDirFromDbPath, resolveRuntimePath } from './runtime.js';
import { listHarnesses, connectHarness, manualSnippet, testMcpConnection } from './mcp/connector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WEB_DIR = join(ROOT, 'web'); // static frontend assets

const HOST = '127.0.0.1'; // loopback only — never 0.0.0.0
const PORT = Number(process.env.PORT) || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Board branding is configurable so the public build stays generic ("StoryDeck",
// "storydeck@board:~$", neutral epics) while a private instance personalizes via
// BOARD_TITLE / BOARD_USER / BOARD_CORE_EPICS in .env (private overlay).
const BOARD_TITLE = (process.env.BOARD_TITLE || 'StoryDeck').trim();
const BOARD_USER = (process.env.BOARD_USER || 'storydeck').trim();
const BOARD_CORE_EPICS = (process.env.BOARD_CORE_EPICS || 'Website,Mobile,Marketing,Ops,Personal,GitHub')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function createApp(dbPath = DEFAULT_DB_PATH, seedPath = ACTIVE_SEED_PATH) {
  const db = openDatabase(dbPath);
  seedIfEmpty(db, seedPath);

  const server = http.createServer(async (req, res) => {
    try {
      // Hard guard: reject any connection that is not loopback.
      const remote = req.socket.remoteAddress || '';
      if (!isLoopback(remote)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: local access only');
        return;
      }

      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      const path = url.pathname;

      if (path.startsWith('/api/')) {
        await handleApi(db, req, res, path, url);
        return;
      }

      await serveStatic(res, path);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
  });

  return { server, db };
}

function isLoopback(addr) {
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.')
  );
}

async function handleApi(db, req, res, path, url) {
  const method = req.method;

  // GET /api/state  → full board
  if (path === '/api/state' && method === 'GET') {
    return sendJSON(res, 200, {
      title: BOARD_TITLE,
      user: BOARD_USER,
      coreEpics: BOARD_CORE_EPICS,
      stories: listStories(db),
    });
  }

  // GET /api/version → app + content version (so the UI can show what's running)
  if (path === '/api/version' && method === 'GET') {
    return sendJSON(res, 200, versionInfo());
  }

  // GET /api/ai/health → active AI provider/model (key-safe; never leaks keys)
  if (path === '/api/ai/health' && method === 'GET') {
    return sendJSON(res, 200, aiHealth());
  }

  // POST /api/ai/key → save a bring-your-own key (persists to userData, not repo)
  if (path === '/api/ai/key' && method === 'POST') {
    const body = await readBody(req);
    try {
      const saved = saveAiKey({ provider: body?.provider, apiKey: body?.apiKey, model: body?.model });
      return sendJSON(res, 200, { saved, health: aiHealth() });
    } catch (err) {
      if (err instanceof AIError) return sendJSON(res, err.status || 400, { error: err.message });
      return sendJSON(res, 400, { error: err.message });
    }
  }

  // GET /api/mcp/harnesses → detect installed AI apps + connection status
  if (path === '/api/mcp/harnesses' && method === 'GET') {
    return sendJSON(res, 200, listHarnesses());
  }

  // GET /api/mcp/manual → copy-paste JSON for unsupported harnesses
  if (path === '/api/mcp/manual' && method === 'GET') {
    return sendJSON(res, 200, { snippet: manualSnippet() });
  }

  // POST /api/mcp/connect → one-click register StoryDeck in a harness config
  if (path === '/api/mcp/connect' && method === 'POST') {
    const body = await readBody(req);
    const harnessId = String(body?.harnessId || '').trim();
    if (!harnessId) return sendJSON(res, 400, { error: 'harnessId is required' });
    try {
      const result = connectHarness(harnessId);
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }

  // POST /api/mcp/test → verify runtime + live board reachable
  if (path === '/api/mcp/test' && method === 'POST') {
    const result = await testMcpConnection();
    return sendJSON(res, result.ok ? 200 : 503, result);
  }

  // GET /api/export → export payload
  if (path === '/api/export' && method === 'GET') {
    return sendJSON(res, 200, {
      version: 1,
      exportedAt: new Date().toISOString(),
      stories: listStories(db),
    });
  }

  // POST /api/import → bulk replace (transactional), backup first.
  // Restore accepts arbitrary user files, so validate the shape UP FRONT and
  // fail with a clear 400 before touching the board. replaceAll is transactional
  // (rolls back on error), so a rejected import never corrupts existing data.
  if (path === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    const stories = Array.isArray(body) ? body : body?.stories;
    if (!Array.isArray(stories)) {
      return sendJSON(res, 400, { error: 'Invalid backup file: expected a stories array (or a { stories: [...] } object).' });
    }
    const badIndex = stories.findIndex(
      (s) => !s || typeof s !== 'object' || Array.isArray(s) || !String(s.task || '').trim(),
    );
    if (badIndex !== -1) {
      return sendJSON(res, 400, {
        error: `Invalid backup file: entry #${badIndex + 1} is not a valid story (each needs a non-empty "task"). Your board was not changed.`,
      });
    }
    try {
      backup(db);
      const result = replaceAll(db, stories);
      return sendJSON(res, 200, { stories: result });
    } catch (err) {
      return sendJSON(res, 400, { error: `Import failed: ${err.message}. Your board was not changed.` });
    }
  }

  // POST /api/reset → back up, then clear to an empty board ("Start fresh").
  // Mainly for new public users who want to drop the demo sample and start
  // clean. A timestamped backup is written first so it's always recoverable.
  if (path === '/api/reset' && method === 'POST') {
    try {
      backup(db);
      const result = replaceAll(db, []);
      return sendJSON(res, 200, { stories: result });
    } catch (err) {
      return sendJSON(res, 500, { error: `Reset failed: ${err.message}. Your board was not changed.` });
    }
  }

  // POST /api/stories → create
  if (path === '/api/stories' && method === 'POST') {
    const body = await readBody(req);
    try {
      const story = createStory(db, body);
      return sendJSON(res, 201, { story });
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }

  // POST /api/stories/reorder → reorder
  if (path === '/api/stories/reorder' && method === 'POST') {
    const body = await readBody(req);
    reorderStories(db, body?.orderedIds || []);
    return sendJSON(res, 200, { stories: listStories(db) });
  }

  // POST /api/chat → AI assistant turn (agentic: may mutate the board)
  if (path === '/api/chat' && method === 'POST') {
    const body = await readBody(req);
    try {
      const { reply, actions } = await runAssistant({ db, message: body?.message, model: body?.model, history: body?.history });
      return sendJSON(res, 200, { reply, actions, stories: listStories(db) });
    } catch (err) {
      if (err instanceof AIError) {
        return sendJSON(res, err.status || 500, { error: err.message, disabled: !!err.disabled });
      }
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // POST /api/comments → add comment
  if (path === '/api/comments' && method === 'POST') {
    const body = await readBody(req);
    const storyId = Number.parseInt(body?.storyId, 10);
    const story = addComment(db, storyId, body?.text);
    if (!story) return sendJSON(res, 404, { error: 'Story not found' });
    return sendJSON(res, 201, { story });
  }

  // /api/stories/:id  → PATCH | DELETE | GET
  const storyMatch = path.match(/^\/api\/stories\/(\d+)$/);
  if (storyMatch) {
    const id = Number.parseInt(storyMatch[1], 10);
    if (method === 'GET') {
      const story = getStory(db, id);
      return story ? sendJSON(res, 200, { story }) : sendJSON(res, 404, { error: 'Not found' });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const story = updateStory(db, id, body || {});
      return story ? sendJSON(res, 200, { story }) : sendJSON(res, 404, { error: 'Not found' });
    }
    if (method === 'DELETE') {
      const ok = deleteStory(db, id);
      return ok ? sendJSON(res, 200, { ok: true }) : sendJSON(res, 404, { error: 'Not found' });
    }
  }

  return sendJSON(res, 404, { error: 'Unknown endpoint' });
}

async function serveStatic(res, path) {
  let rel = path === '/' ? '/index.html' : path;
  // Prevent path traversal.
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  // Prefer a writable content overlay (hot updates) when present, then fall back
  // to the bundled assets. Each candidate is confined to its own root.
  const overlay = (process.env.WEB_OVERLAY_DIR || '').trim();
  const roots = overlay ? [overlay, WEB_DIR] : [WEB_DIR];
  for (const root of roots) {
    const file = join(root, safe);
    if (file.startsWith(root) && existsSync(file)) {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
      return;
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Start only when run directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  applyConfigToEnv(); // load a first-run stored key (if any) before serving
  const { server, db } = createApp();
  backup(db);
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    const v = versionInfo();
    const runtimeDir = runtimeDirFromDbPath(DEFAULT_DB_PATH);
    if (runtimeDir) {
      try {
        writeRuntimeFile(runtimeDir, {
          host: HOST,
          port: PORT,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          appVersion: v.appVersion,
        });
        process.env.STORYDECK_RUNTIME_FILE = resolveRuntimePath(runtimeDir);
      } catch { /* best-effort for dev MCP */ }
    }
    console.log(`\n  ${BOARD_TITLE} v${v.appVersion} — running locally (on-device only)`);
    console.log(`  content v${v.contentVersion}${v.commit ? ` (${v.commit})` : ''} · ${v.source}`);
    console.log(`  ${url}`);
    console.log(`  DB: ${DEFAULT_DB_PATH}\n`);
  });
}

export { HOST, PORT, WEB_DIR, isLoopback };
