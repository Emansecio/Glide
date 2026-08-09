/** Plain-text length at or above which stream_stop defers markdown parse to idle time. */
export const MARKDOWN_DEFER_MIN_CHARS = 400;

export const MARKDOWN_IDLE_FALLBACK_MS = 48;

export function shouldDeferMarkdownRender(length: number): boolean {
  return length >= MARKDOWN_DEFER_MIN_CHARS;
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
