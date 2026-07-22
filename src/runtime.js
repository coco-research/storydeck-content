// Runtime discovery file for MCP and other local integrations.
// Written by the Electron shell (main.js) or dev server on listen; removed on shutdown.

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const RUNTIME_FILE_NAME = 'runtime.json';

export function resolveRuntimePath(userDataDir) {
  const dir = String(userDataDir || '').trim();
  if (!dir) return null;
  return join(dir, RUNTIME_FILE_NAME);
}

export function defaultRuntimeFilePath() {
  const override = (process.env.STORYDECK_RUNTIME_FILE || '').trim();
  if (override) return override;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'storydeck', RUNTIME_FILE_NAME);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'storydeck', RUNTIME_FILE_NAME);
  }
  return join(homedir(), '.config', 'storydeck', RUNTIME_FILE_NAME);
}

export function writeRuntimeFile(userDataDir, data) {
  const file = resolveRuntimePath(userDataDir);
  if (!file) throw new Error('userDataDir is required');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return file;
}

export function readRuntimeFile(filePath) {
  const file = String(filePath || '').trim();
  if (!file || !existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data.port !== 'number' || !data.host) return null;
    return data;
  } catch {
    return null;
  }
}

export function removeRuntimeFile(userDataDir) {
  const file = resolveRuntimePath(userDataDir);
  if (!file || !existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch { /* best-effort */ }
}

export function runtimeDirFromDbPath(dbPath) {
  const p = String(dbPath || '').trim();
  if (!p) return null;
  return dirname(p);
}
