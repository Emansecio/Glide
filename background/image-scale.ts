// Pure scale math for screenshot downscaling. Claude bills images by area
// (~tokens = width*height/750), so a HiDPI 2560x1600 capture costs ~5k tokens.
// Capping the longest side to maxDim cuts that dramatically with no readable-text
// loss for UI screenshots. Kept pure (no canvas) so it is unit-testable.
export type ClipRect = { x: number; y: number; width: number; height: number };
export type ViewportSize = { width: number; height: number };

/** Clamp element rect + padding to viewport bounds for screenshot cropping. */
export function computeClipRect(
  rect: { x: number; y: number; width: number; height: number },
  padding: number,
  viewport: ViewportSize,
): ClipRect {
  const pad = Math.max(0, Number(padding) || 0);
  const vw = Math.max(1, Math.round(Number(viewport.width) || 1));
  const vh = Math.max(1, Math.round(Number(viewport.height) || 1));

  let x = Math.floor(Number(rect.x) - pad);
  let y = Math.floor(Number(rect.y) - pad);
  let width = Math.ceil(Number(rect.width) + pad * 2);
  let height = Math.ceil(Number(rect.height) + pad * 2);

  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  if (x + width > vw) width = vw - x;
  if (y + height > vh) height = vh - y;

  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

/** True when an element rect overlaps the viewport (before or after padding). */
export function rectIntersectsViewport(
  rect: { x: number; y: number; width: number; height: number },
  viewport: ViewportSize,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const vw = Math.max(1, Number(viewport.width) || 1);
  const vh = Math.max(1, Number(viewport.height) || 1);
  return rect.x < vw && rect.y < vh && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

/** True when a clip region overlaps a captured bitmap (guards off-viewport 1×1 crops). */
export function clipIntersectsBitmap(clip: ClipRect, bitmap: ViewportSize): boolean {
  if (clip.width <= 0 || clip.height <= 0) return false;
  const bw = Math.max(1, Math.round(Number(bitmap.width) || 1));
  const bh = Math.max(1, Math.round(Number(bitmap.height) || 1));
  return clip.x < bw && clip.y < bh && clip.x + clip.width > 0 && clip.y + clip.height > 0;
}

export function computeDownscale(
  width: number,
  height: number,
  maxDim: number,
): { width: number; height: number; scaled: boolean } {
  const w = Number(width);
  const h = Number(height);
  const cap = Number(maxDim);
  const longest = Math.max(w, h);
  if (!Number.isFinite(longest) || longest <= 0 || !Number.isFinite(cap) || cap <= 0 || longest <= cap) {
    return { width: w, height: h, scaled: false };
  }
  const scale = cap / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scaled: true,
  };
}

/** Chunk size for base64 binary-string conversion (~32 KiB, safe for apply stack limits). */
const BASE64_CHUNK_SIZE = 0x8000;

/** True when capture dimensions exceed maxDim and would need canvas downscale + re-encode. */
export function needsScreenshotDownscale(width: number, height: number, maxDim: number): boolean {
  return computeDownscale(width, height, maxDim).scaled;
}

/** Build a base64 string from raw bytes without Array.from on each chunk. */
export function uint8ArrayToBase64(bytes: Uint8Array, chunkSize = BASE64_CHUNK_SIZE): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    binary += String.fromCharCode.apply(null, bytes.subarray(i, end) as unknown as number[]);
  }
  return btoa(binary);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return uint8ArrayToBase64(new Uint8Array(buffer));
}
