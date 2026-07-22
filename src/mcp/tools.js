// MCP tool handlers — thin wrappers over the local StoryDeck REST API.

import {
  apiRequest,
  filterStories,
  probeConnection,
  resolveBaseUrl,
  StoryDeckApiError,
  StoryDeckNotRunningError,
} from './client.js';

function toolError(err) {
  if (err instanceof StoryDeckNotRunningError || err instanceof StoryDeckApiError) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
  return { isError: true, content: [{ type: 'text', text: err?.message || String(err) }] };
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export async function storydeckStatus() {
  const baseUrl = resolveBaseUrl();
  const version = await probeConnection(baseUrl);
  const state = await apiRequest('GET', '/api/state');
  const stories = state.stories || [];
  const pending = stories.filter((s) => s.status === 'pending').length;
  const done = stories.filter((s) => s.status === 'done').length;
  return ok({
    connected: true,
    url: baseUrl,
    title: state.title,
    appVersion: version.appVersion,
    contentVersion: version.contentVersion,
    source: version.source,
    counts: { total: stories.length, pending, done },
  });
}

export async function storydeckList({ status, project, search } = {}) {
  const state = await apiRequest('GET', '/api/state');
  const stories = filterStories(state.stories || [], { status, project, search });
  return ok({ title: state.title, count: stories.length, stories });
}

export async function storydeckGet({ id }) {
  const storyId = Number.parseInt(id, 10);
  if (!Number.isFinite(storyId)) throw new StoryDeckApiError('id must be a number', 400);
  const data = await apiRequest('GET', `/api/stories/${storyId}`);
  return ok(data.story);
}

export async function storydeckCreate(input = {}) {
  const task = String(input.task || '').trim();
  if (!task) throw new StoryDeckApiError('task is required', 400);
  const body = { task };
  if (input.project != null) body.project = input.project;
  if (input.points != null) body.points = input.points;
  if (input.due != null) body.due = input.due;
  if (input.note != null) body.note = input.note;
  const data = await apiRequest('POST', '/api/stories', body);
  return ok(data.story);
}

export async function storydeckUpdate({ id, ...patch }) {
  const storyId = Number.parseInt(id, 10);
  if (!Number.isFinite(storyId)) throw new StoryDeckApiError('id must be a number', 400);
  const data = await apiRequest('PATCH', `/api/stories/${storyId}`, patch);
  return ok(data.story);
}

export async function storydeckComplete({ id }) {
  return storydeckUpdate({ id, status: 'done' });
}

export async function storydeckComment({ id, text }) {
  const storyId = Number.parseInt(id, 10);
  if (!Number.isFinite(storyId)) throw new StoryDeckApiError('id must be a number', 400);
  const comment = String(text || '').trim();
  if (!comment) throw new StoryDeckApiError('text is required', 400);
  const data = await apiRequest('POST', '/api/comments', { storyId, text: comment });
  return ok(data.story);
}

export async function storydeckDelete({ id }) {
  const storyId = Number.parseInt(id, 10);
  if (!Number.isFinite(storyId)) throw new StoryDeckApiError('id must be a number', 400);
  await apiRequest('DELETE', `/api/stories/${storyId}`);
  return ok({ deleted: true, id: storyId });
}

export async function storydeckExport() {
  const data = await apiRequest('GET', '/api/export');
  return ok(data);
}

export const TOOL_HANDLERS = {
  storydeck_status: () => storydeckStatus(),
  storydeck_list: (args) => storydeckList(args),
  storydeck_get: (args) => storydeckGet(args),
  storydeck_create: (args) => storydeckCreate(args),
  storydeck_update: (args) => storydeckUpdate(args),
  storydeck_complete: (args) => storydeckComplete(args),
  storydeck_comment: (args) => storydeckComment(args),
  storydeck_delete: (args) => storydeckDelete(args),
  storydeck_export: () => storydeckExport(),
};

export async function callTool(name, args = {}) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  try {
    return await handler(args);
  } catch (err) {
    return toolError(err);
  }
}
