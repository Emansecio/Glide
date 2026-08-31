import {
  ELEMENT_HANDLE_PROP,
  FRAME_TARGET_PROPS,
  RETRIES_PROP,
  SELECTOR_PROP,
  TAB_ID_PROP,
  type ToolDefinition,
  defineTool,
} from './tool-schema.js';

export const buildToolDefinitions = (_maxSessionTabs: number): ToolDefinition[] => [
  defineTool(
    'navigate',
    'Navigate the current tab to a URL. Always use absolute URLs starting with https://. For searches, use a search engine URL with query params (e.g., https://www.google.com/search?q=term).',
    {
      url: { type: 'string', description: 'Absolute URL to visit. Must start with http:// or https://.' },
      tabId: TAB_ID_PROP,
    },
    ['url'],
  ),
  defineTool(
    'openTab',
    'Open an ADDITIONAL browser tab (there is no fixed per-session tab limit). Prefer navigate on the current session tab for the first site — only use openTab when you need a second page open at the same time. Always use absolute https:// URLs.',
    {
      url: { type: 'string', description: 'Absolute URL to open. Must start with http:// or https://.' },
    },
    ['url'],
  ),
  defineTool(
    'click',
    'Click an element by CSS selector or visible text hint. Uses full pointer/mouse events (works on React/Instagram). After click, reports if a dialog/modal opened. If the selector fails, use findElement({ query: "button text" }) first. Prefer id, data-testid, aria-label, short labels (e.g. "seguindo", "seguidores"), or a[href*="/following"]. NEVER use Instagram utility classes like .x1i10hfl — they match the wrong element.',
    {
      selector: SELECTOR_PROP(
        'CSS selector or short visible label. Prefer "seguindo", "a[href*=\'/following\']", "#submit" — not .x* utility classes.',
      ),
      handle: ELEMENT_HANDLE_PROP,
      tabId: TAB_ID_PROP,
      retries: RETRIES_PROP,
      waitForDialog: {
        type: 'boolean',
        description:
          'After click, wait briefly for a modal/dialog to open (default true). Useful for Instagram followers/lists.',
      },
      ...FRAME_TARGET_PROPS,
    },
    ['selector'],
  ),
  defineTool(
    'hover',
    'Move the pointer over an element by CSS selector or text hint. Use this to open hover menus, reveal toolbars, trigger flyouts, or activate CSS :hover states. Supports retries, accessible frames, and >>> shadow DOM selectors.',
    {
      selector: SELECTOR_PROP(
        'CSS selector or text hint for the element to hover. Example: "#menu", "[aria-label=More]".',
      ),
      tabId: TAB_ID_PROP,
      retries: RETRIES_PROP,
    },
    ['selector'],
  ),
  defineTool(
    'mouse',
    'Advanced mouse: doubleClick, rightClick, or drag (requires toSelector). Use for context menus, double-click select, or drag-and-drop. Supports retries, frames, and >>> shadow selectors.',
    {
      action: {
        type: 'string',
        enum: ['doubleClick', 'rightClick', 'drag'],
        description: 'Mouse action: doubleClick, rightClick, or drag (needs toSelector).',
      },
      selector: SELECTOR_PROP('CSS selector or text hint for the source element.'),
      toSelector: {
        type: 'string',
        description: 'For action=drag: CSS selector or text hint of the drop target.',
      },
      tabId: TAB_ID_PROP,
      retries: RETRIES_PROP,
    },
    ['action', 'selector'],
  ),
  defineTool(
    'type',
    'Type text into an input, textarea, select, or contenteditable element. If the selector fails, use findElement({ query: "placeholder text" }) first to obtain a reliable selector.',
    {
      selector: SELECTOR_PROP('CSS selector for the field. Example: "#email", "[name=password]".'),
      handle: ELEMENT_HANDLE_PROP,
      text: { type: 'string', description: 'Text to enter.' },
      tabId: TAB_ID_PROP,
      retries: RETRIES_PROP,
      ...FRAME_TARGET_PROPS,
    },
    ['selector', 'text'],
  ),
  defineTool(
    'pressKey',
    'Press a keyboard key or chord (e.g., Enter, Escape, ArrowDown, Ctrl+K). Dispatches keydown/keypress/keyup with modifier flags; fires input/change only for printable keys without modifiers or Backspace/Delete. OS-level shortcuts (e.g. real Ctrl+S browser save) cannot be guaranteed from a content script — in-app handlers (Ctrl+K, Ctrl+F) work. Use without selector to target the focused element.',
    {
      key: { type: 'string', description: 'Keyboard key (e.g., Enter, Tab, Escape, ArrowDown, k).' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['Control', 'Alt', 'Shift', 'Meta'] },
        description:
          'Optional modifier keys held during the chord, e.g. ["Control"] for Ctrl+key or ["Control","Shift"] for Ctrl+Shift+key.',
      },
      selector: { type: 'string', description: 'Optional selector to focus before pressing the key.' },
      handle: ELEMENT_HANDLE_PROP,
      tabId: TAB_ID_PROP,
      ...FRAME_TARGET_PROPS,
    },
    ['key'],
  ),
  defineTool(
    'scroll',
    'Scroll up, down, to top, or bottom. Auto-targets the inner scroller of an OPEN modal/dialog (e.g. Instagram followers/following list). Default strategy "auto" combines multi-step wheel events + scrollTop + scrollIntoView on the last list row (better for IntersectionObserver). For bulk Instagram lists prefer httpRequest or executeScript fetch pagination over endless scroll. Result: scrolled, delta, atBottom, intoViewUsed.',
    {
      direction: { type: 'string', description: 'up, down, top, or bottom.' },
      amount: { type: 'number', description: 'Scroll amount in pixels (default 600).' },
      strategy: {
        type: 'string',
        description: 'auto (default: intoView + multi-wheel + scrollTop), wheel, intoView, or top (scrollTop only).',
      },
      selector: {
        type: 'string',
        description:
          'Optional CSS selector of a scrollable element (or a child of one) to scroll. Omit to auto-target an open modal list or the page.',
      },
      tabId: TAB_ID_PROP,
    },
  ),
  defineTool(
    'getContent',
    'Extract page content. Modes: text (visible text), structure (semantic page structure with selectors for interactive elements), html (raw HTML preview), title, url, links. Use mode="structure" before click/type to discover reliable selectors.',
    {
      type: { type: 'string', description: 'text, html, title, url, links, or structure.' },
      mode: { type: 'string', description: 'Alias for type. Supports structure.' },
      selector: { type: 'string', description: 'Optional selector to scope content.' },
      tabId: TAB_ID_PROP,
      maxChars: { type: 'number', description: 'Maximum output size in characters.' },
      maxItems: { type: 'number', description: 'Maximum items per structured section.' },
    },
  ),
  defineTool('screenshot', 'Capture a screenshot of the current tab for visual analysis.', {
    tabId: TAB_ID_PROP,
    format: { type: 'string', description: 'Optional format: jpeg or png.' },
    quality: { type: 'number', description: 'Optional JPEG quality (1-100).' },
  }),
  defineTool(
    'annotatedScreenshot',
    'Capture a set-of-marks screenshot: numbered overlays on interactive elements plus a marks list (ref, selector, tag, text, box). Use refs like e3 with click/type after grounding.',
    {
      scope: {
        type: 'string',
        enum: ['page', 'dialog'],
        description: 'page (default) or dialog (topmost open dialog only).',
      },
      maxMarks: {
        type: 'number',
        description: 'Max numbered overlays. Default 30. Range 1–80.',
      },
      tabId: TAB_ID_PROP,
      ...FRAME_TARGET_PROPS,
    },
  ),
  defineTool(
    'elementScreenshot',
    'Capture a clipped screenshot around one element (selector or readPage ref). Scrolls into view, captures the visible tab, crops with padding.',
    {
      selector: SELECTOR_PROP('CSS selector for the target element.'),
      ref: { type: 'string', description: 'readPage ref such as e1 (alternative to selector).' },
      handle: ELEMENT_HANDLE_PROP,
      padding: {
        type: 'number',
        description: 'Padding in px around the element. Default 8. Range 0–100.',
      },
      tabId: TAB_ID_PROP,
      ...FRAME_TARGET_PROPS,
    },
  ),
  defineTool('getTabs', 'List tabs in the current window.', {}),
  defineTool(
    'closeTab',
    'Close a tab by id.',
    {
      tabId: { type: 'number', description: 'Tab id to close.' },
    },
    ['tabId'],
  ),
  defineTool(
    'switchTab',
    'Activate a tab by id.',
    {
      tabId: { type: 'number', description: 'Tab id to activate.' },
    },
    ['tabId'],
  ),
  defineTool(
    'focusTab',
    'Focus a tab by id.',
    {
      tabId: { type: 'number', description: 'Tab id to focus.' },
    },
    ['tabId'],
  ),
  defineTool('groupTabs', 'Group tabs together with an optional name and color.', {
    tabIds: { type: 'array', items: { type: 'number' }, description: 'Tabs to group.' },
    title: { type: 'string', description: 'Group title.' },
    color: { type: 'string', description: 'Group color name.' },
  }),
  defineTool('describeSessionTabs', 'List tabs captured for this session.', {}),
  defineTool(
    'executeScript',
    'Execute JavaScript in the active tab via chrome.userScripts (USER_SCRIPT world, not eval). Requires the user to enable scripting in Settings and “Allow User Scripts” on the extension. Prefer deterministic tools (readPage, click, httpRequest) first. Async/await and Promises are awaited (timeoutMs default 60s, max 120s). world:"MAIN" only for page JS globals (page CSP may block). Return compact JSON. Examples: "return document.title".',
    {
      code: {
        type: 'string',
        description:
          'JavaScript to run. Prefer "return <value>". Top-level await is auto-wrapped in an async IIFE. Bare one-line expressions become return (expr). Example: "return document.title".',
      },
      world: {
        type: 'string',
        description:
          'Execution world: "USER_SCRIPT" (default, exempt from page CSP) or "MAIN" (page JS globals; may be CSP-blocked).',
      },
      timeoutMs: {
        type: 'number',
        description: 'Max wait for the script (including async fetch loops). Default 60000. Max 120000.',
      },
      tabId: { type: 'number', description: 'Tab ID to execute in. Defaults to the active session tab.' },
    },
    ['code'],
  ),
  defineTool(
    'httpRequest',
    'HTTP request from the EXTENSION host (outside the page). Bypasses page CSP and does not use eval. Cookies for the target site are included automatically (host permissions). Use this for Instagram API pagination after discovering the endpoint with getNetworkRequests — e.g. GET https://www.instagram.com/api/v1/friendships/{user_id}/followers/?count=50&max_id=... with headers X-IG-App-ID and X-CSRFToken (get token via executeScript: return document.cookie). Returns status, headers, and truncated body. Prefer absolute https URLs.',
    {
      url: {
        type: 'string',
        description:
          'Absolute http(s) URL. Example: https://www.instagram.com/api/v1/friendships/123/followers/?count=50',
      },
      method: {
        type: 'string',
        description: 'HTTP method: GET (default), POST, PUT, PATCH, DELETE, HEAD.',
      },
      headers: {
        type: 'object',
        description:
          'Optional headers object (e.g. {"X-IG-App-ID":"936619743392459","X-CSRFToken":"...","X-Requested-With":"XMLHttpRequest"}). Cookie/Host/Origin cannot be set manually — cookies are attached automatically.',
      },
      body: { type: 'string', description: 'Optional request body for POST/PUT/PATCH.' },
      timeoutMs: { type: 'number', description: 'Timeout in ms. Default 30000. Max 90000.' },
      maxBodyChars: {
        type: 'number',
        description: 'Max response body characters returned. Default 50000. Max 100000.',
      },
      tabId: {
        type: 'number',
        description:
          'Optional tab id. When set, auto-fills X-CSRFToken from that tab document.cookie csrftoken if you did not pass X-CSRFToken.',
      },
    },
    ['url'],
  ),
  defineTool(
    'getNetworkRequests',
    'Capture real page network traffic (Fetch/XHR/WebSocket open+messages) — you DO have network access; do not claim DevTools is required. FIRST call installs hooks (buffer may be empty). Then perform the UI action that triggers APIs. THEN call again with filterUrl (e.g. "graphql", "api", "friendships") to read buffered requests; a non-empty read automatically restores the page hooks. Use stop:true to force restoration when no entries matched. Each entry includes method, url, status, useful headers, truncated requestBody, apiHints (doc_id, query_id, friendly name when present), and optional responseBodyPreview. Also returns Performance Resource Timing. Buffer holds up to 200 intercepts after install only.',
    {
      maxEntries: { type: 'number', description: 'Maximum entries to return. Default: 50. Max: 200.' },
      filterUrl: {
        type: 'string',
        description:
          'Filter to URLs containing this substring. Examples: "graphql", "/api/", "friendships", "i.instagram.com".',
      },
      filterMethod: {
        type: 'string',
        description: 'Filter by HTTP method (GET, POST, PUT, DELETE, PATCH). Case-insensitive.',
      },
      filterStatus: {
        type: 'number',
        description: 'Filter intercepted requests by HTTP status code (e.g., 404, 500).',
      },
      includeRequestBody: {
        type: 'boolean',
        description: 'Include truncated request body (default true). Useful for GraphQL doc_id and form payloads.',
      },
      includeResponseBody: {
        type: 'boolean',
        description: 'Include truncated response body preview (default false — can be large). Set true when needed.',
      },
      maxBodyChars: {
        type: 'number',
        description: 'Max characters per captured body field. Default: 2500. Max: 16000.',
      },
      clear: { type: 'boolean', description: 'Clear intercepted request buffer after reading. Default: false.' },
      stop: {
        type: 'boolean',
        description: 'Restore the page Fetch/XHR/WebSocket implementations and stop capturing after this read.',
      },
      tabId: { type: 'number', description: 'Tab ID to inspect. Defaults to the active session tab.' },
    },
  ),
  defineTool(
    'findElement',
    'Find an interactive element by text, aria-label, placeholder, name, or data-testid. Prefer scope="dialog" when a modal is open (Instagram followers list, etc.). Use BEFORE click/type when selectors are unknown. For Instagram profile stats use query "seguindo" or "seguidores" (returns stable a[href*="/following"] selectors — not .x* classes).',
    {
      query: {
        type: 'string',
        description: 'Text to search for. Example: "seguindo", "seguidores", "followers", "Close", "Seguir".',
      },
      type: { type: 'string', description: 'Optional element type filter: button, link, input, any. Default: any.' },
      scope: {
        type: 'string',
        description:
          'Search scope: "auto" (prefer open dialog if any), "dialog" (only inside modal), "page" (whole document). Default: auto.',
      },
      tabId: TAB_ID_PROP,
      maxResults: { type: 'number', description: 'Maximum number of candidates to return. Default: 5.' },
      fuzzy: {
        type: 'boolean',
        description: 'Enable fuzzy matching to tolerate minor text variations and typos. Default: true.',
      },
      deep: {
        type: 'boolean',
        description:
          'When true, scan up to 300 interactive candidates (default cap is 80). Use for sparse or large pages when the default search misses targets.',
      },
      ...FRAME_TARGET_PROPS,
    },
    ['query'],
  ),
  defineTool(
    'wait',
    'Wait for a condition before proceeding. Supports time, selector/visible (element exists AND visible), hidden (element absent OR not visible), dialog (modal open), and networkIdle (no Fetch/XHR in-flight for idleMs). Examples: wait({ condition: "time", ms: 800 }); wait({ condition: "visible", selector: "#submit" }); wait({ condition: "hidden", selector: ".spinner" }); wait({ condition: "networkIdle", idleMs: 500 }); wait({ condition: "dialog" }).',
    {
      condition: {
        type: 'string',
        enum: ['time', 'selector', 'visible', 'hidden', 'dialog', 'networkIdle', 'networkidle'],
        description:
          'Wait type: "time", "selector"/"visible" (visible element), "hidden" (absent or not visible), "dialog" (modal), or "networkIdle" (Fetch/XHR quiet).',
      },
      ms: { type: 'number', description: 'Milliseconds to wait when condition="time". Max 15000.' },
      selector: {
        type: 'string',
        description: 'CSS selector when condition is "selector", "visible", or "hidden".',
      },
      idleMs: {
        type: 'number',
        description: 'Quiet period when condition="networkIdle". Default 500. Range 100–10000.',
      },
      timeout: {
        type: 'number',
        description:
          'Maximum milliseconds to wait for selector/visible/hidden/dialog/networkIdle. Default: 5000. Max: 15000.',
      },
      tabId: TAB_ID_PROP,
      ...FRAME_TARGET_PROPS,
    },
    ['condition'],
  ),
  defineTool(
    'dismissModal',
    'Close the topmost open modal/dialog. Tries close button (aria-label Close/Fechar), Escape, then backdrop click. Use after finishing work inside Instagram followers/lists/dialogs.',
    {
      tabId: TAB_ID_PROP,
    },
  ),
  defineTool(
    'getStorageData',
    'Inspect localStorage, sessionStorage, or cookies for the current page. Useful for debugging persisted state, auth tokens, feature flags, and user preferences. Values are truncated to 500 characters each for safety.',
    {
      store: {
        type: 'string',
        description: 'Storage type to inspect: "localStorage", "sessionStorage", or "cookies". Default: localStorage.',
      },
      filterKey: {
        type: 'string',
        description: 'Optional: filter entries whose key contains this substring (case-insensitive).',
      },
      maxEntries: { type: 'number', description: 'Maximum entries to return. Default: 50. Max: 200.' },
      tabId: TAB_ID_PROP,
    },
  ),
  defineTool(
    'getPerformanceMetrics',
    'Collect Web Vitals and navigation performance metrics for the current page. Returns TTFB, First Contentful Paint, DOM interactive/complete timing, total load time, resource counts by type (script, css, img, font, xhr, fetch), and memory usage when available. Useful for performance audits.',
    {
      tabId: TAB_ID_PROP,
    },
  ),
  defineTool(
    'getConsoleOutput',
    'Capture recent console output (log, warn, error, info) from the page. Installs a lightweight capture hook on first call, then reads buffered entries on subsequent calls. Useful for debugging JavaScript errors, application state, and API responses logged to console. Buffer holds up to 200 entries.',
    {
      maxEntries: { type: 'number', description: 'Maximum entries to return. Default: 50. Max: 200.' },
      level: {
        type: 'string',
        description: 'Filter by level: "log", "warn", "error", "info", or "all". Default: all.',
      },
      clear: { type: 'boolean', description: 'Clear the buffer after reading. Default: false.' },
      tabId: TAB_ID_PROP,
    },
  ),
  defineTool(
    'readPage',
    'Inventory interactive (and optional landmark) elements with stable refs (e1, e2…) plus CSS selectors. Prefer this over raw HTML when deciding what to click/type. Pass selector from a ref into click/type/findElement. scope: auto|dialog|page.',
    {
      maxItems: { type: 'number', description: 'Max elements. Default 40. Max 80.' },
      interactiveOnly: {
        type: 'boolean',
        description: 'If true (default), only buttons/links/inputs/roles. If false, also landmarks/headings.',
      },
      scope: {
        type: 'string',
        description: 'auto (prefer open dialog), dialog, or page. Default auto.',
      },
      tabId: TAB_ID_PROP,
      ...FRAME_TARGET_PROPS,
    },
  ),
  defineTool(
    'clipboard',
    'Read or write the system clipboard from the page context. action "write" needs text; "read" returns clipboard text when the page allows it.',
    {
      action: {
        type: 'string',
        enum: ['read', 'write'],
        description: 'read or write.',
      },
      text: { type: 'string', description: 'Text to write when action=write.' },
      tabId: TAB_ID_PROP,
    },
    ['action'],
  ),
  defineTool(
    'setInputFiles',
    'Assign synthetic File objects to an <input type="file"> (and fire change). files: [{ name, content?, contentBase64?, mimeType? }] — use content for UTF-8 text or contentBase64 for binary uploads (images/PDFs). Prefer contentBase64 when both are provided.',
    {
      selector: SELECTOR_PROP('CSS selector for the file input.'),
      files: {
        type: 'array',
        description:
          'Array of { name, content?, contentBase64?, mimeType? }. content is plain UTF-8 text; contentBase64 is base64-encoded binary.',
      },
      tabId: TAB_ID_PROP,
    },
    ['selector', 'files'],
  ),
  defineTool(
    'selectOption',
    'Select an option in a native <select> or custom ARIA dropdown (MUI/React-Select combobox + portal listbox). Provide exactly one of value, label, or index.',
    {
      selector: SELECTOR_PROP('CSS selector for the <select> or combobox trigger.'),
      handle: ELEMENT_HANDLE_PROP,
      value: { type: 'string', description: 'Option value attribute to select.' },
      label: { type: 'string', description: 'Visible option label/text to select.' },
      index: { type: 'number', description: 'Zero-based option index.' },
      tabId: TAB_ID_PROP,
      ...FRAME_TARGET_PROPS,
    },
    ['selector'],
  ),
  defineTool(
    'fillForm',
    'Fill multiple form fields in one call. Each field uses text (inputs/textareas), checked (checkbox/radio), or option ({ value?, label?, index? } for selects). Runs sequentially and returns per-field results. Max 20 fields.',
    {
      fields: {
        type: 'array',
        description: 'Array of { selector, text?, checked?, option? }. option selects via selectOption semantics.',
      },
      submitSelector: {
        type: 'string',
        description: 'Optional submit button selector clicked after all fields succeed.',
      },
      tabId: TAB_ID_PROP,
      ...FRAME_TARGET_PROPS,
    },
    ['fields'],
  ),
  defineTool(
    'navigateHistory',
    'Navigate browser history: back, forward, or reload the current tab. Waits for tab readiness and returns the final URL.',
    {
      action: {
        type: 'string',
        enum: ['back', 'forward', 'reload'],
        description: 'History action: back, forward, or reload.',
      },
      tabId: TAB_ID_PROP,
    },
    ['action'],
  ),
  defineTool(
    'highlightElement',
    'Draw a transient outline overlay on an element so the user can see what you are acting on. Pass selector or a readPage ref (e.g. e3). Overlay auto-removes after durationMs.',
    {
      selector: SELECTOR_PROP('CSS selector for the target element.'),
      ref: { type: 'string', description: 'readPage ref such as e1, e2 (alternative to selector).' },
      handle: ELEMENT_HANDLE_PROP,
      durationMs: {
        type: 'number',
        description: 'Highlight duration in ms. Default 1200. Range 200–5000.',
      },
      tabId: TAB_ID_PROP,
      ...FRAME_TARGET_PROPS,
    },
  ),
  defineTool(
    'captureDownload',
    'Capture a file download triggered by the page (or start one directly). Arms a download listener, optionally clicks trigger.selector or downloads url directly, then returns { id, url, filename, mime, fileSize, state } when complete. saveAs is always false (automatic save). Downloads are correlated by startTime after arming — chrome.downloads has no tabId, so capture is not tab-isolated.',
    {
      urlPattern: {
        type: 'string',
        description: 'Optional substring match against the download URL.',
      },
      filename: {
        type: 'string',
        description: 'Optional substring match against the downloaded filename.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Max wait for a matching download. Default 30000. Range 1000–120000.',
      },
      saveAs: {
        type: 'boolean',
        description: 'Must be false (default). Prompted Save-As dialogs are not supported.',
      },
      url: {
        type: 'string',
        description:
          'Optional absolute URL to download directly via chrome.downloads (no page interaction). Must start with http:// or https://.',
      },
      trigger: {
        type: 'object',
        description: 'Optional one-call trigger: { selector } clicked after arming the listener.',
      },
      tabId: TAB_ID_PROP,
    },
  ),
  defineTool(
    'findInPage',
    'Find text in visible page content. TreeWalker over text nodes (skips script/style/hidden); falls back to window.find only when TreeWalker finds zero matches. Returns match contexts (~60 chars) and total count; scrolls first match into view by default.',
    {
      query: { type: 'string', description: 'Text to search for (required).' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive search. Default false.' },
      maxMatches: { type: 'number', description: 'Max match contexts returned. Default 20. Range 1–100.' },
      scrollToFirst: {
        type: 'boolean',
        description: 'Scroll first match into view (block: center). Default true.',
      },
      tabId: TAB_ID_PROP,
    },
    ['query'],
  ),
  defineTool(
    'extractTable',
    'Extract a structured HTML table. Default target is the largest table by row count; or pass selector. Skips display:none rows. colspan cells repeat their text across spanned columns; short rows are padded with empty strings.',
    {
      selector: { type: 'string', description: 'Optional CSS selector for a specific <table>.' },
      maxRows: { type: 'number', description: 'Max data rows returned. Default 100. Range 1–1000.' },
      includeHeaders: { type: 'boolean', description: 'Include header row. Default true.' },
      tabId: TAB_ID_PROP,
    },
  ),
  defineTool(
    'harvestScroll',
    'Harvest repeated items from infinite-scroll lists. Collects unique items by trimmed textContent (first 200 chars each), scrolls one viewport down, waits ~800ms, stops after stableRounds with no new items, maxItems, or 20 rounds.',
    {
      itemSelector: {
        type: 'string',
        description: 'CSS selector matching repeated list/card items (required).',
      },
      scrollSelector: {
        type: 'string',
        description: 'Scroll container selector. Default: document scroll.',
      },
      maxItems: { type: 'number', description: 'Max unique items to collect. Default 100. Range 1–1000.' },
      stableRounds: {
        type: 'number',
        description: 'Consecutive rounds with no new items before stopping. Default 2. Range 1–5.',
      },
      tabId: TAB_ID_PROP,
    },
    ['itemSelector'],
  ),
  defineTool(
    'cdp',
    'Chrome DevTools Protocol via chrome.debugger (opt-in: toolPermissions.debugger). action: attach|detach|status|send. For send: method like Network.enable, Network.getResponseBody, Runtime.evaluate, Input.dispatchKeyEvent. Prefer getNetworkRequests/httpRequest/executeScript first — CDP shows a yellow debugger banner and is for hard cases only.',
    {
      action: {
        type: 'string',
        enum: ['attach', 'detach', 'status', 'send'],
        description: 'attach, detach, status, or send (default send).',
      },
      method: {
        type: 'string',
        description: 'CDP method when action=send (e.g. Network.enable, Runtime.evaluate).',
      },
      params: {
        type: 'object',
        description: 'Optional CDP params object for action=send.',
      },
      tabId: TAB_ID_PROP,
    },
  ),
];
