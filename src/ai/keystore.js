// First-run API-key store for the packaged/public build.
//
// Public users shouldn't have to edit a .env file. They paste a key into the
// in-app settings screen; we persist it next to the database (which the packaged
// desktop app points at the OS userData dir via DB_PATH), NEVER inside the repo.
// At startup the stored key is loaded into process.env so the existing provider
// gateway picks it up with no other changes.
//
// The file is plain JSON on the user's own machine — same trust boundary as the
// local SQLite DB. It is gitignored and never leaves the device.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROVIDERS, KEY_FOR } from './providers.js';
import { AIError } from './errors.js';
import { DEFAULT_DB_PATH } from '../db.js';

// Where the config lives: AI_CONFIG_PATH override (used by tests) else alongside
// the DB file. DB_PATH is read dynamically (the packaged app sets it after import
// time), so a downloaded app writes the key to userData automatically.
export function configPath(env = process.env) {
  const override = (env.AI_CONFIG_PATH || '').trim();
  if (override) return override;
  const dbPath = (env.DB_PATH || '').trim() || DEFAULT_DB_PATH;
  return join(dirname(dbPath), 'ai-config.json');
}

export function readConfig(env = process.env) {
  const file = configPath(env);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Persist { provider, apiKey, model }. Validates provider + key; returns a
// key-SAFE summary (never echoes the key back).
export function saveConfig({ provider, apiKey, model } = {}, env = process.env) {
  const p = String(provider || '').trim().toLowerCase();
  if (!PROVIDERS.includes(p)) {
    throw new AIError(`Unknown provider "${provider}". Use one of: ${PROVIDERS.join(', ')}.`, { status: 400 });
  }
  const key = String(apiKey || '').trim();
  if (!key) throw new AIError('API key is required.', { status: 400 });

  const record = { provider: p, apiKey: key, savedAt: new Date().toISOString() };
  const m = String(model || '').trim();
  if (m) record.model = m;

  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });

  applyConfigToEnv(env);
  return { provider: p, model: record.model || null, keyPresent: true };
}

// Load a stored key into the environment so the provider gateway can use it.
// A key set explicitly in the real shell/.env wins (we only fill gaps), but the
// stored provider/model preference is applied so the user's last choice sticks.
export function applyConfigToEnv(env = process.env) {
  const cfg = readConfig(env);
  if (!cfg.provider || !PROVIDERS.includes(cfg.provider)) return false;
  const envKey = KEY_FOR[cfg.provider];
  if (cfg.apiKey && !env[envKey]) env[envKey] = cfg.apiKey;
  if (!env.AI_PROVIDER) env.AI_PROVIDER = cfg.provider;
  if (cfg.model && !env.AI_MODEL) env.AI_MODEL = cfg.model;
  return true;
}
