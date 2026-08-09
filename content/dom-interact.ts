/**
 * Shared DOM interaction helpers for content-bridge + page automation.
 * Tuned for SPAs (Instagram-style): role=button divs, portals, dialogs, fixed overlays.
 */

export const DIALOG_SELECTOR =
  '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i], [class*="Dialog" i], [class*="modal" i]';

export const CLICKABLE_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="reset"]',
  '[onclick]',
  '[tabindex="0"]',
].join(', ');

/** Broader target set for hover/mouse (includes labeled controls, not only clickables). */
export const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
  'label',
  '[aria-label]',
  '[title]',
  '[data-testid]',
  '[onclick]',
  '[tabindex="0"]',
].join(', ');

export const CLOSE_BUTTON_SELECTOR = [
  'button[aria-label*="close" i]',
  'button[aria-label*="fechar" i]',
  'button[aria-label*="dismiss" i]',
  '[role="button"][aria-label*="close" i]',
  '[role="button"][aria-label*="fechar" i]',
  '[aria-label="Close"]',
  '[aria-label="Fechar"]',
  'button[aria-label="Close"]',
  'svg[aria-label="Close"]',
  'svg[aria-label="Fechar"]',
].join(', ');

export const normalizeText = (value: string) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

export const isVisible = (element: HTMLElement): boolean => {
  if (!element || element.hidden) return false;
  if ((element as HTMLInputElement).type === 'hidden') return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;

  // Cheap Chrome path: checkVisibility avoids most getComputedStyle walks.
  const checkVisibility = (
    element as HTMLElement & {
      checkVisibility?: (options?: {
        checkOpacity?: boolean;
        checkVisibilityCSS?: boolean;
        contentVisibilityAuto?: boolean;
      }) => boolean;
    }
  ).checkVisibility;
  if (typeof checkVisibility === 'function') {
    try {
      if (
        !checkVisibility.call(element, {
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      ) {
        return false;
      }
      // Still require non-zero box (some sticky/fixed edge cases).
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      // Fall through to manual path.
    }
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  // Fixed/sticky Instagram dialogs often have offsetParent === null while still visible.
  if (element.offsetParent === null) {
    const style = window.getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'sticky') {
      // Still allow if in a fixed ancestor (common for portals).
      let parent: HTMLElement | null = element.parentElement;
      let fixedAncestor = false;
      while (parent && parent !== document.body) {
        const ps = window.getComputedStyle(parent);
        if (ps.position === 'fixed' || ps.position === 'sticky') {
          fixedAncestor = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!fixedAncestor) return false;
    }
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  } else {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return true;
};

export const deepQuerySelector = <T extends Element = HTMLElement>(
  query: string,
  root: Document | ShadowRoot | Element = document,
): T | null => {
  if (!query) return null;
  if (!query.includes('>>>')) {
    try {
      return root.querySelector<T>(query);
    } catch {
      return null;
    }
  }
  const parts = query
    .split('>>>')
    .map((part) => part.trim())
    .filter(Boolean);
  let current: Document | ShadowRoot | Element = root;
  for (let index = 0; index < parts.length; index += 1) {
    let next: Element | null = null;
    try {
      next = current.querySelector(parts[index]);
    } catch {
      return null;
    }
    if (!next) return null;
    if (index === parts.length - 1) return next as T;
    const shadow = (next as HTMLElement).shadowRoot;
    if (!shadow) return null;
    current = shadow;
  }
  return null;
};

/** Safety TTL when MutationObserver events may be missed. */
const SHADOW_HOST_CACHE_SAFETY_TTL_MS = 5000;
const shadowHostCache = new WeakMap<object, { epoch: number; at: number; hosts: HTMLElement[] }>();
let shadowHostCacheEpoch = 0;
let shadowHostObserver: MutationObserver | null = null;
let shadowHostObserverConnected = false;

/** Pure: cache entry is stale when epoch bumped or safety TTL elapsed. */
export const isShadowHostCacheStale = (
  cachedEpoch: number,
  currentEpoch: number,
  cachedAt: number,
  now: number,
  safetyTtlMs = SHADOW_HOST_CACHE_SAFETY_TTL_MS,
): boolean => cachedEpoch !== currentEpoch || now - cachedAt >= safetyTtlMs;

const ensureShadowHostObserver = () => {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  if (shadowHostObserver) return;
  shadowHostObserver = new MutationObserver(() => {
    shadowHostCacheEpoch += 1;
  });
  const connect = () => {
    if (shadowHostObserverConnected || !shadowHostObserver) return;
    try {
      shadowHostObserver.observe(document.documentElement, { childList: true, subtree: true });
      shadowHostObserverConnected = true;
    } catch {
      // ignore
    }
  };
  const disconnect = () => {
    if (!shadowHostObserverConnected || !shadowHostObserver) return;
    shadowHostObserver.disconnect();
    shadowHostObserverConnected = false;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') disconnect();
    else connect();
  });
  if (document.visibilityState !== 'hidden') connect();
};

/**
 * List elements with open shadowRoot under `root`.
 * Invalidates lazily via MutationObserver (childList) + 5s safety TTL.
 */
export const listOpenShadowHosts = (
  root: Document | ShadowRoot | Element,
  options?: { forceRefresh?: boolean },
): HTMLElement[] => {
  ensureShadowHostObserver();
  const cacheKey = root as object;
  const cached = shadowHostCache.get(cacheKey);
  const now = Date.now();
  if (!options?.forceRefresh && cached && !isShadowHostCacheStale(cached.epoch, shadowHostCacheEpoch, cached.at, now)) {
    return cached.hosts;
  }

  const hosts: HTMLElement[] = [];
  try {
    const all = root.querySelectorAll<HTMLElement>('*');
    for (let i = 0; i < all.length; i += 1) {
      if (all[i].shadowRoot) hosts.push(all[i]);
    }
  } catch {
    // ignore
  }

  shadowHostCache.set(cacheKey, { epoch: shadowHostCacheEpoch, at: now, hosts });
  return hosts;
};

export type CollectElementsOptions = {
  /** When false, do not pierce open shadow roots (faster for light-DOM dialogs). Default true. */
  pierceShadow?: boolean;
};

export const collectElements = <T extends Element>(
  query: string,
  root: Document | ShadowRoot | Element = document,
  max = 400,
  options?: CollectElementsOptions,
): T[] => {
  const pierceShadow = options?.pierceShadow !== false;
  const results: T[] = [];
  const visit = (node: Document | ShadowRoot | Element) => {
    if (results.length >= max) return;
    let matches: Element[] = [];
    try {
      matches = Array.from(node.querySelectorAll(query));
    } catch {
      return;
    }
    for (const element of matches) {
      results.push(element as T);
      if (results.length >= max) return;
    }
    if (!pierceShadow) return;
    const hosts = listOpenShadowHosts(node);
    for (const host of hosts) {
      if (results.length >= max) return;
      if (host.shadowRoot) visit(host.shadowRoot);
    }
  };
  visit(root);
  return results;
};

/** Collect up to `limit` matches without materializing the full NodeList into an array first. */
export const queryLimited = <T extends Element>(root: ParentNode, selector: string, limit: number): T[] => {
  const out: T[] = [];
  if (limit <= 0) return out;
  let matches: NodeListOf<Element>;
  try {
    matches = root.querySelectorAll(selector);
  } catch {
    return out;
  }
  const cap = Math.min(limit, matches.length);
  for (let i = 0; i < cap; i += 1) {
    out.push(matches[i] as T);
  }
  return out;
};

/** Approximate JSON size of a shallow object without full stringify (budget tracking). */
export const approxJsonBytes = (value: unknown): number => {
  if (value == null) return 4;
  if (typeof value === 'string') return value.length + 2;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Array.isArray(value)) {
    let n = 2;
    for (let i = 0; i < value.length; i += 1) {
      n += approxJsonBytes(value[i]) + (i > 0 ? 1 : 0);
    }
    return n;
  }
  if (typeof value === 'object') {
    let n = 2;
    let first = true;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      n += k.length + 3 + approxJsonBytes(v) + (first ? 0 : 1);
      first = false;
    }
    return n;
  }
  return 8;
};

export type DialogInfo = {
  selector: string;
  label: string;
  open: boolean;
};

const buildLocalSelector = (element: Element, options: { includePlaceholder?: boolean } = {}): string => {
  const el = element as HTMLElement;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  // Prefer stable href over Instagram utility classes (.x1i10hfl …).
  const href = el.getAttribute('href');
  if (href && (el.tagName === 'A' || el.getAttribute('role') === 'link')) {
    // Prefer path-only match for long profile URLs.
    if (href.includes('/following')) return 'a[href*="/following"]';
    if (href.includes('/followers')) return 'a[href*="/followers"]';
    return `a[href="${CSS.escape(href)}"]`;
  }
  const name = el.getAttribute('name');
  if (name) return `[name="${CSS.escape(name)}"]`;
  const aria = el.getAttribute('aria-label');
  if (aria) return `[aria-label="${CSS.escape(aria)}"]`;
  if (options.includePlaceholder) {
    const placeholder = (el as HTMLInputElement).placeholder;
    if (placeholder) return `[placeholder="${CSS.escape(placeholder)}"]`;
  }
  const role = el.getAttribute('role');
  if (role === 'dialog' || el.getAttribute('aria-modal') === 'true') {
    return `${el.tagName.toLowerCase()}[role="dialog"]`;
  }
  // Skip pure Instagram/React hashed utility classes (x + alnum) — they collide site-wide.
  const cls = Array.from(el.classList).find(
    (c) => /^[a-z][a-z0-9_-]{2,40}$/i.test(c) && !/[0-9]{5,}/.test(c) && !/^x[a-z0-9]{4,}$/i.test(c),
  );
  if (cls) return `.${cls}`;
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (parent) {
    // nth-of-type conta só o mesmo tag; nth-child conta todos os filhos — o
    // índice por-tag com nth-child apontava para o nó errado com irmãos mistos.
    const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    const index = siblings.indexOf(el) + 1;
    return `${tag}:nth-of-type(${index})`;
  }
  return tag;
};

export const listOpenDialogs = (): DialogInfo[] => {
  const nodes = collectElements<HTMLElement>(DIALOG_SELECTOR, document, 20);
  const dialogs: DialogInfo[] = [];
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const label = normalizeText(
      el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') ||
        el.querySelector('h1, h2, h3, [role="heading"]')?.textContent ||
        '',
    ).slice(0, 120);
    dialogs.push({
      selector: buildLocalSelector(el),
      label: label || 'dialog',
      open: true,
    });
  }
  return dialogs;
};

export const getPreferredSearchRoot = (scope: 'auto' | 'page' | 'dialog' = 'auto'): Document | Element => {
  if (scope === 'page') return document;
  const dialogs = collectElements<HTMLElement>(DIALOG_SELECTOR, document, 12).filter(isVisible);
  if (scope === 'dialog') {
    return dialogs[0] || document;
  }
  // auto: prefer the topmost (last in DOM / highest z) open dialog
  if (dialogs.length > 0) {
    return dialogs[dialogs.length - 1];
  }
  return document;
};

export const performRichClick = (
  element: HTMLElement,
): {
  success: true;
  strategy: string;
  coordinates: { x: number; y: number };
  targetTag: string;
  matched: string;
} => {
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const rect = element.getBoundingClientRect();
  const clientX = Math.round(rect.left + Math.min(rect.width / 2, Math.max(4, rect.width - 4)));
  const clientY = Math.round(rect.top + Math.min(rect.height / 2, Math.max(4, rect.height - 4)));

  // If an overlay sits on top, prefer the topmost clickable under the point when it's
  // inside the same dialog/container — otherwise click the intended element.
  const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  let eventTarget = element;
  if (hit instanceof HTMLElement) {
    if (hit === element || element.contains(hit) || hit.contains(element)) {
      eventTarget = (hit.closest(CLICKABLE_SELECTOR) as HTMLElement | null) || hit;
    } else {
      // Overlay intercept: still fire on intended element (Instagram often layers transparent divs).
      eventTarget = element;
    }
  }

  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
  };

  try {
    eventTarget.focus?.({ preventScroll: true });
  } catch {
    eventTarget.focus?.();
  }

  if (typeof PointerEvent !== 'undefined') {
    eventTarget.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse' }));
  }
  eventTarget.dispatchEvent(new MouseEvent('mousedown', eventInit));
  if (typeof PointerEvent !== 'undefined') {
    eventTarget.dispatchEvent(
      new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse', buttons: 0 }),
    );
  }
  eventTarget.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
  eventTarget.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
  // Native click as last resort for non-React handlers
  try {
    eventTarget.click();
  } catch {
    // ignore
  }

  return {
    success: true,
    strategy: 'rich-click',
    coordinates: { x: clientX, y: clientY },
    targetTag: eventTarget.tagName.toLowerCase(),
    matched: normalizeText(
      element.getAttribute('aria-label') || element.textContent || element.getAttribute('href') || '',
    ).slice(0, 100),
  };
};

/**
 * Instagram / social profile stats: "154 seguindo", "174 seguidores", "following".
 * Prefer stable href targets over ephemeral classes (.x1i10hfl).
 */
export const resolveProfileStatLink = (query: string, root: Document | Element = document): HTMLElement | null => {
  const needle = normalizeText(query).toLowerCase();
  if (!needle) return null;

  const wantsFollowing =
    (/\b(seguindo|following)\b/.test(needle) || /\/following\b/.test(needle)) &&
    !/\b(seguidores|followers)\b/.test(needle);
  const wantsFollowers = /\b(seguidores|followers)\b/.test(needle) || /\/followers\b/.test(needle);
  if (!wantsFollowing && !wantsFollowers) return null;

  const hrefNeedle = wantsFollowing ? '/following' : '/followers';
  // Direct anchors (most reliable on Instagram profile header).
  const anchors = collectElements<HTMLAnchorElement>('a[href]', root, 200).filter(isVisible);
  const hrefHits = anchors.filter((a) => {
    const href = (a.getAttribute('href') || '').toLowerCase();
    // Match /user/following/ but not /user/following/xyz edge cases if needed
    return href.includes(hrefNeedle);
  });
  if (hrefHits.length === 1) return hrefHits[0];
  if (hrefHits.length > 1) {
    // Prefer header/profile-ish short labels over footer/nav noise.
    hrefHits.sort((a, b) => {
      const ta = normalizeText(a.textContent || '').length;
      const tb = normalizeText(b.textContent || '').length;
      return ta - tb;
    });
    return hrefHits[0];
  }

  // role=link without classic a[href] (rare)
  const roleLinks = collectElements<HTMLElement>('[role="link"]', root, 100).filter(isVisible);
  for (const el of roleLinks) {
    const href = (el.getAttribute('href') || el.getAttribute('data-testid') || '').toLowerCase();
    const text = normalizeText(el.textContent || '').toLowerCase();
    if (
      href.includes(hrefNeedle) ||
      (wantsFollowing && text.includes('seguindo')) ||
      (wantsFollowers && text.includes('seguidores'))
    ) {
      return el;
    }
  }
  return null;
};

export const findClickableByText = (query: string, root: Document | Element = document): HTMLElement | null => {
  const needle = normalizeText(query).toLowerCase();
  if (!needle) return null;

  // Profile stats first — "154 seguindo" must not lose to a random .x* class match elsewhere.
  const stat = resolveProfileStatLink(needle, root);
  if (stat) return stat;

  const candidates = collectElements<HTMLElement>(CLICKABLE_SELECTOR, root, 300).filter(isVisible);
  // Strip leading counts so "154 seguindo" also matches label-only nodes ("seguindo").
  const labelOnly = needle.replace(/^[\d.,\s]+/, '').trim();
  const tokens = needle.split(/\s+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t));

  // Prefer exact / prefix matches on short labels (Instagram "seguidores", "followers").
  const scored: Array<{ el: HTMLElement; score: number }> = [];
  for (const el of candidates) {
    const text = normalizeText(el.textContent || '').toLowerCase();
    const aria = normalizeText(el.getAttribute('aria-label') || '').toLowerCase();
    const title = normalizeText(el.getAttribute('title') || '').toLowerCase();
    const href = normalizeText(el.getAttribute('href') || '').toLowerCase();
    const fields = [aria, title, text.slice(0, 120), href];
    let score = 0;
    for (const field of fields) {
      if (!field) continue;
      if (field === needle) score = Math.max(score, 100);
      else if (labelOnly && field === labelOnly) score = Math.max(score, 95);
      else if (field.startsWith(needle) || (labelOnly && field.startsWith(labelOnly))) score = Math.max(score, 80);
      else if (field.includes(needle) || (labelOnly && labelOnly.length >= 4 && field.includes(labelOnly))) {
        score = Math.max(score, 70);
      }
      // Instagram profile stats often put the count + label in the same node ("123 seguidores")
      else if (needle.length >= 4 && field.split(/\s+/).some((w) => w === needle || w.includes(needle))) {
        score = Math.max(score, 65);
      } else if (tokens.length >= 1 && tokens.every((t) => field.includes(t))) {
        score = Math.max(score, 75);
      }
    }
    // Strong boost for stable social hrefs when the query is about that list.
    if (href.includes('/following') && (needle.includes('seguindo') || needle.includes('following'))) {
      score = Math.max(score, 110);
    }
    if (href.includes('/followers') && (needle.includes('seguidores') || needle.includes('followers'))) {
      score = Math.max(score, 110);
    }
    if (score > 0) scored.push({ el, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.el || null;
};

export const findCloseControl = (dialog?: Element | null): HTMLElement | null => {
  const root = dialog || getPreferredSearchRoot('dialog');
  const candidates = collectElements<HTMLElement>(CLOSE_BUTTON_SELECTOR, root, 40).filter(isVisible);
  if (candidates[0]) return candidates[0];
  // SVG parent button
  const svgs = collectElements<HTMLElement>('svg[aria-label]', root, 40).filter(isVisible);
  for (const svg of svgs) {
    const label = normalizeText(svg.getAttribute('aria-label') || '').toLowerCase();
    if (label === 'close' || label === 'fechar' || label.includes('close') || label.includes('fechar')) {
      const btn = (svg.closest('button, [role="button"], a') as HTMLElement | null) || svg;
      if (isVisible(btn)) return btn;
    }
  }
  return null;
};

export const pressKeyOn = (key: string, target?: HTMLElement | null) => {
  const el = target || (document.activeElement as HTMLElement | null) || document.body;
  const init: KeyboardEventInit = {
    key,
    code: key === 'Escape' ? 'Escape' : key,
    keyCode: key === 'Escape' ? 27 : 0,
    which: key === 'Escape' ? 27 : 0,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
};

const INTERACTIVE_DISMISS_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);

/** Backdrop click is safe only for full-viewport overlay layers — not nav/links at (8,8). */
export const isDismissBackdropTarget = (hit: HTMLElement, dialogEl: HTMLElement): boolean => {
  if (dialogEl.contains(hit)) return false;
  if (INTERACTIVE_DISMISS_TAGS.has(hit.tagName)) return false;
  if (hit.closest('a[href], button, input, select, textarea, [role="button"], [role="link"], nav')) return false;
  const rect = hit.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (rect.width < vw * 0.85 || rect.height < vh * 0.85) return false;
  const style = window.getComputedStyle(hit);
  if (style.position !== 'fixed' && style.position !== 'absolute') return false;
  const opacity = Number.parseFloat(style.opacity);
  if (Number.isFinite(opacity) && opacity <= 0.05) return false;
  return true;
};

export const dismissOpenModal = (): {
  success: boolean;
  strategy?: string;
  dialogsRemaining: number;
  error?: string;
  noop?: boolean;
} => {
  const before = listOpenDialogs();
  if (!before.length) {
    // Still try Escape — some Instagram sheets lack role=dialog
    pressKeyOn('Escape');
    const remaining = listOpenDialogs().length;
    return {
      success: true,
      strategy: 'escape-no-dialog',
      dialogsRemaining: remaining,
      noop: remaining === 0,
    };
  }

  const dialogEl = collectElements<HTMLElement>(DIALOG_SELECTOR, document, 12).filter(isVisible).slice(-1)[0] || null;
  const closeBtn = findCloseControl(dialogEl);
  if (closeBtn) {
    performRichClick(closeBtn);
    const remaining = listOpenDialogs().length;
    if (remaining < before.length) {
      return { success: true, strategy: 'close-button', dialogsRemaining: remaining };
    }
  }

  pressKeyOn('Escape', dialogEl || document.body);
  const afterEscape = listOpenDialogs().length;
  if (afterEscape < before.length) {
    return { success: true, strategy: 'escape', dialogsRemaining: afterEscape };
  }

  // Click backdrop only when the hit target is a full-viewport overlay layer.
  if (dialogEl) {
    const backdrop = document.elementFromPoint(8, 8) as HTMLElement | null;
    if (backdrop && isDismissBackdropTarget(backdrop, dialogEl)) {
      performRichClick(backdrop);
      const remaining = listOpenDialogs().length;
      if (remaining < before.length) {
        return { success: true, strategy: 'backdrop-click', dialogsRemaining: remaining };
      }
    }
  }

  return {
    success: false,
    error: 'Could not dismiss modal (no close control; Escape did not close).',
    dialogsRemaining: listOpenDialogs().length,
  };
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const extractTextHint = (selectorText: string, minLen = 2): string => {
  const quoted = selectorText.match(/["']([^"']+)["']/);
  if (quoted?.[1]) return quoted[1].trim();
  const bare = selectorText
    .replace(/^[#.\[\]="']+/g, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!bare || bare.length < minLen) return '';
  if (/[ >:[\]#()]/.test(selectorText) && !quoted) return '';
  return bare;
};

export const findInteractiveByText = (
  query: string,
  root: Document | Element = document,
  selector: string = INTERACTIVE_SELECTOR,
): HTMLElement | null => {
  const needle = normalizeText(query).toLowerCase();
  if (!needle) return null;
  return (
    collectElements<HTMLElement>(selector, root, 300)
      .filter(isVisible)
      .find((element) => {
        const text = normalizeText(element.textContent || '').toLowerCase();
        const aria = normalizeText(element.getAttribute('aria-label') || '').toLowerCase();
        const title = normalizeText(element.getAttribute('title') || '').toLowerCase();
        const testId = normalizeText(element.getAttribute('data-testid') || '').toLowerCase();
        const value = normalizeText((element as HTMLInputElement).value || '').toLowerCase();
        return (
          text.includes(needle) ||
          aria.includes(needle) ||
          title.includes(needle) ||
          testId.includes(needle) ||
          value.includes(needle)
        );
      }) || null
  );
};

export const resolveInteractiveTarget = (
  selector: string,
  querySelector: string = INTERACTIVE_SELECTOR,
): HTMLElement | null => {
  const selectorText = String(selector || '').trim();
  if (selectorText) {
    const bySelector = deepQuerySelector<HTMLElement>(selectorText);
    if (bySelector && isVisible(bySelector)) return bySelector;
  }
  const hint = extractTextHint(selectorText, 2);
  if (hint) {
    const byText = findInteractiveByText(hint, document, querySelector);
    if (byText) return byText;
  }
  if (selectorText) {
    const byText = findInteractiveByText(selectorText, document, querySelector);
    if (byText) return byText;
  }
  return null;
};

export const performHover = (
  element: HTMLElement,
): {
  success: true;
  strategy: string;
  coordinates: { x: number; y: number };
  targetTag: string;
  matched: string;
} => {
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const rect = element.getBoundingClientRect();
  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);
  const hitElement = document.elementFromPoint(clientX, clientY);
  const eventTarget =
    hitElement instanceof HTMLElement && (hitElement === element || element.contains(hitElement))
      ? hitElement
      : element;
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: 0,
  };
  eventTarget.focus?.();
  if (typeof PointerEvent !== 'undefined') {
    eventTarget.dispatchEvent(new PointerEvent('pointerover', { ...eventInit, pointerId: 1, pointerType: 'mouse' }));
    eventTarget.dispatchEvent(
      new PointerEvent('pointerenter', { ...eventInit, pointerId: 1, pointerType: 'mouse', bubbles: false }),
    );
    eventTarget.dispatchEvent(new PointerEvent('pointermove', { ...eventInit, pointerId: 1, pointerType: 'mouse' }));
  }
  eventTarget.dispatchEvent(new MouseEvent('mouseover', eventInit));
  eventTarget.dispatchEvent(new MouseEvent('mouseenter', { ...eventInit, bubbles: false }));
  eventTarget.dispatchEvent(new MouseEvent('mousemove', eventInit));
  return {
    success: true,
    strategy: 'rich-hover',
    matched: normalizeText(element.textContent || element.getAttribute('aria-label') || '').slice(0, 100),
    coordinates: { x: clientX, y: clientY },
    targetTag: eventTarget.tagName.toLowerCase(),
  };
};

export const performMouseAction = (
  element: HTMLElement,
  actionName: string,
): {
  success: true;
  action: string;
  strategy: string;
  coordinates: { x: number; y: number };
  targetTag: string;
  matched: string;
} | null => {
  const disabled =
    (element as HTMLButtonElement | HTMLInputElement).disabled === true ||
    element.getAttribute('aria-disabled') === 'true';
  if (disabled) return null;
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const rect = element.getBoundingClientRect();
  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);
  const hitElement = document.elementFromPoint(clientX, clientY);
  const eventTarget =
    hitElement instanceof HTMLElement && (hitElement === element || element.contains(hitElement))
      ? hitElement
      : element;
  const button = actionName === 'rightClick' ? 2 : 0;
  const buttons = actionName === 'rightClick' ? 2 : 1;
  const baseEventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button,
    buttons,
  };
  const dispatchClickCycle = (detail: number) => {
    if (typeof PointerEvent !== 'undefined') {
      eventTarget.dispatchEvent(
        new PointerEvent('pointerdown', { ...baseEventInit, pointerId: 1, pointerType: 'mouse' }),
      );
    }
    eventTarget.dispatchEvent(new MouseEvent('mousedown', { ...baseEventInit, detail }));
    if (typeof PointerEvent !== 'undefined') {
      eventTarget.dispatchEvent(
        new PointerEvent('pointerup', { ...baseEventInit, buttons: 0, pointerId: 1, pointerType: 'mouse' }),
      );
    }
    eventTarget.dispatchEvent(new MouseEvent('mouseup', { ...baseEventInit, buttons: 0, detail }));
    if (actionName !== 'rightClick') {
      eventTarget.dispatchEvent(new MouseEvent('click', { ...baseEventInit, buttons: 0, detail }));
    }
  };
  eventTarget.focus?.();
  // Match inject path: doubleClick cycles twice; otherwise one cycle + contextmenu
  // (rightClick skips the synthetic 'click' inside dispatchClickCycle).
  if (actionName === 'doubleClick') {
    dispatchClickCycle(1);
    dispatchClickCycle(2);
    eventTarget.dispatchEvent(new MouseEvent('dblclick', { ...baseEventInit, buttons: 0, detail: 2 }));
  } else {
    dispatchClickCycle(1);
    eventTarget.dispatchEvent(new MouseEvent('contextmenu', { ...baseEventInit, detail: 1 }));
  }
  return {
    success: true,
    action: actionName,
    strategy: 'rich-mouse',
    matched: normalizeText(element.textContent || element.getAttribute('aria-label') || '').slice(0, 100),
    coordinates: { x: clientX, y: clientY },
    targetTag: eventTarget.tagName.toLowerCase(),
  };
};

export type KeyModifier = 'Control' | 'Alt' | 'Shift' | 'Meta';

const KEY_MODIFIERS = new Set<KeyModifier>(['Control', 'Alt', 'Shift', 'Meta']);

export const normalizeKeyModifiers = (modifiers?: string[]): KeyModifier[] => {
  if (!Array.isArray(modifiers)) return [];
  const out: KeyModifier[] = [];
  for (const raw of modifiers) {
    const mod = String(raw || '').trim() as KeyModifier;
    if (KEY_MODIFIERS.has(mod) && !out.includes(mod)) out.push(mod);
  }
  return out;
};

/** Fire synthetic input/change only for value-editing keys (not chords or navigation keys). */
export const shouldFireInputChangeForKey = (key: string, modifiers: KeyModifier[] = []): boolean => {
  const k = String(key || '');
  if (!k) return false;
  const lower = k.toLowerCase();
  if (lower === 'backspace' || lower === 'delete') return true;
  if (modifiers.length > 0) return false;
  return k.length === 1;
};

export const pressKeyOnTarget = (key: string, selector?: string, modifiers?: string[]) => {
  let target: HTMLElement | null = null;
  if (selector) {
    target = deepQuerySelector<HTMLElement>(selector);
    if (!target) {
      return {
        success: false as const,
        code: 'ELEMENT_NOT_FOUND',
        error: 'Target not found.',
      };
    }
  } else {
    target = (document.activeElement as HTMLElement | null) || document.body;
  }
  if (!target) return { success: false as const, error: 'Target not found.' };
  if (selector) {
    try {
      target.focus?.({ preventScroll: true } as FocusOptions);
    } catch {
      target.focus?.();
    }
  }
  const mods = normalizeKeyModifiers(modifiers);
  const init: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: mods.includes('Control'),
    altKey: mods.includes('Alt'),
    shiftKey: mods.includes('Shift'),
    metaKey: mods.includes('Meta'),
  };
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  if (shouldFireInputChangeForKey(key, mods)) {
    if (typeof InputEvent !== 'undefined') {
      target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    } else {
      target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }
    target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }
  return { success: true as const, modifiers: mods.length ? mods : undefined };
};

// Pure scroll math: where a scroll should land, clamped to the element bounds.
// Exported for unit tests (no DOM needed).
export const computeScrollTarget = (
  direction: string,
  current: number,
  amount: number,
  maxScrollTop: number,
): number => {
  const max = Math.max(0, maxScrollTop);
  const cur = Math.min(Math.max(0, current), max);
  const step = Math.abs(amount) || 600;
  if (direction === 'top') return 0;
  if (direction === 'bottom') return max;
  if (direction === 'up') return Math.max(0, cur - step);
  return Math.min(max, cur + step);
};

// Pure scroller selection: among scrollable candidates, pick the one hiding the
// most content (largest overflow), breaking ties by larger visible area. This is
// how we tell a modal's inner list apart from tiny incidental scrollers. -1 = none.
export const pickBestScrollerIndex = (candidates: Array<{ overflow: number; area: number }>): number => {
  let best = -1;
  let bestOverflow = 0;
  let bestArea = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (!c || c.overflow <= 4) continue;
    if (c.overflow > bestOverflow || (c.overflow === bestOverflow && c.area > bestArea)) {
      best = i;
      bestOverflow = c.overflow;
      bestArea = c.area;
    }
  }
  return best;
};

const isScrollableEl = (el: Element | null): el is HTMLElement => {
  if (!el || el.nodeType !== 1) return false;
  const node = el as HTMLElement;
  if (node.scrollHeight - node.clientHeight <= 4) return false;
  const oy = getComputedStyle(node).overflowY;
  return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
};

// Nearest scrollable ancestor-or-self of a starting element.
const nearestScroller = (start: Element | null): HTMLElement | null => {
  let node: Element | null = start;
  for (let depth = 0; node && depth < 30; depth += 1) {
    if (isScrollableEl(node)) return node;
    node = node.parentElement;
  }
  return null;
};

// Resolve which element to scroll: an explicit selector's nearest scroller, else
// the inner scroller of an open dialog, else null (meaning: scroll the window).
// This is the key fix — with a modal open we scroll its list, not the pinned page.
const resolveScrollTarget = (selector?: string): HTMLElement | null => {
  if (selector) {
    const el = document.querySelector(selector);
    const scroller = nearestScroller(el);
    if (scroller) return scroller;
  }
  const root = getPreferredSearchRoot('auto');
  if (root === document) return null;
  const container = root as HTMLElement;
  const els: HTMLElement[] = [];
  const metrics: Array<{ overflow: number; area: number }> = [];
  const consider = (el: HTMLElement) => {
    if (!isScrollableEl(el)) return;
    const rect = el.getBoundingClientRect();
    els.push(el);
    metrics.push({
      overflow: el.scrollHeight - el.clientHeight,
      area: Math.max(0, rect.width) * Math.max(0, rect.height),
    });
  };
  consider(container);
  const nodes = container.querySelectorAll<HTMLElement>('*');
  const limit = Math.min(nodes.length, 3000);
  for (let i = 0; i < limit; i += 1) consider(nodes[i]);
  const idx = pickBestScrollerIndex(metrics);
  return idx >= 0 ? els[idx] : null;
};

const dispatchWheelBurst = (el: HTMLElement, deltaY: number, steps = 4) => {
  const rect = el.getBoundingClientRect();
  const stepDelta = deltaY / Math.max(1, steps);
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + Math.min(rect.height * 0.85, rect.height - 8);
  for (let i = 0; i < steps; i += 1) {
    try {
      el.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: stepDelta,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: cx,
          clientY: cy,
          view: window,
        }),
      );
    } catch {
      // WheelEvent unsupported
    }
  }
};

/** Scroll last (or first) list child into view — wakes IntersectionObservers better than jump scrollTop. */
const scrollEdgeChildIntoView = (el: HTMLElement, direction: string) => {
  const kids = el.querySelectorAll<HTMLElement>('a, [role="listitem"], li, div[style*="height"]');
  if (!kids.length) return false;
  const preferEnd = direction === 'down' || direction === 'bottom';
  const edge = preferEnd ? kids[kids.length - 1] : kids[0];
  try {
    edge.scrollIntoView({
      block: preferEnd ? 'end' : 'start',
      inline: 'nearest',
      behavior: 'instant' as ScrollBehavior,
    });
    return true;
  } catch {
    return false;
  }
};

const scrollTargetElement = (el: HTMLElement, direction: string, amount: number, strategy = 'auto') => {
  const before = el.scrollTop;
  const maxTopBefore = el.scrollHeight - el.clientHeight;
  const step = Math.abs(amount) || 600;
  const target = computeScrollTarget(direction, before, step, maxTopBefore);
  const deltaY = direction === 'up' || direction === 'top' ? -step : step;
  const mode = String(strategy || 'auto').toLowerCase();
  let intoViewUsed = false;

  // Instagram-style lists: intoView on the last row is often what re-arms IO.
  if (mode === 'auto' || mode === 'intoView' || mode === 'intoview') {
    if (direction === 'down' || direction === 'bottom' || direction === 'up' || direction === 'top') {
      intoViewUsed = scrollEdgeChildIntoView(el, direction);
    }
  }

  if (mode === 'auto' || mode === 'wheel') {
    // Multi-step wheel (still isTrusted:false, but matches human-ish burst better than one jump).
    dispatchWheelBurst(el, deltaY, 5);
  }

  if (mode !== 'intoView' && mode !== 'intoview') {
    el.scrollTop = target;
  } else if (!intoViewUsed) {
    el.scrollTop = target;
  }

  try {
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  } catch {
    // ignore
  }
  const after = el.scrollTop;
  const maxTopAfter = el.scrollHeight - el.clientHeight;
  const delta = after - before;
  return {
    success: true as const,
    direction,
    amount: step,
    strategy: mode,
    target: 'container' as const,
    containerSelector: buildLocalSelector(el),
    intoViewUsed,
    scrolled: Math.abs(delta) > 0.5 || intoViewUsed,
    delta,
    scrollTop: after,
    maxScrollTop: maxTopAfter,
    atBottom: after >= maxTopAfter - 4,
  };
};

export const scrollPage = (direction: string, amount: number, selector?: string, strategy = 'auto') => {
  const container = resolveScrollTarget(selector);
  if (container) {
    return scrollTargetElement(container, direction, amount || 600, strategy);
  }
  const beforeY = window.scrollY;
  if (direction === 'top') {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  } else if (direction === 'bottom') {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior });
  } else if (direction === 'up') {
    window.scrollBy({ top: -amount, behavior: 'instant' as ScrollBehavior });
  } else {
    window.scrollBy({ top: amount, behavior: 'instant' as ScrollBehavior });
  }
  const afterY = window.scrollY;
  const maxY = Math.max(0, document.body.scrollHeight - window.innerHeight);
  const delta = afterY - beforeY;
  return {
    success: true as const,
    direction,
    amount,
    target: 'window' as const,
    scrolled: Math.abs(delta) > 0.5,
    delta,
    scrollTop: afterY,
    maxScrollTop: maxY,
    atBottom: afterY >= maxY - 4,
  };
};

const buildOptimalSelector = (element: Element): string => {
  const localSelector = buildLocalSelector(element, { includePlaceholder: true });
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    return `${buildOptimalSelector(root.host)} >>> ${localSelector}`;
  }
  return localSelector;
};

const levenshtein = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (Math.abs(m - n) > 3) return Math.abs(m - n);
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
};

const fuzzyThreshold = (q: string): number => {
  const len = q.length;
  if (len <= 4) return 0;
  if (len <= 8) return 1;
  if (len <= 15) return 2;
  return 3;
};

export type FindElementCandidate = {
  selector: string;
  tag: string;
  text: string;
  visible: boolean;
  position: { top: number; left: number; width: number; height: number };
  attributes: Record<string, string | undefined>;
};

export const FIND_ELEMENT_SCAN_CAP_DEFAULT = 80;
export const FIND_ELEMENT_SCAN_CAP_DEEP = 300;
export const FIND_ELEMENT_SELECTOR_CACHE_MAX = 20;

export type FindElementScopeKind = 'dialog' | 'form' | 'landmark' | 'page';

export const getFindElementScanCap = (deep?: boolean): number =>
  deep ? FIND_ELEMENT_SCAN_CAP_DEEP : FIND_ELEMENT_SCAN_CAP_DEFAULT;

export const isInputishFindType = (typeFilter: string): boolean =>
  String(typeFilter || 'any').toLowerCase() === 'input';

/** Scope order for findElement: dialog → form (input type) → landmarks → full page. */
export const buildFindElementScopeOrder = (searchScope: string, typeFilter: string): FindElementScopeKind[] => {
  const scope = String(searchScope || 'auto').toLowerCase();
  if (scope === 'page') return ['page'];
  if (scope === 'dialog') return ['dialog'];
  const order: FindElementScopeKind[] = ['dialog'];
  if (isInputishFindType(typeFilter)) order.push('form');
  order.push('landmark', 'page');
  return order;
};

export const buildFindElementCacheKey = (
  url: string,
  query: string,
  typeFilter: string,
  searchScope: string,
  fuzzy: boolean,
  deep: boolean,
): string => `${url}\0${query}\0${typeFilter}\0${searchScope}\0${fuzzy ? '1' : '0'}\0${deep ? '1' : '0'}`;

const findElementSelectorCache = new Map<string, { selector: string }>();

const getCachedFindElementSelector = (key: string): string | null =>
  findElementSelectorCache.get(key)?.selector ?? null;

const setCachedFindElementSelector = (key: string, selector: string) => {
  if (findElementSelectorCache.size >= FIND_ELEMENT_SELECTOR_CACHE_MAX) {
    const oldest = findElementSelectorCache.keys().next().value;
    if (oldest) findElementSelectorCache.delete(oldest);
  }
  findElementSelectorCache.set(key, { selector });
};

export const resolveFindElementSearchRoot = (
  kind: FindElementScopeKind,
  documentRef: Document = document,
): Document | Element | null => {
  if (kind === 'page') return documentRef;
  if (kind === 'dialog') {
    const dialogs = collectElements<HTMLElement>(DIALOG_SELECTOR, documentRef, 12).filter(isVisible);
    return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
  }
  if (kind === 'form') {
    const forms = collectElements<HTMLFormElement>('form', documentRef, 8).filter(isVisible);
    return forms.length > 0 ? forms[0] : null;
  }
  if (kind === 'landmark') {
    for (const sel of ['main', '[role="main"]', 'nav']) {
      try {
        const el = documentRef.querySelector(sel);
        if (el instanceof HTMLElement && isVisible(el)) return el;
      } catch {
        // ignore invalid selector edge cases
      }
    }
    return null;
  }
  return documentRef;
};

export const findElementsByQuery = (options: {
  query: string;
  typeFilter?: string;
  maxResults?: number;
  fuzzy?: boolean;
  scope?: string;
  deep?: boolean;
}):
  | {
      success: true;
      query: string;
      count: number;
      candidates: FindElementCandidate[];
      fuzzy: boolean;
      scope: string;
      dialogsOpen: number;
      searchedInDialog: boolean;
    }
  | {
      success: false;
      code: string;
      error: string;
      hint?: string;
      query: string;
    } => {
  const searchQuery = String(options.query || '');
  const filterType = String(options.typeFilter || 'any').toLowerCase();
  const maxRes = Math.max(1, Math.min(20, options.maxResults ?? 5));
  const useFuzzy = options.fuzzy !== false;
  const searchScope = String(options.scope || 'auto').toLowerCase();
  const deepScan = options.deep === true;
  const needle = normalizeText(searchQuery).toLowerCase();
  if (!needle) return { success: false, code: 'EMPTY_QUERY', error: 'Empty query.', query: searchQuery };

  const MAX_FUZZY_FIELD_LEN = 40;
  const MAX_CANDIDATE_SCAN = getFindElementScanCap(deepScan);
  const INTERACTIVE =
    'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], label, [tabindex="0"]';

  const cacheKey = buildFindElementCacheKey(
    typeof location !== 'undefined' ? location.href : '',
    searchQuery,
    filterType,
    searchScope,
    useFuzzy,
    deepScan,
  );
  const cachedSelector = getCachedFindElementSelector(cacheKey);
  if (cachedSelector) {
    const cachedEl = deepQuerySelector<HTMLElement>(cachedSelector);
    if (cachedEl && isVisible(cachedEl)) {
      const rect = cachedEl.getBoundingClientRect();
      const cachedCandidate: FindElementCandidate = {
        selector: cachedSelector,
        tag: cachedEl.tagName.toLowerCase(),
        text: normalizeText(cachedEl.textContent || cachedEl.getAttribute('aria-label') || '').slice(0, 120),
        visible: true,
        position: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        attributes: {
          id: cachedEl.id || undefined,
          name: cachedEl.getAttribute('name') || undefined,
          'data-testid': cachedEl.getAttribute('data-testid') || undefined,
          'aria-label': cachedEl.getAttribute('aria-label') || undefined,
          placeholder: (cachedEl as HTMLInputElement).placeholder || undefined,
          type: (cachedEl as HTMLInputElement).type || undefined,
        },
      };
      const openDialogsEarly = listOpenDialogs();
      return {
        success: true,
        query: searchQuery,
        count: 1,
        candidates: [cachedCandidate],
        fuzzy: useFuzzy,
        scope: searchScope,
        dialogsOpen: openDialogsEarly.length,
        searchedInDialog: searchScope === 'dialog' || (searchScope === 'auto' && openDialogsEarly.length > 0),
      };
    }
  }

  // Profile stats first — "seguindo"/"following" must beat noisy utility-class nodes.
  let profileStatSeed: FindElementCandidate | null = null;
  let profileStatEl: HTMLElement | null = null;
  const profileSearchRoot =
    searchScope === 'page' ? document : getPreferredSearchRoot(searchScope === 'dialog' ? 'dialog' : 'auto');
  profileStatEl = resolveProfileStatLink(needle, profileSearchRoot === document ? document : profileSearchRoot);
  if (profileStatEl) {
    const rect = profileStatEl.getBoundingClientRect();
    profileStatSeed = {
      selector: buildOptimalSelector(profileStatEl),
      tag: profileStatEl.tagName.toLowerCase(),
      text: normalizeText(profileStatEl.textContent || profileStatEl.getAttribute('aria-label') || '').slice(0, 120),
      visible: true,
      position: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      attributes: {
        id: profileStatEl.id || undefined,
        name: profileStatEl.getAttribute('name') || undefined,
        'data-testid': profileStatEl.getAttribute('data-testid') || undefined,
        'aria-label': profileStatEl.getAttribute('aria-label') || undefined,
        href: profileStatEl.getAttribute('href') || undefined,
      },
    };
    if (maxRes <= 1) {
      setCachedFindElementSelector(cacheKey, profileStatSeed.selector);
      return {
        success: true,
        query: searchQuery,
        count: 1,
        candidates: [profileStatSeed],
        fuzzy: useFuzzy,
        scope: searchScope,
        dialogsOpen: listOpenDialogs().length,
        searchedInDialog: profileSearchRoot !== document,
      };
    }
  }

  const passesTypeFilter = (element: HTMLElement, tag: string) => {
    if (filterType === 'any') return true;
    if (filterType === 'button' && !['button', 'input'].includes(tag) && element.getAttribute('role') !== 'button') {
      return false;
    }
    if (filterType === 'link' && tag !== 'a' && element.getAttribute('role') !== 'link') return false;
    if (filterType === 'input' && !['input', 'textarea', 'select'].includes(tag)) return false;
    return true;
  };

  const threshold = useFuzzy ? fuzzyThreshold(needle) : 0;

  const matchCandidatesInElements = (allElements: HTMLElement[]): HTMLElement[] => {
    const exactCandidates: HTMLElement[] = [];
    const fuzzyCandidates: Array<{ element: HTMLElement; distance: number }> = [];

    for (const element of allElements) {
      if (!isVisible(element)) continue;
      const tag = element.tagName.toLowerCase();
      if (!passesTypeFilter(element, tag)) continue;
      const shortFields = [
        normalizeText(element.getAttribute('aria-label') || ''),
        normalizeText(element.getAttribute('title') || ''),
        normalizeText((element as HTMLInputElement).placeholder || ''),
        normalizeText(element.getAttribute('name') || ''),
        normalizeText(element.getAttribute('data-testid') || ''),
        normalizeText(element.id || ''),
      ]
        .filter(Boolean)
        .map((f) => f.toLowerCase());
      if (shortFields.some((field) => field.includes(needle) || needle.includes(field))) {
        exactCandidates.push(element);
        if (exactCandidates.length >= maxRes) break;
      }
    }

    if (exactCandidates.length < maxRes) {
      for (const element of allElements) {
        if (exactCandidates.includes(element)) continue;
        if (!isVisible(element)) continue;
        const tag = element.tagName.toLowerCase();
        if (!passesTypeFilter(element, tag)) continue;
        const text = normalizeText(element.textContent || '').toLowerCase();
        if (text && text.length <= 200 && text.includes(needle)) {
          exactCandidates.push(element);
          if (exactCandidates.length >= maxRes) break;
        }
      }
    }

    if (useFuzzy && threshold > 0 && exactCandidates.length < maxRes) {
      for (const element of allElements) {
        if (exactCandidates.includes(element)) continue;
        if (!isVisible(element)) continue;
        const tag = element.tagName.toLowerCase();
        if (!passesTypeFilter(element, tag)) continue;
        const fields = [
          normalizeText(element.getAttribute('aria-label') || ''),
          normalizeText(element.getAttribute('title') || ''),
          normalizeText((element as HTMLInputElement).placeholder || ''),
          normalizeText(element.getAttribute('name') || ''),
          normalizeText(element.getAttribute('data-testid') || ''),
        ].filter((field) => field && field.length <= MAX_FUZZY_FIELD_LEN);

        let minDist = Number.POSITIVE_INFINITY;
        for (const field of fields) {
          const lower = field.toLowerCase();
          if (Math.abs(lower.length - needle.length) > threshold + 1) continue;
          const dist = levenshtein(needle, lower);
          if (dist < minDist) minDist = dist;
          if (minDist === 0) break;
          if (field.includes(' ')) {
            for (const word of field.split(/\s+/)) {
              if (word.length < needle.length - threshold || word.length > needle.length + threshold) continue;
              const wdist = levenshtein(needle, word.toLowerCase());
              if (wdist < minDist) minDist = wdist;
            }
          }
        }
        if (minDist <= threshold) fuzzyCandidates.push({ element, distance: minDist });
      }
    }

    const combined = exactCandidates.slice(0, maxRes);
    if (combined.length < maxRes && fuzzyCandidates.length > 0) {
      fuzzyCandidates.sort((a, b) => a.distance - b.distance);
      for (const fc of fuzzyCandidates.slice(0, maxRes - combined.length)) {
        if (!combined.includes(fc.element)) combined.push(fc.element);
      }
    }
    return combined;
  };

  let searchRoot: Document | Element = document;
  let combined: HTMLElement[] = [];
  const scopeOrder = buildFindElementScopeOrder(searchScope, filterType);
  for (const kind of scopeOrder) {
    const root = resolveFindElementSearchRoot(kind);
    if (!root) continue;
    const allElements = collectElements<HTMLElement>(INTERACTIVE, root, MAX_CANDIDATE_SCAN);
    combined = matchCandidatesInElements(allElements);
    if (combined.length > 0) {
      searchRoot = root;
      break;
    }
  }

  const openDialogs = listOpenDialogs();

  if (combined.length === 0 && !profileStatSeed) {
    return {
      success: false,
      code: 'ELEMENT_NOT_FOUND',
      error: `No visible element found matching "${searchQuery}".`,
      hint: 'Try getContent({ mode: "structure" }) to inspect available interactive elements.',
      query: searchQuery,
    };
  }

  const mapped: FindElementCandidate[] = combined.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      selector: buildOptimalSelector(element),
      tag: element.tagName.toLowerCase(),
      text: normalizeText(element.textContent || element.getAttribute('aria-label') || '').slice(0, 120),
      visible: true,
      position: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      attributes: {
        id: element.id || undefined,
        name: element.getAttribute('name') || undefined,
        'data-testid': element.getAttribute('data-testid') || undefined,
        'aria-label': element.getAttribute('aria-label') || undefined,
        placeholder: (element as HTMLInputElement).placeholder || undefined,
        type: (element as HTMLInputElement).type || undefined,
      },
    };
  });

  // Profile-stat link always first (stable href), then other matches without duplicate selectors.
  const candidates: FindElementCandidate[] = [];
  const seed = profileStatSeed;
  if (seed) candidates.push(seed);
  for (const c of mapped) {
    if (candidates.length >= maxRes) break;
    if (seed && c.selector === seed.selector) continue;
    if (seed && profileStatEl && combined.includes(profileStatEl) && c.tag === seed.tag && c.text === seed.text) {
      continue;
    }
    candidates.push(c);
  }

  const finalCandidates = candidates.slice(0, maxRes);
  if (finalCandidates.length > 0) {
    setCachedFindElementSelector(cacheKey, finalCandidates[0].selector);
  }

  return {
    success: true,
    query: searchQuery,
    count: finalCandidates.length,
    candidates: finalCandidates,
    fuzzy: useFuzzy,
    scope: searchScope,
    dialogsOpen: openDialogs.length,
    searchedInDialog: searchRoot !== document,
  };
};

const clipText = (value: string, length: number) => {
  const text = String(value || '').trim();
  if (text.length <= length) return text;
  return `${text.slice(0, length)}...`;
};

/**
 * Structured page snapshot for getContent({ mode: "structure" }).
 * Uses approximate byte budget (no per-item JSON.stringify) and limited queries.
 */
export const extractPageStructure = (
  root: HTMLElement = document.body,
  maxLen = 8000,
  maxPerSection = 40,
): {
  success: true;
  mode: 'structure';
  structure: Record<string, unknown>;
  sections: Record<string, number>;
  truncated: boolean;
  content: string;
  contentLength: number;
} => {
  const safeLimit = Math.max(200, Math.floor(maxLen));
  const safeMax = Math.max(10, Math.floor(maxPerSection));
  const getSelector = (element: Element) => buildLocalSelector(element);

  const dialogNodes = queryLimited<HTMLElement>(
    document,
    '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]',
    12,
  ).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const activeDialog = dialogNodes[dialogNodes.length - 1] || null;
  const scanRoot: HTMLElement = activeDialog || root;

  const structure: Record<string, unknown> = {
    title: clipText(document.title || '', 220),
    url: clipText(window.location.href || '', 420),
    dialogOpen: Boolean(activeDialog),
    dialogs: dialogNodes.slice(0, 5).map((el) => ({
      label: clipText(el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.textContent || 'dialog', 120),
      selector: getSelector(el),
    })),
    searchedInDialog: Boolean(activeDialog),
    headings: [] as Record<string, unknown>[],
    forms: [] as Record<string, unknown>[],
    actions: [] as Record<string, unknown>[],
    sidebarItems: [] as Record<string, unknown>[],
    cards: [] as Record<string, unknown>[],
    tables: [] as Record<string, unknown>[],
    filters: [] as Record<string, unknown>[],
    tabs: [] as Record<string, unknown>[],
    badges: [] as Record<string, unknown>[],
    kpis: [] as Record<string, unknown>[],
    landmarks: [] as Record<string, unknown>[],
  };

  let truncated = false;
  // Seed budget with base metadata (approx, with 8% headroom vs final JSON).
  let budgetUsed = Math.ceil(
    approxJsonBytes({
      title: structure.title,
      url: structure.url,
      dialogOpen: structure.dialogOpen,
      dialogs: structure.dialogs,
      searchedInDialog: structure.searchedInDialog,
    }) * 1.08,
  );
  const budgetLimit = Math.floor(safeLimit * 0.92);

  type SectionKey =
    | 'headings'
    | 'forms'
    | 'actions'
    | 'sidebarItems'
    | 'cards'
    | 'tables'
    | 'filters'
    | 'tabs'
    | 'badges'
    | 'kpis'
    | 'landmarks';

  const tryPush = (key: SectionKey, item: Record<string, unknown>) => {
    const list = structure[key] as Record<string, unknown>[];
    const add = approxJsonBytes(item) + 1;
    if (budgetUsed + add > budgetLimit) {
      truncated = true;
      return false;
    }
    list.push(item);
    budgetUsed += add;
    return true;
  };

  const summarizeField = (element: Element) => ({
    tag: element.tagName.toLowerCase(),
    type: clipText(element.getAttribute('type') || '', 40),
    name: clipText(element.getAttribute('name') || '', 120),
    id: clipText(element.getAttribute('id') || '', 120),
    label: clipText(
      element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('alt') || '',
      140,
    ),
    placeholder: clipText(element.getAttribute('placeholder') || '', 120),
    required: element.hasAttribute('required'),
    disabled: element.hasAttribute('disabled'),
    selector: getSelector(element),
  });

  // Fetch one extra to detect truncation without materializing huge lists for budgeting.
  const overscan = safeMax + 1;

  const headings = queryLimited<HTMLElement>(scanRoot, 'h1, h2, h3', overscan);
  for (let i = 0; i < headings.length && i < safeMax; i += 1) {
    const heading = headings[i];
    if (
      !tryPush('headings', {
        level: heading.tagName.toLowerCase(),
        text: clipText(heading.textContent || '', 220),
      })
    ) {
      break;
    }
  }
  if (headings.length > safeMax) truncated = true;

  const forms = queryLimited<HTMLFormElement>(scanRoot, 'form', overscan);
  for (let i = 0; i < forms.length && i < safeMax; i += 1) {
    const form = forms[i];
    const fields = queryLimited(form, 'input, select, textarea, button', 16).map((field) => summarizeField(field));
    if (
      !tryPush('forms', {
        id: clipText(form.id || '', 120),
        name: clipText(form.getAttribute('name') || '', 120),
        method: clipText((form.getAttribute('method') || 'get').toUpperCase(), 12),
        action: clipText(form.getAttribute('action') || '', 220),
        fields,
      })
    ) {
      break;
    }
  }
  if (forms.length > safeMax) truncated = true;

  const actions = queryLimited<HTMLElement>(
    scanRoot,
    'button, a[href], input[type="submit"], input[type="button"], [role="button"], [role="link"], [tabindex="0"]',
    overscan,
  );
  for (let i = 0; i < actions.length && i < safeMax; i += 1) {
    const action = actions[i];
    if (
      !tryPush('actions', {
        tag: action.tagName.toLowerCase(),
        text: clipText(action.textContent || '', 200),
        id: clipText(action.id || '', 120),
        href: clipText((action as HTMLAnchorElement).href || '', 260),
        disabled: (action as HTMLButtonElement).disabled === true || action.getAttribute('aria-disabled') === 'true',
        selector: getSelector(action),
      })
    ) {
      break;
    }
  }
  if (actions.length > safeMax) truncated = true;

  const sidebarCandidates = queryLimited<HTMLElement>(
    scanRoot,
    'aside a[href], nav a[href], [role="navigation"] a[href], aside button, nav button, [role="navigation"] button, [role="menuitem"]',
    overscan,
  );
  for (let i = 0; i < sidebarCandidates.length && i < safeMax; i += 1) {
    const candidate = sidebarCandidates[i];
    if (
      !tryPush('sidebarItems', {
        tag: candidate.tagName.toLowerCase(),
        text: clipText(candidate.textContent || candidate.getAttribute('aria-label') || '', 180),
        href: clipText((candidate as HTMLAnchorElement).href || '', 240),
        role: clipText(candidate.getAttribute('role') || '', 60),
        selector: getSelector(candidate),
      })
    ) {
      break;
    }
  }
  if (sidebarCandidates.length > safeMax) truncated = true;

  const cardCandidates = queryLimited<HTMLElement>(
    scanRoot,
    'article, section, [class*="card" i], [class*="tile" i], [class*="widget" i], [data-card], [data-testid*="card" i]',
    overscan,
  );
  for (let i = 0; i < cardCandidates.length && i < safeMax; i += 1) {
    const card = cardCandidates[i];
    const titleNode = card.querySelector('h1, h2, h3, h4, strong, [data-title], [class*="title" i]');
    const summaryText = clipText(card.textContent || '', 220);
    const titleText = clipText((titleNode as HTMLElement | null)?.textContent || '', 140);
    if (!titleText && summaryText.length < 30) continue;
    if (
      !tryPush('cards', {
        tag: card.tagName.toLowerCase(),
        id: clipText(card.id || '', 80),
        title: titleText,
        summary: summaryText,
      })
    ) {
      break;
    }
  }
  if (cardCandidates.length > safeMax) truncated = true;

  const tableCandidates = queryLimited<HTMLTableElement>(scanRoot, 'table', overscan);
  for (let i = 0; i < tableCandidates.length && i < safeMax; i += 1) {
    const table = tableCandidates[i];
    const headers = queryLimited(table, 'th', 6)
      .map((th) => clipText(th.textContent || '', 60))
      .filter(Boolean);
    const rowCount = table.querySelectorAll('tbody tr').length || table.querySelectorAll('tr').length;
    if (
      !tryPush('tables', {
        id: clipText(table.id || '', 80),
        caption: clipText(table.querySelector('caption')?.textContent || '', 120),
        rows: rowCount,
        headers,
      })
    ) {
      break;
    }
  }
  if (tableCandidates.length > safeMax) truncated = true;

  const filterCandidates = queryLimited<HTMLElement>(
    scanRoot,
    'input[type="search"], input[placeholder*="busc" i], input[placeholder*="filter" i], select, [aria-label*="filtro" i], [aria-label*="filter" i]',
    overscan,
  );
  for (let i = 0; i < filterCandidates.length && i < safeMax; i += 1) {
    const filter = filterCandidates[i];
    if (
      !tryPush('filters', {
        tag: filter.tagName.toLowerCase(),
        type: clipText((filter as HTMLInputElement).type || '', 40),
        name: clipText(filter.getAttribute('name') || '', 80),
        label: clipText(
          filter.getAttribute('aria-label') || filter.getAttribute('title') || filter.getAttribute('placeholder') || '',
          140,
        ),
        selector: getSelector(filter),
      })
    ) {
      break;
    }
  }
  if (filterCandidates.length > safeMax) truncated = true;

  const tabCandidates = queryLimited<HTMLElement>(
    scanRoot,
    '[role="tab"], [data-tab], [aria-selected], .tab, [class*="tab-" i]',
    overscan,
  );
  for (let i = 0; i < tabCandidates.length && i < safeMax; i += 1) {
    const tab = tabCandidates[i];
    const text = clipText(tab.textContent || tab.getAttribute('aria-label') || '', 120);
    if (!text) continue;
    if (
      !tryPush('tabs', {
        text,
        selected: tab.getAttribute('aria-selected') === 'true',
        role: clipText(tab.getAttribute('role') || '', 40),
        selector: getSelector(tab),
      })
    ) {
      break;
    }
  }
  if (tabCandidates.length > safeMax) truncated = true;

  const badgeCandidates = queryLimited<HTMLElement>(
    scanRoot,
    '[class*="badge" i], [class*="tag" i], [data-badge], [aria-label*="badge" i]',
    overscan,
  );
  for (let i = 0; i < badgeCandidates.length && i < safeMax; i += 1) {
    const badge = badgeCandidates[i];
    const text = clipText(badge.textContent || badge.getAttribute('aria-label') || '', 100);
    if (!text || text.length < 2) continue;
    if (!tryPush('badges', { text, tag: badge.tagName.toLowerCase() })) break;
  }
  if (badgeCandidates.length > safeMax) truncated = true;

  const kpiCandidates = queryLimited<HTMLElement>(
    scanRoot,
    '[data-kpi], [class*="kpi" i], [class*="metric" i], [class*="stat" i], [class*="summary-value" i]',
    overscan,
  );
  for (let i = 0; i < kpiCandidates.length && i < safeMax; i += 1) {
    const kpi = kpiCandidates[i];
    const valueText = clipText(kpi.textContent || '', 100);
    if (!valueText) continue;
    const labelNode = kpi.querySelector('[class*="label" i], [data-label], small, span, strong') || kpi.parentElement;
    if (
      !tryPush('kpis', {
        label: clipText((labelNode as HTMLElement | null)?.textContent || '', 120),
        value: valueText,
      })
    ) {
      break;
    }
  }
  if (kpiCandidates.length > safeMax) truncated = true;

  const landmarks = queryLimited<HTMLElement>(scanRoot, 'main, nav, header, footer, aside, section, article', overscan);
  for (let i = 0; i < landmarks.length && i < safeMax; i += 1) {
    const landmark = landmarks[i];
    if (
      !tryPush('landmarks', {
        tag: landmark.tagName.toLowerCase(),
        id: clipText(landmark.id || '', 120),
        role: clipText(landmark.getAttribute('role') || '', 80),
        label: clipText(
          landmark.getAttribute('aria-label') ||
            landmark.getAttribute('title') ||
            landmark.getAttribute('data-testid') ||
            '',
          180,
        ),
      })
    ) {
      break;
    }
  }
  if (landmarks.length > safeMax) truncated = true;

  const content = JSON.stringify(structure);
  if (content.length > safeLimit) {
    // Rare: approx under-estimated. Truncate arrays from the end of low-priority sections.
    truncated = true;
  }

  return {
    success: true,
    mode: 'structure',
    structure,
    sections: {
      headings: (structure.headings as unknown[]).length,
      forms: (structure.forms as unknown[]).length,
      actions: (structure.actions as unknown[]).length,
      sidebarItems: (structure.sidebarItems as unknown[]).length,
      cards: (structure.cards as unknown[]).length,
      tables: (structure.tables as unknown[]).length,
      filters: (structure.filters as unknown[]).length,
      tabs: (structure.tabs as unknown[]).length,
      badges: (structure.badges as unknown[]).length,
      kpis: (structure.kpis as unknown[]).length,
      landmarks: (structure.landmarks as unknown[]).length,
    },
    truncated,
    content: content.length > safeLimit ? content.slice(0, safeLimit) : content,
    contentLength: content.length,
  };
};

/** Wait until ANY dialog is open (for wait tool). Returns immediately if already open. */
export const waitForDialog = async (timeoutMs = 2500): Promise<DialogInfo | null> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const dialogs = listOpenDialogs();
    if (dialogs.length) return dialogs[dialogs.length - 1];
    await sleep(50);
  }
  return null;
};

/**
 * Post-click helper: wait only for a *new* dialog relative to `dialogsBefore`.
 * Early-exits when a new dialog appears; otherwise stops at timeout without
 * blocking the full window when nothing is opening (usage bottleneck fix).
 *
 * Uses a short progressive poll so Instagram sheets (~100–400ms) are caught
 * without adding ~900ms tax on every normal click.
 */
export const waitForNewDialog = async (dialogsBefore: number, timeoutMs = 450): Promise<DialogInfo | null> => {
  // Immediate re-check (modal may already be in DOM after click).
  let dialogs = listOpenDialogs();
  if (dialogs.length > dialogsBefore) return dialogs[dialogs.length - 1];

  const started = Date.now();
  // Progressive intervals: 40 → 80 → 120… until timeout
  let delay = 40;
  while (Date.now() - started < timeoutMs) {
    await sleep(delay);
    dialogs = listOpenDialogs();
    if (dialogs.length > dialogsBefore) return dialogs[dialogs.length - 1];
    delay = Math.min(120, delay + 20);
  }
  return null;
};

const normalizeOptionText = (value: string) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export type SelectOptionCriteria = {
  value?: string;
  label?: string;
  index?: number;
};

const pickNativeOption = (select: HTMLSelectElement, criteria: SelectOptionCriteria): HTMLOptionElement | null => {
  const options = Array.from(select.options);
  if (criteria.index !== undefined && Number.isFinite(criteria.index)) {
    const idx = Math.max(0, Math.floor(Number(criteria.index)));
    return options[idx] || null;
  }
  if (criteria.value !== undefined) {
    const want = String(criteria.value);
    return options.find((opt) => opt.value === want) || null;
  }
  if (criteria.label !== undefined) {
    const want = normalizeOptionText(criteria.label);
    return options.find((opt) => normalizeOptionText(opt.textContent || opt.label) === want) || null;
  }
  return null;
};

const listCustomOptions = (): HTMLElement[] => {
  const selector = '[role="option"], [role="menuitem"], li[role="option"]';
  return collectElements<HTMLElement>(selector, document, 200).filter(isVisible);
};

const pickCustomOption = (criteria: SelectOptionCriteria): HTMLElement | null => {
  const options = listCustomOptions();
  if (criteria.index !== undefined && Number.isFinite(criteria.index)) {
    const idx = Math.max(0, Math.floor(Number(criteria.index)));
    return options[idx] || null;
  }
  if (criteria.value !== undefined) {
    const want = String(criteria.value);
    return (
      options.find(
        (opt) =>
          opt.getAttribute('data-value') === want ||
          opt.getAttribute('value') === want ||
          opt.getAttribute('data-key') === want,
      ) || null
    );
  }
  if (criteria.label !== undefined) {
    const want = normalizeOptionText(criteria.label);
    return (
      options.find((opt) => {
        const text = normalizeOptionText(opt.textContent || '');
        const aria = normalizeOptionText(opt.getAttribute('aria-label') || '');
        return text === want || aria === want || text.includes(want);
      }) || null
    );
  }
  return null;
};

const resolveComboboxTrigger = (element: HTMLElement): HTMLElement => {
  if (element.getAttribute('role') === 'combobox') return element;
  const combo = element.closest('[role="combobox"]') as HTMLElement | null;
  if (combo) return combo;
  if (element instanceof HTMLSelectElement) {
    const sibling = element.parentElement?.querySelector<HTMLElement>('[role="combobox"], [aria-haspopup="listbox"]');
    if (sibling) return sibling;
  }
  return element;
};

export const selectOptionOnTarget = async (
  selector: string,
  criteria: SelectOptionCriteria,
): Promise<{
  success: boolean;
  code?: string;
  error?: string;
  selectedLabel?: string;
  selectedValue?: string;
  kind?: 'native' | 'custom';
}> => {
  const selectorText = String(selector || '').trim();
  if (!selectorText) {
    return { success: false, code: 'INVALID_SELECTOR', error: 'Missing selector.' };
  }
  const hasValue = criteria.value !== undefined;
  const hasLabel = criteria.label !== undefined;
  const hasIndex = criteria.index !== undefined;
  const count = [hasValue, hasLabel, hasIndex].filter(Boolean).length;
  if (count !== 1) {
    return {
      success: false,
      code: 'INVALID_ARGS',
      error: 'Provide exactly one of value, label, or index.',
    };
  }

  let element: HTMLElement | null = null;
  try {
    element = deepQuerySelector<HTMLElement>(selectorText);
  } catch {
    return { success: false, code: 'INVALID_SELECTOR', error: `Invalid selector syntax: ${selectorText}` };
  }
  if (!element || !isVisible(element)) {
    return { success: false, code: 'ELEMENT_NOT_FOUND', error: `Element not found: ${selectorText}` };
  }

  if (element instanceof HTMLSelectElement) {
    if (element.disabled) {
      return { success: false, code: 'ELEMENT_DISABLED', error: 'Select is disabled.' };
    }
    const option = pickNativeOption(element, criteria);
    if (!option) {
      return { success: false, code: 'OPTION_NOT_FOUND', error: 'Matching option not found in native select.' };
    }
    element.value = option.value;
    option.selected = true;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      success: true,
      kind: 'native',
      selectedLabel: normalizeText(option.textContent || option.label),
      selectedValue: option.value,
    };
  }

  const trigger = resolveComboboxTrigger(element);
  trigger.scrollIntoView({ block: 'center', inline: 'center' });
  const listboxAlreadyOpen =
    trigger.getAttribute('aria-expanded') === 'true' ||
    listCustomOptions().length > 0 ||
    Boolean(
      document.querySelector('[role="listbox"]:not([hidden])') &&
        Array.from(document.querySelectorAll('[role="option"]')).some((element) => isVisible(element as HTMLElement)),
    );
  if (!listboxAlreadyOpen) {
    performRichClick(trigger);
  }

  const started = Date.now();
  let customOption: HTMLElement | null = null;
  while (Date.now() - started < 1200) {
    customOption = pickCustomOption(criteria);
    if (customOption) break;
    await sleep(80);
  }
  if (!customOption) {
    return {
      success: false,
      code: 'OPTION_NOT_FOUND',
      error: 'Custom dropdown option not found after opening listbox.',
      kind: 'custom',
    };
  }
  performRichClick(customOption);
  const selectedLabel = normalizeText(customOption.textContent || customOption.getAttribute('aria-label') || '');
  const selectedValue =
    customOption.getAttribute('data-value') ||
    customOption.getAttribute('value') ||
    customOption.getAttribute('data-key') ||
    selectedLabel;
  return { success: true, kind: 'custom', selectedLabel, selectedValue };
};

export { resolveReadPageRef } from '../tools/ref-resolver.js';

export const highlightElementOverlay = (
  target: HTMLElement,
  options: { durationMs?: number; label?: string } = {},
): {
  success: boolean;
  ref?: string;
  box?: { x: number; y: number; width: number; height: number };
} => {
  const durationMs = Math.min(5000, Math.max(200, Number(options.durationMs) || 1200));
  const label = options.label ? String(options.label) : undefined;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { success: false };
  }

  const pad = 3;
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

  if (label) {
    const badge = document.createElement('span');
    badge.textContent = label;
    badge.style.cssText = [
      'position:absolute',
      'top:-10px',
      'left:8px',
      'padding:1px 6px',
      'font:600 11px/16px system-ui,sans-serif',
      'color:#fff',
      'background:#2f6feb',
      'border-radius:4px',
      'transform:translateY(-100%)',
    ].join(';');
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
  }, durationMs);

  return {
    success: true,
    ref: label,
    box: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
};
