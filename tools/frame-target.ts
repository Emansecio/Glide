export type FrameInfo = {
  frameId: number;
  url: string;
  parentFrameId: number;
};

export type ResolveTargetFrameSuccess = {
  ok: true;
  frameId: number;
  frameUrl: string;
};

export type ResolveTargetFrameFailure = {
  ok: false;
  code: 'FRAME_NOT_FOUND' | 'FRAME_AMBIGUOUS' | 'FRAME_NOT_REACHABLE';
  error: string;
  candidates?: string[];
};

export type ResolveTargetFrameResult = ResolveTargetFrameSuccess | ResolveTargetFrameFailure;

export const FRAME_TARGET_TOOLS = [
  'click',
  'type',
  'wait',
  'findElement',
  'readPage',
  'pressKey',
  'selectOption',
  'highlightElement',
  'annotatedScreenshot',
  'elementScreenshot',
] as const;

export function absoluteFrameUrl(src: string, pageUrl: string): string {
  const trimmed = String(src || '').trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed, pageUrl).href;
  } catch {
    return trimmed;
  }
}

export function matchFramesByUrlSubstring(frames: FrameInfo[], needle: string): FrameInfo[] {
  const lower = String(needle || '')
    .trim()
    .toLowerCase();
  if (!lower) return [];
  return frames.filter((frame) => frame.url && frame.url.toLowerCase().includes(lower));
}

export function resolveTargetFrameId(frames: FrameInfo[], options: { frameUrl: string }): ResolveTargetFrameResult {
  const needle = String(options.frameUrl || '').trim();
  if (!needle) {
    return {
      ok: false,
      code: 'FRAME_NOT_FOUND',
      error: 'No frame URL to match.',
    };
  }

  const matches = matchFramesByUrlSubstring(frames, needle);
  if (matches.length === 0) {
    return {
      ok: false,
      code: 'FRAME_NOT_FOUND',
      error: `No frame matched URL substring "${needle}".`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'FRAME_AMBIGUOUS',
      error: `Multiple frames (${matches.length}) matched URL substring "${needle}". Refine frameUrl or use frameSelector.`,
      candidates: matches.map((frame) => frame.url),
    };
  }

  return {
    ok: true,
    frameId: matches[0].frameId,
    frameUrl: matches[0].url,
  };
}
