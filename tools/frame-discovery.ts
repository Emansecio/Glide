/**
 * Read-only frame probing for mutative tools. Discovery may scan all frames;
 * mutations must target a single resolved frameId.
 */

export type FrameInjectionHit = {
  frameId?: number;
  result?: unknown;
};

/** Injected into each frame — must stay self-contained (no closures). */
export function probeSelectorInFrame(selector: string): { found: boolean } {
  const sel = String(selector || '').trim();
  if (!sel) return { found: false };
  try {
    return { found: Boolean(document.querySelector(sel)) };
  } catch {
    return { found: false };
  }
}

export function pickFrameIdForSelectorProbe(results: FrameInjectionHit[] | null | undefined): number | null {
  if (!Array.isArray(results)) return null;
  for (const entry of results) {
    const payload = entry?.result as { found?: boolean } | null | undefined;
    if (payload?.found === true && typeof entry.frameId === 'number') {
      return entry.frameId;
    }
  }
  return null;
}
