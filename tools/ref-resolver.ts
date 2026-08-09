/** Scope for readPage-style ref resolution. */
export type ReadPageRefScope = 'auto' | 'page' | 'dialog';

const DIALOG_SEL = '[role="dialog"], [aria-modal="true"], div[role="dialog"]';
const INTERACTIVE =
  'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [contenteditable="true"], [tabindex="0"]';
const LANDMARKS = 'main, nav, header, footer, h1, h2, h3, [role="navigation"], [role="main"]';

/**
 * Self-contained ref resolver for executeScript injection and content scripts.
 * Mirrors readPage element collection: dialog auto-scope, shadow DOM, dedup, visibility,
 * optional landmarks when interactiveOnly is false.
 */
export function resolveReadPageRef(
  ref: string,
  scope: ReadPageRefScope = 'auto',
  interactiveOnly = true,
): HTMLElement | null {
  const normalizedRef = String(ref || '')
    .trim()
    .toLowerCase();
  if (!/^e\d+$/.test(normalizedRef)) return null;
  const targetIndex = Number.parseInt(normalizedRef.slice(1), 10);
  if (!Number.isFinite(targetIndex) || targetIndex < 1) return null;

  const isVisible = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  let root: Document | Element = document;
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SEL)).filter(isVisible);
  if (scope === 'dialog' || (scope === 'auto' && dialogs.length)) {
    root = dialogs[dialogs.length - 1] || document;
  }

  const collected: HTMLElement[] = [];
  let shadowScanned = 0;
  const walkShadowHosts = (base: Document | ShadowRoot | Element, visitShadow: (shadow: ShadowRoot) => void) => {
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_ELEMENT);
    let current = walker.nextNode() as HTMLElement | null;
    while (current && shadowScanned < 4000) {
      shadowScanned += 1;
      if (current.shadowRoot) visitShadow(current.shadowRoot);
      current = walker.nextNode() as HTMLElement | null;
    }
  };
  const visit = (base: Document | Element | ShadowRoot) => {
    if (collected.length >= targetIndex * 2) return;
    for (const el of Array.from(base.querySelectorAll<HTMLElement>(INTERACTIVE))) {
      collected.push(el);
      if (collected.length >= targetIndex * 2) return;
    }
    if (!interactiveOnly) {
      for (const el of Array.from(base.querySelectorAll<HTMLElement>(LANDMARKS))) {
        collected.push(el);
      }
    }
    walkShadowHosts(base, visit);
  };
  visit(root);

  const seen = new Set<HTMLElement>();
  let idx = 0;
  for (const el of collected) {
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    idx += 1;
    if (idx === targetIndex) return el;
  }
  return null;
}

/** Injected helper: measure an element for visible-tab screenshot cropping. */
export function measureScreenshotTarget(
  sel: string,
  refId: string,
  scope: ReadPageRefScope = 'auto',
  interactiveOnly = true,
): {
  success: boolean;
  code?: string;
  error?: string;
  selector?: string;
  ref?: string;
  rect?: { x: number; y: number; width: number; height: number };
  viewport?: { width: number; height: number };
} {
  const deepQuery = (query: string): HTMLElement | null => {
    if (!query.includes('>>>')) {
      try {
        return document.querySelector(query);
      } catch {
        return null;
      }
    }
    const parts = query
      .split('>>>')
      .map((p) => p.trim())
      .filter(Boolean);
    let root: Document | ShadowRoot | Element = document;
    for (let i = 0; i < parts.length; i++) {
      let next: Element | null = null;
      try {
        next = root.querySelector(parts[i]);
      } catch {
        return null;
      }
      if (!next) return null;
      if (i === parts.length - 1) return next as HTMLElement;
      if (!(next as HTMLElement).shadowRoot) return null;
      root = (next as HTMLElement).shadowRoot!;
    }
    return null;
  };
  const isVisible = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  let target: HTMLElement | null = null;
  if (sel) target = deepQuery(sel);
  else if (refId) target = resolveReadPageRef(refId, scope, interactiveOnly);
  if (!target || !isVisible(target)) {
    return { success: false, code: 'ELEMENT_NOT_FOUND', error: 'Element screenshot target not found.' };
  }
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = target.getBoundingClientRect();
  return {
    success: true,
    selector: sel || undefined,
    ref: refId || undefined,
    rect: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
}

/** Injected helper: highlight an element resolved by selector or readPage ref. */
export function highlightTargetOverlay(
  sel: string,
  refId: string,
  duration: number,
  scope: ReadPageRefScope = 'auto',
  interactiveOnly = true,
): {
  success: boolean;
  code?: string;
  error?: string;
  selector?: string;
  ref?: string;
  durationMs?: number;
  box?: { x: number; y: number; width: number; height: number };
} {
  const deepQuery = (query: string): HTMLElement | null => {
    try {
      return document.querySelector(query);
    } catch {
      return null;
    }
  };
  const isVisible = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  let target: HTMLElement | null = null;
  if (sel) target = deepQuery(sel);
  else if (refId) target = resolveReadPageRef(refId, scope, interactiveOnly);
  if (!target || !isVisible(target)) {
    return { success: false, code: 'ELEMENT_NOT_FOUND', error: 'Highlight target not found.' };
  }
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = target.getBoundingClientRect();
  const pad = 3;
  const clampedDuration = Math.min(5000, Math.max(200, duration));
  const overlay = document.createElement('div');
  overlay.setAttribute('data-glide-highlight', '1');
  overlay.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:2147483646',
    'box-sizing:border-box',
    'border:2px solid #2f6feb',
    'border-radius:6px',
    'opacity:0',
    'transform:scale(0.98)',
    'transition:opacity 180ms ease-out, transform 180ms ease-out',
    `left:${Math.round(rect.left - pad)}px`,
    `top:${Math.round(rect.top - pad)}px`,
    `width:${Math.round(rect.width + pad * 2)}px`,
    `height:${Math.round(rect.height + pad * 2)}px`,
  ].join(';');
  if (refId) {
    const badge = document.createElement('span');
    badge.textContent = refId;
    badge.style.cssText =
      'position:absolute;top:-10px;left:8px;padding:1px 6px;font:600 11px/16px system-ui,sans-serif;color:#fff;background:#2f6feb;border-radius:4px;transform:translateY(-100%)';
    overlay.appendChild(badge);
  }
  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    overlay.style.transform = 'scale(1)';
  });
  window.setTimeout(() => {
    overlay.style.opacity = '0';
    overlay.style.transform = 'scale(1.01)';
    window.setTimeout(() => overlay.remove(), 180);
  }, clampedDuration);
  return {
    success: true,
    selector: sel || undefined,
    ref: refId || undefined,
    durationMs: clampedDuration,
    box: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

/** Pure helper: assign e1..eN refs to an ordered element id list (for unit tests). */
export function assignReadPageRefs(elementIds: string[], _interactiveOnly = true): Map<string, string> {
  const refs = new Map<string, string>();
  let idx = 0;
  const seen = new Set<string>();
  for (const id of elementIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    idx += 1;
    refs.set(id, `e${idx}`);
  }
  return refs;
}
