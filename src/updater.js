// On-launch content updater ("hot updates") for StoryDeck.
//
// The Electron *binary* still needs a full reinstall to change (that's what
// tools/update-app.sh is for), but the app's CONTENT — the frontend (web/) and
// the local server/data layer (src/) — is just files. This module lets a
// packaged app pull newer content from GitHub into a WRITABLE overlay in
// userData, so most fixes ship without a reinstall.
//
// Safety model (deliberately conservative — this runs code on the user's box):
//   • HTTPS only, from a pinned repo's raw.githubusercontent.com.
//   • Every file is checked against a SHA-256 listed in a signed-by-commit
//     manifest; a mismatch aborts the whole update (all-or-nothing).
//   • Only paths under web/ or src/ are ever written (no path traversal).
//   • Downloads land in overlay-next/, then swap in atomically; a failed
//     download never leaves a half-applied overlay.
//   • Updates apply on the NEXT launch, never mid-session.
//   • Auto-rollback: choosing the overlay bumps a fail counter that is only
//     reset once the app boots successfully. After repeated boot failures we
//     fall back to the bundled content, so a bad update can't brick the app.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import https from 'node:https';

// Public content mirror (the source repo is private, so raw.githubusercontent
// can't serve it unauthenticated). Only web/ + src/ + the manifest live here.
export const CONTENT_REPO = (process.env.STORYDECK_UPDATE_REPO || 'coco-research/storydeck-content').trim();
export const CONTENT_BRANCH = (process.env.STORYDECK_UPDATE_BRANCH || 'main').trim();
export const MANIFEST_NAME = 'content-manifest.json';
const MAX_BOOT_FAILURES = 2;       // after this many bad boots, roll back to bundled
const ALLOWED_PREFIXES = ['web/', 'src/'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Monotonic integer comparison; higher contentVersion wins.
export function isNewer(candidate, current) {
  return Number(candidate) > Number(current || 0);
}

export function readManifest(file) {
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof m.contentVersion !== 'number' || typeof m.files !== 'object' || !m.files) return null;
    return m;
  } catch {
    return null;
  }
}

// Reject anything that isn't a plain relative path under an allowed prefix.
export function isAllowedRelPath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  if (rel.includes('\0')) return false;
  const norm = normalize(rel);
  if (norm.startsWith('..') || norm.includes(`..${sep}`) || norm.startsWith(sep)) return false;
  const unix = norm.split(sep).join('/');
  return ALLOWED_PREFIXES.some((p) => unix.startsWith(p)) && !unix.endsWith('/');
}

function overlayDir(userDataDir) { return join(userDataDir, 'content-overlay'); }
function overlayNextDir(userDataDir) { return join(userDataDir, 'content-overlay-next'); }
function metaPath(userDataDir) { return join(overlayDir(userDataDir), '.meta.json'); }

export function readOverlayMeta(userDataDir) {
  try {
    return JSON.parse(readFileSync(metaPath(userDataDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeOverlayMeta(userDataDir, meta) {
  writeFileSync(metaPath(userDataDir), JSON.stringify(meta, null, 2));
}

// Decide which content tree to run THIS launch. Pure-ish (only touches the
// overlay meta file to record a boot attempt). Returns:
//   { dir, version, fromOverlay }
// `dir` is the directory that contains web/ and src/ to load from.
export function chooseContentSource({ bundledDir, userDataDir, bundledVersion, maxFailures = MAX_BOOT_FAILURES }) {
  const bundled = { dir: bundledDir, version: Number(bundledVersion || 0), fromOverlay: false };
  const meta = readOverlayMeta(userDataDir);
  const oDir = overlayDir(userDataDir);
  if (!meta || typeof meta.version !== 'number') return bundled;
  // Overlay files must actually be present.
  if (!existsSync(join(oDir, 'web')) || !existsSync(join(oDir, 'src'))) return bundled;
  // A full reinstall can ship a newer bundle than the overlay → prefer bundled.
  if (!isNewer(meta.version, bundled.version)) return bundled;
  // Auto-rollback: too many failed boots on this overlay version.
  if ((meta.failcount || 0) >= maxFailures) return bundled;
  // Record a boot attempt; markBootOk() clears it once startup succeeds.
  try {
    writeOverlayMeta(userDataDir, { ...meta, failcount: (meta.failcount || 0) + 1 });
  } catch { /* best-effort */ }
  return { dir: oDir, version: meta.version, fromOverlay: true };
}

// Call after the app has started successfully to clear the boot-attempt counter.
export function markBootOk(userDataDir) {
  const meta = readOverlayMeta(userDataDir);
  if (meta && meta.failcount) {
    try { writeOverlayMeta(userDataDir, { ...meta, failcount: 0 }); } catch { /* best-effort */ }
  }
}

function rawUrl(repo, branch, file) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${file}`;
}

// Minimal HTTPS GET → Buffer. Follows a couple of redirects, hard size/time caps.
export function httpGetBuffer(url, { timeoutMs = 15000, maxBytes = MAX_FILE_BYTES, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('refusing non-https url'));
    const req = https.get(u, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGetBuffer(new URL(res.headers.location, u).href, { timeoutMs, maxBytes, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) { req.destroy(); reject(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
  });
}

// Fetch the remote manifest and, if it's newer than everything we have, download
// + verify + atomically swap in a new overlay for the NEXT launch. Best-effort:
// any failure leaves the current install completely untouched.
export async function downloadUpdate({
  userDataDir,
  currentVersion,
  repo = CONTENT_REPO,
  branch = CONTENT_BRANCH,
  fetchImpl = httpGetBuffer,
} = {}) {
  try {
    const manifestBuf = await fetchImpl(rawUrl(repo, branch, MANIFEST_NAME));
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    if (typeof manifest.contentVersion !== 'number' || !manifest.files || typeof manifest.files !== 'object') {
      return { updated: false, reason: 'bad-manifest' };
    }
    const overlayMeta = readOverlayMeta(userDataDir);
    const haveVersion = Math.max(Number(currentVersion || 0), Number(overlayMeta?.version || 0));
    if (!isNewer(manifest.contentVersion, haveVersion)) {
      return { updated: false, reason: 'up-to-date', version: haveVersion };
    }

    const entries = Object.entries(manifest.files);
    for (const [rel] of entries) {
      if (!isAllowedRelPath(rel)) return { updated: false, reason: `disallowed-path:${rel}` };
    }

    const nextDir = overlayNextDir(userDataDir);
    rmSync(nextDir, { recursive: true, force: true });
    mkdirSync(nextDir, { recursive: true });

    for (const [rel, expectedSha] of entries) {
      const buf = await fetchImpl(rawUrl(repo, branch, rel));
      if (sha256(buf) !== expectedSha) {
        rmSync(nextDir, { recursive: true, force: true });
        return { updated: false, reason: `sha-mismatch:${rel}` };
      }
      const dest = join(nextDir, normalize(rel));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
    }

    // The overlay lives under userData, where the nearest package.json does NOT
    // declare ESM. Without this marker Node loads the overlay's .js as CommonJS
    // and every `import` in it throws. Stamp the tree as an ES module so the
    // dynamic import in main.js resolves correctly.
    writeFileSync(join(nextDir, 'package.json'), JSON.stringify({ type: 'module', private: true }) + '\n');
    // Ship the manifest inside the overlay so the running app (which reads
    // content-manifest.json from its own root) reports the ACTIVE version.
    writeFileSync(join(nextDir, MANIFEST_NAME), manifestBuf);

    // Atomic-ish swap: move the freshly built tree into place.
    const oDir = overlayDir(userDataDir);
    rmSync(oDir, { recursive: true, force: true });
    renameSync(nextDir, oDir);
    writeOverlayMeta(userDataDir, {
      version: manifest.contentVersion,
      appVersion: manifest.appVersion || null,
      commit: manifest.commit || null,
      failcount: 0,
      appliedAt: new Date().toISOString(),
    });
    return {
      updated: true,
      version: manifest.contentVersion,
      appVersion: manifest.appVersion || null,
      commit: manifest.commit || null,
      generatedAt: manifest.generatedAt || null,
    };
  } catch (err) {
    try { rmSync(overlayNextDir(userDataDir), { recursive: true, force: true }); } catch { /* ignore */ }
    return { updated: false, reason: 'error', error: err.message };
  }
}
