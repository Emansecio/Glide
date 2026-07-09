import { RETRIES_PROP, SELECTOR_PROP, TAB_ID_PROP, type ToolDefinition, defineTool } from './tool-schema.js';

export const buildToolDefinitions = (maxSessionTabs: number): ToolDefinition[] => [
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
    `Open a new tab with a URL. Limited to ${maxSessionTabs} tabs per session — prefer navigating existing tabs over opening new ones. Always use absolute https:// URLs.`,
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
      tabId: TAB_ID_PROP,
      retries: RETRIES_PROP,
      waitForDialog: {
        type: 'boolean',
        description: 'After click, wait briefly for a modal/dialog to open (default true). Useful for Instagram followers/lists.',
      },
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
    'Perform advanced mouse actions on an element. Supports doubleClick and rightClick for controls that require double-click selection or custom context menus. Supports retries, accessible frames, and >>> shadow DOM selectors.',
    {
      action: {
        type: 'string',
        enum: ['doubleClick', 'rightClick'],
        description: 'Mouse action to perform.',
      },
      selector: SELECTOR_PROP('CSS selector or text hint for the target element.'),
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
      text: { type: 'string', description: 'Text to enter.' },
      tabId: TAB_ID_PROP,
      retries: RETRIES_PROP,
    },
    ['selector', 'text'],
  ),
  defineTool(
    'pressKey',
    'Press a keyboard key (e.g., Enter, Tab, Escape, ArrowDown). Dispatches keydown, keypress, keyup, input, and change events for full React/Vue compatibility. Use without selector to target the currently focused element.',
    {
      key: { type: 'string', description: 'Keyboard key (e.g., Enter, Tab, Escape, ArrowDown, ArrowUp).' },
      selector: { type: 'string', description: 'Optional selector to focus before pressing the key.' },
      tabId: TAB_ID_PROP,
    },
    ['key'],
  ),
  defineTool('scroll', 'Scroll the page up, down, to top, or bottom.', {
    direction: { type: 'string', description: 'up, down, top, or bottom.' },
    amount: { type: 'number', description: 'Scroll amount in pixels.' },
    tabId: TAB_ID_PROP,
  }),
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
    'Execute JavaScript code in the context of the current page and return the result. The code runs in the page\'s own origin context (not the extension). Useful for reading DOM state, computed values, or running page-specific logic. Example: "return document.title" or "return window.location.href".',
    {
      code: {
        type: 'string',
        description:
          'JavaScript code to execute. Use "return" to return a value. Example: "return document.querySelectorAll(\'a\').length"',
      },
      tabId: { type: 'number', description: 'Tab ID to execute in. Defaults to the active session tab.' },
    },
    ['code'],
  ),
  defineTool(
    'getNetworkRequests',
    'Inspect network requests made by the page. Installs lightweight Fetch/XHR interception hooks on first call to capture real HTTP methods, status codes, response headers, and timing. Also includes Performance Resource Timing data. Call once to install hooks, then again to read buffered requests. Buffer holds up to 150 intercepted requests.',
    {
      maxEntries: { type: 'number', description: 'Maximum entries to return. Default: 50. Max: 200.' },
      filterUrl: { type: 'string', description: 'Filter results to entries whose URL contains this substring.' },
      filterStatus: {
        type: 'number',
        description: 'Filter intercepted requests by HTTP status code (e.g., 404, 500).',
      },
      clear: { type: 'boolean', description: 'Clear intercepted request buffer after reading. Default: false.' },
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
    },
    ['query'],
  ),
  defineTool(
    'wait',
    'Wait for a condition before proceeding. Supports time, selector, or dialog/modal appearance (condition="dialog"). Use after clicks that open Instagram-style sheets.',
    {
      condition: {
        type: 'string',
        description: 'Wait type: "time", "selector", or "dialog" (any open modal/role=dialog).',
      },
      ms: { type: 'number', description: 'Milliseconds to wait when condition="time". Max 15000.' },
      selector: { type: 'string', description: 'CSS selector to wait for when condition="selector".' },
      timeout: {
        type: 'number',
        description: 'Maximum milliseconds to wait for selector/dialog. Default: 5000. Max: 15000.',
      },
      tabId: TAB_ID_PROP,
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
];
