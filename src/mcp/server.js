#!/usr/bin/env node
// StoryDeck MCP server — stdio transport proxying to the local board API.
// Run with system Node (dev) or Electron-as-Node (installed app).

import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callTool } from './tools.js';

const mcp = new McpServer({
  name: 'storydeck',
  version: '1.3.0',
});

const optionalString = z.string().optional();
const idSchema = { id: z.union([z.number(), z.string()]).describe('Story id') };

mcp.registerTool(
  'storydeck_status',
  { description: 'StoryDeck connection status, versions, and story counts' },
  async () => callTool('storydeck_status'),
);

mcp.registerTool(
  'storydeck_list',
  {
    description: 'List stories on the board (optional filters: status, project, search)',
    inputSchema: {
      status: optionalString.describe('Filter by status: pending or done'),
      project: optionalString.describe('Filter by project/epic name'),
      search: optionalString.describe('Search task, project, note, comments'),
    },
  },
  async (args) => callTool('storydeck_list', args),
);

mcp.registerTool(
  'storydeck_get',
  { description: 'Get a single story by id', inputSchema: idSchema },
  async (args) => callTool('storydeck_get', args),
);

mcp.registerTool(
  'storydeck_create',
  {
    description: 'Create a new story (task required)',
    inputSchema: {
      task: z.string().describe('Story title / task text'),
      project: optionalString.describe('Project or epic name'),
      points: z.number().optional().describe('Story points'),
      due: optionalString.describe('Due date (YYYY-MM-DD)'),
      note: optionalString.describe('Optional note'),
    },
  },
  async (args) => callTool('storydeck_create', args),
);

mcp.registerTool(
  'storydeck_update',
  {
    description: 'Update fields on an existing story',
    inputSchema: {
      ...idSchema,
      task: optionalString,
      project: optionalString,
      status: optionalString,
      points: z.number().optional(),
      due: optionalString,
      note: optionalString,
    },
  },
  async (args) => callTool('storydeck_update', args),
);

mcp.registerTool(
  'storydeck_complete',
  { description: 'Mark a story as done', inputSchema: idSchema },
  async (args) => callTool('storydeck_complete', args),
);

mcp.registerTool(
  'storydeck_comment',
  {
    description: 'Add a comment to a story',
    inputSchema: {
      ...idSchema,
      text: z.string().describe('Comment text'),
    },
  },
  async (args) => callTool('storydeck_comment', args),
);

mcp.registerTool(
  'storydeck_delete',
  { description: 'Delete a story', inputSchema: idSchema },
  async (args) => callTool('storydeck_delete', args),
);

mcp.registerTool(
  'storydeck_export',
  { description: 'Export the full board as JSON' },
  async () => callTool('storydeck_export'),
);

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startMcpServer().catch((err) => {
    console.error('StoryDeck MCP server failed:', err);
    process.exit(1);
  });
}
