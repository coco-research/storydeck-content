// HTTP client for the local StoryDeck API (loopback only).

import { readFileSync, existsSync } from 'node:fs';
import { readRuntimeFile, defaultRuntimeFilePath } from '../runtime.js';
import { isLoopback } from '../server.js';

export class StoryDeckNotRunningError extends Error {
  constructor(message = 'Start StoryDeck first, then retry.') {
    super(message);
    this.name = 'StoryDeckNotRunningError';
  }
}

export class StoryDeckApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'StoryDeckApiError';
    this.status = status;
  }
}

export function assertLoopbackUrl(urlString) {
  const u = new URL(urlString);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported');
  }
  if (!isLoopback(u.hostname)) {
    throw new Error('StoryDeck MCP only connects to loopback addresses');
  }
  return u;
}

export function resolveBaseUrl(options = {}) {
  const explicit = (options.baseUrl || process.env.STORYDECK_URL || '').trim();
  if (explicit) {
    const u = assertLoopbackUrl(explicit);
    return u.origin;
  }

  const runtimePath = (options.runtimeFile || process.env.STORYDECK_RUNTIME_FILE || defaultRuntimeFilePath()).trim();
  const runtime = readRuntimeFile(runtimePath);
  if (runtime) {
    const origin = `http://${runtime.host}:${runtime.port}`;
    assertLoopbackUrl(origin);
    return origin;
  }

  const fallback = 'http://127.0.0.1:4321';
  assertLoopbackUrl(fallback);
  return fallback;
}

export async function probeConnection(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new StoryDeckNotRunningError();
    return res.json();
  } catch (err) {
    if (err instanceof StoryDeckNotRunningError) throw err;
    const msg = err?.message || '';
    if (err?.name === 'TimeoutError' || err?.code === 'ECONNREFUSED' || /fetch failed/i.test(msg)) {
      throw new StoryDeckNotRunningError(
        'StoryDeck is not running. Open the StoryDeck app, then retry.',
      );
    }
    throw err;
  }
}

export async function apiRequest(method, path, body, options = {}) {
  const baseUrl = resolveBaseUrl(options);
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });
  } catch (err) {
    const msg = err?.message || '';
    if (err?.name === 'TimeoutError' || err?.code === 'ECONNREFUSED' || /fetch failed/i.test(msg)) {
      throw new StoryDeckNotRunningError(
        'StoryDeck is not running. Open the StoryDeck app, then retry.',
      );
    }
    throw err;
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || res.statusText };
  }

  if (!res.ok) {
    const msg = data?.error || res.statusText || `HTTP ${res.status}`;
    throw new StoryDeckApiError(msg, res.status);
  }
  return data;
}

export function filterStories(stories, { status, project, search } = {}) {
  let list = Array.isArray(stories) ? [...stories] : [];
  if (status) {
    const s = String(status).trim().toLowerCase();
    list = list.filter((st) => String(st.status || '').toLowerCase() === s);
  }
  if (project) {
    const p = String(project).trim().toLowerCase();
    list = list.filter((st) => String(st.project || '').toLowerCase() === p);
  }
  if (search) {
    const q = String(search).trim().toLowerCase();
    list = list.filter((st) => {
      const hay = [
        st.task,
        st.project,
        st.note,
        ...(st.comments || []).map((c) => c.text),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  return list;
}
