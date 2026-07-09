import { GLIDE_BRIDGE_MESSAGE_TYPE, type GlideBridgeOp } from '../tools/content-bridge.js';
import {
  CLICKABLE_SELECTOR,
  INTERACTIVE_SELECTOR,
  collectElements,
  deepQuerySelector,
  dismissOpenModal,
  extractPageStructure,
  findClickableByText,
  findElementsByQuery,
  isVisible,
  listOpenDialogs,
  normalizeText,
  performHover,
  performMouseAction,
  performRichClick,
  pressKeyOnTarget,
  resolveInteractiveTarget,
  resolveProfileStatLink,
  scrollPage,
  sleep,
  waitForDialog,
  waitForNewDialog,
} from './dom-interact.js';

const BRIDGE_FLAG = '__glide_bridge_installed__';

const dispatchInputEvents = (element: HTMLElement, value: string) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (element.isContentEditable) {
    element.focus();
    element.textContent = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
  }
};

const resolveClickTarget = (selector: string): HTMLElement | null => {
  // Unstable Instagram utility classes (.x1i10hfl, .x1n2onr6, …) match the wrong node
  // first — prefer text/href resolution when the selector looks like that.
  const looksLikeIgUtilityClass = /^\.x[a-z0-9]{4,}$/i.test(selector.trim());

  const bySelector = !looksLikeIgUtilityClass ? deepQuerySelector<HTMLElement>(selector) : null;
  if (bySelector && isVisible(bySelector)) return bySelector;

  // Text / label fallback when model passes a pseudo-selector or bare word.
  const textHint = (() => {
    const quoted = selector.match(/["']([^"']+)["']/);
    if (quoted?.[1]) return quoted[1].trim();
    const bare = selector.replace(/^[#.\[\]="']+/g, '').replace(/[_-]+/g, ' ').trim();
    if (!bare || bare.length < 2) return '';
    if (/[ >:[\]#]/.test(selector) && !quoted) return '';
    return bare;
  })();
  if (textHint) {
    const byStat = resolveProfileStatLink(textHint);
    if (byStat) return byStat;
    const byText = findClickableByText(textHint);
    if (byText) return byText;
  }

  // Do NOT fall back to pure Instagram utility classes (.x1i10hfl) — first match is
  // almost always the wrong node (success-on-wrong-target wastes a full model turn).
  // Prefer ELEMENT_NOT_FOUND + similar_elements / profile-stat hints instead.
  if (looksLikeIgUtilityClass) {
    return null;
  }

  return bySelector && isVisible(bySelector) ? bySelector : null;
};

const handleClick = async (payload: Record<string, unknown>) => {
  const selector = String(payload.selector || '').trim();
  const retries = typeof payload.retries === 'number' ? Math.max(1, Math.min(5, Number(payload.retries))) : 2;
  const waitForModal = payload.waitForDialog !== false;
  if (!selector) return { success: false, code: 'INVALID_SELECTOR', error: 'Missing selector.' };

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const element = resolveClickTarget(selector);
    if (element) {
      const disabled =
        (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true';
      if (disabled) {
        return { success: false, code: 'ELEMENT_DISABLED', error: 'Target element is disabled.' };
      }
      // Count dialogs BEFORE click so we only wait for a *new* modal (no 900ms tax on every click).
      const dialogsBefore = listOpenDialogs().length;
      const result = performRichClick(element);
      let openedDialog: ReturnType<typeof listOpenDialogs>[number] | null = null;
      if (waitForModal) {
        // Short progressive poll (~320ms max) — exits early if nothing opens / if dialog already there.
        openedDialog = await waitForNewDialog(dialogsBefore, 320);
      }
      const dialogsNow = listOpenDialogs().length;
      return {
        ...result,
        strategy: `bridge-${result.strategy}`,
        attempt,
        openedDialog: openedDialog || undefined,
        dialogOpen: Boolean(openedDialog),
        dialogsOpen: dialogsNow,
      };
    }
    if (attempt < retries) await sleep(200 * attempt);
  }

  // Prefer profile-stat anchors in recovery hints when the query smells like Instagram stats.
  const statHint = resolveProfileStatLink(selector);
  const similarBase = collectElements<HTMLElement>(CLICKABLE_SELECTOR, document, 40).filter(isVisible);
  const similar = (statHint ? [statHint, ...similarBase.filter((el) => el !== statHint)] : similarBase)
    .slice(0, 8)
    .map((el) => {
      const id = el.id ? `#${CSS.escape(el.id)}` : '';
      const testId = el.getAttribute('data-testid');
      const aria = normalizeText(el.getAttribute('aria-label') || '');
      const href = el.getAttribute('href') || '';
      const selectorHint =
        id ||
        (testId ? `[data-testid="${CSS.escape(testId)}"]` : '') ||
        (href ? `a[href="${CSS.escape(href)}"]` : '') ||
        (aria ? `[aria-label="${CSS.escape(aria)}"]` : '');
      return {
        tag: el.tagName.toLowerCase(),
        text: normalizeText(el.textContent || '').slice(0, 60),
        aria: aria.slice(0, 60),
        href: href || undefined,
        selector: selectorHint || undefined,
      };
    });

  return {
    success: false,
    code: 'ELEMENT_NOT_FOUND',
    error: `Element not found for selector: ${selector}`,
    hint:
      'For Instagram following/followers use click({ selector: "seguindo" }) or a[href*="/following"]. Avoid generic .x* classes. Prefer findElement({ query: "seguindo" }).',
    similar_elements: similar,
    dialogsOpen: listOpenDialogs().length,
  };
};

const handleType = async (payload: Record<string, unknown>) => {
  const selector = String(payload.selector || '').trim();
  const text = String(payload.text ?? '');
  const retries = typeof payload.retries === 'number' ? Math.max(1, Math.min(5, Number(payload.retries))) : 2;
  if (!selector) return { success: false, code: 'INVALID_SELECTOR', error: 'Missing selector.' };

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let element = deepQuerySelector<HTMLElement>(selector);
    if (!element || !isVisible(element)) {
      // Try text/placeholder match for inputs
      const hint = selector.replace(/^[#.\[\]="']+/g, '').trim();
      if (hint) {
        const inputs = collectElements<HTMLElement>(
          'input, textarea, [contenteditable="true"], [role="textbox"]',
          document,
          80,
        ).filter(isVisible);
        element =
          inputs.find((el) => {
            const ph = normalizeText((el as HTMLInputElement).placeholder || '').toLowerCase();
            const aria = normalizeText(el.getAttribute('aria-label') || '').toLowerCase();
            const name = normalizeText(el.getAttribute('name') || '').toLowerCase();
            const n = hint.toLowerCase();
            return ph.includes(n) || aria.includes(n) || name.includes(n);
          }) || null;
      }
    }
    if (element && isVisible(element)) {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.focus();
      dispatchInputEvents(element, text);
      return { success: true, strategy: 'bridge-type', attempt };
    }
    if (attempt < retries) await sleep(250 * attempt);
  }
  return { success: false, code: 'ELEMENT_NOT_FOUND', error: `Input not found for selector: ${selector}` };
};

const handleWait = async (payload: Record<string, unknown>) => {
  const condition = String(payload.condition || 'time');
  if (condition === 'dialog' || condition === 'modal') {
    const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 5000;
    const dialog = await waitForDialog(Math.min(15000, Math.max(200, timeoutMs)));
    if (dialog) return { success: true, condition: 'dialog', dialog, dialogs: listOpenDialogs() };
    return { success: false, code: 'WAIT_TIMEOUT', error: 'No dialog/modal appeared in time.' };
  }
  if (condition === 'selector') {
    const selector = String(payload.selector || '').trim();
    const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 5000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const element = deepQuerySelector<HTMLElement>(selector);
      if (element && isVisible(element)) {
        return { success: true, condition: 'selector', selector };
      }
      await sleep(100);
    }
    return { success: false, code: 'WAIT_TIMEOUT', error: `Selector not ready: ${selector}` };
  }
  const ms = typeof payload.ms === 'number' ? Math.max(0, payload.ms) : 500;
  await sleep(ms);
  return { success: true, condition: 'time', ms };
};

const handleGetContent = (payload: Record<string, unknown>) => {
  const mode = String(payload.mode || payload.type || 'text').toLowerCase();
  const selector = String(payload.selector || '').trim();
  if (mode === 'dialogs' || mode === 'modals') {
    return { success: true, mode: 'dialogs', dialogs: listOpenDialogs() };
  }
  if (mode === 'structure' && !selector) {
    const maxChars = typeof payload.maxChars === 'number' ? Math.max(200, payload.maxChars) : 8000;
    const maxItems = typeof payload.maxItems === 'number' ? Math.max(10, payload.maxItems) : 40;
    return extractPageStructure(document.body, maxChars, maxItems);
  }
  if (mode !== 'text' || selector) {
    return {
      success: false,
      code: 'BRIDGE_UNSUPPORTED',
      error: 'Content bridge supports getContent modes: text, structure, dialogs (without selector).',
    };
  }
  const maxChars = typeof payload.maxChars === 'number' ? Math.max(100, payload.maxChars) : 8000;
  // textContent is cheaper than innerText (no forced style recalc).
  const text = (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  return { success: true, mode: 'text', text, dialogsOpen: listOpenDialogs().length };
};

const handleDismissModal = async (_payload: Record<string, unknown>) => {
  // Small delay so animations settle
  await sleep(80);
  const result = dismissOpenModal();
  if (!result.success) {
    await sleep(200);
    const retry = dismissOpenModal();
    return { ...retry, bridge: true };
  }
  return { ...result, bridge: true };
};

const handleHover = async (payload: Record<string, unknown>) => {
  const selector = String(payload.selector || '').trim();
  const retries = typeof payload.retries === 'number' ? Math.max(1, Math.min(5, Number(payload.retries))) : 3;
  if (!selector) return { success: false, code: 'INVALID_SELECTOR', error: 'Missing selector.' };

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const element = resolveInteractiveTarget(selector, INTERACTIVE_SELECTOR);
    if (element) {
      const result = performHover(element);
      return { ...result, strategy: `bridge-${result.strategy}`, attempt };
    }
    if (attempt < retries) await sleep(250 * attempt);
  }

  const similar = collectElements<HTMLElement>(INTERACTIVE_SELECTOR, document, 40)
    .filter(isVisible)
    .slice(0, 10)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: normalizeText(el.textContent || '').slice(0, 80),
      aria: normalizeText(el.getAttribute('aria-label') || '').slice(0, 80),
      role: el.getAttribute('role') || '',
    }));

  return {
    success: false,
    code: 'ELEMENT_NOT_FOUND',
    error: `Hover target not found: ${selector}`,
    hint: 'Use findElement() or getContent({ mode: "structure" }) to locate a stable hover target.',
    similar_elements: similar,
    attempts: retries,
  };
};

const handleMouse = async (payload: Record<string, unknown>) => {
  const selector = String(payload.selector || '').trim();
  const action = String(payload.action || '');
  const retries = typeof payload.retries === 'number' ? Math.max(1, Math.min(5, Number(payload.retries))) : 3;
  if (!selector) return { success: false, code: 'INVALID_SELECTOR', error: 'Missing selector.' };

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const element = resolveInteractiveTarget(selector, INTERACTIVE_SELECTOR);
    if (element) {
      const result = performMouseAction(element, action);
      if (result) return { ...result, strategy: `bridge-${result.strategy}`, attempt };
    }
    if (attempt < retries) await sleep(250 * attempt);
  }

  const similar = collectElements<HTMLElement>(INTERACTIVE_SELECTOR, document, 40)
    .filter(isVisible)
    .slice(0, 10)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: normalizeText(el.textContent || '').slice(0, 80),
      aria: normalizeText(el.getAttribute('aria-label') || '').slice(0, 80),
      role: el.getAttribute('role') || '',
    }));

  return {
    success: false,
    code: 'ELEMENT_NOT_FOUND',
    error: `Mouse target not found: ${selector}`,
    hint: 'Use findElement() or getContent({ mode: "structure" }) to locate a stable mouse target.',
    similar_elements: similar,
    attempts: retries,
  };
};

const handlePressKey = (payload: Record<string, unknown>) => {
  const key = String(payload.key || '');
  const selector = payload.selector ? String(payload.selector) : '';
  if (!key) return { success: false, code: 'INVALID_ARGS', error: 'Missing key.' };
  return pressKeyOnTarget(key, selector || undefined);
};

const handleScroll = (payload: Record<string, unknown>) => {
  const direction = String(payload.direction || 'down');
  const amount = typeof payload.amount === 'number' ? payload.amount : 600;
  return scrollPage(direction, amount);
};

const handleFindElement = (payload: Record<string, unknown>) => {
  return findElementsByQuery({
    query: String(payload.query || ''),
    typeFilter: String(payload.type || 'any'),
    maxResults: typeof payload.maxResults === 'number' ? payload.maxResults : 5,
    fuzzy: payload.fuzzy !== false,
    scope: String(payload.scope || 'auto'),
  });
};

const bridgeHandlers: Record<GlideBridgeOp, (payload: Record<string, unknown>) => Promise<unknown> | unknown> = {
  ping: () => ({ success: true, bridge: true }),
  click: handleClick,
  type: handleType,
  wait: handleWait,
  getContent: handleGetContent,
  dismissModal: handleDismissModal,
  hover: handleHover,
  mouse: handleMouse,
  pressKey: handlePressKey,
  scroll: handleScroll,
  findElement: handleFindElement,
};

export const installGlideBridge = () => {
  const globalWindow = window as unknown as Record<string, boolean>;
  if (globalWindow[BRIDGE_FLAG]) return;
  globalWindow[BRIDGE_FLAG] = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== GLIDE_BRIDGE_MESSAGE_TYPE) return false;
    const op = String(message.op || '') as GlideBridgeOp;
    const handler = bridgeHandlers[op];
    if (!handler) {
      sendResponse({ success: false, error: `Unknown bridge op: ${op}` });
      return true;
    }
    void Promise.resolve(handler((message.payload || {}) as Record<string, unknown>))
      .then((result) => sendResponse({ bridge: true, ...(result as Record<string, unknown>) }))
      .catch((error) =>
        sendResponse({
          success: false,
          bridge: true,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  });
};
