export type CompactPreset = 'telemetry' | 'history';

type CompactLimits = {
  stringDefault: number;
  stringError: number;
  stringHint: number;
  stringContent: number;
  stringHtml: number;
  maxArrayRoot: number;
  maxArrayNested: number;
  maxObjectRoot: number;
  maxObjectNested: number;
  maxDepth: number;
};

const PRESETS: Record<CompactPreset, CompactLimits> = {
  telemetry: {
    stringDefault: 180,
    stringError: 180,
    stringHint: 180,
    stringContent: 180,
    stringHtml: 180,
    maxArrayRoot: 20,
    maxArrayNested: 8,
    maxObjectRoot: 20,
    maxObjectNested: 20,
    maxDepth: 2,
  },
  history: {
    stringDefault: 700,
    stringError: 320,
    stringHint: 420,
    stringContent: 1800,
    stringHtml: 1200,
    maxArrayRoot: 20,
    maxArrayNested: 10,
    maxObjectRoot: 16,
    maxObjectNested: 10,
    maxDepth: 2,
  },
};

function trimText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function isSensitiveKey(key: string): boolean {
  const normalized = String(key || '').toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('apikey') ||
    normalized.includes('api_key') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('authorization') ||
    normalized.includes('credential') ||
    normalized.includes('cookie') ||
    normalized.includes('csrf') ||
    normalized.includes('xsrf')
  );
}

function trimStringForKey(value: string, key: string, limits: CompactLimits, preset: CompactPreset): string {
  const keyLower = key.toLowerCase();
  if (preset === 'history') {
    if (isSensitiveKey(keyLower)) return `<redacted:${value.length} chars>`;
    if (keyLower.includes('dataurl')) return `<redacted:${value.length} chars>`;
    if (keyLower.includes('error')) return trimText(value, limits.stringError);
    if (keyLower.includes('hint')) return trimText(value, limits.stringHint);
    if (keyLower.includes('content')) return trimText(value, limits.stringContent);
    if (keyLower.includes('html') || keyLower.includes('markdown')) return trimText(value, limits.stringHtml);
  } else if (isSensitiveKey(keyLower)) {
    return `<redacted:${value.length} chars>`;
  }
  return trimText(value, limits.stringDefault);
}

// Memo cache: WeakMap for object references (por preset — a mesma referência
// compactada como 'telemetry' e depois como 'history' tem limites distintos e
// não pode reaproveitar o resultado), LRU for primitives.
const _memoCache = new WeakMap<object, Partial<Record<CompactPreset, unknown>>>();
const _primCache = new Map<string, { ts: number; value: unknown }>();
const PRIM_CACHE_MAX = 64;

function _memoKey(value: unknown, preset: CompactPreset, key: string, depth: number): string | null {
  if (typeof value === 'string' && value.length <= 200) return `${preset}|${depth}|${key}|${value}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${preset}|${depth}|${key}|${String(value)}`;
  return null;
}

export function compactValue(value: unknown, preset: CompactPreset, key = '', depth = 0): unknown {
  // Object reference cache hit
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const cached = _memoCache.get(value as object)?.[preset];
    if (cached !== undefined) return cached;
  }
  // Primitive cache hit
  const sk = _memoKey(value, preset, key, depth);
  if (sk) {
    const hit = _primCache.get(sk);
    if (hit) {
      hit.ts = Date.now();
      return hit.value;
    }
  }

  const limits = PRESETS[preset];
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return trimStringForKey(value, key, limits, preset);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  let result: unknown;

  if (Array.isArray(value)) {
    const maxItems = depth === 0 ? limits.maxArrayRoot : limits.maxArrayNested;
    result = value.slice(0, maxItems).map((item) => compactValue(item, preset, '', depth + 1));
  } else if (typeof value === 'object') {
    if (depth >= limits.maxDepth) {
      result = '[omitted]';
    } else {
      const source = value as Record<string, unknown>;
      const entries = Object.entries(source);
      const maxEntries = depth === 0 ? limits.maxObjectRoot : limits.maxObjectNested;
      const compacted: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of entries.slice(0, maxEntries)) {
        if (nestedKey === 'dataUrl' && typeof nestedValue === 'string' && preset === 'telemetry') {
          compacted[nestedKey] = `<dataUrl:${nestedValue.length} chars>`;
        } else {
          compacted[nestedKey] = compactValue(nestedValue, preset, nestedKey, depth + 1);
        }
      }
      if (preset === 'history' && entries.length > maxEntries) {
        compacted.truncatedFieldCount = entries.length - maxEntries;
      }
      result = compacted;
    }
  } else {
    result = String(value);
  }

  // Populate caches at depth 0 only (consumers call compactValue on root objects)
  if (depth === 0) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const slot = _memoCache.get(value as object) ?? {};
      slot[preset] = result;
      _memoCache.set(value as object, slot);
    }
    if (sk && result !== undefined) {
      if (_primCache.size >= PRIM_CACHE_MAX) {
        const oldest = _primCache.keys().next().value;
        if (oldest) _primCache.delete(oldest);
      }
      _primCache.set(sk, { ts: Date.now(), value: result });
    }
  }

  return result;
}
