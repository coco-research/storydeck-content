// One-click MCP registration for external AI harnesses (Cursor, Claude Desktop, …).

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHarness, platformHarnesses } from './registry.js';
import { defaultRuntimeFilePath, readRuntimeFile } from '../runtime.js';
import { storydeckStatus } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

export function resolveConnectorContext(options = {}) {
  const runtimeFile = (options.runtimeFile || process.env.STORYDECK_RUNTIME_FILE || defaultRuntimeFilePath()).trim();
  const packaged = options.packaged ?? (process.env.STORYDECK_PACKAGED === '1');
  const appRoot = options.appRoot || process.env.STORYDECK_APP_ROOT || REPO_ROOT;
  const execPath = options.execPath || process.env.STORYDECK_MCP_COMMAND || process.execPath;

  let mcpScript = (process.env.STORYDECK_MCP_SCRIPT || '').trim();
  if (!mcpScript) {
    mcpScript = join(appRoot, 'src', 'mcp', 'server.js');
  }

  return { runtimeFile, packaged, appRoot, execPath, mcpScript };
}

export function buildStorydeckMcpEntry(ctx = resolveConnectorContext()) {
  const env = { STORYDECK_RUNTIME_FILE: ctx.runtimeFile };
  if (ctx.packaged) {
    return {
      command: ctx.execPath,
      args: [ctx.mcpScript],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return {
    command: ctx.execPath,
    args: [ctx.mcpScript],
    env,
  };
}

function harnessConfigPath(harness, platform = process.platform) {
  return harness.configPath?.[platform] || null;
}

function isAppInstalled(harness, platform = process.platform) {
  if (harness.manual) return true;
  const paths = harness.apps?.[platform] || [];
  return paths.some((p) => p && existsSync(p));
}

function readJsonFile(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function serverEntryMatches(existing, expected) {
  if (!existing || typeof existing !== 'object') return false;
  if (String(existing.command || '') !== String(expected.command || '')) return false;
  const a = Array.isArray(existing.args) ? existing.args.join('\0') : '';
  const b = Array.isArray(expected.args) ? expected.args.join('\0') : '';
  return a === b;
}

export function harnessConnectionState(harness, ctx = resolveConnectorContext(), platform = process.platform) {
  if (harness.manual) {
    return { installed: true, connected: false, status: 'manual', configPath: null };
  }

  const configPath = harnessConfigPath(harness, platform);
  const installed = isAppInstalled(harness, platform);
  if (!installed) {
    return { installed: false, connected: false, status: 'not_installed', configPath };
  }
  if (!configPath) {
    return { installed: true, connected: false, status: 'unsupported_platform', configPath: null };
  }

  const doc = readJsonFile(configPath) || {};
  const root = doc[harness.configRoot];
  const existing = root?.[harness.serverKey];
  const expected = buildStorydeckMcpEntry(ctx);
  const connected = serverEntryMatches(existing, expected);

  return {
    installed: true,
    connected,
    status: connected ? 'connected' : 'available',
    configPath,
  };
}

export function listHarnesses(ctx = resolveConnectorContext()) {
  const platform = process.platform;
  const entry = buildStorydeckMcpEntry(ctx);
  const runtime = readRuntimeFile(ctx.runtimeFile);

  return {
    platform,
    runtimeFile: ctx.runtimeFile,
    runtimeOk: !!runtime,
    serverEntry: entry,
    harnesses: platformHarnesses(platform).map((h) => {
      const state = harnessConnectionState(h, ctx, platform);
      return {
        id: h.id,
        name: h.name,
        blurb: h.blurb,
        manual: !!h.manual,
        restartHint: h.restartHint,
        ...state,
      };
    }),
  };
}

function backupConfig(configPath) {
  if (!existsSync(configPath)) return;
  try {
    copyFileSync(configPath, `${configPath}.storydeck.bak`);
  } catch { /* best-effort */ }
}

export function connectHarness(harnessId, ctx = resolveConnectorContext()) {
  const harness = getHarness(harnessId);
  if (!harness) throw new Error(`Unknown harness: ${harnessId}`);
  if (harness.manual) {
    return { ok: true, manual: true, snippet: manualSnippet(ctx), restartHint: harness.restartHint };
  }

  const platform = process.platform;
  const configPath = harnessConfigPath(harness, platform);
  if (!configPath) throw new Error(`${harness.name} is not supported on ${platform} yet.`);
  if (!isAppInstalled(harness, platform)) {
    throw new Error(`${harness.name} is not installed on this device.`);
  }

  mkdirSync(dirname(configPath), { recursive: true });
  backupConfig(configPath);

  const doc = readJsonFile(configPath) || {};
  if (!doc[harness.configRoot] || typeof doc[harness.configRoot] !== 'object') {
    doc[harness.configRoot] = {};
  }
  doc[harness.configRoot][harness.serverKey] = buildStorydeckMcpEntry(ctx);
  writeFileSync(configPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    harnessId: harness.id,
    name: harness.name,
    configPath,
    restartHint: harness.restartHint,
    connected: true,
  };
}

export function manualSnippet(ctx = resolveConnectorContext()) {
  const entry = buildStorydeckMcpEntry(ctx);
  return {
    mcpServers: {
      storydeck: entry,
    },
  };
}

export async function testMcpConnection(ctx = resolveConnectorContext()) {
  const runtime = readRuntimeFile(ctx.runtimeFile);
  if (!runtime) {
    return {
      ok: false,
      error: 'StoryDeck runtime file missing. Keep the StoryDeck app open.',
    };
  }
  try {
    process.env.STORYDECK_RUNTIME_FILE = ctx.runtimeFile;
    const result = await storydeckStatus();
    if (result.isError) {
      return { ok: false, error: result.content?.[0]?.text || 'Connection failed' };
    }
    const data = JSON.parse(result.content[0].text);
    return {
      ok: true,
      appVersion: data.appVersion,
      counts: data.counts,
      url: data.url,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
