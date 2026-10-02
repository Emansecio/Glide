/** Plain-text length at or above which stream_stop defers markdown parse to idle time. */
export const MARKDOWN_DEFER_MIN_CHARS = 400;

const MARKDOWN_IDLE_FALLBACK_MS = 48;

export function shouldDeferMarkdownRender(length: number): boolean {
  return length >= MARKDOWN_DEFER_MIN_CHARS;
}

function normalizeMarkdownSource(source: string): string {
  return String(source ?? '').replace(/\r\n?/g, '\n');
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * End offset (exclusive) of the last complete markdown block in `source` after `from`: the
 * position right after a blank line that sits outside any code fence. Returns -1 when no new
 * block is complete. `from` must itself be a block boundary. Used to render finished
 * paragraphs while a response streams; the unfinished tail stays plain text.
 */
export function findMarkdownCommitBoundary(source: string, from = 0): number {
  let fenceChar = '';
  let boundary = -1;
  let lineStart = from;
  while (lineStart < source.length) {
    const lineEnd = source.indexOf('\n', lineStart);
    if (lineEnd < 0) break;
    const line = source.slice(lineStart, lineEnd);
    const fence = FENCE_LINE.exec(line);
    if (fence) {
      if (!fenceChar) fenceChar = fence[1][0];
      else if (fence[1][0] === fenceChar) fenceChar = '';
    } else if (!fenceChar && line.trim() === '') {
      boundary = lineEnd + 1;
    }
    lineStart = lineEnd + 1;
  }
  return boundary;
}

const TABLE_ROW_START = /^ {0,3}\|/;
const TABLE_DIVIDER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const TABLE_DIVIDER_PREFIX = /^[ \t|:-]*$/;

/**
 * Detects a GFM table still arriving in `open`, the unfinished tail of a streaming response.
 * Returns the complete lines received so far (`source` ends at the last newline) so the table
 * can be rendered row by row instead of showing raw `| a | b |` syntax; `lines` is 0 or 1 while
 * the header and divider are still incomplete. Returns null when the tail is not a table.
 */
export function findStreamingTable(open: string): { source: string; lines: number } | null {
  if (!TABLE_ROW_START.test(open)) return null;
  const end = open.lastIndexOf('\n');
  if (end < 0) return { source: '', lines: 0 };
  const lines = open.slice(0, end).split('\n');
  if (lines.length === 1) {
    return TABLE_DIVIDER_PREFIX.test(open.slice(end + 1)) ? { source: '', lines: 1 } : null;
  }
  if (!TABLE_DIVIDER.test(lines[1]) || lines.slice(2).some((line) => !line.includes('|'))) return null;
  return { source: open.slice(0, end + 1), lines: lines.length };
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
