// Catalog of MCP client harnesses StoryDeck can register with (one-click connect).

import { homedir } from 'node:os';
import { join } from 'node:path';

function home(rel) {
  return join(homedir(), rel);
}

/** @typedef {'darwin'|'win32'|'linux'} Platform */

/**
 * @typedef HarnessDef
 * @property {string} id
 * @property {string} name
 * @property {string} blurb
 * @property {Partial<Record<Platform, string[]>>} apps - install paths to detect
 * @property {Partial<Record<Platform, string>>} configPath
 * @property {string} configRoot - top-level key holding servers (usually mcpServers)
 * @property {string} serverKey - key for StoryDeck inside that object
 * @property {string} restartHint
 * @property {boolean} [manual]
 */

/** @type {HarnessDef[]} */
export const HARNESSES = [
  {
    id: 'cursor',
    name: 'Cursor',
    blurb: 'Cursor IDE agent chat',
    apps: {
      darwin: ['/Applications/Cursor.app'],
      win32: [join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'Cursor.exe')],
      linux: ['/usr/bin/cursor', '/usr/local/bin/cursor'],
    },
    configPath: {
      darwin: home('.cursor/mcp.json'),
      win32: home('.cursor/mcp.json'),
      linux: home('.cursor/mcp.json'),
    },
    configRoot: 'mcpServers',
    serverKey: 'storydeck',
    restartHint: 'Restart Cursor, then ask: “list my StoryDeck stories”.',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    blurb: 'Anthropic Claude desktop app',
    apps: {
      darwin: ['/Applications/Claude.app'],
      win32: [join(process.env.LOCALAPPDATA || '', 'Programs', 'Claude', 'Claude.exe')],
    },
    configPath: {
      darwin: home('Library/Application Support/Claude/claude_desktop_config.json'),
      win32: join(process.env.APPDATA || home('AppData/Roaming'), 'Claude', 'claude_desktop_config.json'),
    },
    configRoot: 'mcpServers',
    serverKey: 'storydeck',
    restartHint: 'Restart Claude Desktop, then ask about your StoryDeck board.',
  },
  {
    id: 'manual',
    name: 'Other / Manual',
    blurb: 'Copy JSON for OpenCode, Zed, Windsurf, Kimi Code, etc.',
    apps: {},
    configPath: {},
    configRoot: 'mcpServers',
    serverKey: 'storydeck',
    restartHint: 'Paste into your agent’s MCP config, then restart that app.',
    manual: true,
  },
];

export function getHarness(id) {
  return HARNESSES.find((h) => h.id === id) || null;
}

export function platformHarnesses(platform = process.platform) {
  return HARNESSES.filter((h) => h.manual || h.configPath[platform]);
}
