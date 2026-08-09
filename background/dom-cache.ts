export type DomCacheTool = 'getContent' | 'findElement';

export type DomCacheLookup = {
  tabId: number;
  tool: DomCacheTool;
  mode?: string;
  selector?: string;
  query?: string;
  maxChars?: number;
  maxItems?: number;
  maxResults?: number;
  /** findElement scope: auto | dialog | page */
  scope?: string;
  /** findElement fuzzy flag */
  fuzzy?: boolean;
  /** findElement deep scan (300 vs 80 cap) */
  deep?: boolean;
};

export type DomCacheEntry = DomCacheLookup & {
  timestamp: number;
  result: unknown;
};

export const buildDomCacheKey = (lookup: DomCacheLookup) =>
  [
    lookup.tabId,
    lookup.tool,
    lookup.mode || '',
    lookup.selector || '',
    lookup.query || '',
    lookup.maxChars ?? '',
    lookup.maxItems ?? '',
    lookup.maxResults ?? '',
    lookup.scope || '',
    lookup.fuzzy === undefined ? '' : lookup.fuzzy ? '1' : '0',
    lookup.deep === undefined ? '' : lookup.deep ? '1' : '0',
  ].join('|');

const buildCacheKey = buildDomCacheKey;
export const DEFAULT_DOM_CACHE_TTL_MS = 5_000;

export class DomCacheLru {
  private entries = new Map<string, DomCacheEntry>();

  constructor(
    private readonly maxSize = 32,
    private readonly ttlMs = DEFAULT_DOM_CACHE_TTL_MS,
  ) {}

  get(lookup: DomCacheLookup): unknown | null {
    const key = buildCacheKey(lookup);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    this.touch(key, entry);
    return entry.result;
  }

  set(lookup: DomCacheLookup, result: unknown) {
    const key = buildCacheKey(lookup);
    const entry: DomCacheEntry = {
      ...lookup,
      timestamp: Date.now(),
      result,
    };
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  invalidateTab(tabId: number) {
    for (const [key, entry] of this.entries) {
      if (entry.tabId === tabId) {
        this.entries.delete(key);
      }
    }
  }

  invalidateAll() {
    this.entries.clear();
  }

  private touch(key: string, entry: DomCacheEntry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}
