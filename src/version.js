// Version info for the running app. Surfaced via GET /api/version and shown in
// the UI, so it's always clear WHICH version is running and — after a hot update
// — what changed.
//
// Two independent version streams:
//   • appVersion    — semver of the Electron binary (package.json). Only changes
//                     with a full reinstall (tools/update-app.sh).
//   • contentVersion — monotonic integer for the hot-updatable content (web/+src/).
//                     Bumps whenever content is published (tools/push-updates.sh).
//
// When the app runs from a downloaded overlay, main.js sets STORYDECK_* env vars
// and the overlay ships its own content-manifest.json, so this resolves the
// ACTIVE content — not the bundled baseline.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function versionInfo() {
  // package.json in an overlay is just an ESM marker (no version), so the binary
  // version always comes from the bundle — main.js passes it through in that case.
  const pkg = readJson(join(ROOT, 'package.json'));
  const manifest = readJson(join(ROOT, 'content-manifest.json'));

  const appVersion = process.env.STORYDECK_APP_VERSION || pkg.version || '0.0.0';
  const contentVersion = Number(manifest.contentVersion) || 0;

  return {
    appVersion,
    contentVersion,
    channel: manifest.channel || 'stable',
    commit: manifest.commit || null,
    contentDate: manifest.generatedAt || null,
    // 'overlay' = running hot-updated content; 'bundled' = shipped-in-the-binary.
    source: process.env.STORYDECK_CONTENT_SOURCE || 'bundled',
  };
}
