/**
 * Ollama auto-detection — equivalent of `ollama list` via HTTP `/api/tags`.
 * (Chrome MV3 cannot shell out to the `ollama` CLI; the API is the supported path.)
 */

export type OllamaModelInfo = {
  /** Full model tag as used by the API (e.g. gemma4:31b-cloud). */
  name: string;
  /** Short digest id like `ollama list` ID column (first 12 hex chars). */
  id: string;
  /** Raw size in bytes when known (cloud tags may report tiny placeholder sizes). */
  size: number;
  /** Human size label: "4.7 GB", "—", etc. */
  sizeLabel: string;
  /** ISO modified_at when provided. */
  modifiedAt: string;
  /** Relative label: "9 seconds ago", "About a minute ago". */
  modifiedLabel: string;
  /** True when the tag looks like an Ollama cloud/remote model. */
  isCloud: boolean;
  parameterSize?: string;
  family?: string;
};

export type OllamaProbeResult = {
  online: boolean;
  endpoint: string;
  models: OllamaModelInfo[];
  /** Convenience: model names only (same order as `ollama list`). */
  modelNames: string[];
  error?: string;
  latencyMs: number;
};

const DEFAULT_ENDPOINTS = ['http://localhost:11434', 'http://127.0.0.1:11434'];

export function formatOllamaSize(bytes: number, isCloud = false): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  // Cloud registry entries often ship a tiny placeholder size; treat tiny values as unknown.
  if (isCloud && bytes < 1024 * 1024) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Prefer compact labels: 1 KB, 4.7 GB, 512 B
  const digits = Number.isInteger(value) || value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 1;
  const rounded = digits === 0 ? Math.round(value) : Number(value.toFixed(digits));
  return `${rounded} ${units[unit]}`;
}

export function formatOllamaModified(isoOrMs: string | number, now = Date.now()): string {
  let ms = 0;
  if (typeof isoOrMs === 'number') ms = isoOrMs;
  else {
    const parsed = Date.parse(String(isoOrMs || ''));
    if (!Number.isFinite(parsed)) return '—';
    ms = parsed;
  }
  const delta = Math.max(0, now - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return sec <= 1 ? 'Just now' : `${sec} seconds ago`;
  const min = Math.floor(sec / 60);
  if (min < 90) return min === 1 ? 'About a minute ago' : `${min} minutes ago`;
  const hr = Math.floor(min / 60);
  if (hr < 36) return hr === 1 ? 'About an hour ago' : `${hr} hours ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return day === 1 ? '1 day ago' : `${day} days ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return month === 1 ? 'About a month ago' : `${month} months ago`;
  const year = Math.floor(day / 365);
  return year <= 1 ? 'About a year ago' : `${year} years ago`;
}

export function shortDigestId(digest: string): string {
  const raw = String(digest || '').replace(/^sha256:/i, '');
  if (!raw) return '—';
  return raw.slice(0, 12);
}

type RawOllamaTag = {
  name?: string;
  model?: string;
  size?: number;
  digest?: string;
  modified_at?: string;
  details?: {
    parameter_size?: string;
    family?: string;
    families?: string[] | null;
  };
  remote_model?: string;
  remote_host?: string;
};

/**
 * Parse `/api/tags` JSON into `ollama list`-style rows.
 * Pure — safe for unit tests without network.
 */
export function parseOllamaTagsPayload(data: unknown, now = Date.now()): OllamaModelInfo[] {
  const list = Array.isArray((data as { models?: unknown })?.models)
    ? ((data as { models: RawOllamaTag[] }).models as RawOllamaTag[])
    : [];

  const rows: OllamaModelInfo[] = [];
  for (const entry of list) {
    const name = String(entry?.name || entry?.model || '').trim();
    if (!name) continue;
    const isCloud =
      name.includes(':cloud') ||
      Boolean(entry?.remote_host) ||
      Boolean(entry?.remote_model);
    const size = typeof entry?.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0;
    const modifiedAt = String(entry?.modified_at || '');
    const family =
      String(entry?.details?.family || '').trim() ||
      (Array.isArray(entry?.details?.families) ? String(entry.details.families[0] || '') : '');
    rows.push({
      name,
      id: shortDigestId(String(entry?.digest || '')),
      size,
      sizeLabel: formatOllamaSize(size, isCloud),
      modifiedAt,
      modifiedLabel: modifiedAt ? formatOllamaModified(modifiedAt, now) : '—',
      isCloud,
      parameterSize: String(entry?.details?.parameter_size || '').trim() || undefined,
      family: family || undefined,
    });
  }

  // Match CLI: newest first when modified_at is available.
  rows.sort((a, b) => {
    const am = Date.parse(a.modifiedAt) || 0;
    const bm = Date.parse(b.modifiedAt) || 0;
    return bm - am;
  });
  return rows;
}

export function normalizeOllamaBaseUrl(customEndpoint?: string): string {
  const raw = String(customEndpoint || '').trim();
  if (!raw) return DEFAULT_ENDPOINTS[0];
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    // Strip trailing /v1 used by OpenAI-compatible clients.
    url.pathname = url.pathname.replace(/\/v1\/?$/i, '').replace(/\/+$/, '') || '';
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return DEFAULT_ENDPOINTS[0];
  }
}

function candidateEndpoints(customEndpoint?: string): string[] {
  const primary = normalizeOllamaBaseUrl(customEndpoint);
  const set = new Set<string>([primary, ...DEFAULT_ENDPOINTS]);
  return Array.from(set);
}

async function fetchTags(base: string, timeoutMs: number): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, data: await response.json() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/**
 * Probe Ollama availability and list installed/cloud models (like `ollama list`).
 * Tries the custom endpoint first, then localhost / 127.0.0.1 defaults.
 */
export async function probeOllama(options: {
  customEndpoint?: string;
  timeoutMs?: number;
  now?: number;
} = {}): Promise<OllamaProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const now = options.now ?? Date.now();
  const started = Date.now();
  const endpoints = candidateEndpoints(options.customEndpoint);
  let lastError = 'Ollama unreachable';

  for (const endpoint of endpoints) {
    const result = await fetchTags(endpoint, timeoutMs);
    if (!result.ok) {
      lastError = result.error;
      continue;
    }
    const models = parseOllamaTagsPayload(result.data, now);
    return {
      online: true,
      endpoint,
      models,
      modelNames: models.map((m) => m.name),
      latencyMs: Date.now() - started,
    };
  }

  return {
    online: false,
    endpoint: endpoints[0],
    models: [],
    modelNames: [],
    error: lastError,
    latencyMs: Date.now() - started,
  };
}

/** One-line summary similar to the CLI header. */
export function formatOllamaListSummary(probe: OllamaProbeResult): string {
  if (!probe.online) return `Ollama offline (${probe.error || 'unreachable'})`;
  if (!probe.models.length) return `Ollama online @ ${probe.endpoint} — no models (run: ollama pull <name>)`;
  return `Ollama online · ${probe.models.length} model${probe.models.length === 1 ? '' : 's'} @ ${probe.endpoint}`;
}
