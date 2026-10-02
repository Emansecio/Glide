/**
 * Page-context ops injected via chrome.scripting.executeScript.
 *
 * Chrome serializes `func` by source — nothing outside glidePageDomOp's own
 * body exists at runtime in the page. That is why every helper lives INSIDE
 * this single dispatcher: one copy, shared by every op, instead of a copy per
 * injected function.
 */
export type PageDomOpName =
  | 'click'
  | 'clickFrame'
  | 'hover'
  | 'mouse'
  | 'type'
  | 'pressKey'
  | 'scroll'
  | 'findElement'
  | 'dismissModal'
  | 'waitDialog'
  | 'waitSelector'
  | 'getContent'
  | 'somOverlay'
  | 'removeOverlay'
  | 'readPage'
  | 'setInputFiles'
  | 'selectOption'
  | 'measureTarget'
  | 'highlight'
  | 'iframeOffset'
  | 'frameSrc'
  | 'dragTargetPoint'
  | 'cookieCsrf'
  | 'historyNav';

// eslint-disable-next-line sonarjs/cognitive-complexity -- serialized dispatcher
export function glidePageDomOp(op: PageDomOpName, p: Record<string, any>): any {
  // ---------------------------------------------------------------------------
  // Shared helpers (defined once for all ops)
  // ---------------------------------------------------------------------------
  const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  const normalize = (value: string) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const normalizeLower = (v: string) => normalize(v).toLowerCase();

  const deepQuerySelector = (query: string): any => {
    if (!query.includes('>>>')) {
      try {
        return document.querySelector(query);
      } catch {
        return null;
      }
    }
    const parts = query
      .split('>>>')
      .map((part) => part.trim())
      .filter(Boolean);
    let root: Document | ShadowRoot | Element = document;
    for (let index = 0; index < parts.length; index += 1) {
      let next: Element | null = null;
      try {
        next = root.querySelector(parts[index]);
      } catch {
        return null;
      }
      if (!next) return null;
      if (index === parts.length - 1) return next;
      const shadow = (next as HTMLElement).shadowRoot;
      if (!shadow) return null;
      root = shadow;
    }
    return null;
  };

  /** querySelectorAll across shadow roots, with optional caps on results/scan. */
  const allElements = (
    query: string,
    root: Document | Element = document,
    maxResults = Number.POSITIVE_INFINITY,
  ): any[] => {
    const results: any[] = [];
    let shadowScanned = 0;
    const MAX_SHADOW_SCAN = 4000;
    const visit = (node: Document | ShadowRoot | Element) => {
      if (results.length >= maxResults) return;
      let matches: Element[] = [];
      try {
        matches = Array.from(node.querySelectorAll(query));
      } catch {
        return;
      }
      for (const element of matches) {
        results.push(element);
        if (results.length >= maxResults) return;
      }
      if (shadowScanned >= MAX_SHADOW_SCAN) return;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      let current = walker.nextNode() as HTMLElement | null;
      while (current && shadowScanned < MAX_SHADOW_SCAN) {
        shadowScanned += 1;
        if (current.shadowRoot) visit(current.shadowRoot);
        current = walker.nextNode() as HTMLElement | null;
      }
    };
    visit(root);
    return results;
  };

  /** Shadow-host walker factory — ops that need their own scan counter use this. */
  const makeShadowWalker = (maxShadowScan = 4000) => {
    let scanned = 0;
    return (base: Document | ShadowRoot | Element, visitShadow: (shadow: ShadowRoot) => void) => {
      const walker = document.createTreeWalker(base, NodeFilter.SHOW_ELEMENT);
      let current = walker.nextNode() as HTMLElement | null;
      while (current && scanned < maxShadowScan) {
        scanned += 1;
        if (current.shadowRoot) visitShadow(current.shadowRoot);
        current = walker.nextNode() as HTMLElement | null;
      }
    };
  };

  const isVisibleBox = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const isVisibleCss = (element: HTMLElement) => {
    if (!element || element.hidden) return false;
    if ((element as HTMLInputElement).type === 'hidden') return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return true;
  };

  const isVisibleMid = (element: HTMLElement) => {
    if (element.hidden) return false;
    if ((element as HTMLInputElement).type === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (element.offsetParent === null) {
      const style = window.getComputedStyle(element);
      if (style.position !== 'fixed' && style.position !== 'sticky') return false;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  };

  const isVisibleStrict = (element: HTMLElement) => {
    if (!element || element.hidden) return false;
    if ((element as HTMLInputElement).type === 'hidden') return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const checkVisibility = (
      element as HTMLElement & {
        checkVisibility?: (options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean;
      }
    ).checkVisibility;
    if (typeof checkVisibility === 'function') {
      try {
        if (!checkVisibility.call(element, { checkOpacity: true, checkVisibilityCSS: true })) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      } catch {
        // fall through
      }
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (element.offsetParent === null) {
      const style = window.getComputedStyle(element);
      if (style.position !== 'fixed' && style.position !== 'sticky') {
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
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
    }
    return true;
  };

  /** First-attribute-wins selector (getContent/overlay/readPage flavor). */
  const buildLocalSelectorSimple = (element: any, options?: any): string => {
    options = options || {};
    const el = element as HTMLElement;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const name = el.getAttribute('name');
    if (name) return `[name="${CSS.escape(name)}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria) return `[aria-label="${CSS.escape(aria)}"]`;
    const ph = (el as HTMLInputElement).placeholder;
    if (ph) return `[placeholder="${CSS.escape(ph)}"]`;
    const cls = Array.from(el.classList || []).find((c) => /^[a-z][a-z0-9_-]{2,40}$/i.test(c) && !/[0-9]{5,}/.test(c));
    if (cls) return `.${cls}`;
    const parent = el.parentElement;
    if (parent) {
      const tag = el.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter((c) => c.tagName.toLowerCase() === tag);
      return `${tag}:nth-of-type(${siblings.indexOf(el) + 1})`;
    }
    return el.tagName.toLowerCase();
  };
  const buildOptimalSelectorSimple = (element: Element): string => {
    const local = buildLocalSelectorSimple(element);
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      return `${buildOptimalSelectorSimple(root.host)} >>> ${local}`;
    }
    return local;
  };

  /** Uniqueness-checking selector (findElement flavor). */
  const buildLocalSelectorUnique = (element: any, options?: any): string => {
    options = options || {};
    const root = element.getRootNode();
    const unique = (selector: string) => {
      try {
        const matches = root.querySelectorAll(selector);
        return matches.length === 1 && matches[0] === element;
      } catch {
        return false;
      }
    };
    const candidates: string[] = [];
    if (element.id) candidates.push('#' + CSS.escape(element.id));
    const attributes = ['data-testid', 'name', 'aria-label'];
    if (options.includePlaceholder) attributes.push('placeholder');
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (value) candidates.push('[' + attribute + '="' + CSS.escape(value) + '"]');
    }
    const classes = Array.from(element.classList).filter(
      (c: any) => /^[a-z][a-z0-9_-]{2,40}$/i.test(c) && !/[0-9]{5,}/.test(c) && !/^x[a-z0-9]{4,}$/i.test(c),
    ) as string[];
    for (let count = 1; count <= Math.min(3, classes.length); count += 1) {
      candidates.push(
        classes
          .slice(0, count)
          .map((name) => '.' + CSS.escape(name))
          .join(''),
      );
    }
    for (const candidate of candidates) {
      if (unique(candidate)) return candidate;
    }
    const segments: string[] = [];
    let current = element;
    while (current && current !== root) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((child: any) => child.tagName === current.tagName)
        : [];
      const index = siblings.indexOf(current) + 1;
      segments.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
      const selector = segments.join(' > ');
      if (unique(selector)) return selector;
      current = parent;
    }
    return segments.join(' > ') || element.tagName.toLowerCase();
  };
  const buildOptimalSelectorUnique = (element: any): string => {
    const localSelector = buildLocalSelectorUnique(element, { includePlaceholder: true });
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      return buildOptimalSelectorUnique(root.host) + ' >>> ' + localSelector;
    }
    return localSelector;
  };

  const textHintFromSelector = (selectorText: string, minLen: number) => {
    const quoted = selectorText.match(/["']([^"']+)["']/);
    if (quoted?.[1]) return quoted[1].trim();
    const bare = selectorText.replace(/^[#.]/, '').replace(/[_-]+/g, ' ').trim();
    if (!bare || bare.length < minLen) return '';
    if (/[ >:[\]()]/.test(selectorText)) return '';
    return bare;
  };

  const findByTextIn = (query: string, candidateQuery: string) => {
    const needle = normalizeLower(query);
    if (!needle) return null;
    return (
      allElements(candidateQuery).find((element: HTMLElement) => {
        const text = normalizeLower(element.textContent || '');
        const aria = normalizeLower(element.getAttribute('aria-label') || '');
        const title = normalizeLower(element.getAttribute('title') || '');
        const value = normalizeLower((element as HTMLInputElement).value || '');
        const testId = normalizeLower(element.getAttribute('data-testid') || '');
        return (
          text.includes(needle) ||
          aria.includes(needle) ||
          title.includes(needle) ||
          value.includes(needle) ||
          testId.includes(needle)
        );
      }) || null
    );
  };

  const getLabel = (inputElement: Element): string => {
    const id = inputElement.getAttribute('id');
    if (id) {
      const labelByFor = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (labelByFor?.textContent) return normalize(labelByFor.textContent);
    }
    const parentLabel = inputElement.closest('label');
    if (parentLabel?.textContent) return normalize(parentLabel.textContent);
    return '';
  };

  const getInputCandidates = () =>
    allElements('input, textarea, select, [contenteditable="true"]') as Array<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement
    >;

  const findInputByHint = (hint: string) => {
    const needle = normalizeLower(hint);
    if (!needle) return null;
    return (
      getInputCandidates().find((candidate) => {
        const placeholder = normalizeLower((candidate as HTMLInputElement).placeholder || '');
        const name = normalizeLower(candidate.getAttribute('name') || '');
        const aria = normalizeLower(candidate.getAttribute('aria-label') || '');
        const title = normalizeLower(candidate.getAttribute('title') || '');
        const label = getLabel(candidate).toLowerCase();
        return (
          placeholder.includes(needle) ||
          name.includes(needle) ||
          aria.includes(needle) ||
          title.includes(needle) ||
          label.includes(needle)
        );
      }) || null
    );
  };

  const applyValue = (
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement,
    nextValue: string,
  ) => {
    const isSelect = element instanceof HTMLSelectElement;
    const isTextFormField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    const disabled =
      ((isTextFormField || isSelect) && (element as HTMLInputElement).disabled === true) ||
      element.getAttribute('aria-disabled') === 'true';
    const readOnly = isTextFormField && (element as HTMLInputElement).readOnly === true;
    if (disabled || readOnly) return false;

    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.focus();

    if (isSelect) {
      const normalizedValue = normalizeLower(nextValue);
      const options = Array.from((element as HTMLSelectElement).options);
      const option =
        options.find((candidate) => candidate.value === nextValue) ||
        options.find((candidate) => normalize(candidate.textContent || '') === normalize(nextValue)) ||
        options.find(
          (candidate) =>
            candidate.value.toLowerCase() === normalizedValue ||
            normalizeLower(candidate.textContent || '') === normalizedValue,
        ) ||
        options.find(
          (candidate) =>
            candidate.value.toLowerCase().includes(normalizedValue) ||
            normalizeLower(candidate.textContent || '').includes(normalizedValue),
        );
      if (!option) return false;
      (element as HTMLSelectElement).value = option.value;
      option.selected = true;
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return (element as HTMLSelectElement).value === option.value;
    }

    const beforeInput =
      typeof InputEvent !== 'undefined'
        ? new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            composed: true,
            inputType: 'insertText',
            data: nextValue,
          })
        : new Event('beforeinput', { bubbles: true, cancelable: true });
    const shouldContinue = element.dispatchEvent(beforeInput);
    if (!shouldContinue) return false;

    if (isTextFormField) {
      try {
        (element as HTMLInputElement).setSelectionRange(0, (element as HTMLInputElement).value.length);
      } catch {
        // Some input types do not support text selection.
      }
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
      if (descriptor?.set) {
        descriptor.set.call(element, nextValue);
      } else {
        (element as HTMLInputElement).value = nextValue;
      }
      element.dispatchEvent(
        typeof InputEvent !== 'undefined'
          ? new InputEvent('input', {
              bubbles: true,
              cancelable: false,
              composed: true,
              inputType: 'insertText',
              data: nextValue,
            })
          : new Event('input', { bubbles: true }),
      );
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return String((element as HTMLInputElement).value) === String(nextValue);
    }
    element.textContent = nextValue;
    if (typeof InputEvent !== 'undefined') {
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          composed: true,
          inputType: 'insertText',
          data: nextValue,
        }),
      );
    } else {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
    const applied = normalize(element.textContent || '');
    const want = normalize(nextValue);
    return !want || applied === want || applied.includes(want);
  };

  const roleOf = (el: HTMLElement) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') return (el as HTMLInputElement).type || 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    return tag;
  };

  const nameOfRead = (el: HTMLElement) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
      if (normalize(parts)) return normalize(parts).slice(0, 120);
    }
    return normalize(
      el.getAttribute('aria-label') ||
        (el as HTMLInputElement).placeholder ||
        el.getAttribute('title') ||
        el.getAttribute('name') ||
        el.getAttribute('alt') ||
        el.textContent ||
        '',
    ).slice(0, 120);
  };

  const nameOfOverlay = (el: HTMLElement) =>
    normalize(
      el.getAttribute('aria-label') ||
        (el as HTMLInputElement).placeholder ||
        el.getAttribute('title') ||
        el.getAttribute('name') ||
        el.getAttribute('alt') ||
        el.textContent ||
        '',
    ).slice(0, 80);

  const centerOf = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  };

  /** Ref ("e42") resolution mirroring readPage element collection order. */
  const resolveReadPageRef = (refId: string, scope: string, interactiveOnly: boolean): HTMLElement | null => {
    const normalizedRef = String(refId || '')
      .trim()
      .toLowerCase();
    if (!/^e\d+$/.test(normalizedRef)) return null;
    const targetIndex = Number.parseInt(normalizedRef.slice(1), 10);
    if (!Number.isFinite(targetIndex) || targetIndex < 1) return null;

    const DIALOG_SEL_R = '[role="dialog"], [aria-modal="true"], div[role="dialog"]';
    const INTERACTIVE_R =
      'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [contenteditable="true"], [tabindex="0"]';
    const LANDMARKS_R = 'main, nav, header, footer, h1, h2, h3, [role="navigation"], [role="main"]';

    let root: Document | Element = document;
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SEL_R)).filter(isVisibleBox);
    if (scope === 'dialog' || (scope === 'auto' && dialogs.length)) {
      root = dialogs[dialogs.length - 1] || document;
    }

    const collected: HTMLElement[] = [];
    const walkShadow = makeShadowWalker();
    const visit = (base: Document | Element | ShadowRoot) => {
      if (collected.length >= targetIndex * 2) return;
      for (const el of Array.from(base.querySelectorAll<HTMLElement>(INTERACTIVE_R))) {
        collected.push(el);
        if (collected.length >= targetIndex * 2) return;
      }
      if (!interactiveOnly) {
        for (const el of Array.from(base.querySelectorAll<HTMLElement>(LANDMARKS_R))) {
          collected.push(el);
        }
      }
      walkShadow(base, visit);
    };
    visit(root);

    const seen = new Set<HTMLElement>();
    let idx = 0;
    for (const el of collected) {
      if (seen.has(el) || !isVisibleBox(el)) continue;
      seen.add(el);
      idx += 1;
      if (idx === targetIndex) return el;
    }
    return null;
  };

  const DIALOG_FULL = '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]';
  const DIALOG_BASIC = '[role="dialog"], [aria-modal="true"], div[role="dialog"]';
  const INTERACTIVE =
    'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [contenteditable="true"], [tabindex="0"]';
  const TARGET_QUERY =
    'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [aria-label], [title], [data-testid], [onclick]';

  // ---------------------------------------------------------------------------
  // Ops
  // ---------------------------------------------------------------------------

  if (op === 'dragTargetPoint') {
    const element = document.querySelector(String(p.sel || ''));
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  if (op === 'frameSrc') {
    const sel = String(p.sel || '');
    let element: Element | null = null;
    try {
      element = document.querySelector(sel);
    } catch {
      return { success: false, code: 'INVALID_SELECTOR', error: `Invalid frameSelector: ${sel}` };
    }
    if (!element) {
      return { success: false, code: 'FRAME_NOT_FOUND', error: `No element matched frameSelector: ${sel}` };
    }
    if (element.tagName !== 'IFRAME') {
      return {
        success: false,
        code: 'FRAME_NOT_FOUND',
        error: `frameSelector matched <${element.tagName.toLowerCase()}>, not an iframe.`,
      };
    }
    const iframe = element as HTMLIFrameElement;
    const rawSrc = iframe.src || iframe.getAttribute('src') || '';
    return { success: true, src: rawSrc };
  }

  if (op === 'iframeOffset') {
    const sel = String(p.sel || '');
    const urlNeedle = String(p.urlNeedle || '');
    let iframe: HTMLIFrameElement | null = null;
    if (sel) {
      try {
        const el = document.querySelector(sel);
        if (el?.tagName === 'IFRAME') iframe = el as HTMLIFrameElement;
      } catch {
        return { success: false, code: 'INVALID_SELECTOR', error: 'Invalid frameSelector.' };
      }
    }
    if (!iframe && urlNeedle) {
      for (const candidate of Array.from(document.querySelectorAll('iframe'))) {
        const src = candidate.src || candidate.getAttribute('src') || '';
        if (src.includes(urlNeedle)) {
          iframe = candidate;
          break;
        }
      }
    }
    if (!iframe) {
      return { success: false, code: 'FRAME_NOT_FOUND', error: 'Could not locate iframe element in top document.' };
    }
    const rect = iframe.getBoundingClientRect();
    return {
      success: true,
      offset: { x: rect.left, y: rect.top },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  if (op === 'cookieCsrf') {
    const m = document.cookie.match(/(?:^|; )csrftoken=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  if (op === 'historyNav') {
    const act = String(p.act || '');
    if (act === 'back') window.history.back();
    else if (act === 'forward') window.history.forward();
    else window.location.reload();
    return { success: true, strategy: 'injected' };
  }

  if (op === 'waitDialog') {
    const to = Number(p.to);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const sel = '[role="dialog"], [aria-modal="true"], div[role="dialog"]';
      const tick = () => {
        const open = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(isVisibleBox);
        if (open.length) {
          resolve({ success: true, condition: 'dialog', dialogsOpen: open.length, elapsed: Date.now() - t0 });
          return;
        }
        if (Date.now() - t0 >= to) {
          resolve({ success: false, code: 'WAIT_TIMEOUT', error: 'No dialog appeared.', elapsed: Date.now() - t0 });
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  if (op === 'waitSelector') {
    const sel = String(p.sel || '');
    const to = Number(p.to);
    const intv = Number(p.intv);
    const hidden = p.hidden === true;
    const resolvedCondition = String(p.resolvedCondition || '');
    const loose = p.loose === true;
    const checkVis = loose ? isVisibleBox : isVisibleStrict;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        try {
          const element = deepQuerySelector(sel);
          const ready = hidden
            ? !element || !checkVis(element as HTMLElement)
            : Boolean(element && checkVis(element as HTMLElement));
          if (ready) {
            resolve({
              success: true,
              found: true,
              elapsed: Date.now() - t0,
              selector: sel,
              condition: resolvedCondition,
            });
            return;
          }
        } catch {
          // Invalid selector, keep waiting
        }
        if (Date.now() - t0 >= to) {
          resolve({
            success: true,
            found: false,
            elapsed: Date.now() - t0,
            selector: sel,
            condition: resolvedCondition,
          });
          return;
        }
        setTimeout(check, intv);
      };
      check();
    });
  }

  if (op === 'pressKey') {
    const k = String(p.k || '');
    const sel = String(p.sel || '');
    const mods = p.mods;
    const allowed = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    const normalizedMods = Array.isArray(mods)
      ? mods.map((m: any) => String(m || '').trim()).filter((m: string) => allowed.has(m))
      : [];
    const shouldEdit = (keyName: string) => {
      const lower = String(keyName || '').toLowerCase();
      if (lower === 'backspace' || lower === 'delete') return true;
      if (normalizedMods.length > 0) return false;
      return String(keyName || '').length === 1;
    };
    let target: HTMLElement | null = null;
    if (sel) {
      try {
        target = deepQuerySelector(sel);
      } catch {
        return { success: false, code: 'INVALID_SELECTOR', error: `Invalid selector syntax: ${String(sel)}` };
      }
      if (!target) return { success: false, code: 'ELEMENT_NOT_FOUND', error: 'Target not found.' };
      try {
        target.focus?.({ preventScroll: true } as FocusOptions);
      } catch {
        target.focus?.();
      }
    } else {
      target = (document.activeElement as HTMLElement | null) || document.body;
    }
    if (!target) return { success: false, error: 'Target not found.' };
    const init: KeyboardEventInit = {
      key: k,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: normalizedMods.includes('Control'),
      altKey: normalizedMods.includes('Alt'),
      shiftKey: normalizedMods.includes('Shift'),
      metaKey: normalizedMods.includes('Meta'),
    };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    if (shouldEdit(k)) {
      if (typeof InputEvent !== 'undefined') {
        target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      } else {
        target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      }
      target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }
    return { success: true, modifiers: normalizedMods.length ? normalizedMods : undefined };
  }

  if (op === 'scroll') {
    const dir = p.dir;
    const amt = p.amt;
    const sel = p.sel;
    const strat = p.strat;
    const step = Math.abs(amt) || 600;
    const mode = String(strat || 'auto').toLowerCase();
    const isScrollable = (el: any) => {
      if (!el || el.nodeType !== 1) return false;
      if (el.scrollHeight - el.clientHeight <= 4) return false;
      const oy = getComputedStyle(el).overflowY;
      return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
    };
    const nearest = (start: any) => {
      let node = start;
      for (let d = 0; node && d < 30; d += 1) {
        if (isScrollable(node)) return node;
        node = node.parentElement;
      }
      return null;
    };
    const DIALOG_SEL =
      '[role="dialog"], [aria-modal="true"], [data-testid*="modal" i], [class*="Dialog" i], [class*="modal" i]';
    const resolveTarget = () => {
      if (sel) {
        const scoped = nearest(document.querySelector(sel));
        if (scoped) return scoped;
      }
      const dialogs = Array.from(document.querySelectorAll(DIALOG_SEL)).filter((el: any) => isVisibleBox(el));
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return null;
      let best: any = null;
      let bestOverflow = 0;
      const scan = (el: any) => {
        if (!isScrollable(el)) return;
        const overflow = el.scrollHeight - el.clientHeight;
        if (overflow > bestOverflow) {
          best = el;
          bestOverflow = overflow;
        }
      };
      scan(dialog);
      const nodes = dialog.querySelectorAll('*');
      const limit = Math.min(nodes.length, 3000);
      for (let i = 0; i < limit; i += 1) scan(nodes[i]);
      return best;
    };
    const container = resolveTarget() as HTMLElement | null;
    if (container) {
      const before = container.scrollTop;
      const maxBefore = container.scrollHeight - container.clientHeight;
      let target = before + step;
      if (dir === 'top') target = 0;
      else if (dir === 'bottom') target = maxBefore;
      else if (dir === 'up') target = Math.max(0, before - step);
      else target = Math.min(maxBefore, before + step);
      const deltaY = dir === 'up' || dir === 'top' ? -step : step;
      let intoViewUsed = false;
      if (mode === 'auto' || mode === 'intoview') {
        const kids = container.querySelectorAll('a, [role="listitem"], li');
        if (kids.length) {
          const preferEnd = dir === 'down' || dir === 'bottom';
          const edge = preferEnd ? kids[kids.length - 1] : kids[0];
          try {
            edge.scrollIntoView({
              block: preferEnd ? 'end' : 'start',
              inline: 'nearest',
              behavior: 'instant',
            });
            intoViewUsed = true;
          } catch (_e) {}
        }
      }
      if (mode === 'auto' || mode === 'wheel') {
        const rect = container.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + Math.min(rect.height * 0.85, rect.height - 8);
        const burst = 5;
        const stepDelta = deltaY / burst;
        for (let i = 0; i < burst; i += 1) {
          try {
            container.dispatchEvent(
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
          } catch (_e) {}
        }
      }
      if (mode !== 'intoview') container.scrollTop = target;
      else if (!intoViewUsed) container.scrollTop = target;
      try {
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch (_e) {}
      const after = container.scrollTop;
      const maxAfter = container.scrollHeight - container.clientHeight;
      const delta = after - before;
      return {
        success: true,
        direction: dir,
        amount: amt,
        strategy: mode,
        target: 'container',
        intoViewUsed,
        scrolled: Math.abs(delta) > 0.5 || intoViewUsed,
        delta,
        scrollTop: after,
        maxScrollTop: maxAfter,
        atBottom: after >= maxAfter - 4,
      };
    }
    const beforeY = window.scrollY;
    if (dir === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
    else if (dir === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    else if (dir === 'up') window.scrollBy({ top: -step, behavior: 'instant' });
    else window.scrollBy({ top: step, behavior: 'instant' });
    const afterY = window.scrollY;
    const maxY = Math.max(0, document.body.scrollHeight - window.innerHeight);
    const delta = afterY - beforeY;
    return {
      success: true,
      direction: dir,
      amount: amt,
      strategy: mode,
      target: 'window',
      scrolled: Math.abs(delta) > 0.5,
      delta,
      scrollTop: afterY,
      maxScrollTop: maxY,
      atBottom: afterY >= maxY - 4,
    };
  }

  if (op === 'dismissModal') {
    return (async () => {
      const dialogSel = '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]';
      const closeSel =
        'button[aria-label*="close" i], button[aria-label*="fechar" i], [role="button"][aria-label*="close" i], svg[aria-label="Close"], svg[aria-label="Fechar"]';
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVisibleBox);
      const pressEscape = () => {
        const target = dialogs[dialogs.length - 1] || document.body;
        const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
      };
      const richClick = (el: HTMLElement) => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        const clientX = Math.round(rect.left + rect.width / 2);
        const clientY = Math.round(rect.top + rect.height / 2);
        const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, button: 0 };
        el.dispatchEvent(new MouseEvent('mousedown', init));
        el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
        try {
          el.click();
        } catch {
          el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
        }
      };

      const before = dialogs.length;
      const root: Document | HTMLElement = dialogs[dialogs.length - 1] || document;
      let closeBtn =
        Array.from(root.querySelectorAll<HTMLElement>(closeSel)).find(isVisibleBox) ||
        Array.from(document.querySelectorAll<HTMLElement>(closeSel)).find(isVisibleBox) ||
        null;
      if (closeBtn?.tagName === 'svg') {
        closeBtn = (closeBtn.closest('button, [role="button"]') as HTMLElement | null) || closeBtn;
      }
      if (closeBtn) {
        richClick(closeBtn);
        const remaining = Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVisibleBox).length;
        if (remaining < before) {
          return { success: true, strategy: 'close-button', dialogsRemaining: remaining };
        }
      }
      pressEscape();
      await sleep(200);
      let after = Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVisibleBox).length;
      if (after < before) {
        return { success: true, strategy: 'escape', dialogsRemaining: after };
      }
      const dialogEl = dialogs[dialogs.length - 1] || null;
      if (dialogEl) {
        const isBackdropOverlay = (hit: HTMLElement, dialog: HTMLElement) => {
          if (dialog.contains(hit)) return false;
          const tag = hit.tagName;
          if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
            return false;
          }
          if (hit.closest('a[href], button, input, select, textarea, [role="button"], [role="link"], nav')) {
            return false;
          }
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
        const backdrop = document.elementFromPoint(8, 8) as HTMLElement | null;
        if (backdrop && isBackdropOverlay(backdrop, dialogEl)) {
          richClick(backdrop);
          await sleep(200);
          after = Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVisibleBox).length;
          if (after < before) {
            return { success: true, strategy: 'backdrop-click', dialogsRemaining: after };
          }
        }
      }
      if (before === 0) {
        return { success: true, strategy: 'escape-no-dialog', dialogsRemaining: after, noop: true };
      }
      return {
        success: false,
        error: 'Could not dismiss modal.',
        hint: 'Try pressKey({ key: "Escape" }) or findElement({ query: "Close", scope: "dialog" }) then click.',
        dialogsRemaining: after,
      };
    })();
  }

  if (op === 'setInputFiles') {
    const sel = String(p.sel || '');
    const fileSpecs = Array.isArray(p.fileSpecs) ? p.fileSpecs : [];
    const input = deepQuerySelector(sel) as HTMLInputElement | null;
    if (!input || input.tagName.toLowerCase() !== 'input') {
      return { success: false, code: 'ELEMENT_NOT_FOUND', error: `File input not found: ${sel}` };
    }
    if (String(input.type || '').toLowerCase() !== 'file') {
      return { success: false, error: 'Target is not input[type=file].' };
    }
    try {
      const dt = new DataTransfer();
      for (const spec of fileSpecs) {
        let blobPart: BlobPart;
        if (spec.contentBase64) {
          const binary = atob(spec.contentBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          blobPart = bytes;
        } else {
          blobPart = spec.content ?? '';
        }
        const file = new File([blobPart], spec.name, { type: spec.mimeType || 'text/plain' });
        dt.items.add(file);
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        success: true,
        count: fileSpecs.length,
        names: fileSpecs.map((f: any) => f.name),
      };
    } catch (error) {
      return { success: false, error: (error as Error)?.message || String(error) };
    }
  }

  if (op === 'measureTarget') {
    let target: HTMLElement | null = null;
    const sel = String(p.sel || '');
    const refId = String(p.refId || '');
    if (sel) target = deepQuerySelector(sel);
    else if (refId) target = resolveReadPageRef(refId, String(p.scope || 'auto'), p.interactiveOnly !== false);
    if (!target || !isVisibleBox(target)) {
      return { success: false, code: 'ELEMENT_NOT_FOUND', error: 'Element screenshot target not found.' };
    }
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = target.getBoundingClientRect();
    return {
      success: true,
      selector: sel || undefined,
      ref: refId || undefined,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  if (op === 'highlight') {
    const sel = String(p.sel || '');
    const refId = String(p.refId || '');
    const duration = Number(p.duration);
    let target: HTMLElement | null = null;
    if (sel) {
      try {
        target = document.querySelector(sel);
      } catch {
        target = null;
      }
    } else if (refId) {
      target = resolveReadPageRef(refId, String(p.scope || 'auto'), p.interactiveOnly !== false);
    }
    if (!target || !isVisibleBox(target)) {
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

  if (op === 'removeOverlay') {
    document.querySelector('[data-glide-som-overlay]')?.remove();
    return { success: true };
  }

  if (op === 'somOverlay') {
    const max = Number(p.max);
    const searchScope = String(p.searchScope || '');
    const OVERLAY_ATTR = 'data-glide-som-overlay';
    document.querySelector(`[${OVERLAY_ATTR}]`)?.remove();

    let root: Document | Element = document;
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_BASIC)).filter(isVisibleCss);
    if (searchScope === 'dialog') {
      root = dialogs[dialogs.length - 1] || document;
    }

    const collected: HTMLElement[] = [];
    const visit = (base: Document | Element | ShadowRoot) => {
      if (collected.length >= max * 2) return;
      for (const el of Array.from(base.querySelectorAll<HTMLElement>(INTERACTIVE))) {
        collected.push(el);
        if (collected.length >= max * 2) return;
      }
    };
    visit(root);

    const seen = new Set<HTMLElement>();
    const marks: Array<Record<string, unknown>> = [];
    let idx = 0;
    for (const el of collected) {
      if (seen.has(el) || !isVisibleCss(el)) continue;
      seen.add(el);
      idx += 1;
      const rect = el.getBoundingClientRect();
      marks.push({
        ref: `e${idx}`,
        selector: buildOptimalSelectorSimple(el),
        tag: el.tagName.toLowerCase(),
        text: nameOfOverlay(el),
        box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      });
      if (marks.length >= max) break;
    }

    const container = document.createElement('div');
    container.setAttribute(OVERLAY_ATTR, '1');
    container.style.cssText = [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      'z-index:2147483646',
      'overflow:visible',
    ].join(';');

    for (const mark of marks) {
      const box = mark.box as { x: number; y: number; w: number; h: number };
      const ref = String(mark.ref || '');
      const labelNum = ref.replace(/^e/i, '') || '?';
      const badge = document.createElement('span');
      badge.textContent = labelNum.slice(0, 3);
      badge.style.cssText = [
        'position:absolute',
        'left:0',
        'top:0',
        `transform:translate(${box.x}px, ${Math.max(0, box.y - 4)}px)`,
        'padding:2px 6px',
        'font:700 11px/14px system-ui,sans-serif',
        'color:#fff',
        'background:#d93025',
        'border-radius:4px',
        'box-shadow:0 1px 3px rgba(0,0,0,.35)',
        'opacity:1',
      ].join(';');
      container.appendChild(badge);
    }

    document.documentElement.appendChild(container);
    return { success: true, marks, scope: searchScope, count: marks.length };
  }

  if (op === 'selectOption') {
    return (async () => {
      const sel = String(p.sel || '');
      const value = p.value;
      const label = p.label;
      const index = p.index;
      const criteriaCount = [value !== undefined, label !== undefined, index !== undefined].filter(Boolean).length;
      if (criteriaCount !== 1) {
        return { success: false, code: 'INVALID_ARGS', error: 'Provide exactly one of value, label, or index.' };
      }
      const element = deepQuerySelector(sel) as HTMLElement | null;
      if (!element || !isVisibleBox(element)) {
        return { success: false, code: 'ELEMENT_NOT_FOUND', error: `Element not found: ${sel}` };
      }
      if (element instanceof HTMLSelectElement) {
        const options = Array.from(element.options);
        let option: HTMLOptionElement | null = null;
        if (index !== undefined) {
          if (index < 0) {
            return { success: false, code: 'INVALID_ARGS', error: 'Index must be >= 0.' };
          }
          option = options[Math.floor(index)] || null;
        } else if (value !== undefined) option = options.find((opt) => opt.value === value) || null;
        else if (label !== undefined) {
          const want = normalizeLower(label);
          option = options.find((opt) => normalizeLower(opt.textContent || opt.label) === want) || null;
        }
        if (!option) {
          return { success: false, code: 'OPTION_NOT_FOUND', error: 'Matching native option not found.' };
        }
        element.value = option.value;
        option.selected = true;
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          success: true,
          kind: 'native',
          selectedLabel: option.textContent || option.label,
          selectedValue: option.value,
        };
      }
      const trigger =
        element.getAttribute('role') === 'combobox'
          ? element
          : (element.closest('[role="combobox"]') as HTMLElement | null) || element;
      trigger.scrollIntoView({ block: 'center', inline: 'center' });
      const listCustomOptions = () =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"], li[role="option"]'),
        ).filter(isVisibleBox);
      const listboxAlreadyOpen =
        trigger.getAttribute('aria-expanded') === 'true' ||
        listCustomOptions().length > 0 ||
        Boolean(
          document.querySelector('[role="listbox"]:not([hidden])') &&
            Array.from(document.querySelectorAll('[role="option"]')).some((el) => isVisibleBox(el as HTMLElement)),
        );
      if (!listboxAlreadyOpen) {
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      const started = Date.now();
      let customOption: HTMLElement | null = null;
      while (Date.now() - started < 1200) {
        const options = listCustomOptions();
        if (index !== undefined) {
          if (index < 0) {
            return { success: false, code: 'INVALID_ARGS', error: 'Index must be >= 0.' };
          }
          customOption = options[Math.floor(index)] || null;
        } else if (value !== undefined) {
          customOption =
            options.find(
              (opt) =>
                opt.getAttribute('data-value') === value ||
                opt.getAttribute('value') === value ||
                opt.getAttribute('data-key') === value,
            ) || null;
        } else if (label !== undefined) {
          const want = normalizeLower(label);
          customOption =
            options.find((opt) => {
              const text = normalizeLower(opt.textContent || '');
              const aria = normalizeLower(opt.getAttribute('aria-label') || '');
              return text === want || aria === want || text.includes(want);
            }) || null;
        }
        if (customOption) break;
        await sleep(80);
      }
      if (!customOption) {
        return { success: false, code: 'OPTION_NOT_FOUND', error: 'Custom option not found.', kind: 'custom' };
      }
      customOption.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return {
        success: true,
        kind: 'custom',
        selectedLabel: customOption.textContent || customOption.getAttribute('aria-label') || '',
        selectedValue:
          customOption.getAttribute('data-value') ||
          customOption.getAttribute('value') ||
          customOption.getAttribute('data-key') ||
          customOption.textContent ||
          '',
      };
    })();
  }

  if (op === 'readPage') {
    const max = Number(p.max);
    const interactive = p.interactive === true;
    const searchScope = String(p.searchScope || '');
    const LANDMARKS = 'main, nav, header, footer, h1, h2, h3, [role="navigation"], [role="main"]';

    let root: Document | Element = document;
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_BASIC)).filter(isVisibleStrict);
    if (searchScope === 'dialog' || (searchScope === 'auto' && dialogs.length)) {
      root = dialogs[dialogs.length - 1] || document;
    }

    const collected: HTMLElement[] = [];
    const walkShadow = makeShadowWalker();
    const visit = (base: Document | Element | ShadowRoot) => {
      if (collected.length >= max * 2) return;
      for (const el of Array.from(base.querySelectorAll<HTMLElement>(INTERACTIVE))) {
        collected.push(el);
        if (collected.length >= max * 2) return;
      }
      if (!interactive) {
        for (const el of Array.from(base.querySelectorAll<HTMLElement>(LANDMARKS))) {
          collected.push(el);
        }
      }
      walkShadow(base, visit);
    };
    visit(root);

    const seen = new Set<HTMLElement>();
    const elements: Array<Record<string, unknown>> = [];
    let idx = 0;
    for (const el of collected) {
      if (seen.has(el) || !isVisibleStrict(el)) continue;
      seen.add(el);
      idx += 1;
      const rect = el.getBoundingClientRect();
      elements.push({
        ref: `e${idx}`,
        role: roleOf(el),
        name: nameOfRead(el),
        tag: el.tagName.toLowerCase(),
        selector: buildOptimalSelectorSimple(el),
        href: (el as HTMLAnchorElement).href || undefined,
        value:
          typeof (el as HTMLInputElement).value === 'string'
            ? String((el as HTMLInputElement).value).slice(0, 80)
            : undefined,
        disabled:
          (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
        box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      });
      if (elements.length >= max) break;
    }

    return {
      success: true,
      url: location.href,
      title: document.title,
      scope: searchScope,
      openDialogs: dialogs.length,
      count: elements.length,
      elements,
      usageHint: 'Use element.selector with click/type. ref is only a label for this snapshot.',
    };
  }

  if (op === 'findElement') {
    const searchQuery = String(p.searchQuery || '');
    const filterType = String(p.filterType || '');
    const maxRes = Number(p.maxRes);
    const useFuzzy = p.useFuzzy === true;
    const searchScope = String(p.searchScope || '');
    const deepScan = p.deepScan === true;
    const needle = normalizeLower(searchQuery);
    if (!needle) return { success: false, error: 'Empty query.' };

    const MAX_FUZZY_FIELD_LEN = 40;
    const MAX_CANDIDATE_SCAN = deepScan ? 300 : 80;
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

    const collectInto = (rootEl: Document | ShadowRoot | Element, bucket: HTMLElement[], walkShadow: any) => {
      if (bucket.length >= MAX_CANDIDATE_SCAN) return;
      const matches = Array.from(rootEl.querySelectorAll<HTMLElement>(INTERACTIVE));
      for (const element of matches) {
        bucket.push(element);
        if (bucket.length >= MAX_CANDIDATE_SCAN) return;
      }
      walkShadow(rootEl, (shadow: ShadowRoot) => collectInto(shadow, bucket, walkShadow));
    };
    const collectElements = (rootEl: Document | ShadowRoot | Element): HTMLElement[] => {
      const bucket: HTMLElement[] = [];
      collectInto(rootEl, bucket, makeShadowWalker());
      return bucket;
    };
    const resolveScopeRoot = (kind: string): Document | Element | null => {
      if (kind === 'page') return document;
      if (kind === 'dialog') {
        const dialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_FULL)).filter(isVisibleBox);
        return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
      }
      if (kind === 'form') {
        const forms = Array.from(document.querySelectorAll<HTMLFormElement>('form')).filter(isVisibleBox);
        return forms.length > 0 ? forms[0] : null;
      }
      if (kind === 'landmark') {
        for (const sel of ['main', '[role="main"]', 'nav']) {
          const el = document.querySelector(sel);
          if (el instanceof HTMLElement && isVisibleBox(el)) return el;
        }
        return null;
      }
      return document;
    };
    const buildScopeOrder = (): string[] => {
      if (searchScope === 'page') return ['page'];
      if (searchScope === 'dialog') return ['dialog'];
      const order = ['dialog'];
      if (String(filterType || 'any').toLowerCase() === 'input') order.push('form');
      order.push('landmark', 'page');
      return order;
    };

    const matchCandidates = (all: HTMLElement[]) => {
      const exactCandidates: HTMLElement[] = [];
      const fuzzyCandidates: Array<{ element: HTMLElement; distance: number }> = [];
      const threshold = useFuzzy ? fuzzyThreshold(needle) : 0;
      const passesTypeFilter = (element: HTMLElement, tag: string) => {
        if (filterType === 'any') return true;
        if (filterType === 'button' && !['button', 'input'].includes(tag) && element.getAttribute('role') !== 'button')
          return false;
        if (filterType === 'link' && tag !== 'a' && element.getAttribute('role') !== 'link') return false;
        if (filterType === 'input' && !['input', 'textarea', 'select'].includes(tag)) return false;
        return true;
      };

      for (const element of all) {
        if (!isVisibleMid(element)) continue;
        const tag = element.tagName.toLowerCase();
        if (!passesTypeFilter(element, tag)) continue;
        const shortFields = [
          normalize(element.getAttribute('aria-label') || ''),
          normalize(element.getAttribute('title') || ''),
          normalize((element as HTMLInputElement).placeholder || ''),
          normalize(element.getAttribute('name') || ''),
          normalize(element.getAttribute('data-testid') || ''),
          normalize(element.id || ''),
        ]
          .filter(Boolean)
          .map((f) => f.toLowerCase());
        if (
          shortFields.some(
            (field) => field === needle || field.includes(needle) || (field.length >= 3 && needle.includes(field)),
          )
        ) {
          exactCandidates.push(element);
          if (exactCandidates.length >= maxRes) break;
        }
      }

      if (exactCandidates.length < maxRes) {
        for (const element of all) {
          if (exactCandidates.includes(element)) continue;
          if (!isVisibleMid(element)) continue;
          const tag = element.tagName.toLowerCase();
          if (!passesTypeFilter(element, tag)) continue;
          const text = normalize(element.innerText || element.textContent || '').toLowerCase();
          if (text && text.length <= 200 && text.includes(needle)) {
            exactCandidates.push(element);
            if (exactCandidates.length >= maxRes) break;
          }
        }
      }

      if (useFuzzy && threshold > 0 && exactCandidates.length < maxRes) {
        for (const element of all) {
          if (exactCandidates.includes(element)) continue;
          if (!isVisibleMid(element)) continue;
          const tag = element.tagName.toLowerCase();
          if (!passesTypeFilter(element, tag)) continue;
          const fields = [
            normalize(element.getAttribute('aria-label') || ''),
            normalize(element.getAttribute('title') || ''),
            normalize((element as HTMLInputElement).placeholder || ''),
            normalize(element.getAttribute('name') || ''),
            normalize(element.getAttribute('data-testid') || ''),
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
        const remaining = maxRes - combined.length;
        for (const fc of fuzzyCandidates.slice(0, remaining)) {
          if (!combined.includes(fc.element)) combined.push(fc.element);
        }
      }
      return combined;
    };

    let searchRoot: Document | Element = document;
    let combined: HTMLElement[] = [];
    for (const kind of buildScopeOrder()) {
      const scopeRoot = resolveScopeRoot(kind);
      if (!scopeRoot) continue;
      combined = matchCandidates(collectElements(scopeRoot));
      if (combined.length > 0) {
        searchRoot = scopeRoot;
        break;
      }
    }

    const openDialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_FULL)).filter(isVisibleBox);

    const results = combined.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        selector: buildOptimalSelectorUnique(element),
        tag: element.tagName.toLowerCase(),
        text: normalize(element.innerText || element.textContent || element.getAttribute('aria-label') || '').slice(
          0,
          120,
        ),
        visible: isVisibleMid(element),
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

    if (results.length === 0) {
      return {
        success: false,
        code: 'ELEMENT_NOT_FOUND',
        error: `No visible element found matching "${searchQuery}".`,
        hint: 'Try getContent({ mode: "structure" }) to inspect available interactive elements.',
        query: searchQuery,
      };
    }

    return {
      success: true,
      query: searchQuery,
      count: results.length,
      candidates: results,
      fuzzy: useFuzzy,
      scope: searchScope,
      dialogsOpen: openDialogs.length,
      searchedInDialog: searchRoot !== document,
    };
  }

  if (op === 'getContent') {
    const t = String(p.t || '');
    const sel = String(p.sel || '');
    const limit = Number(p.limit);
    const maxPerSection = Number(p.maxPerSection);
    const base = (sel ? deepQuerySelector(sel) : document.body) as HTMLElement | null;
    if (!base) return { success: false, error: 'Target not found.' };
    const normalizedType = ['text', 'html', 'title', 'url', 'links', 'structure'].includes(t) ? t : 'text';
    const safeLimit = Number.isFinite(limit) ? Math.max(200, Math.floor(limit)) : 8000;
    const safeMaxItems = Number.isFinite(maxPerSection) ? Math.max(10, Math.floor(maxPerSection)) : 40;
    const truncate = (value: string) => {
      const length = value.length;
      if (length <= safeLimit) {
        return { content: value, truncated: false, contentLength: length };
      }
      return { content: value.slice(0, safeLimit), truncated: true, contentLength: length };
    };
    const extractVisibleText = (rootEl: HTMLElement, maxLen: number) => {
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          if (parent.hidden || parent.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
          const cv = (parent as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
          if (typeof cv === 'function') {
            try {
              if (!cv.call(parent, { checkOpacity: true, checkVisibilityCSS: true })) {
                return NodeFilter.FILTER_REJECT;
              }
              return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            } catch {
              // fall through
            }
          }
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return NodeFilter.FILTER_REJECT;
          }
          return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });

      const chunks: string[] = [];
      let consumed = 0;
      let truncated = false;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim() || '';
        if (!text) continue;
        const remaining = maxLen - consumed;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        if (text.length > remaining) {
          chunks.push(text.slice(0, remaining));
          consumed += remaining;
          truncated = true;
          break;
        }
        chunks.push(text);
        consumed += text.length + 1;
      }

      const content = chunks.join(' ').trim();
      return { content, truncated, contentLength: content.length };
    };
    const extractHtmlPreview = (rootEl: HTMLElement, maxLen: number) => {
      const escapeAttr = (value: string) => value.replace(/"/g, '&quot;');
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let content = '';
      let truncated = false;
      let node: Node | null;

      while ((node = walker.nextNode()) && content.length < maxLen) {
        let chunk = '';
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          const attrs = Array.from(element.attributes)
            .slice(0, 4)
            .map((attr) => `${attr.name}="${escapeAttr(attr.value)}"`)
            .join(' ');
          chunk = attrs ? `<${element.tagName.toLowerCase()} ${attrs}>` : `<${element.tagName.toLowerCase()}>`;
        } else {
          chunk = node.textContent?.trim() || '';
        }

        if (!chunk) continue;
        const remaining = maxLen - content.length;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        if (chunk.length > remaining) {
          content += chunk.slice(0, remaining);
          truncated = true;
          break;
        }
        content += chunk;
      }

      if (!truncated && content.length >= maxLen) {
        truncated = true;
      }

      return { content, truncated, contentLength: content.length };
    };
    const extractStructure = (rootEl: HTMLElement, maxLen: number, maxPerSectionCount: number) => {
      const clip = (value: string, length: number) => {
        const text = String(value || '').trim();
        if (text.length <= length) return text;
        return `${text.slice(0, length)}...`;
      };
      const getSelector = (element: Element): string => buildLocalSelectorSimple(element);

      const dialogNodes = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_FULL)).filter(isVisibleBox);
      const activeDialog = dialogNodes[dialogNodes.length - 1] || null;
      const scanRoot: HTMLElement = activeDialog || rootEl;

      const summarizeField = (element: Element) => {
        const tag = element.tagName.toLowerCase();
        const type = element.getAttribute('type') || '';
        const name = element.getAttribute('name') || '';
        const id = element.getAttribute('id') || '';
        const placeholder = element.getAttribute('placeholder') || '';
        const label =
          element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('alt') || '';
        return {
          tag,
          type: clip(type, 40),
          name: clip(name, 120),
          id: clip(id, 120),
          label: clip(label, 140),
          placeholder: clip(placeholder, 120),
          required: element.hasAttribute('required'),
          disabled: element.hasAttribute('disabled'),
          selector: getSelector(element),
        };
      };

      const structure: Record<string, any> = {
        title: clip(document.title || '', 220),
        url: clip(window.location.href || '', 420),
        dialogOpen: Boolean(activeDialog),
        dialogs: dialogNodes.slice(0, 5).map((el) => ({
          label: clip(el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.textContent || 'dialog', 120),
          selector: getSelector(el),
        })),
        searchedInDialog: Boolean(activeDialog),
        headings: [],
        forms: [],
        actions: [],
        sidebarItems: [],
        cards: [],
        tables: [],
        filters: [],
        tabs: [],
        badges: [],
        kpis: [],
        landmarks: [],
      };

      let truncated = false;
      const approxBytes = (value: unknown): number => {
        if (value == null) return 4;
        if (typeof value === 'string') return value.length + 2;
        if (typeof value === 'number' || typeof value === 'boolean') return 8;
        if (Array.isArray(value)) {
          let n = 2;
          for (let i = 0; i < value.length; i += 1) n += approxBytes(value[i]) + (i > 0 ? 1 : 0);
          return n;
        }
        if (typeof value === 'object') {
          let n = 2;
          let first = true;
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (v === undefined) continue;
            n += k.length + 3 + approxBytes(v) + (first ? 0 : 1);
            first = false;
          }
          return n;
        }
        return 8;
      };
      let structureSerializedLength = Math.ceil(
        approxBytes({
          title: structure.title,
          url: structure.url,
          dialogOpen: structure.dialogOpen,
          dialogs: structure.dialogs,
          searchedInDialog: structure.searchedInDialog,
        }) * 1.08,
      );
      const budgetLimit = Math.floor(maxLen * 0.92);
      const tryPush = (key: string, item: Record<string, any>) => {
        const list = structure[key] as Record<string, any>[];
        const add = approxBytes(item) + 1;
        if (structureSerializedLength + add > budgetLimit) {
          truncated = true;
          return false;
        }
        list.push(item);
        structureSerializedLength += add;
        return true;
      };

      const take = <T extends Element>(selector: string, takeLimit: number): T[] => {
        const out: T[] = [];
        let nodes: NodeListOf<Element>;
        try {
          nodes = scanRoot.querySelectorAll(selector);
        } catch {
          return out;
        }
        const cap = Math.min(takeLimit, nodes.length);
        for (let i = 0; i < cap; i += 1) out.push(nodes[i] as T);
        return out;
      };
      const overscan = maxPerSectionCount + 1;

      const headings = take<HTMLElement>('h1, h2, h3', overscan);
      for (let i = 0; i < headings.length && i < maxPerSectionCount; i += 1) {
        const heading = headings[i];
        const item = { level: heading.tagName.toLowerCase(), text: clip(heading.textContent || '', 220) };
        if (!tryPush('headings', item)) break;
      }
      if (headings.length > maxPerSectionCount) truncated = true;

      const forms = take<HTMLFormElement>('form', overscan);
      for (let i = 0; i < forms.length && i < maxPerSectionCount; i += 1) {
        const form = forms[i];
        const fieldNodes = form.querySelectorAll('input, select, textarea, button');
        const fields: ReturnType<typeof summarizeField>[] = [];
        for (let f = 0; f < fieldNodes.length && f < 16; f += 1) {
          fields.push(summarizeField(fieldNodes[f] as Element));
        }
        const item = {
          id: clip(form.id || '', 120),
          name: clip(form.getAttribute('name') || '', 120),
          method: clip((form.getAttribute('method') || 'get').toUpperCase(), 12),
          action: clip(form.getAttribute('action') || '', 220),
          fields,
        };
        if (!tryPush('forms', item)) break;
      }
      if (forms.length > maxPerSectionCount) truncated = true;

      const actions = take<HTMLElement>(
        'button, a[href], input[type="submit"], input[type="button"], [role="button"], [role="link"], [tabindex="0"]',
        overscan,
      );
      for (let i = 0; i < actions.length && i < maxPerSectionCount; i += 1) {
        const action = actions[i];
        const item = {
          tag: action.tagName.toLowerCase(),
          text: clip(action.textContent || '', 200),
          id: clip(action.id || '', 120),
          href: clip((action as HTMLAnchorElement).href || '', 260),
          disabled: (action as HTMLButtonElement).disabled === true || action.getAttribute('aria-disabled') === 'true',
          selector: getSelector(action),
        };
        if (!tryPush('actions', item)) break;
      }
      if (actions.length > maxPerSectionCount) truncated = true;

      const sidebarCandidates = take<HTMLElement>(
        'aside a[href], nav a[href], [role="navigation"] a[href], aside button, nav button, [role="navigation"] button, [role="menuitem"]',
        overscan,
      );
      for (let i = 0; i < sidebarCandidates.length && i < maxPerSectionCount; i += 1) {
        const candidate = sidebarCandidates[i];
        const item = {
          tag: candidate.tagName.toLowerCase(),
          text: clip(candidate.textContent || candidate.getAttribute('aria-label') || '', 180),
          href: clip((candidate as HTMLAnchorElement).href || '', 240),
          role: clip(candidate.getAttribute('role') || '', 60),
          selector: getSelector(candidate),
        };
        if (!tryPush('sidebarItems', item)) break;
      }
      if (sidebarCandidates.length > maxPerSectionCount) truncated = true;

      const cardCandidates = take<HTMLElement>(
        'article, section, [class*="card" i], [class*="tile" i], [class*="widget" i], [data-card], [data-testid*="card" i]',
        overscan,
      );
      for (let i = 0; i < cardCandidates.length && i < maxPerSectionCount; i += 1) {
        const card = cardCandidates[i];
        const titleNode = card.querySelector('h1, h2, h3, h4, strong, [data-title], [class*="title" i]');
        const summaryText = clip(card.textContent || '', 220);
        const titleText = clip((titleNode as HTMLElement | null)?.textContent || '', 140);
        if (!titleText && summaryText.length < 30) continue;
        const item = {
          tag: card.tagName.toLowerCase(),
          id: clip(card.id || '', 80),
          title: titleText,
          summary: summaryText,
        };
        if (!tryPush('cards', item)) break;
      }
      if (cardCandidates.length > maxPerSectionCount) truncated = true;

      const tableCandidates = take<HTMLTableElement>('table', overscan);
      for (let i = 0; i < tableCandidates.length && i < maxPerSectionCount; i += 1) {
        const table = tableCandidates[i];
        const thNodes = table.querySelectorAll('th');
        const headers: string[] = [];
        for (let h = 0; h < thNodes.length && h < 6; h += 1) {
          const th = clip(thNodes[h].textContent || '', 60);
          if (th) headers.push(th);
        }
        const rowCount = table.querySelectorAll('tbody tr').length || table.querySelectorAll('tr').length;
        const caption = clip(table.querySelector('caption')?.textContent || '', 120);
        const item = { id: clip(table.id || '', 80), caption, rows: rowCount, headers };
        if (!tryPush('tables', item)) break;
      }
      if (tableCandidates.length > maxPerSectionCount) truncated = true;

      const filterCandidates = take<HTMLElement>(
        'input[type="search"], input[placeholder*="busc" i], input[placeholder*="filter" i], select, [aria-label*="filtro" i], [aria-label*="filter" i]',
        overscan,
      );
      for (let i = 0; i < filterCandidates.length && i < maxPerSectionCount; i += 1) {
        const filter = filterCandidates[i];
        const item = {
          tag: filter.tagName.toLowerCase(),
          type: clip((filter as HTMLInputElement).type || '', 40),
          name: clip(filter.getAttribute('name') || '', 80),
          label: clip(
            filter.getAttribute('aria-label') ||
              filter.getAttribute('title') ||
              filter.getAttribute('placeholder') ||
              '',
            140,
          ),
          selector: getSelector(filter),
        };
        if (!tryPush('filters', item)) break;
      }
      if (filterCandidates.length > maxPerSectionCount) truncated = true;

      const tabCandidates = take<HTMLElement>(
        '[role="tab"], [data-tab], [aria-selected], .tab, [class*="tab-" i]',
        overscan,
      );
      for (let i = 0; i < tabCandidates.length && i < maxPerSectionCount; i += 1) {
        const tab = tabCandidates[i];
        const text = clip(tab.textContent || tab.getAttribute('aria-label') || '', 120);
        if (!text) continue;
        const item = {
          text,
          selected: tab.getAttribute('aria-selected') === 'true',
          role: clip(tab.getAttribute('role') || '', 40),
          selector: getSelector(tab),
        };
        if (!tryPush('tabs', item)) break;
      }
      if (tabCandidates.length > maxPerSectionCount) truncated = true;

      const badgeCandidates = take<HTMLElement>(
        '[class*="badge" i], [class*="tag" i], [data-badge], [aria-label*="badge" i]',
        overscan,
      );
      for (let i = 0; i < badgeCandidates.length && i < maxPerSectionCount; i += 1) {
        const badge = badgeCandidates[i];
        const text = clip(badge.textContent || badge.getAttribute('aria-label') || '', 100);
        if (!text || text.length < 2) continue;
        const item = { text, tag: badge.tagName.toLowerCase() };
        if (!tryPush('badges', item)) break;
      }
      if (badgeCandidates.length > maxPerSectionCount) truncated = true;

      const kpiCandidates = take<HTMLElement>(
        '[data-kpi], [class*="kpi" i], [class*="metric" i], [class*="stat" i], [class*="summary-value" i]',
        overscan,
      );
      for (let i = 0; i < kpiCandidates.length && i < maxPerSectionCount; i += 1) {
        const kpi = kpiCandidates[i];
        const valueText = clip(kpi.textContent || '', 100);
        if (!valueText) continue;
        const labelNode =
          kpi.querySelector('[class*="label" i], [data-label], small, span, strong') || kpi.parentElement;
        const labelText = clip((labelNode as HTMLElement | null)?.textContent || '', 120);
        const item = { label: labelText, value: valueText };
        if (!tryPush('kpis', item)) break;
      }
      if (kpiCandidates.length > maxPerSectionCount) truncated = true;

      const landmarks = take<HTMLElement>('main, nav, header, footer, aside, section, article', overscan);
      for (let i = 0; i < landmarks.length && i < maxPerSectionCount; i += 1) {
        const landmark = landmarks[i];
        const item = {
          tag: landmark.tagName.toLowerCase(),
          id: clip(landmark.id || '', 120),
          role: clip(landmark.getAttribute('role') || '', 80),
          label: clip(
            landmark.getAttribute('aria-label') ||
              landmark.getAttribute('title') ||
              landmark.getAttribute('data-testid') ||
              '',
            180,
          ),
        };
        if (!tryPush('landmarks', item)) break;
      }
      if (landmarks.length > maxPerSectionCount) truncated = true;

      const content = JSON.stringify(structure);
      return {
        success: true,
        mode: 'structure',
        structure,
        sections: {
          headings: structure.headings.length,
          forms: structure.forms.length,
          actions: structure.actions.length,
          sidebarItems: structure.sidebarItems.length,
          cards: structure.cards.length,
          tables: structure.tables.length,
          filters: structure.filters.length,
          tabs: structure.tabs.length,
          badges: structure.badges.length,
          kpis: structure.kpis.length,
          landmarks: structure.landmarks.length,
        },
        truncated,
        content,
        contentLength: content.length,
      };
    };
    if (normalizedType === 'html') {
      const result = extractHtmlPreview(base, safeLimit);
      return { success: true, ...result };
    }
    if (normalizedType === 'structure') {
      return extractStructure(base, safeLimit, safeMaxItems);
    }
    if (normalizedType === 'title') {
      const result = truncate(document.title || '');
      return { success: true, ...result };
    }
    if (normalizedType === 'url') {
      const result = truncate(window.location.href || '');
      return { success: true, ...result };
    }
    if (normalizedType === 'links') {
      const maxItems = 200;
      const links: Array<{ text: string; href: string }> = [];
      const anchors = base.getElementsByTagName('a');
      let estimatedLength = 2;
      let truncated = false;

      for (let i = 0; i < anchors.length && links.length < maxItems; i += 1) {
        const link = anchors[i];
        const item = { text: (link.textContent || '').trim(), href: link.href || '' };
        const itemBytes = item.text.length + item.href.length + 20;
        const projected = estimatedLength + itemBytes + (links.length > 0 ? 1 : 0);
        if (projected > safeLimit) {
          truncated = true;
          break;
        }
        links.push(item);
        estimatedLength = projected;
      }

      if (!truncated && (anchors.length > links.length || links.length >= maxItems)) {
        truncated = anchors.length > links.length;
      }

      const content = JSON.stringify(links);
      return { success: true, items: links.length, content, truncated, contentLength: content.length };
    }
    const result = extractVisibleText(base, safeLimit);
    return { success: true, ...result };
  }

  if (op === 'type') {
    return (async () => {
      const selectorText = String(p.sel || '').trim();
      const attempts = Number.isFinite(p.maxAttempts) ? Math.max(1, Math.floor(p.maxAttempts)) : 3;
      const targetValue = String(p.value ?? '');
      const frameMode = p.frameMode === true;
      const textHint = textHintFromSelector(selectorText, 3);

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement | null = null;
        let strategy = frameMode ? 'frame_selector' : 'selector';
        if (selectorText) {
          try {
            target = deepQuerySelector(selectorText);
          } catch {
            target = null;
          }
        }
        if (!target) {
          target = findInputByHint(textHint || selectorText);
          strategy = frameMode ? 'frame_hint_match' : 'hint_match';
        }
        if (target) {
          if (applyValue(target, targetValue)) {
            return {
              success: true,
              strategy,
              attempt,
              inputType:
                target instanceof HTMLSelectElement
                  ? 'select'
                  : target instanceof HTMLInputElement
                    ? target.type || 'text'
                    : target.tagName.toLowerCase(),
            };
          }
        }
        if (attempt < attempts) await sleep(250 * attempt);
      }

      return {
        success: false,
        code: 'ELEMENT_NOT_FOUND',
        error: frameMode
          ? `Input not found in main document or accessible frames for selector: ${selectorText}`
          : `Element not found for selector: ${selectorText}`,
        hint: 'Use getContent({ mode: "structure" }) to locate form fields by placeholder/label before retrying type().',
        attempts,
      };
    })();
  }

  if (op === 'hover') {
    return (async () => {
      const selectorText = String(p.sel || '').trim();
      const attempts = Number.isFinite(p.maxAttempts) ? Math.max(1, Math.floor(p.maxAttempts)) : 3;
      const frameMode = p.frameMode === true;
      const textHint = textHintFromSelector(selectorText, 3);
      const findByText = (query: string) => findByTextIn(query, TARGET_QUERY);
      const hoverCandidate = (element: HTMLElement | null, strategy: string) => {
        if (!element) return null;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const { x: clientX, y: clientY } = centerOf(element);
        const hitElement = document.elementFromPoint(clientX, clientY);
        const eventTarget =
          hitElement instanceof HTMLElement && (hitElement === element || element.contains(hitElement))
            ? hitElement
            : element;
        const eventInit = {
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
          eventTarget.dispatchEvent(
            new PointerEvent('pointerover', { ...eventInit, pointerId: 1, pointerType: 'mouse' }),
          );
          eventTarget.dispatchEvent(
            new PointerEvent('pointerenter', { ...eventInit, pointerId: 1, pointerType: 'mouse', bubbles: false }),
          );
          eventTarget.dispatchEvent(
            new PointerEvent('pointermove', { ...eventInit, pointerId: 1, pointerType: 'mouse' }),
          );
        }
        eventTarget.dispatchEvent(new MouseEvent('mouseover', eventInit));
        eventTarget.dispatchEvent(new MouseEvent('mouseenter', { ...eventInit, bubbles: false }));
        eventTarget.dispatchEvent(new MouseEvent('mousemove', eventInit));
        return {
          success: true,
          strategy,
          matched: normalize(element.textContent || element.getAttribute('aria-label') || '').slice(0, 100),
          coordinates: { x: clientX, y: clientY },
          targetTag: eventTarget.tagName.toLowerCase(),
        };
      };

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (selectorText) {
          const exact = hoverCandidate(deepQuerySelector(selectorText), frameMode ? 'frame_selector' : 'selector');
          if (exact) return { ...exact, attempt };
        }
        const byText = hoverCandidate(
          findByText(textHint || selectorText),
          frameMode ? 'frame_text_match' : 'text_match',
        );
        if (byText) return { ...byText, attempt };
        if (attempt < attempts) await sleep(250 * attempt);
      }
      const candidates = (allElements(TARGET_QUERY) as HTMLElement[]).slice(0, 10).map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: normalize(element.textContent || '').slice(0, 80),
        aria: normalize(element.getAttribute('aria-label') || '').slice(0, 80),
        role: element.getAttribute('role') || '',
      }));
      return {
        success: false,
        code: 'ELEMENT_NOT_FOUND',
        error: `Hover target not found${frameMode ? ' in main document or accessible frames' : ''}: ${selectorText}`,
        hint: 'Use findElement() or getContent({ mode: "structure" }) to locate a stable hover target.',
        similar_elements: candidates,
        attempts,
      };
    })();
  }

  if (op === 'mouse') {
    return (async () => {
      const selectorText = String(p.sel || '').trim();
      const actionName = String(p.act || '');
      const dropSel = String(p.dropSel || '');
      const attempts = Number.isFinite(p.maxAttempts) ? Math.max(1, Math.floor(p.maxAttempts)) : 3;
      const frameMode = p.frameMode === true;
      const textHint = textHintFromSelector(selectorText, 3);
      const findByText = (query: string) => findByTextIn(query, TARGET_QUERY);
      const resolveTarget = (query: string) => {
        const q = String(query || '').trim();
        if (!q) return null;
        return deepQuerySelector(q) || findByText(q);
      };
      const performMouseAction = (element: HTMLElement | null, strategy: string) => {
        if (!element) return null;
        const disabled =
          (element as HTMLButtonElement | HTMLInputElement).disabled === true ||
          element.getAttribute('aria-disabled') === 'true';
        if (disabled) return null;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const { x: clientX, y: clientY } = centerOf(element);
        const hitElement = document.elementFromPoint(clientX, clientY);
        const eventTarget =
          hitElement instanceof HTMLElement && (hitElement === element || element.contains(hitElement))
            ? hitElement
            : element;
        const button = actionName === 'rightClick' ? 2 : 0;
        const buttons = actionName === 'rightClick' ? 2 : 1;
        const baseEventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX,
          clientY,
          button,
          buttons,
        };

        if (actionName === 'drag') {
          const dropEl = resolveTarget(dropSel) as HTMLElement | null;
          if (!dropEl) {
            return { success: false, code: 'ELEMENT_NOT_FOUND', error: `Drag drop target not found: ${dropSel}` };
          }
          dropEl.scrollIntoView({ block: 'center', inline: 'center' });
          const from = centerOf(element);
          const to = centerOf(dropEl);
          const fire = (type: string, x: number, y: number, target: Element, extra: Record<string, unknown> = {}) => {
            const init = {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window,
              clientX: x,
              clientY: y,
              button: 0,
              buttons: type === 'mouseup' || type === 'pointerup' ? 0 : 1,
              ...extra,
            };
            if (type.startsWith('pointer') && typeof PointerEvent !== 'undefined') {
              target.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse' } as any));
            } else {
              target.dispatchEvent(new MouseEvent(type, init));
            }
          };
          fire('pointerdown', from.x, from.y, eventTarget);
          fire('mousedown', from.x, from.y, eventTarget);
          fire('pointermove', from.x, from.y, eventTarget);
          fire('mousemove', from.x, from.y, eventTarget);
          fire('pointermove', to.x, to.y, dropEl);
          fire('mousemove', to.x, to.y, dropEl);
          fire('pointerup', to.x, to.y, dropEl);
          fire('mouseup', to.x, to.y, dropEl);
          try {
            const dt = new DataTransfer();
            eventTarget.dispatchEvent(
              new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
            );
            dropEl.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
            dropEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
            dropEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            eventTarget.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
          } catch {
            /* some pages lack DragEvent / DataTransfer — pointer path still ran */
          }
          return {
            success: true,
            action: 'drag',
            strategy,
            from,
            to,
            matched: normalize(element.textContent || element.getAttribute('aria-label') || '').slice(0, 100),
          };
        }

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
          strategy,
          matched: normalize(element.textContent || element.getAttribute('aria-label') || '').slice(0, 100),
          coordinates: { x: clientX, y: clientY },
          targetTag: eventTarget.tagName.toLowerCase(),
        };
      };

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (selectorText) {
          const exact = performMouseAction(deepQuerySelector(selectorText), frameMode ? 'frame_selector' : 'selector');
          if (exact) return { ...exact, attempt };
        }
        const byText = performMouseAction(
          findByText(textHint || selectorText),
          frameMode ? 'frame_text_match' : 'text_match',
        );
        if (byText) return { ...byText, attempt };
        if (attempt < attempts) await sleep(250 * attempt);
      }
      const candidates = (allElements(TARGET_QUERY) as HTMLElement[]).slice(0, 10).map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: normalize(element.textContent || '').slice(0, 80),
        aria: normalize(element.getAttribute('aria-label') || '').slice(0, 80),
        role: element.getAttribute('role') || '',
      }));
      return {
        success: false,
        code: 'ELEMENT_NOT_FOUND',
        error: `Mouse target not found${frameMode ? ' in main document or accessible frames' : ''}: ${selectorText}`,
        hint: 'Use findElement() or getContent({ mode: "structure" }) to locate a stable mouse target.',
        similar_elements: candidates,
        attempts,
      };
    })();
  }

  if (op === 'click' || op === 'clickFrame') {
    return (async () => {
      const frameMode = op === 'clickFrame';
      const selectorText = String(p.sel || '').trim();
      const maxAttempts = Number.isFinite(p.maxAttempts) ? Math.max(1, Math.floor(p.maxAttempts)) : frameMode ? 1 : 3;
      const shouldWaitDialog = p.shouldWaitDialog === true;
      const clickableQuery = frameMode
        ? 'button, a[href], [role="tab"], [role="button"], [role="link"], input[type="submit"], input[type="button"], [onclick]'
        : 'button, a[href], [role="tab"], [role="button"], [role="link"], [role="menuitem"], input[type="submit"], input[type="button"], [onclick], [tabindex="0"]';
      const textHint = textHintFromSelector(selectorText, frameMode ? 3 : 2);

      const listOpenDialogs = () =>
        (allElements(DIALOG_FULL) as HTMLElement[]).filter(isVisibleBox).map((el) => ({
          label: normalize(
            el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.textContent || 'dialog',
          ).slice(0, 80),
        }));

      const clickCandidate = (element: HTMLElement | null, strategy: string) => {
        if (!element) return null;
        const disabled =
          (element as HTMLButtonElement | HTMLInputElement).disabled === true ||
          element.getAttribute('aria-disabled') === 'true';
        if (disabled) return null;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        const clientX = frameMode
          ? Math.round(rect.left + rect.width / 2)
          : Math.round(rect.left + Math.min(rect.width / 2, Math.max(4, rect.width - 4)));
        const clientY = frameMode
          ? Math.round(rect.top + rect.height / 2)
          : Math.round(rect.top + Math.min(rect.height / 2, Math.max(4, rect.height - 4)));
        // Instagram often layers transparent divs — prefer intended element even if hit-test differs.
        const hitElement = document.elementFromPoint(clientX, clientY);
        let eventTarget = element;
        if (frameMode) {
          eventTarget =
            hitElement instanceof HTMLElement && (hitElement === element || element.contains(hitElement))
              ? hitElement
              : element;
        } else if (hitElement instanceof HTMLElement) {
          if (hitElement === element || element.contains(hitElement) || hitElement.contains(element)) {
            eventTarget = (hitElement.closest(clickableQuery) as HTMLElement | null) || hitElement;
          }
        }
        const eventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX,
          clientY,
          button: 0,
          buttons: 1,
        };
        if (frameMode) {
          eventTarget.focus?.();
        } else {
          try {
            eventTarget.focus?.({ preventScroll: true } as FocusOptions);
          } catch {
            eventTarget.focus?.();
          }
        }
        if (typeof PointerEvent !== 'undefined') {
          eventTarget.dispatchEvent(
            new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse' }),
          );
        }
        eventTarget.dispatchEvent(new MouseEvent('mousedown', eventInit));
        if (typeof PointerEvent !== 'undefined') {
          eventTarget.dispatchEvent(
            frameMode
              ? new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse' })
              : new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse', buttons: 0 }),
          );
        }
        eventTarget.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
        if (frameMode) {
          eventTarget.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
        } else {
          // Um único click: dispatchEvent + .click() disparava o handler duas vezes (curtir/seguir/submit).
          try {
            eventTarget.click();
          } catch {
            eventTarget.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
          }
        }
        return {
          success: true,
          strategy,
          matched: normalize(element.textContent || element.getAttribute('aria-label') || '').slice(0, 100),
          coordinates: { x: clientX, y: clientY },
          targetTag: eventTarget.tagName.toLowerCase(),
        };
      };

      const findClickables = () => allElements(clickableQuery) as HTMLElement[];
      const findByText = (query: string) => findByTextIn(query, clickableQuery);
      const findByAttributeHint = (hint: string) => {
        if (frameMode) {
          const needle = normalizeLower(hint);
          if (!needle) return null;
          return (
            (
              allElements(
                '[aria-label], [title], [data-testid], button[name], input[name], [role="button"], [role="link"]',
              ) as HTMLElement[]
            ).find((element) => {
              const aria = normalizeLower(element.getAttribute('aria-label') || '');
              const title = normalizeLower(element.getAttribute('title') || '');
              const testId = normalizeLower(element.getAttribute('data-testid') || '');
              const name = normalizeLower(element.getAttribute('name') || '');
              return (
                aria.includes(needle) || title.includes(needle) || testId.includes(needle) || name.includes(needle)
              );
            }) || null
          );
        }
        const escaped = hint.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const selectors = [
          `[aria-label*="${escaped}" i]`,
          `[title*="${escaped}" i]`,
          `[data-testid*="${escaped}" i]`,
          `button[name*="${escaped}" i]`,
          `input[name*="${escaped}" i]`,
        ];
        for (const candidateSelector of selectors) {
          try {
            const candidate = document.querySelector<HTMLElement>(candidateSelector);
            if (candidate) return candidate;
          } catch {
            // Ignore malformed selectors produced by edge-case hints.
          }
        }
        return null;
      };

      const waitForNewDialog = async (dialogsBefore: number, timeoutMs = 320) => {
        let dialogs = listOpenDialogs();
        if (dialogs.length > dialogsBefore) return dialogs[dialogs.length - 1];
        const started = Date.now();
        let delay = 40;
        while (Date.now() - started < timeoutMs) {
          await sleep(delay);
          dialogs = listOpenDialogs();
          if (dialogs.length > dialogsBefore) return dialogs[dialogs.length - 1];
          delay = Math.min(100, delay + 20);
        }
        return undefined;
      };

      const tryClick = async (element: HTMLElement | null, strategy: string, attempt: number) => {
        if (!element) return null;
        const dialogsBefore = listOpenDialogs().length;
        const base = clickCandidate(element, strategy);
        if (!base) return null;
        let openedDialog: { label: string } | undefined;
        if (shouldWaitDialog) {
          openedDialog = await waitForNewDialog(dialogsBefore, 320);
        }
        return {
          ...base,
          attempt,
          openedDialog,
          dialogOpen: Boolean(openedDialog),
          dialogsOpen: listOpenDialogs().length,
        };
      };

      const attempts = maxAttempts;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (selectorText) {
          try {
            if (frameMode) {
              const exact = clickCandidate(deepQuerySelector(selectorText), 'frame_selector');
              if (exact) return { ...exact, attempt };
            } else {
              const exact = await tryClick(deepQuerySelector(selectorText), 'selector', attempt);
              if (exact) return exact;
            }
          } catch {
            // Invalid selector syntax - continue with fallback strategies.
          }
        }

        if (frameMode) {
          const byText = clickCandidate(findByText(textHint || selectorText), 'frame_text_match');
          if (byText) return { ...byText, attempt };
          const byHint = clickCandidate(findByAttributeHint(textHint || selectorText), 'frame_attribute_hint');
          if (byHint) return { ...byHint, attempt };
          if (attempt < attempts) await sleep(250 * attempt);
        } else {
          const byText = await tryClick(findByText(textHint || selectorText), 'text_match', attempt);
          if (byText) return byText;
          const byHint = await tryClick(findByAttributeHint(textHint || selectorText), 'attribute_hint', attempt);
          if (byHint) return byHint;
          if (attempt < attempts) await sleep(200 * attempt);
        }
      }

      if (frameMode) {
        return {
          success: false,
          code: 'ELEMENT_NOT_FOUND',
          error: `Element not found in main document or accessible frames for selector: ${selectorText}`,
          attempts,
        };
      }

      const candidates = findClickables()
        .slice(0, 10)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: normalize(element.textContent || '').slice(0, 80),
          aria: normalize(element.getAttribute('aria-label') || '').slice(0, 80),
          classes: String(element.className || '').slice(0, 100),
          role: element.getAttribute('role') || '',
        }));

      return {
        success: false,
        code: 'ELEMENT_NOT_FOUND',
        error: `Element not found for selector: ${selectorText}`,
        hint: 'Try findElement({ query, scope: "auto" }) or getContent({ mode: "structure" }). Prefer short labels like "seguidores".',
        similar_elements: candidates,
        attempts,
        dialogsOpen: listOpenDialogs().length,
      };
    })();
  }

  return { success: false, error: `Unknown page op: ${String(op)}` };
}
