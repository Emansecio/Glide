type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

type SessionTabSummary = {
  id: number;
  title?: string;
  url?: string;
};

type GroupOptions = {
  title?: string;
  color?: chrome.tabGroups.ColorEnum;
};

type TabResolution = {
  tabId: number;
  tab: chrome.tabs.Tab;
  requestedTabId: number | null;
  fallbackUsed: boolean;
};

type ToolArgValidationResult =
  | { ok: true; args: Record<string, any> }
  | { ok: false; error: string; hint?: string };

// Maximum number of tabs allowed per session to prevent runaway tab creation
const MAX_SESSION_TABS = 5;

export class BrowserTools {
  tools: Record<string, true>;
  private sessionTabs: Map<number, SessionTabSummary>;
  private currentSessionTabId: number | null;
  private sessionTabGroupId: number | null;

  constructor() {
    this.sessionTabs = new Map();
    this.currentSessionTabId = null;
    this.sessionTabGroupId = null;
    this.tools = {
      navigate: true,
      openTab: true,
      click: true,
      type: true,
      pressKey: true,
      scroll: true,
      getContent: true,
      screenshot: true,
      getTabs: true,
      closeTab: true,
      switchTab: true,
      focusTab: true,
      groupTabs: true,
      describeSessionTabs: true,
    };
    this.bindTabLifecycleListeners();
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private getToolDefinition(toolName: string) {
    return this.getToolDefinitions().find((tool) => tool.name === toolName) || null;
  }

  private validateArgsAgainstDefinition(toolName: string, args: unknown): ToolArgValidationResult {
    if (args === undefined) return { ok: true, args: {} };
    if (!this.isRecord(args)) {
      return {
        ok: false,
        error: `Invalid arguments for ${toolName}: expected an object payload.`,
        hint: `Call ${toolName} with a JSON object matching the tool schema.`,
      };
    }

    const definition = this.getToolDefinition(toolName);
    if (!definition) {
      return { ok: true, args: { ...args } };
    }

    const schema = definition.input_schema;
    const properties = this.isRecord(schema?.properties) ? schema.properties : {};
    const normalizedArgs: Record<string, any> = { ...args };

    for (const requiredKey of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(normalizedArgs, requiredKey)) {
        return {
          ok: false,
          error: `Missing required argument "${requiredKey}" for ${toolName}.`,
          hint: `Review ${toolName} input_schema and provide "${requiredKey}".`,
        };
      }
      if (normalizedArgs[requiredKey] == null) {
        return {
          ok: false,
          error: `Argument "${requiredKey}" for ${toolName} cannot be null/undefined.`,
        };
      }
    }

    for (const [key, value] of Object.entries(normalizedArgs)) {
      if (key.startsWith('_') || key === 'attempt') continue;
      const propertySchema = properties[key];
      if (!this.isRecord(propertySchema)) continue;
      const expectedType = propertySchema.type;
      if (typeof expectedType !== 'string' || value == null) continue;
      if (expectedType === 'string' && typeof value !== 'string') {
        return { ok: false, error: `Argument "${key}" for ${toolName} must be a string.` };
      }
      if (expectedType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
        return { ok: false, error: `Argument "${key}" for ${toolName} must be a finite number.` };
      }
      if (expectedType === 'array' && !Array.isArray(value)) {
        return { ok: false, error: `Argument "${key}" for ${toolName} must be an array.` };
      }
      if (
        expectedType === 'object' &&
        (!value || typeof value !== 'object' || Array.isArray(value))
      ) {
        return { ok: false, error: `Argument "${key}" for ${toolName} must be an object.` };
      }
      if (Array.isArray(propertySchema.enum) && !propertySchema.enum.includes(value)) {
        return {
          ok: false,
          error: `Argument "${key}" for ${toolName} must be one of: ${propertySchema.enum.join(', ')}.`,
        };
      }
    }

    return { ok: true, args: normalizedArgs };
  }

  private validateToolArgs(toolName: string, args: unknown): ToolArgValidationResult {
    const base = this.validateArgsAgainstDefinition(toolName, args);
    if (!base.ok) return base;
    const normalizedArgs = { ...base.args };

    if ((toolName === 'navigate' || toolName === 'openTab') && typeof normalizedArgs.url === 'string') {
      normalizedArgs.url = normalizedArgs.url.trim();
      if (!normalizedArgs.url) {
        return { ok: false, error: `Argument "url" for ${toolName} cannot be empty.` };
      }
      if (!/^https?:\/\//i.test(normalizedArgs.url)) {
        return {
          ok: false,
          error: `Invalid URL for ${toolName}: "${normalizedArgs.url}". Only http(s) URLs are supported.`,
          hint: 'Use an https:// URL (for searches, use a search engine URL with query params).',
        };
      }
    }

    if ((toolName === 'click' || toolName === 'type') && typeof normalizedArgs.selector === 'string') {
      normalizedArgs.selector = normalizedArgs.selector.trim();
      if (!normalizedArgs.selector) {
        return { ok: false, error: `Argument "selector" for ${toolName} cannot be empty.` };
      }
    }

    if (toolName === 'type' && typeof normalizedArgs.text !== 'string') {
      return { ok: false, error: 'Argument "text" for type must be a string.' };
    }

    if (toolName === 'pressKey') {
      if (typeof normalizedArgs.key === 'string') normalizedArgs.key = normalizedArgs.key.trim();
      if (!normalizedArgs.key) {
        return { ok: false, error: 'Argument "key" for pressKey cannot be empty.' };
      }
      if (normalizedArgs.selector !== undefined && typeof normalizedArgs.selector !== 'string') {
        return { ok: false, error: 'Argument "selector" for pressKey must be a string when provided.' };
      }
    }

    if (toolName === 'scroll') {
      if (normalizedArgs.direction !== undefined) {
        const direction = String(normalizedArgs.direction).toLowerCase().trim();
        if (!['up', 'down', 'top', 'bottom'].includes(direction)) {
          return {
            ok: false,
            error: `Invalid scroll direction "${String(normalizedArgs.direction)}".`,
            hint: 'Use one of: up, down, top, bottom.',
          };
        }
        normalizedArgs.direction = direction;
      }
      if (normalizedArgs.amount !== undefined) {
        if (typeof normalizedArgs.amount !== 'number' || !Number.isFinite(normalizedArgs.amount)) {
          return { ok: false, error: 'Argument "amount" for scroll must be a finite number.' };
        }
        normalizedArgs.amount = Math.max(1, Math.min(20000, Math.round(normalizedArgs.amount)));
      }
    }

    if (toolName === 'getContent') {
      if (normalizedArgs.mode !== undefined && typeof normalizedArgs.mode === 'string') {
        normalizedArgs.mode = normalizedArgs.mode.trim();
      }
      if (normalizedArgs.type !== undefined && typeof normalizedArgs.type === 'string') {
        normalizedArgs.type = normalizedArgs.type.trim();
      }
      if (normalizedArgs.maxChars !== undefined) {
        if (typeof normalizedArgs.maxChars !== 'number' || !Number.isFinite(normalizedArgs.maxChars)) {
          return { ok: false, error: 'Argument "maxChars" for getContent must be a finite number.' };
        }
        normalizedArgs.maxChars = Math.max(200, Math.min(50000, Math.floor(normalizedArgs.maxChars)));
      }
      if (normalizedArgs.maxItems !== undefined) {
        if (typeof normalizedArgs.maxItems !== 'number' || !Number.isFinite(normalizedArgs.maxItems)) {
          return { ok: false, error: 'Argument "maxItems" for getContent must be a finite number.' };
        }
        normalizedArgs.maxItems = Math.max(1, Math.min(500, Math.floor(normalizedArgs.maxItems)));
      }
    }

    if (toolName === 'screenshot') {
      if (normalizedArgs.format !== undefined) {
        const format = String(normalizedArgs.format).toLowerCase().trim();
        if (!['jpeg', 'png'].includes(format)) {
          return { ok: false, error: 'Argument "format" for screenshot must be "jpeg" or "png".' };
        }
        normalizedArgs.format = format;
      }
      if (normalizedArgs.quality !== undefined) {
        if (typeof normalizedArgs.quality !== 'number' || !Number.isFinite(normalizedArgs.quality)) {
          return { ok: false, error: 'Argument "quality" for screenshot must be a finite number.' };
        }
        normalizedArgs.quality = Math.max(1, Math.min(100, Math.round(normalizedArgs.quality)));
      }
    }

    if (['closeTab', 'focusTab', 'switchTab'].includes(toolName)) {
      if (typeof normalizedArgs.tabId !== 'number' || !Number.isFinite(normalizedArgs.tabId)) {
        return { ok: false, error: `Argument "tabId" for ${toolName} must be a finite number.` };
      }
      normalizedArgs.tabId = Math.trunc(normalizedArgs.tabId);
    }

    if (toolName === 'groupTabs') {
      if (!Array.isArray(normalizedArgs.tabIds) || normalizedArgs.tabIds.length === 0) {
        return { ok: false, error: 'Argument "tabIds" for groupTabs must be a non-empty array.' };
      }
      if (!normalizedArgs.tabIds.every((id: unknown) => typeof id === 'number' && Number.isFinite(id))) {
        return { ok: false, error: 'Argument "tabIds" for groupTabs must contain only numbers.' };
      }
      normalizedArgs.tabIds = normalizedArgs.tabIds.map((id: number) => Math.trunc(id));
    }

    if (normalizedArgs.tabId !== undefined) {
      if (typeof normalizedArgs.tabId !== 'number' || !Number.isFinite(normalizedArgs.tabId)) {
        return { ok: false, error: `Argument "tabId" for ${toolName} must be a finite number.` };
      }
      normalizedArgs.tabId = Math.trunc(normalizedArgs.tabId);
    }

    if (normalizedArgs.retries !== undefined) {
      if (typeof normalizedArgs.retries !== 'number' || !Number.isFinite(normalizedArgs.retries)) {
        return { ok: false, error: `Argument "retries" for ${toolName} must be a finite number.` };
      }
      normalizedArgs.retries = Math.max(1, Math.min(5, Math.round(normalizedArgs.retries)));
    }

    return { ok: true, args: normalizedArgs };
  }

  private bindTabLifecycleListeners() {
    if (!chrome?.tabs?.onRemoved?.addListener) return;
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.sessionTabs.delete(tabId);
      if (this.currentSessionTabId === tabId) {
        const nextId = this.sessionTabs.keys().next().value;
        this.currentSessionTabId = typeof nextId === 'number' ? nextId : null;
      }
      if (this.sessionTabs.size === 0) {
        this.sessionTabGroupId = null;
      }
    });
  }

  private async pruneSessionTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const activeIds = new Set<number>();
    tabs.forEach((tab) => {
      if (typeof tab.id === 'number') {
        activeIds.add(tab.id);
      }
    });

    for (const tabId of Array.from(this.sessionTabs.keys())) {
      if (!activeIds.has(tabId)) {
        this.sessionTabs.delete(tabId);
      }
    }

    if (this.currentSessionTabId !== null && !activeIds.has(this.currentSessionTabId)) {
      const nextId = this.sessionTabs.keys().next().value;
      this.currentSessionTabId = typeof nextId === 'number' ? nextId : null;
    }

    if (this.sessionTabs.size === 0) {
      this.sessionTabGroupId = null;
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'navigate',
        description: 'Navigate the current tab to a URL.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute URL to visit.' },
            tabId: { type: 'number', description: 'Optional tab id.' },
          },
          required: ['url'],
        },
      },
      {
        name: 'openTab',
        description: `Open a new tab with a URL. Limited to ${MAX_SESSION_TABS} tabs per session - prefer navigating existing tabs over opening new ones.`,
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute URL to open.' },
          },
          required: ['url'],
        },
      },
      {
        name: 'click',
        description: 'Click an element by CSS selector.',
        input_schema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector to click.' },
            tabId: { type: 'number', description: 'Optional tab id.' },
            retries: { type: 'number', description: 'Optional retry attempts for dynamic pages (1-5).' },
          },
          required: ['selector'],
        },
      },
      {
        name: 'type',
        description: 'Type text into an input or textarea.',
        input_schema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for the input.' },
            text: { type: 'string', description: 'Text to enter.' },
            tabId: { type: 'number', description: 'Optional tab id.' },
            retries: { type: 'number', description: 'Optional retry attempts for dynamic pages (1-5).' },
          },
          required: ['selector', 'text'],
        },
      },
      {
        name: 'pressKey',
        description: 'Press a key in the page.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Keyboard key (e.g., Enter, ArrowDown).' },
            selector: { type: 'string', description: 'Optional selector to target.' },
            tabId: { type: 'number', description: 'Optional tab id.' },
          },
          required: ['key'],
        },
      },
      {
        name: 'scroll',
        description: 'Scroll the page.',
        input_schema: {
          type: 'object',
          properties: {
            direction: { type: 'string', description: 'up, down, top, or bottom.' },
            amount: { type: 'number', description: 'Scroll amount in pixels.' },
            tabId: { type: 'number', description: 'Optional tab id.' },
          },
        },
      },
      {
        name: 'getContent',
        description: 'Extract page content.',
        input_schema: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'text, html, title, url, links, or structure.' },
            mode: { type: 'string', description: 'Alias for type. Supports structure.' },
            selector: { type: 'string', description: 'Optional selector to scope content.' },
            tabId: { type: 'number', description: 'Optional tab id.' },
            maxChars: { type: 'number', description: 'Maximum output size in characters.' },
            maxItems: { type: 'number', description: 'Maximum items per structured section.' },
          },
        },
      },
      {
        name: 'screenshot',
        description: 'Capture a screenshot of the current tab.',
        input_schema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Optional tab id.' },
            format: { type: 'string', description: 'Optional format: jpeg or png.' },
            quality: { type: 'number', description: 'Optional JPEG quality (1-100).' },
          },
        },
      },
      {
        name: 'getTabs',
        description: 'List tabs in the current window.',
        input_schema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'closeTab',
        description: 'Close a tab by id.',
        input_schema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Tab id to close.' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'switchTab',
        description: 'Activate a tab by id.',
        input_schema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Tab id to activate.' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'focusTab',
        description: 'Focus a tab by id.',
        input_schema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Tab id to focus.' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'groupTabs',
        description: 'Group tabs together with an optional name and color.',
        input_schema: {
          type: 'object',
          properties: {
            tabIds: { type: 'array', items: { type: 'number' }, description: 'Tabs to group.' },
            title: { type: 'string', description: 'Group title.' },
            color: { type: 'string', description: 'Group color name.' },
          },
        },
      },
      {
        name: 'describeSessionTabs',
        description: 'List tabs captured for this session.',
        input_schema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  getSessionTabSummaries(): SessionTabSummary[] {
    return Array.from(this.sessionTabs.values());
  }

  getCurrentSessionTabId(): number | null {
    return this.currentSessionTabId;
  }

  async configureSessionTabs(tabs: chrome.tabs.Tab[], options: GroupOptions = {}) {
    this.sessionTabs.clear();
    this.currentSessionTabId = null;
    this.sessionTabGroupId = null;
    tabs.forEach((tab) => {
      if (typeof tab.id !== 'number') return;
      this.sessionTabs.set(tab.id, { id: tab.id, title: tab.title, url: tab.url });
      if (!this.currentSessionTabId) {
        this.currentSessionTabId = tab.id;
      }
    });
    if (tabs.length > 0) {
      // Create session tab group with "Glide" title and blue color
      await this.ensureSessionTabGroup({ title: options.title || 'Glide', color: options.color || 'blue' });
    }
  }

  async ensureSessionTabGroup(options: GroupOptions = { title: 'Glide', color: 'blue' }) {
    const sessionTabIds = Array.from(this.sessionTabs.keys());
    if (sessionTabIds.length === 0) return;

    try {
      if (this.sessionTabGroupId !== null) {
        // Add tabs to existing group
        await chrome.tabs.group({ groupId: this.sessionTabGroupId, tabIds: sessionTabIds });
      } else {
        // Create new group
        const groupId = await chrome.tabs.group({ tabIds: sessionTabIds });
        await chrome.tabGroups.update(groupId, {
          title: options.title || 'Glide',
          color: options.color || 'blue',
          collapsed: false,
        });
        this.sessionTabGroupId = groupId;
      }
    } catch (error) {
      // Tab grouping may fail in some Chrome configurations, fail silently
      console.warn('Failed to group tabs:', error);
    }
  }

  async executeTool(toolName: string, args: Record<string, any> = {}) {
    try {
      const validatedArgs = this.validateToolArgs(toolName, args);
      if (!validatedArgs.ok) {
        return {
          success: false,
          code: 'INVALID_TOOL_ARGS',
          error: validatedArgs.error,
          ...(validatedArgs.hint ? { hint: validatedArgs.hint } : {}),
        };
      }
      const safeArgs = validatedArgs.args;
      switch (toolName) {
        case 'navigate':
          return await this.navigate(safeArgs);
        case 'openTab':
          return await this.openTab(safeArgs);
        case 'click':
          return await this.click(safeArgs);
        case 'type':
          return await this.type(safeArgs);
        case 'pressKey':
          return await this.pressKey(safeArgs);
        case 'scroll':
          return await this.scroll(safeArgs);
        case 'getContent':
          return await this.getContent(safeArgs);
        case 'screenshot':
          return await this.screenshot(safeArgs);
        case 'getTabs':
          return await this.getTabs();
        case 'closeTab':
          return await this.closeTab(safeArgs);
        case 'switchTab':
          return await this.focusTab(safeArgs);
        case 'focusTab':
          return await this.focusTab(safeArgs);
        case 'groupTabs':
          return await this.groupTabs(safeArgs);
        case 'describeSessionTabs':
          await this.pruneSessionTabs();
          return {
            success: true,
            tabs: this.getSessionTabSummaries(),
            tabCount: this.sessionTabs.size,
            maxTabs: MAX_SESSION_TABS,
            canOpenMore: this.sessionTabs.size < MAX_SESSION_TABS,
          };
        default:
          return { success: false, error: `Unknown tool: ${toolName}` };
      }
    } catch (error) {
      // Catch any unhandled errors in tool execution
      console.error(`Tool execution error (${toolName}):`, error);
      return {
        success: false,
        error: `Tool "${toolName}" failed: ${error?.message || String(error)}`,
        hint: 'Try a different approach or check the arguments.',
      };
    }
  }

  private isHttpUrl(url: string | undefined | null) {
    if (!url) return false;
    return url.startsWith('http://') || url.startsWith('https://');
  }

  private async safeGetTab(tabId: number) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  private trackTab(tab: chrome.tabs.Tab | null | undefined) {
    if (!tab || typeof tab.id !== 'number') return;
    this.sessionTabs.set(tab.id, { id: tab.id, title: tab.title, url: tab.url });
  }

  private buildNoExecutableTabError(toolName: string, requestedTabId: number | null, candidates: chrome.tabs.Tab[]) {
    const candidateUrls = candidates
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab?.id === 'number')
      .map((tab) => ({
        tabId: tab.id,
        url: tab.url || '',
        title: tab.title || '',
      }));
    return {
      success: false,
      code: 'NO_EXECUTABLE_TAB',
      error: `No accessible http(s) tab available for ${toolName}. Open a web page and try again.`,
      details: {
        tool: toolName,
        requestedTabId,
        candidateTabs: candidateUrls,
      },
    };
  }

  private attachResolutionMeta(result: Record<string, any>, resolution: TabResolution) {
    if (!resolution.fallbackUsed) return result;
    return {
      ...result,
      fallbackUsed: true,
      requestedTabId: resolution.requestedTabId,
      resolvedTabId: resolution.tabId,
      resolvedUrl: resolution.tab.url || '',
    };
  }

  private async resolveExecutableTab(args: Record<string, any> = {}, toolName = 'tool') {
    const requestedTabId = typeof args.tabId === 'number' ? args.tabId : null;
    const strictTabId = args?._strictTabId === true;
    if (strictTabId && requestedTabId !== null) {
      const strictTab = await this.safeGetTab(requestedTabId);
      if (!strictTab || typeof strictTab.id !== 'number') {
        return {
          ok: false as const,
          result: this.buildNoExecutableTabError(toolName, requestedTabId, []),
        };
      }
      this.trackTab(strictTab);
      if (!this.isHttpUrl(strictTab.url)) {
        return {
          ok: false as const,
          result: {
            success: false,
            code: 'TAB_INACCESSIBLE',
            error: `Requested tab ${requestedTabId} is not an accessible http(s) page for ${toolName}.`,
          },
        };
      }
      return {
        ok: true as const,
        resolution: {
          tabId: strictTab.id,
          tab: strictTab,
          requestedTabId,
          fallbackUsed: false,
        } as TabResolution,
      };
    }

    const candidateIds: number[] = [];
    const addCandidateId = (id: number | null | undefined) => {
      if (typeof id === 'number' && !candidateIds.includes(id)) candidateIds.push(id);
    };

    addCandidateId(requestedTabId);
    addCandidateId(this.currentSessionTabId);

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    addCandidateId(activeTab?.id);

    for (const id of this.sessionTabs.keys()) addCandidateId(id);
    const windowTabs = await chrome.tabs.query({ currentWindow: true });
    for (const tab of windowTabs) addCandidateId(tab.id);

    const candidates: chrome.tabs.Tab[] = [];
    let selected: chrome.tabs.Tab | null = null;
    let selectedIndex = -1;

    for (let i = 0; i < candidateIds.length; i += 1) {
      const tab = await this.safeGetTab(candidateIds[i]);
      if (!tab) {
        this.sessionTabs.delete(candidateIds[i]);
        if (this.currentSessionTabId === candidateIds[i]) {
          this.currentSessionTabId = null;
        }
        continue;
      }
      this.trackTab(tab);
      candidates.push(tab);
      if (!selected && this.isHttpUrl(tab.url)) {
        selected = tab;
        selectedIndex = i;
      }
    }

    if (!selected || typeof selected.id !== 'number') {
      return {
        ok: false as const,
        result: this.buildNoExecutableTabError(toolName, requestedTabId, candidates),
      };
    }

    const fallbackUsed = selectedIndex > 0 || (requestedTabId !== null && requestedTabId !== selected.id);
    // Fix 8: Do NOT mutate this.currentSessionTabId here as a side-effect.
    // Callers that need to persist the resolved tab (navigate, openTab, focusTab) do so explicitly.
    this.trackTab(selected);
    return {
      ok: true as const,
      resolution: {
        tabId: selected.id,
        tab: selected,
        requestedTabId,
        fallbackUsed,
      } as TabResolution,
    };
  }

  private async resolveTabId(args: Record<string, any> = {}) {
    if (typeof args.tabId === 'number') return args.tabId;
    if (this.currentSessionTabId) return this.currentSessionTabId;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return active?.id ?? null;
  }

  private async runInTab(tabId: number, func: (...args: any[]) => unknown, args: any[] = [], timeoutMs = 8000): Promise<any> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Script execution timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      const results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          func,
          args,
        }),
        timeoutPromise,
      ]);
      return (results as chrome.scripting.InjectionResult[])?.[0]?.result ?? null;
    } catch (error) {
      const message = error?.message || String(error) || 'Script execution failed.';
      const normalized = message.toLowerCase();
      if (
        normalized.includes('cannot access contents of url') ||
        normalized.includes('cannot access a chrome://') ||
        normalized.includes('extensions gallery cannot be scripted')
      ) {
        return {
          success: false,
          code: 'TAB_INACCESSIBLE',
          error: 'Cannot access the selected tab URL. Use an http(s) page.',
          details: { tabId, reason: message },
        };
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async navigate(args: Record<string, any>) {
    const tabId = await this.resolveTabId(args);
    if (!tabId) return { success: false, error: 'No active tab.' };

    const url = args.url;
    if (!url || typeof url !== 'string') {
      return { success: false, error: 'Missing or invalid url parameter.' };
    }

    // Validate URL format
     if (!url.startsWith('http://') && !url.startsWith('https://')) {
       return {
         success: false,
         error: `Invalid URL: "${url}". URLs must start with http:// or https://`,
         hint: 'For Google searches, use: https://www.google.com/search?q=your+query',
       };
     }

    try {
      await chrome.tabs.update(tabId, { url });
      this.currentSessionTabId = tabId;
      return { success: true, tabId, url };
    } catch (error) {
      return {
        success: false,
        error: `Navigation failed: ${error?.message || String(error)}`,
      };
    }
  }

  private async openTab(args: Record<string, any>) {
    await this.pruneSessionTabs();
    // Enforce tab limit to prevent runaway tab creation
    if (this.sessionTabs.size >= MAX_SESSION_TABS) {
      return {
        success: false,
        error: `Tab limit reached (max ${MAX_SESSION_TABS} tabs per session). Close existing tabs with closeTab or use navigate on current tab.`,
        hint: 'Use closeTab({ tabId: <id> }) to close a tab, or navigate({ url: "..." }) to reuse current tab.',
      };
    }

    // Validate URL
    const url = args.url;
    if (!url || typeof url !== 'string') {
      return { success: false, error: 'Missing or invalid url parameter.' };
    }

    // Check if it looks like a valid URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return {
        success: false,
        error: `Invalid URL: "${url}". URLs must start with http:// or https://`,
        hint: 'Use navigate({ url: "https://google.com/search?q=..." }) for searches.',
      };
    }

    try {
      const tab = await chrome.tabs.create({ url, active: true });
      if (tab.id) {
        this.sessionTabs.set(tab.id, { id: tab.id, title: tab.title, url: tab.url });
        this.currentSessionTabId = tab.id;
        // Add new tab to session group
        await this.ensureSessionTabGroup();
      }
      return { success: true, tabId: tab.id, url };
    } catch (error) {
      return {
        success: false,
        error: `Failed to open tab: ${error?.message || String(error)}`,
        hint: 'Try using navigate() on current tab instead.',
      };
    }
  }

  private async focusTab(args: Record<string, any>) {
    const tabId = typeof args.tabId === 'number' ? args.tabId : null;
    if (!tabId) return { success: false, error: 'Missing tabId.' };
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      this.currentSessionTabId = tabId;
      this.trackTab(tab);
      return { success: true, tabId };
    } catch (error) {
      const message = error?.message || String(error);
      return {
        success: false,
        code: 'TAB_FOCUS_FAILED',
        error: `Failed to focus tab ${tabId}: ${message}`,
        hint: 'The tab may have been closed or is no longer accessible.',
      };
    }
  }

  private async closeTab(args: Record<string, any>) {
    const tabId = typeof args.tabId === 'number' ? args.tabId : null;
    if (!tabId) return { success: false, error: 'Missing tabId.' };
    try {
      await chrome.tabs.remove(tabId);
      this.sessionTabs.delete(tabId);
      if (this.currentSessionTabId === tabId) {
        this.currentSessionTabId = null;
      }
      return { success: true, tabId };
    } catch (error) {
      const message = error?.message || String(error);
      // Clean up local state even if close failed (tab may already be gone)
      this.sessionTabs.delete(tabId);
      if (this.currentSessionTabId === tabId) {
        this.currentSessionTabId = null;
      }
      return {
        success: false,
        code: 'TAB_CLOSE_FAILED',
        error: `Failed to close tab ${tabId}: ${message}`,
        hint: 'The tab may have already been closed or cannot be closed programmatically.',
      };
    }
  }

  private async click(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'click');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const selector = String(args.selector || '');
    const retries =
      typeof args.retries === 'number'
        ? Math.max(1, Math.min(5, Math.round(args.retries)))
        : 3;
    const result = await this.runInTab(
      tabId,
      async (sel, maxAttempts) => {
        const selectorText = String(sel || '').trim();
        const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
        const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
        const normalize = (value: string) => String(value || '').replace(/\s+/g, ' ').trim();
        const clickableQuery =
          'button, a[href], [role="tab"], [role="button"], [role="link"], input[type="submit"], input[type="button"], [onclick]';

        const textHint = (() => {
          const quoted = selectorText.match(/["']([^"']+)["']/);
          if (quoted?.[1]) return quoted[1].trim();
          const bare = selectorText.replace(/^[#.]/, '').replace(/[_-]+/g, ' ').trim();
          if (!bare || bare.length < 3) return '';
          if (/[ >:[\]()]/.test(selectorText)) return '';
          return bare;
        })();

        const clickCandidate = (element: HTMLElement | null, strategy: string) => {
          if (!element) return null;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          element.click();
          return {
            success: true,
            strategy,
            matched: normalize(element.textContent || element.getAttribute('aria-label') || '').slice(0, 100),
          };
        };

        const findClickables = () =>
          Array.from(document.querySelectorAll<HTMLElement>(clickableQuery));

        const findByText = (query: string) => {
          const needle = normalize(query).toLowerCase();
          if (!needle) return null;
          return (
            findClickables().find((element) => {
              const text = normalize(element.textContent || '').toLowerCase();
              const aria = normalize(element.getAttribute('aria-label') || '').toLowerCase();
              const title = normalize(element.getAttribute('title') || '').toLowerCase();
              const value = normalize((element as HTMLInputElement).value || '').toLowerCase();
              return text.includes(needle) || aria.includes(needle) || title.includes(needle) || value.includes(needle);
            }) || null
          );
        };

        const findByAttributeHint = (hint: string) => {
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

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (selectorText) {
            try {
              const exact = clickCandidate(document.querySelector<HTMLElement>(selectorText), 'selector');
              if (exact) return { ...exact, attempt };
            } catch {
              // Invalid selector syntax - continue with fallback strategies.
            }
          }

          const byText = clickCandidate(findByText(textHint || selectorText), 'text_match');
          if (byText) return { ...byText, attempt };

          const byHint = clickCandidate(findByAttributeHint(textHint || selectorText), 'attribute_hint');
          if (byHint) return { ...byHint, attempt };

          if (attempt < attempts) {
            await sleep(250 * attempt);
          }
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
          hint: 'Try getContent({ mode: "structure" }) and use text/aria-label selectors from the visible actions.',
          similar_elements: candidates,
          attempts,
        };
      },
      [selector, retries],
    );
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  private async type(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'type');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const selector = String(args.selector || '');
    const text = String(args.text ?? '');
    const retries =
      typeof args.retries === 'number'
        ? Math.max(1, Math.min(5, Math.round(args.retries)))
        : 3;
    const result = await this.runInTab(
      tabId,
      async (sel, value, maxAttempts) => {
        const selectorText = String(sel || '').trim();
        const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
        const targetValue = String(value ?? '');
        const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
        const normalize = (input: string) => String(input || '').replace(/\s+/g, ' ').trim();

        const textHint = (() => {
          const quoted = selectorText.match(/["']([^"']+)["']/);
          if (quoted?.[1]) return quoted[1].trim();
          const bare = selectorText.replace(/^[#.]/, '').replace(/[_-]+/g, ' ').trim();
          if (!bare || bare.length < 3) return '';
          if (/[ >:[\]()]/.test(selectorText)) return '';
          return bare;
        })();

        const getLabel = (inputElement: Element) => {
          const id = inputElement.getAttribute('id');
          if (id) {
            const labelByFor = document.querySelector(`label[for="${id}"]`);
            if (labelByFor?.textContent) return normalize(labelByFor.textContent);
          }
          const parentLabel = inputElement.closest('label');
          if (parentLabel?.textContent) return normalize(parentLabel.textContent);
          return '';
        };

        const getInputCandidates = () =>
          Array.from(
            document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(
              'input, textarea, [contenteditable="true"]',
            ),
          );

        const findByHint = (hint: string) => {
          const needle = normalize(hint).toLowerCase();
          if (!needle) return null;
          return (
            getInputCandidates().find((candidate) => {
              const placeholder = normalize((candidate as HTMLInputElement).placeholder || '').toLowerCase();
              const name = normalize(candidate.getAttribute('name') || '').toLowerCase();
              const aria = normalize(candidate.getAttribute('aria-label') || '').toLowerCase();
              const title = normalize(candidate.getAttribute('title') || '').toLowerCase();
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

        const applyValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLElement, nextValue: string) => {
          element.focus();
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
            if (descriptor?.set) {
              descriptor.set.call(element, nextValue);
            } else {
              element.value = nextValue;
            }
          } else {
            element.textContent = nextValue;
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        };

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          let target: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null = null;
          let strategy = 'selector';
          if (selectorText) {
            try {
              target = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(selectorText);
            } catch {
              target = null;
            }
          }
          if (!target) {
            target = findByHint(textHint || selectorText);
            strategy = 'hint_match';
          }
          if (target) {
            applyValue(target, targetValue);
            return {
              success: true,
              strategy,
              attempt,
            };
          }
          if (attempt < attempts) {
            await sleep(250 * attempt);
          }
        }

        return {
          success: false,
          code: 'ELEMENT_NOT_FOUND',
          error: `Element not found for selector: ${selectorText}`,
          hint: 'Use getContent({ mode: "structure" }) to locate form fields by placeholder/label before retrying type().',
          attempts,
        };
      },
      [selector, text, retries],
    );
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  private async pressKey(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'pressKey');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const key = String(args.key || '');
    const selector = args.selector ? String(args.selector) : '';
    const result = await this.runInTab(
      tabId,
      (k, sel) => {
        let target: HTMLElement | null = null;
        if (sel) {
          try {
            target = document.querySelector<HTMLElement>(sel);
          } catch {
            return {
              success: false,
              code: 'INVALID_SELECTOR',
              error: `Invalid selector syntax: ${String(sel)}`,
            };
          }
        } else {
          target = (document.activeElement as HTMLElement | null) || document.body;
        }
        if (!target) return { success: false, error: 'Target not found.' };
        target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keypress', { key: k, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
        return { success: true };
      },
      [key, selector],
    );
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  private async scroll(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'scroll');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const direction = String(args.direction || 'down');
    const amount = typeof args.amount === 'number' ? args.amount : 600;
    const result = await this.runInTab(
      tabId,
      (dir, amt) => {
        if (dir === 'top') {
          window.scrollTo({ top: 0, behavior: 'instant' });
        } else if (dir === 'bottom') {
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
        } else if (dir === 'up') {
          window.scrollBy({ top: -amt, behavior: 'instant' });
        } else {
          window.scrollBy({ top: amt, behavior: 'instant' });
        }
        return { success: true };
      },
      [direction, amount],
    );
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  private async getContent(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'getContent');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const type = String(args.type || args.mode || 'text');
    const selector = args.selector ? String(args.selector) : '';
    const maxChars = typeof args.maxChars === 'number' && args.maxChars > 0 ? args.maxChars : 8000;
    const maxItems = typeof args.maxItems === 'number' && args.maxItems > 0 ? args.maxItems : 40;
    const result = await this.runInTab(
      tabId,
      (t, sel, limit, maxPerSection) => {
        const base = sel ? document.querySelector<HTMLElement>(sel) : document.body;
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
        const extractVisibleText = (root: HTMLElement, maxLen: number) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              const style = window.getComputedStyle(parent);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0' ||
                parent.tagName === 'SCRIPT' ||
                parent.tagName === 'STYLE'
              ) {
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
          return {
            content,
            truncated,
            contentLength: content.length,
          };
        };
        const extractHtmlPreview = (root: HTMLElement, maxLen: number) => {
          const escapeAttr = (value: string) => value.replace(/"/g, '&quot;');
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
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
              chunk = attrs
                ? `<${element.tagName.toLowerCase()} ${attrs}>`
                : `<${element.tagName.toLowerCase()}>`;
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

          return {
            content,
            truncated,
            contentLength: content.length,
          };
        };
        const extractStructure = (root: HTMLElement, maxLen: number, maxPerSectionCount: number) => {
          const clip = (value: string, length: number) => {
            const text = String(value || '').trim();
            if (text.length <= length) return text;
            return `${text.slice(0, length)}...`;
          };
          const summarizeField = (element: Element) => {
            const tag = element.tagName.toLowerCase();
            const type = element.getAttribute('type') || '';
            const name = element.getAttribute('name') || '';
            const id = element.getAttribute('id') || '';
            const placeholder = element.getAttribute('placeholder') || '';
            const label =
              element.getAttribute('aria-label') ||
              element.getAttribute('title') ||
              element.getAttribute('alt') ||
              '';
            return {
              tag,
              type: clip(type, 40),
              name: clip(name, 120),
              id: clip(id, 120),
              label: clip(label, 140),
              placeholder: clip(placeholder, 120),
              required: element.hasAttribute('required'),
              disabled: element.hasAttribute('disabled'),
            };
          };

          const structure: Record<string, any> = {
            title: clip(document.title || '', 220),
            url: clip(window.location.href || '', 420),
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
          let structureSerializedLength = JSON.stringify(structure).length;
          const tryPush = (
            key:
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
              | 'landmarks',
            item: Record<string, any>,
          ) => {
            const list = structure[key] as Record<string, any>[];
            const serializedItem = JSON.stringify(item);
            const projectedLength = structureSerializedLength + serializedItem.length + (list.length > 0 ? 1 : 0);
            if (projectedLength > maxLen) {
              truncated = true;
              return false;
            }
            list.push(item);
            structureSerializedLength = projectedLength;
            return true;
          };

          const headings = Array.from(root.querySelectorAll('h1, h2, h3')) as HTMLElement[];
          for (let i = 0; i < headings.length && i < maxPerSectionCount; i += 1) {
            const heading = headings[i];
            const item = {
              level: heading.tagName.toLowerCase(),
              text: clip(heading.innerText || heading.textContent || '', 220),
            };
            if (!tryPush('headings', item)) break;
          }
          if (headings.length > maxPerSectionCount) truncated = true;

          const forms = Array.from(root.querySelectorAll('form')) as HTMLFormElement[];
          for (let i = 0; i < forms.length && i < maxPerSectionCount; i += 1) {
            const form = forms[i];
            const fields = Array.from(form.querySelectorAll('input, select, textarea, button'))
              .slice(0, 16)
              .map((field) => summarizeField(field as Element));
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

          const actions = Array.from(
            root.querySelectorAll('button, a[href], input[type="submit"], input[type="button"], [role="button"]'),
          ) as HTMLElement[];
          for (let i = 0; i < actions.length && i < maxPerSectionCount; i += 1) {
            const action = actions[i];
            const item = {
              tag: action.tagName.toLowerCase(),
              text: clip(action.innerText || action.textContent || '', 200),
              id: clip(action.id || '', 120),
              href: clip((action as HTMLAnchorElement).href || '', 260),
              disabled: (action as HTMLButtonElement).disabled === true || action.getAttribute('aria-disabled') === 'true',
            };
            if (!tryPush('actions', item)) break;
          }
          if (actions.length > maxPerSectionCount) truncated = true;

          const sidebarCandidates = Array.from(
            root.querySelectorAll(
              'aside a[href], nav a[href], [role="navigation"] a[href], aside button, nav button, [role="navigation"] button, [role="menuitem"]',
            ),
          ) as HTMLElement[];
          for (let i = 0; i < sidebarCandidates.length && i < maxPerSectionCount; i += 1) {
            const candidate = sidebarCandidates[i];
            const item = {
              tag: candidate.tagName.toLowerCase(),
              text: clip(candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label') || '', 180),
              href: clip((candidate as HTMLAnchorElement).href || '', 240),
              role: clip(candidate.getAttribute('role') || '', 60),
            };
            if (!tryPush('sidebarItems', item)) break;
          }
          if (sidebarCandidates.length > maxPerSectionCount) truncated = true;

          const cardCandidates = Array.from(
            root.querySelectorAll(
              'article, section, [class*="card" i], [class*="tile" i], [class*="widget" i], [data-card], [data-testid*="card" i]',
            ),
          ) as HTMLElement[];
          for (let i = 0; i < cardCandidates.length && i < maxPerSectionCount; i += 1) {
            const card = cardCandidates[i];
            const titleNode = card.querySelector('h1, h2, h3, h4, strong, [data-title], [class*="title" i]');
            const summaryText = clip(card.innerText || card.textContent || '', 220);
            const titleText = clip(
              (titleNode as HTMLElement | null)?.innerText ||
                (titleNode as HTMLElement | null)?.textContent ||
                '',
              140,
            );
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

          const tableCandidates = Array.from(root.querySelectorAll('table')) as HTMLTableElement[];
          for (let i = 0; i < tableCandidates.length && i < maxPerSectionCount; i += 1) {
            const table = tableCandidates[i];
            const headers = Array.from(table.querySelectorAll('th'))
              .slice(0, 6)
              .map((th) => clip(th.innerText || th.textContent || '', 60))
              .filter(Boolean);
            const rowCount = table.querySelectorAll('tbody tr').length || table.querySelectorAll('tr').length;
            const caption = clip(table.querySelector('caption')?.textContent || '', 120);
            const item = {
              id: clip(table.id || '', 80),
              caption,
              rows: rowCount,
              headers,
            };
            if (!tryPush('tables', item)) break;
          }
          if (tableCandidates.length > maxPerSectionCount) truncated = true;

          const filterCandidates = Array.from(
            root.querySelectorAll(
              'input[type="search"], input[placeholder*="busc" i], input[placeholder*="filter" i], select, [aria-label*="filtro" i], [aria-label*="filter" i]',
            ),
          ) as HTMLElement[];
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
            };
            if (!tryPush('filters', item)) break;
          }
          if (filterCandidates.length > maxPerSectionCount) truncated = true;

          const tabCandidates = Array.from(
            root.querySelectorAll('[role="tab"], [data-tab], [aria-selected], .tab, [class*="tab-" i]'),
          ) as HTMLElement[];
          for (let i = 0; i < tabCandidates.length && i < maxPerSectionCount; i += 1) {
            const tab = tabCandidates[i];
            const text = clip(tab.innerText || tab.textContent || tab.getAttribute('aria-label') || '', 120);
            if (!text) continue;
            const item = {
              text,
              selected: tab.getAttribute('aria-selected') === 'true',
              role: clip(tab.getAttribute('role') || '', 40),
            };
            if (!tryPush('tabs', item)) break;
          }
          if (tabCandidates.length > maxPerSectionCount) truncated = true;

          const badgeCandidates = Array.from(
            root.querySelectorAll('[class*="badge" i], [class*="tag" i], [data-badge], [aria-label*="badge" i]'),
          ) as HTMLElement[];
          for (let i = 0; i < badgeCandidates.length && i < maxPerSectionCount; i += 1) {
            const badge = badgeCandidates[i];
            const text = clip(badge.innerText || badge.textContent || badge.getAttribute('aria-label') || '', 100);
            if (!text || text.length < 2) continue;
            const item = {
              text,
              tag: badge.tagName.toLowerCase(),
            };
            if (!tryPush('badges', item)) break;
          }
          if (badgeCandidates.length > maxPerSectionCount) truncated = true;

          const kpiCandidates = Array.from(
            root.querySelectorAll(
              '[data-kpi], [class*="kpi" i], [class*="metric" i], [class*="stat" i], [class*="summary-value" i]',
            ),
          ) as HTMLElement[];
          for (let i = 0; i < kpiCandidates.length && i < maxPerSectionCount; i += 1) {
            const kpi = kpiCandidates[i];
            const valueText = clip(kpi.innerText || kpi.textContent || '', 100);
            if (!valueText) continue;
            const labelNode =
              kpi.querySelector('[class*="label" i], [data-label], small, span, strong') || kpi.parentElement;
            const labelText = clip((labelNode as HTMLElement | null)?.innerText || '', 120);
            const item = {
              label: labelText,
              value: valueText,
            };
            if (!tryPush('kpis', item)) break;
          }
          if (kpiCandidates.length > maxPerSectionCount) truncated = true;

          const landmarks = Array.from(root.querySelectorAll('main, nav, header, footer, aside, section, article')) as HTMLElement[];
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
          let estimatedLength = 2; // []
          let truncated = false;

          for (let i = 0; i < anchors.length && links.length < maxItems; i += 1) {
            const link = anchors[i];
            const item = {
              text: (link.textContent || '').trim(),
              href: link.href || '',
            };
            const serializedItem = JSON.stringify(item);
            const projected = estimatedLength + serializedItem.length + (links.length > 0 ? 1 : 0);
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
          return {
            success: true,
            items: links.length,
            content,
            truncated,
            contentLength: content.length,
          };
        }
        const result = extractVisibleText(base, safeLimit);
        return { success: true, ...result };
      },
      [type, selector, maxChars, maxItems],
    );
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  private async screenshot(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'screenshot');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tab = resolution.tab;
    const requestedFormat = String(args.format || 'jpeg').toLowerCase();
    const format = requestedFormat === 'png' ? 'png' : 'jpeg';
    const quality =
      typeof args.quality === 'number'
        ? Math.max(1, Math.min(100, Math.round(args.quality)))
        : 90;
    let focusedForCapture = false;
    let restoredFocus = false;
    const capturedTabId = typeof tab.id === 'number' ? tab.id : null;
    const [activeBeforeCapture] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    const previouslyActiveTabId = typeof activeBeforeCapture?.id === 'number' ? activeBeforeCapture.id : null;

    if (capturedTabId && previouslyActiveTabId !== capturedTabId) {
      try {
        await chrome.tabs.update(capturedTabId, { active: true });
        focusedForCapture = true;
      } catch (error) {
        return this.attachResolutionMeta(
          {
            success: false,
            code: 'SCREENSHOT_FOCUS_FAILED',
            error: `Failed to focus target tab ${capturedTabId} for screenshot: ${error?.message || String(error)}`,
          },
          resolution,
        );
      }
    }

    let captureResult: Record<string, any>;
    try {
      if (format === 'png') {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        captureResult = {
          success: true,
          dataUrl,
          format: 'png',
        };
      } else {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality });
        captureResult = {
          success: true,
          dataUrl,
          format: 'jpeg',
          quality,
        };
      }
    } catch (error) {
      if (format === 'jpeg') {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        captureResult = {
          success: true,
          dataUrl,
          format: 'png',
          fallbackFrom: 'jpeg',
          fallbackReason: error?.message || String(error),
        };
      } else {
        captureResult = {
          success: false,
          code: 'SCREENSHOT_CAPTURE_FAILED',
          error: `Failed to capture screenshot: ${error?.message || String(error)}`,
        };
      }
    } finally {
      if (focusedForCapture && previouslyActiveTabId !== null && previouslyActiveTabId !== capturedTabId) {
        try {
          await chrome.tabs.update(previouslyActiveTabId, { active: true });
          restoredFocus = true;
        } catch {
          // Best effort focus restore.
        }
      }
    }

    return this.attachResolutionMeta(
      {
        ...captureResult,
        focusedForCapture,
        restoredFocus,
        capturedTabId,
      },
      resolution,
    );
  }

  private async getTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return {
      success: true,
      tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
    };
  }

  private async groupTabs(args: Record<string, any>) {
    const tabIds = Array.isArray(args.tabIds) ? args.tabIds.filter((id) => typeof id === 'number') : [];
    if (!tabIds.length) {
      return { success: false, error: 'No tab ids provided.' };
    }
    await this.groupTabsInternal(tabIds, { title: args.title, color: args.color });
    return { success: true, tabIds };
  }

  private async groupTabsInternal(tabIds: number[], options: GroupOptions) {
    if (!tabIds.length) return;
    const groupId = await chrome.tabs.group({ tabIds });
    if (options.title || options.color) {
      await chrome.tabGroups.update(groupId, {
        title: options.title,
        color: options.color,
      });
    }
  }
}
