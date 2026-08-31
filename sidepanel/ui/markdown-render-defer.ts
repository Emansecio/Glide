/** Plain-text length at or above which stream_stop defers markdown parse to idle time. */
export const MARKDOWN_DEFER_MIN_CHARS = 400;

export const MARKDOWN_IDLE_FALLBACK_MS = 48;

export function shouldDeferMarkdownRender(length: number): boolean {
  return length >= MARKDOWN_DEFER_MIN_CHARS;
}

export function normalizeMarkdownSource(source: string): string {
  return String(source ?? '').replace(/\r\n?/g, '\n');
}

/** Small stable digest used only to reconcile equivalent stream/final content. */
export function digestMarkdownSource(source: string): string {
  const normalized = normalizeMarkdownSource(source);
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${normalized.length}:${(hash >>> 0).toString(16)}`;
}

export type MarkdownIdleHandle = {
  kind: 'idle' | 'timeout';
  id: number;
};

export function scheduleMarkdownIdleWork(callback: () => void): MarkdownIdleHandle {
  if (typeof document !== 'undefined' && document.hidden) {
    return { kind: 'timeout', id: setTimeout(callback, MARKDOWN_IDLE_FALLBACK_MS) as unknown as number };
  }
  if (typeof requestIdleCallback === 'function') {
    return { kind: 'idle', id: requestIdleCallback(callback, { timeout: 500 }) as number };
  }
  return { kind: 'timeout', id: setTimeout(callback, MARKDOWN_IDLE_FALLBACK_MS) as unknown as number };
}

export function cancelMarkdownIdleWork(handle: MarkdownIdleHandle | null | undefined): void {
  if (!handle) return;
  if (handle.kind === 'idle' && typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(handle.id);
    return;
  }
  clearTimeout(handle.id);
}
