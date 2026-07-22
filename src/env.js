// Tiny zero-dependency .env loader.
// Reads <projectRoot>/.env once at import time and copies any KEY=VALUE pairs
// into process.env WITHOUT overwriting variables already present in the real
// environment (so an inline `CURSOR_API_KEY=… node …` still wins).
//
// Supports: blank lines, `# comments`, optional `export ` prefix, and values
// wrapped in single or double quotes. Values may contain `=`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(file = join(ROOT, '.env')) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {}; // no .env — nothing to do
  }

  const loaded = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return loaded;
}

// Auto-load on import so importing this module has the side effect of populating env.
// The private overlay (private/.env) takes precedence over a root .env; neither
// overwrites variables already set in the real environment.
loadEnv(join(ROOT, 'private', '.env'));
loadEnv(join(ROOT, '.env'));
