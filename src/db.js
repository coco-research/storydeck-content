// Data layer for the local Stories board.
// Uses Node's built-in node:sqlite (DatabaseSync) — no native build, no external deps.
// The DB file lives on local disk; nothing is ever sent off-device.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Public/private split via an on-device overlay:
//   - Repo root is the PUBLIC build (committed, pushed). Its data dir holds only
//     the fictional sample seed.
//   - A gitignored `private/` folder is the McKinsey instance's overlay: real
//     seed, live DB, and backups live there and are NEVER pushed.
// When `private/` exists we read/write there; otherwise we use the public data dir.
const PUBLIC_DATA_DIR = join(ROOT, 'data');
const PRIVATE_DIR = join(ROOT, 'private');
const HAS_PRIVATE = existsSync(PRIVATE_DIR);

const DATA_DIR = HAS_PRIVATE ? join(PRIVATE_DIR, 'data') : PUBLIC_DATA_DIR;

// DB_PATH override: the packaged desktop app points this at a writable userData
// dir (app resources are read-only), so downloaded copies save data automatically.
const ENV_DB = (process.env.DB_PATH || '').trim();
const DEFAULT_DB_PATH = ENV_DB || join(DATA_DIR, 'todo.db');
const BACKUP_DIR = ENV_DB
  ? join(dirname(ENV_DB), 'backups')
  : (HAS_PRIVATE ? join(PRIVATE_DIR, 'backups') : join(ROOT, 'backups'));
// Private, on-device seed (gitignored). Public clones don't have it.
const SEED_PATH = join(DATA_DIR, 'seed.json');
// Public demo seed committed to the repo — always at the public data dir.
const SAMPLE_SEED_PATH = join(PUBLIC_DATA_DIR, 'seed.sample.json');
// Runtime seed resolution (first wins):
//   1. SEED_PATH env override — lets a packaged build or a smoke test pin a seed.
//   2. the private real data (private/data/seed.json) when the overlay exists.
//   3. the shipped public sample.
const ENV_SEED = (process.env.SEED_PATH || '').trim();
const ACTIVE_SEED_PATH = ENV_SEED || (existsSync(SEED_PATH) ? SEED_PATH : SAMPLE_SEED_PATH);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task        TEXT    NOT NULL,
  epic        TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'pending',   -- 'pending' | 'done'
  work_status TEXT,                                 -- NULL | 'in-progress' | 'blocked'
  urgent      INTEGER NOT NULL DEFAULT 0,           -- 0 | 1
  points      INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  due         TEXT,                                 -- NULL | 'YYYY-MM-DD' target date
  position    INTEGER NOT NULL DEFAULT 0,           -- ordering within a column
  added       TEXT,
  completed   TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id   INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  created    TEXT,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_story ON comments(story_id);
CREATE INDEX IF NOT EXISTS idx_stories_position ON stories(position);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Long-term assistant memory (durable facts), on-device only. See AGENTIC-PLAN.md.
CREATE TABLE IF NOT EXISTS memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL DEFAULT 'fact',   -- 'fact' | 'preference' | 'entity' | 'pin'
  text       TEXT    NOT NULL,
  entity     TEXT,
  weight     REAL    NOT NULL DEFAULT 1,
  created    TEXT    NOT NULL,
  last_used  TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory(kind);
`;

function nowISO() {
  return new Date().toISOString();
}

export function openDatabase(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:' && !existsSync(dirname(dbPath))) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive, idempotent migrations for DBs created before a column existed.
// `CREATE TABLE IF NOT EXISTS` never alters an existing table, so we backfill
// new columns here without touching data.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(stories)').all().map((c) => c.name);
  if (!cols.includes('due')) db.exec('ALTER TABLE stories ADD COLUMN due TEXT');
}

// ── mapping between DB rows and the story shape the frontend expects ──────────
function rowToStory(db, row) {
  const comments = db
    .prepare('SELECT text, created FROM comments WHERE story_id = ? ORDER BY id ASC')
    .all(row.id)
    .map((c) => ({ text: c.text, created: c.created || '' }));

  const story = {
    id: row.id,
    task: row.task,
    project: row.epic || '',
    status: row.status === 'done' ? 'done' : 'pending',
    points: Number.isFinite(row.points) ? row.points : 1,
    position: row.position,
    added: row.added || undefined,
    comments,
  };
  if (row.status === 'done') story.completed = row.completed || undefined;
  else if (row.work_status) story.workStatus = row.work_status;
  if (row.urgent) story.urgent = true;
  if (row.note) story.note = row.note;
  if (row.due) story.due = row.due;
  return story;
}

export function listStories(db) {
  const rows = db.prepare('SELECT * FROM stories ORDER BY position ASC, id ASC').all();
  return rows.map((r) => rowToStory(db, r));
}

export function getStory(db, id) {
  const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
  return row ? rowToStory(db, row) : null;
}

function normalizePoints(value, fallback = 1) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// Due date: accept an ISO calendar date (YYYY-MM-DD); anything else clears it.
function normalizeDue(value) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function nextPosition(db) {
  const row = db.prepare('SELECT MAX(position) AS maxPos FROM stories').get();
  return (row?.maxPos ?? -1) + 1;
}

export function createStory(db, input = {}) {
  const ts = nowISO();
  const task = String(input.task || '').trim();
  if (!task) throw new Error('task is required');

  const status = input.status === 'done' ? 'done' : 'pending';
  const workStatus =
    status === 'done' ? null : normalizeWorkStatus(input.workStatus);
  const completed = status === 'done' ? input.completed || ts.slice(0, 10) : null;
  const position = Number.isFinite(input.position) ? input.position : nextPosition(db);

  const info = db
    .prepare(
      `INSERT INTO stories (task, epic, status, work_status, urgent, points, note, due, position, added, completed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      task,
      normalizeEpic(input.project),
      status,
      workStatus,
      input.urgent ? 1 : 0,
      normalizePoints(input.points),
      input.note ? String(input.note) : null,
      normalizeDue(input.due),
      position,
      input.added || ts.slice(0, 10),
      completed,
      ts,
      ts
    );

  const id = Number(info.lastInsertRowid);
  if (Array.isArray(input.comments)) {
    for (const c of input.comments) {
      const text = String(c?.text || '').trim();
      if (text) insertComment(db, id, text, c?.created || '');
    }
  }
  return getStory(db, id);
}

const MUTABLE_FIELDS = new Set([
  'task', 'project', 'status', 'workStatus', 'urgent', 'points', 'note', 'due', 'completed', 'added',
]);

export function updateStory(db, id, patch = {}) {
  const existing = db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
  if (!existing) return null;

  const next = {
    task: existing.task,
    epic: existing.epic,
    status: existing.status,
    work_status: existing.work_status,
    urgent: existing.urgent,
    points: existing.points,
    note: existing.note,
    due: existing.due,
    completed: existing.completed,
    added: existing.added,
  };

  for (const key of Object.keys(patch)) {
    if (!MUTABLE_FIELDS.has(key)) continue;
    switch (key) {
      case 'task': {
        const t = String(patch.task || '').trim();
        if (t) next.task = t;
        break;
      }
      case 'project':
        next.epic = normalizeEpic(patch.project);
        break;
      case 'status':
        next.status = patch.status === 'done' ? 'done' : 'pending';
        break;
      case 'workStatus':
        next.work_status = normalizeWorkStatus(patch.workStatus);
        break;
      case 'urgent':
        next.urgent = patch.urgent ? 1 : 0;
        break;
      case 'points':
        next.points = normalizePoints(patch.points, existing.points);
        break;
      case 'note':
        next.note = patch.note ? String(patch.note) : null;
        break;
      case 'due':
        next.due = normalizeDue(patch.due);
        break;
      case 'completed':
        next.completed = patch.completed || null;
        break;
      case 'added':
        next.added = patch.added || null;
        break;
    }
  }

  // Keep status / work_status / completed internally consistent.
  if (next.status === 'done') {
    next.work_status = null;
    if (!next.completed) next.completed = nowISO().slice(0, 10);
  } else {
    next.completed = null;
  }

  db.prepare(
    `UPDATE stories SET task=?, epic=?, status=?, work_status=?, urgent=?, points=?, note=?, due=?, completed=?, added=?, updated_at=? WHERE id=?`
  ).run(
    next.task,
    next.epic,
    next.status,
    next.work_status,
    next.urgent,
    next.points,
    next.note,
    next.due,
    next.completed,
    next.added,
    nowISO(),
    id
  );
  return getStory(db, id);
}

export function deleteStory(db, id) {
  const info = db.prepare('DELETE FROM stories WHERE id = ?').run(id);
  return info.changes > 0;
}

// Reassign positions for the given ordered ids so they sort correctly within a column.
export function reorderStories(db, orderedIds = []) {
  const ids = [...new Set(orderedIds.map((n) => Number.parseInt(n, 10)).filter(Number.isFinite))];
  const base = nextPosition(db);
  const stmt = db.prepare('UPDATE stories SET position = ?, updated_at = ? WHERE id = ?');
  const ts = nowISO();
  const run = db.prepare('BEGIN');
  run.run();
  try {
    ids.forEach((id, index) => stmt.run(base + index, ts, id));
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
  return true;
}

function insertComment(db, storyId, text, created) {
  return db
    .prepare('INSERT INTO comments (story_id, text, created, created_at) VALUES (?, ?, ?, ?)')
    .run(storyId, text, created || '', nowISO());
}

export function addComment(db, storyId, text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('comment text is required');
  const story = db.prepare('SELECT id FROM stories WHERE id = ?').get(storyId);
  if (!story) return null;
  const created = nowISO().slice(0, 16).replace('T', ' ');
  insertComment(db, storyId, clean, created);
  return getStory(db, storyId);
}

// ── helpers ───────────────────────────────────────────────────────────────
function normalizeEpic(value) {
  const v = (value || '').trim();
  return v === 'Unassigned' ? '' : v;
}

function normalizeWorkStatus(value) {
  return value === 'in-progress' || value === 'blocked' ? value : null;
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value)
  );
}

// One-time seed from data/seed.json. Idempotent: guarded by a meta flag.
export function seedIfEmpty(db, seedPath = ACTIVE_SEED_PATH) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  if (count > 0 || getMeta(db, 'seeded') === 'true') return { seeded: false, count };
  if (!existsSync(seedPath)) return { seeded: false, count: 0 };

  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  const run = db.prepare('BEGIN');
  run.run();
  try {
    seed.forEach((s, i) => {
      createStory(db, {
        ...s,
        position: Number.isFinite(s.position) ? s.position : i,
      });
    });
    setMeta(db, 'seeded', 'true');
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
  return { seeded: true, count: seed.length };
}

// Replace all data transactionally (used by JSON import). Keeps a backup first.
export function replaceAll(db, stories = []) {
  if (!Array.isArray(stories)) throw new Error('stories must be an array');
  const run = db.prepare('BEGIN');
  run.run();
  try {
    db.prepare('DELETE FROM comments').run();
    db.prepare('DELETE FROM stories').run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('stories','comments')").run();
    stories.forEach((s, i) => {
      createStory(db, { ...s, position: Number.isFinite(s.position) ? s.position : i });
    });
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
  return listStories(db);
}

// Snapshot the current data to a timestamped JSON backup on local disk.
export function backup(db, dir = BACKUP_DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `stories-${stamp}.json`);
  const payload = {
    version: 1,
    exportedAt: nowISO(),
    stories: listStories(db),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

// ── Long-term memory (durable facts) ─────────────────────────────────────────
// M0 (baseline): capture + cheap keyword recall, weight bumping on use. No ML.
const MEMORY_KINDS = new Set(['fact', 'preference', 'entity', 'pin']);

function memoryById(db, id) {
  return db
    .prepare('SELECT id, kind, text, entity, weight, created, last_used FROM memory WHERE id = ?')
    .get(id) || null;
}

// Store a durable fact. Idempotent on (text, kind): a repeat bumps weight instead
// of duplicating, so recurring reminders naturally rank higher.
export function rememberFact(db, { text, kind = 'fact', entity = null, weight = 1 } = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('memory text is required');
  const k = MEMORY_KINDS.has(kind) ? kind : 'fact';
  const ent = entity != null && String(entity).trim() ? String(entity).trim() : null;
  const ts = nowISO();

  const existing = db.prepare('SELECT id FROM memory WHERE text = ? AND kind = ?').get(t, k);
  if (existing) {
    db.prepare('UPDATE memory SET weight = weight + 1, last_used = ?, entity = COALESCE(?, entity) WHERE id = ?')
      .run(ts, ent, existing.id);
    return memoryById(db, existing.id);
  }
  const info = db
    .prepare('INSERT INTO memory (kind, text, entity, weight, created, last_used) VALUES (?, ?, ?, ?, ?, ?)')
    .run(k, t, ent, Number.isFinite(weight) ? weight : 1, ts, ts);
  return memoryById(db, Number(info.lastInsertRowid));
}

export function listMemory(db, { limit = 100 } = {}) {
  return db
    .prepare('SELECT id, kind, text, entity, weight, created, last_used FROM memory ORDER BY weight DESC, id DESC LIMIT ?')
    .all(limit);
}

export function forgetMemory(db, id) {
  return db.prepare('DELETE FROM memory WHERE id = ?').run(id).changes > 0;
}

// Recall durable facts for a query. Empty query → top-weighted pins/facts.
// Cheap keyword scoring (token overlap + pin boost + light weight boost); recall
// reinforces rows by bumping weight/last_used so useful facts stick around.
export function recallFacts(db, { query = '', limit = 15 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const ts = nowISO();
  let rows;
  if (!q) {
    rows = db
      .prepare("SELECT * FROM memory ORDER BY (kind = 'pin') DESC, weight DESC, last_used DESC LIMIT ?")
      .all(limit);
  } else {
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 8);
    const all = db.prepare('SELECT * FROM memory').all();
    const scored = all
      .map((r) => {
        const hay = `${r.text} ${r.entity || ''}`.toLowerCase();
        let score = 0;
        for (const tok of tokens) if (hay.includes(tok)) score += 1;
        if (r.kind === 'pin') score += 0.5;
        score += Math.min(r.weight, 5) * 0.1;
        return { r, score };
      })
      .filter((x) => x.score > 0 || x.r.kind === 'pin');
    scored.sort((a, b) => b.score - a.score || b.r.weight - a.r.weight);
    rows = scored.slice(0, limit).map((x) => x.r);
  }
  const bump = db.prepare('UPDATE memory SET last_used = ?, weight = weight + 0.1 WHERE id = ?');
  for (const r of rows) bump.run(ts, r.id);
  return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, entity: r.entity || null, weight: r.weight }));
}

export { DEFAULT_DB_PATH, BACKUP_DIR, SEED_PATH, SAMPLE_SEED_PATH, ACTIVE_SEED_PATH };
