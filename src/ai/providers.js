// Multi-provider model gateway for the AI assistant.
//
// The public build supports three providers, chosen by AI_PROVIDER or auto-
// detected from whichever API key is present (in priority order):
//   - openai     → OPENAI_API_KEY     (Chat Completions, JSON mode)
//   - anthropic  → ANTHROPIC_API_KEY  (Messages API, Claude)
//   - cursor     → CURSOR_API_KEY     (Cursor SDK gateway)
//
// Every runner takes the single prompt string the agent builds and returns the
// raw model text; the agent extracts the STRICT-JSON action plan from it.
// Tests never reach this file — they inject a fake runner via setModelRunner().

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(__dirname, '..', '..', '.ai-scratch');

export const PROVIDERS = ['openai', 'anthropic', 'cursor'];

// Sensible, configurable defaults (override any of them with AI_MODEL).
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-5',
  cursor: 'auto',
};

export const KEY_FOR = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  cursor: 'CURSOR_API_KEY',
};

// Which provider + key to use. Explicit AI_PROVIDER wins; else first key found.
export function resolveProvider(env = process.env) {
  const explicit = String(env.AI_PROVIDER || '').trim().toLowerCase();
  if (explicit) {
    if (!PROVIDERS.includes(explicit)) {
      throw new AIError(`Unknown AI_PROVIDER "${explicit}". Use one of: ${PROVIDERS.join(', ')}.`, {
        disabled: true,
        status: 503,
      });
    }
    const apiKey = env[KEY_FOR[explicit]];
    if (!apiKey) {
      throw new AIError(`AI provider "${explicit}" is selected but ${KEY_FOR[explicit]} is not set.`, {
        disabled: true,
        status: 503,
      });
    }
    return { provider: explicit, apiKey };
  }
  for (const p of PROVIDERS) {
    if (env[KEY_FOR[p]]) return { provider: p, apiKey: env[KEY_FOR[p]] };
  }
  throw new AIError(
    'AI is unavailable: set one of OPENAI_API_KEY, ANTHROPIC_API_KEY, or CURSOR_API_KEY.',
    { disabled: true, status: 503 },
  );
}

export function resolveModel(provider, env = process.env) {
  const override = env.AI_MODEL && String(env.AI_MODEL).trim();
  return override || DEFAULT_MODELS[provider] || 'auto';
}

// Key-safe health snapshot for the UI. Never returns key values — only which
// providers have a key present (booleans) and the resolved active provider/model.
// Never throws: when AI is unavailable it reports enabled:false + the reason.
export function health(env = process.env) {
  const keysPresent = {};
  for (const p of PROVIDERS) keysPresent[p] = Boolean(env[KEY_FOR[p]]);
  try {
    const { provider } = resolveProvider(env);
    return {
      enabled: true,
      provider,
      model: resolveModel(provider, env),
      keysPresent,
    };
  } catch (err) {
    return {
      enabled: false,
      provider: null,
      model: null,
      keysPresent,
      reason: err && err.message ? err.message : 'AI is unavailable',
    };
  }
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

// ── Retry / backoff helpers (pure + testable, no network) ────────────────────
// Transient HTTP statuses worth retrying: 429 (rate limit), 500/502/503/504
// (server/timeout), 529 (Anthropic overloaded). 4xx model/auth errors are NOT
// retryable — retrying them just wastes the user's time.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
export function retryableStatus(status) {
  return RETRYABLE_STATUS.has(Number(status));
}

// Parse a Retry-After header (integer seconds or an HTTP date) into ms.
// Returns null when absent/unparseable so the caller falls back to jitter.
export function parseRetryAfter(headerValue, now = Date.now()) {
  if (headerValue == null) return null;
  const raw = String(headerValue).trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

// Full-jitter exponential backoff (AWS pattern): random(0, min(cap, base*2^n)).
// A trustworthy Retry-After (429) always wins over computed jitter.
export function computeBackoffMs(attempt, { base = 500, cap = 8000, retryAfterMs = null, rng = Math.random } = {}) {
  if (retryAfterMs != null && retryAfterMs >= 0) return retryAfterMs;
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(rng() * ceiling);
}

// Reject runaway prompts before we spend a network round-trip. Char-based
// (a cheap proxy for tokens); the assistant's snapshot is far smaller than this.
export const MAX_PROMPT_CHARS = 120_000;
export function guardPromptLength(prompt, max = MAX_PROMPT_CHARS) {
  const len = typeof prompt === 'string' ? prompt.length : 0;
  if (len > max) {
    throw new AIError(
      `Request too large (${len} chars > ${max}). Narrow the ask or clear the chat history.`,
      { status: 413 },
    );
  }
  return prompt;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch() with bounded retries on transient failures. Honors Retry-After for
// 429s, full-jitter backoff otherwise; also retries network errors. Non-transient
// responses are returned as-is for the caller to interpret.
async function fetchWithRetry(url, opts, { attempts = 3, label = 'request' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok || !retryableStatus(res.status) || attempt === attempts - 1) return res;
      const retryAfterMs = parseRetryAfter(res.headers && res.headers.get && res.headers.get('retry-after'));
      await sleep(computeBackoffMs(attempt, { retryAfterMs }));
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1) break;
      await sleep(computeBackoffMs(attempt));
    }
  }
  throw new AIError(`${label} failed after ${attempts} attempts: ${lastErr ? lastErr.message : 'network error'}`, {
    status: 502,
  });
}

// Turn a non-ok response into a clear, user-facing AIError. 429 → rate limited,
// 529/5xx → temporarily overloaded, 400/404 mentioning the model → model hint.
async function httpError(provider, res) {
  const body = await safeText(res);
  const status = res.status;
  if (status === 429) {
    return new AIError(`${provider} is rate limited right now — wait a moment and try again.`, { status: 429 });
  }
  if (status === 529 || status >= 500) {
    return new AIError(`${provider} is temporarily overloaded — try again shortly.`, { status: 503 });
  }
  if ((status === 404 || status === 400) && /model/i.test(body)) {
    return new AIError(`${provider} rejected the model — set AI_MODEL to a valid model. (${body})`, { status: 400 });
  }
  return new AIError(`${provider} request failed (${status}): ${body}`, { status: 502 });
}

// ── OpenAI (Chat Completions, JSON mode) ─────────────────────────────────────
async function runOpenAI(prompt, { apiKey, model }) {
  const res = await fetchWithRetry(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    },
    { label: 'OpenAI' },
  );
  if (!res.ok) throw await httpError('OpenAI', res);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ── Anthropic (Messages API) ─────────────────────────────────────────────────
// Note: newer Sonnet models reject non-default temperature, so we don't send it.
async function runAnthropic(prompt, { apiKey, model }) {
  const res = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    { label: 'Anthropic' },
  );
  if (!res.ok) throw await httpError('Anthropic', res);
  const data = await res.json();
  const parts = Array.isArray(data?.content) ? data.content : [];
  return parts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') || '';
}

// ── Cursor SDK ───────────────────────────────────────────────────────────────
let _cachedCursorModel = null;
async function resolveCursorModel(apiKey, sdk, requested) {
  if (requested && requested !== 'auto') return requested;
  if (_cachedCursorModel) return _cachedCursorModel;
  try {
    const models = await sdk.Cursor.models.list({ apiKey });
    const ids = (models?.models || models || [])
      .map((m) => (typeof m === 'string' ? m : m.id))
      .filter(Boolean);
    const sonnet = ids.filter((id) => /sonnet/i.test(id)).sort().reverse();
    _cachedCursorModel = sonnet[0] || 'auto';
  } catch {
    _cachedCursorModel = 'auto';
  }
  return _cachedCursorModel;
}

async function runCursor(prompt, { apiKey, model }) {
  let sdk;
  try {
    sdk = await import('@cursor/sdk');
  } catch {
    throw new AIError('AI is unavailable: the @cursor/sdk package is not installed. Run `npm install @cursor/sdk`.', {
      disabled: true,
      status: 503,
    });
  }
  mkdirSync(SCRATCH, { recursive: true });
  const modelId = await resolveCursorModel(apiKey, sdk, model);
  const result = await sdk.Agent.prompt(prompt, {
    apiKey,
    model: { id: modelId },
    local: { cwd: SCRATCH },
  });
  if (result.status === 'error') {
    throw new AIError(`Model run failed: ${result.result || 'unknown error'}`, { status: 502 });
  }
  return result.result || '';
}

// Dispatch: resolve provider + model, then call the right API. Returns raw text.
export async function runViaProvider(prompt, { model } = {}, env = process.env) {
  guardPromptLength(prompt);
  const { provider, apiKey } = resolveProvider(env);
  const modelId = (model && String(model).trim()) || resolveModel(provider, env);
  if (provider === 'openai') return runOpenAI(prompt, { apiKey, model: modelId });
  if (provider === 'anthropic') return runAnthropic(prompt, { apiKey, model: modelId });
  return runCursor(prompt, { apiKey, model: modelId });
}
