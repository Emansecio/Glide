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
