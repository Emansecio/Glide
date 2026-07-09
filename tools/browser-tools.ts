import { type GlideBridgeOp, sendGlideBridge } from './content-bridge.js';
import { type TabResolution, withResolvedTab } from './tab-resolve.js';
import { buildToolDefinitions } from './tool-definitions.js';
import { INLINE_TOOL_HANDLERS, TOOL_HANDLER_REGISTRY } from './tool-registry.js';
import type { ToolDefinition } from './tool-schema.js';
import { clampInt, isHttpUrl, requireHttpUrl } from './validation.js';

type SessionTabSummary = {
  id: number;
  title?: string;
  url?: string;
};

type GroupOptions = {
  title?: string;
  color?: chrome.tabGroups.ColorEnum;
};

type ToolArgValidationResult = { ok: true; args: Record<string, any> } | { ok: false; error: string; hint?: string };

// Maximum number of tabs allowed per session to prevent runaway tab creation
const MAX_SESSION_TABS = 5;
const TAB_RESOLVE_MEMO_TTL_MS = 2000;

export class BrowserTools {
  tools: Record<string, true>;
  useContentBridge = true;
  private sessionTabs: Map<number, SessionTabSummary>;
  private currentSessionTabId: number | null;
  private sessionTabGroupId: number | null;
  private tabResolveMemo = new Map<
    string,
    { at: number; value: Awaited<ReturnType<BrowserTools['resolveExecutableTab']>> }
  >();

  constructor() {
    this.sessionTabs = new Map();
    this.currentSessionTabId = null;
    this.sessionTabGroupId = null;
    const toolNames = [...Object.keys(TOOL_HANDLER_REGISTRY), ...INLINE_TOOL_HANDLERS];
    this.tools = Object.fromEntries(toolNames.map((name) => [name, true as const]));
    this.bindTabLifecycleListeners();
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private _toolDefinitionsCache: ReturnType<typeof this.getToolDefinitions> | null = null;
  private _toolDefinitionsMap: Map<string, ToolDefinition> | null = null;

  private getToolDefinition(toolName: string) {
    if (!this._toolDefinitionsCache) {
      this._toolDefinitionsCache = this.getToolDefinitions();
      this._toolDefinitionsMap = new Map(this._toolDefinitionsCache.map((t) => [t.name, t]));
    }
    return this._toolDefinitionsMap?.get(toolName) ?? null;
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
      if (expectedType === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
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
      const trimmedUrl = normalizedArgs.url.trim();
      if (!trimmedUrl) {
        return { ok: false, error: `Argument "url" for ${toolName} cannot be empty.` };
      }
      const urlCheck = requireHttpUrl(trimmedUrl);
      if (!urlCheck.ok) {
        return {
          ok: false,
          error: `Invalid URL for ${toolName}: "${trimmedUrl}". Only http(s) URLs are supported.`,
          ...(urlCheck.hint ? { hint: urlCheck.hint } : {}),
        };
      }
      normalizedArgs.url = urlCheck.url;
    }

    if (
      (toolName === 'click' || toolName === 'hover' || toolName === 'mouse' || toolName === 'type') &&
      typeof normalizedArgs.selector === 'string'
    ) {
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
        normalizedArgs.amount = clampInt(normalizedArgs.amount, 1, 20000);
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
        normalizedArgs.maxChars = clampInt(normalizedArgs.maxChars, 200, 50000, 'floor');
      }
      if (normalizedArgs.maxItems !== undefined) {
        if (typeof normalizedArgs.maxItems !== 'number' || !Number.isFinite(normalizedArgs.maxItems)) {
          return { ok: false, error: 'Argument "maxItems" for getContent must be a finite number.' };
        }
        normalizedArgs.maxItems = clampInt(normalizedArgs.maxItems, 1, 500, 'floor');
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
        normalizedArgs.quality = clampInt(normalizedArgs.quality, 1, 100);
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
      normalizedArgs.retries = clampInt(normalizedArgs.retries, 1, 5);
    }

    if (toolName === 'findElement') {
      if (typeof normalizedArgs.query !== 'string' || !normalizedArgs.query.trim()) {
        return { ok: false, error: 'Argument "query" for findElement must be a non-empty string.' };
      }
      normalizedArgs.query = normalizedArgs.query.trim();
      if (normalizedArgs.type !== undefined) {
        const allowed = ['button', 'link', 'input', 'any'];
        const t = String(normalizedArgs.type).toLowerCase().trim();
        if (!allowed.includes(t)) {
          return { ok: false, error: `Argument "type" for findElement must be one of: ${allowed.join(', ')}.` };
        }
        normalizedArgs.type = t;
      }
      if (normalizedArgs.scope !== undefined) {
        const allowed = ['auto', 'page', 'dialog'];
        const s = String(normalizedArgs.scope).toLowerCase().trim();
        if (!allowed.includes(s)) {
          return { ok: false, error: `Argument "scope" for findElement must be one of: ${allowed.join(', ')}.` };
        }
        normalizedArgs.scope = s;
      }
      if (normalizedArgs.maxResults !== undefined) {
        if (typeof normalizedArgs.maxResults !== 'number' || !Number.isFinite(normalizedArgs.maxResults)) {
          return { ok: false, error: 'Argument "maxResults" for findElement must be a finite number.' };
        }
        normalizedArgs.maxResults = clampInt(normalizedArgs.maxResults, 1, 20);
      }
      if (normalizedArgs.fuzzy !== undefined) {
        if (typeof normalizedArgs.fuzzy !== 'boolean') {
          return { ok: false, error: 'Argument "fuzzy" for findElement must be a boolean.' };
        }
      }
    }

    if (toolName === 'click' && normalizedArgs.waitForDialog !== undefined) {
      if (typeof normalizedArgs.waitForDialog !== 'boolean') {
        return { ok: false, error: 'Argument "waitForDialog" for click must be a boolean.' };
      }
    }

    if (toolName === 'wait') {
      const condition = String(normalizedArgs.condition || '')
        .toLowerCase()
        .trim();
      if (!['time', 'selector', 'dialog', 'modal'].includes(condition)) {
        return {
          ok: false,
          error: 'Argument "condition" for wait must be "time", "selector", or "dialog".',
        };
      }
      normalizedArgs.condition = condition === 'modal' ? 'dialog' : condition;
      if (condition === 'time') {
        if (typeof normalizedArgs.ms !== 'number' || !Number.isFinite(normalizedArgs.ms)) {
          return {
            ok: false,
            error: 'Argument "ms" for wait is required when condition="time" and must be a finite number.',
          };
        }
        normalizedArgs.ms = clampInt(normalizedArgs.ms, 0, 15000);
      }
      if (condition === 'selector') {
        if (typeof normalizedArgs.selector !== 'string' || !normalizedArgs.selector.trim()) {
          return { ok: false, error: 'Argument "selector" for wait is required when condition="selector".' };
        }
        normalizedArgs.selector = normalizedArgs.selector.trim();
      }
      if (normalizedArgs.timeout !== undefined) {
        if (typeof normalizedArgs.timeout !== 'number' || !Number.isFinite(normalizedArgs.timeout)) {
          return { ok: false, error: 'Argument "timeout" for wait must be a finite number.' };
        }
        normalizedArgs.timeout = clampInt(normalizedArgs.timeout, 100, 15000);
      }
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
    return buildToolDefinitions(MAX_SESSION_TABS);
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
      await this.ensureSessionTabGroup({ title: options.title || 'Glide', color: options.color || 'blue' });
    }
  }

  async ensureSessionTabGroup(options: GroupOptions = { title: 'Glide', color: 'blue' }) {
    const sessionTabIds = Array.from(this.sessionTabs.keys());
    if (sessionTabIds.length === 0) return;

    try {
      if (this.sessionTabGroupId !== null) {
        await chrome.tabs.group({ groupId: this.sessionTabGroupId, tabIds: sessionTabIds });
      } else {
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
      if (INLINE_TOOL_HANDLERS.has(toolName)) {
        if (toolName === 'describeSessionTabs') {
          await this.pruneSessionTabs();
          return {
            success: true,
            tabs: this.getSessionTabSummaries(),
            tabCount: this.sessionTabs.size,
            maxTabs: MAX_SESSION_TABS,
            canOpenMore: this.sessionTabs.size < MAX_SESSION_TABS,
          };
        }
      }

      const handlerName = TOOL_HANDLER_REGISTRY[toolName];
      if (!handlerName) {
        return { success: false, error: `Unknown tool: ${toolName}` };
      }

      const handler = (this as Record<string, unknown>)[handlerName];
      if (typeof handler !== 'function') {
        return { success: false, error: `Unknown tool: ${toolName}` };
      }

      return await (handler as (args: Record<string, any>) => Promise<Record<string, any>>).call(this, safeArgs);
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

  setUseContentBridge(enabled: boolean) {
    this.useContentBridge = enabled;
  }

  private buildTabResolveMemoKey(args: Record<string, any>, toolName: string) {
    const requestedTabId = typeof args.tabId === 'number' ? args.tabId : 'none';
    const strictTabId = args?._strictTabId === true ? '1' : '0';
    return `${toolName}:${requestedTabId}:${strictTabId}:${this.currentSessionTabId ?? 'none'}`;
  }

  /**
   * Call the content-script bridge. Returns:
   * - null when bridge is off / unavailable / timed out (caller may inject)
   * - full response (success or structured failure) when the bridge handled the op
   *   so we do NOT fall through to the inject path and re-pay DOM work.
   */
  private async tryBridge(tabId: number, op: GlideBridgeOp, payload: Record<string, unknown>) {
    if (!this.useContentBridge) return null;
    const response = await sendGlideBridge(tabId, op, payload);
    if (!response) return null;
    // Trust any well-formed bridge payload (success or ELEMENT_NOT_FOUND etc.).
    if (typeof response.success === 'boolean' || response.bridge || response.code) {
      return response;
    }
    return null;
  }

  async resolveExecutableTab(args: Record<string, any> = {}, toolName = 'tool') {
    const memoKey = this.buildTabResolveMemoKey(args, toolName);
    const memo = this.tabResolveMemo.get(memoKey);
    if (memo && Date.now() - memo.at < TAB_RESOLVE_MEMO_TTL_MS) {
      return memo.value;
    }

    const requestedTabId = typeof args.tabId === 'number' ? args.tabId : null;
    const strictTabId = args?._strictTabId === true;
    const allowsNonHttpStrictTab = toolName === 'navigate';
    if (strictTabId && requestedTabId !== null) {
      const strictTab = await this.safeGetTab(requestedTabId);
      if (!strictTab || typeof strictTab.id !== 'number') {
        return {
          ok: false as const,
          result: this.buildNoExecutableTabError(toolName, requestedTabId, []),
        };
      }
      this.trackTab(strictTab);
      if (!isHttpUrl(strictTab.url) && !allowsNonHttpStrictTab) {
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
    // Deliberately NOT enumerating every tab in the window: falling back to an
    // arbitrary unrelated tab (e.g. the user's banking/email tab) would let an
    // LLM-driven click/type act on a page outside the automation session.
    // Candidates stay limited to the explicit/session/active tabs above.

    const tabs = await Promise.all(candidateIds.map((id) => this.safeGetTab(id)));
    const candidates: chrome.tabs.Tab[] = [];
    let selected: chrome.tabs.Tab | null = null;
    let selectedIndex = -1;

    for (let i = 0; i < candidateIds.length; i += 1) {
      const tab = tabs[i];
      if (!tab) {
        this.sessionTabs.delete(candidateIds[i]);
        if (this.currentSessionTabId === candidateIds[i]) {
          this.currentSessionTabId = null;
        }
        continue;
      }
      this.trackTab(tab);
      candidates.push(tab);
      if (!selected && isHttpUrl(tab.url)) {
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
    const resolved = {
      ok: true as const,
      resolution: {
        tabId: selected.id,
        tab: selected,
        requestedTabId,
        fallbackUsed,
      } as TabResolution,
    };
    this.tabResolveMemo.set(memoKey, { at: Date.now(), value: resolved });
    return resolved;
  }

  private async runInTab(
    tabId: number,
    func: (...args: any[]) => unknown,
    args: any[] = [],
    timeoutMs = 8000,
    allFrames = false,
  ): Promise<any> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Script execution timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      const results = await Promise.race([
        chrome.scripting.executeScript({
          target: allFrames ? { tabId, allFrames: true } : { tabId },
          func,
          args,
        }),
        timeoutPromise,
      ]);
      const injectionResults = (results as chrome.scripting.InjectionResult[]) || [];
      if (!allFrames) return injectionResults[0]?.result ?? null;
      const isUsefulFrameResult = (value: unknown) => {
        if (!value || typeof value !== 'object') return false;
        const result = value as Record<string, unknown>;
        if (result.success !== true) return false;
        if (result.found === false) return false;
        if (typeof result.count === 'number' && result.count <= 0) return false;
        return true;
      };
      const successful = injectionResults.find((entry) => {
        return isUsefulFrameResult(entry?.result);
      });
      const firstResult = successful || injectionResults[0];
      const result = firstResult?.result as Record<string, unknown> | null | undefined;
      if (result && typeof result === 'object') {
        return {
          ...result,
          frameId: firstResult.frameId,
          frameFallbackUsed: true,
          inspectedFrames: injectionResults.length,
        };
      }
      return result ?? null;
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

  async navigate(args: Record<string, any>) {
    return withResolvedTab(this, args, 'navigate', async (resolution) => {
      const tabId = resolution.tabId;
      const url = args.url;
      if (!url || typeof url !== 'string') {
        return { success: false, error: 'Missing or invalid url parameter.' };
      }

      const urlCheck = requireHttpUrl(url);
      if (!urlCheck.ok) {
        return { success: false, error: urlCheck.error, hint: urlCheck.hint };
      }

      try {
        await chrome.tabs.update(tabId, { url: urlCheck.url });
        this.currentSessionTabId = tabId;
        return { success: true, tabId, url: urlCheck.url };
      } catch (error) {
        return {
          success: false,
          error: `Navigation failed: ${error?.message || String(error)}`,
        };
      }
    });
  }

  async openTab(args: Record<string, any>) {
    await this.pruneSessionTabs();
    // Enforce tab limit to prevent runaway tab creation
    if (this.sessionTabs.size >= MAX_SESSION_TABS) {
      return {
        success: false,
        error: `Tab limit reached (max ${MAX_SESSION_TABS} tabs per session). Close existing tabs with closeTab or use navigate on current tab.`,
        hint: 'Use closeTab({ tabId: <id> }) to close a tab, or navigate({ url: "..." }) to reuse current tab.',
      };
    }

    const url = args.url;
    if (!url || typeof url !== 'string') {
      return { success: false, error: 'Missing or invalid url parameter.' };
    }

    const urlCheck = requireHttpUrl(url);
    if (!urlCheck.ok) {
      return { success: false, error: urlCheck.error, hint: urlCheck.hint };
    }

    try {
      const tab = await chrome.tabs.create({ url: urlCheck.url, active: true });
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

  async focusTab(args: Record<string, any>) {
    const tabId = typeof args.tabId === 'number' ? args.tabId : null;
    if (!tabId) return { success: false, error: 'Missing tabId.' };
    // Only tabs the automation session already owns may be focused/retargeted.
    // Without this guard a model could pull the user's authenticated
    // banking/email tab into the session and act on it.
    if (!this.sessionTabs.has(tabId)) {
      return {
        success: false,
        code: 'TAB_NOT_IN_SESSION',
        error: `Tab ${tabId} is not part of this automation session.`,
        hint: 'Use openTab to create a session tab; Glide only controls tabs it opened.',
      };
    }
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

  async closeTab(args: Record<string, any>) {
    const tabId = typeof args.tabId === 'number' ? args.tabId : null;
    if (!tabId) return { success: false, error: 'Missing tabId.' };
    if (!this.sessionTabs.has(tabId)) {
      return {
        success: false,
        code: 'TAB_NOT_IN_SESSION',
        error: `Tab ${tabId} is not part of this automation session and will not be closed.`,
        hint: 'Glide only closes tabs it opened during this session.',
      };
    }
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

  async click(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'click');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const selector = String(args.selector || '');
    // Default 2 attempts (was 3) — recovery Layer 3 handles hard misses cheaper than inject retries.
    const retries = typeof args.retries === 'number' ? Math.max(1, Math.min(5, Math.round(args.retries))) : 2;
    const waitForDialog = args.waitForDialog !== false;

    // Pure Instagram/React utility classes collide site-wide — never inject-click them alone.
    // Prefer fail + recovery candidates over success-on-wrong-target.
    if (/^\.x[a-z0-9]{4,}$/i.test(selector.trim())) {
      return this.attachResolutionMeta(
        {
          success: false,
          code: 'ELEMENT_NOT_FOUND',
          error: `Refusing unstable Instagram utility selector: ${selector}`,
          hint: 'Use a visible label (e.g. "seguindo") or a[href*="/following"]. Never reuse generic .x* classes.',
          similar_elements: [],
        },
        resolution,
      );
    }

    const bridged = await this.tryBridge(tabId, 'click', { selector, retries, waitForDialog });
    if (bridged) {
      return this.attachResolutionMeta(bridged, resolution);
    }

    let result = await this.runInTab(
      tabId,
      async (sel, maxAttempts, shouldWaitDialog) => {
        const selectorText = String(sel || '').trim();
        const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
        const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
        const normalize = (value: string) =>
          String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
        const clickableQuery =
          'button, a[href], [role="tab"], [role="button"], [role="link"], [role="menuitem"], input[type="submit"], input[type="button"], [onclick], [tabindex="0"]';
        const dialogSelector =
          '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]';
        const allElements = <T extends Element>(query: string, root: Document | Element = document) => {
          const results: T[] = [];
          const visit = (node: Document | ShadowRoot | Element) => {
            let matches: Element[] = [];
            try {
              matches = Array.from(node.querySelectorAll(query));
            } catch {
              return;
            }
            for (const element of matches) {
              results.push(element as T);
            }
            for (const element of Array.from(node.querySelectorAll('*'))) {
              const shadow = (element as HTMLElement).shadowRoot;
              if (shadow) visit(shadow);
            }
          };
          visit(root);
          return results;
        };
        const deepQuerySelector = <T extends Element>(query: string) => {
          if (!query.includes('>>>')) {
            try {
              return document.querySelector<T>(query);
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
            if (index === parts.length - 1) return next as T;
            const shadow = (next as HTMLElement).shadowRoot;
            if (!shadow) return null;
            root = shadow;
          }
          return null;
        };

        const listOpenDialogs = () =>
          allElements<HTMLElement>(dialogSelector)
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            })
            .map((el) => ({
              label: normalize(
                el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.textContent || 'dialog',
              ).slice(0, 80),
            }));

        const textHint = (() => {
          const quoted = selectorText.match(/["']([^"']+)["']/);
          if (quoted?.[1]) return quoted[1].trim();
          const bare = selectorText.replace(/^[#.]/, '').replace(/[_-]+/g, ' ').trim();
          if (!bare || bare.length < 2) return '';
          if (/[ >:[\]()]/.test(selectorText) && !quoted) return '';
          return bare;
        })();

        const clickCandidate = (element: HTMLElement | null, strategy: string) => {
          if (!element) return null;
          const disabled =
            (element as HTMLButtonElement | HTMLInputElement).disabled === true ||
            element.getAttribute('aria-disabled') === 'true';
          if (disabled) return null;
          element.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = element.getBoundingClientRect();
          const clientX = Math.round(rect.left + Math.min(rect.width / 2, Math.max(4, rect.width - 4)));
          const clientY = Math.round(rect.top + Math.min(rect.height / 2, Math.max(4, rect.height - 4)));
          // Instagram often layers transparent divs � prefer intended element even if hit-test differs.
          const hitElement = document.elementFromPoint(clientX, clientY);
          let eventTarget = element;
          if (hitElement instanceof HTMLElement) {
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
          try {
            eventTarget.focus?.({ preventScroll: true } as FocusOptions);
          } catch {
            eventTarget.focus?.();
          }
          if (typeof PointerEvent !== 'undefined') {
            eventTarget.dispatchEvent(
              new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse' }),
            );
          }
          eventTarget.dispatchEvent(new MouseEvent('mousedown', eventInit));
          if (typeof PointerEvent !== 'undefined') {
            eventTarget.dispatchEvent(
              new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse', buttons: 0 }),
            );
          }
          eventTarget.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
          eventTarget.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
          try {
            eventTarget.click();
          } catch {
            // ignore
          }
          return {
            success: true,
            strategy,
            matched: normalize(element.textContent || element.getAttribute('aria-label') || '').slice(0, 100),
            coordinates: { x: clientX, y: clientY },
            targetTag: eventTarget.tagName.toLowerCase(),
          };
        };

        const findClickables = () => allElements<HTMLElement>(clickableQuery);

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

        // Wait only for a *new* dialog after click. Progressive poll, early exit.
        // Avoids the previous ~900ms tax on every non-modal click.
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
          // Measure BEFORE click so post-click wait only detects *new* modals.
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

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (selectorText) {
            try {
              const exact = await tryClick(deepQuerySelector<HTMLElement>(selectorText), 'selector', attempt);
              if (exact) return exact;
            } catch {
              // Invalid selector syntax - continue with fallback strategies.
            }
          }

          const byText = await tryClick(findByText(textHint || selectorText), 'text_match', attempt);
          if (byText) return byText;

          const byHint = await tryClick(findByAttributeHint(textHint || selectorText), 'attribute_hint', attempt);
          if (byHint) return byHint;

          if (attempt < attempts) {
            await sleep(200 * attempt);
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
          hint: 'Try findElement({ query, scope: "auto" }) or getContent({ mode: "structure" }). Prefer short labels like "seguidores".',
          similar_elements: candidates,
          attempts,
          dialogsOpen: listOpenDialogs().length,
        };
      },
      [selector, retries, waitForDialog],
    );
    // Single all-frames pass with 1 attempt � avoid nested retry storms.
    if (result?.success === false && result?.code === 'ELEMENT_NOT_FOUND') {
      result = await this.runInTab(
        tabId,
        async (sel, maxAttempts) => {
          const selectorText = String(sel || '').trim();
          const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 1;
          const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
          const normalize = (value: string) =>
            String(value || '')
              .replace(/\s+/g, ' ')
              .trim();
          const clickableQuery =
            'button, a[href], [role="tab"], [role="button"], [role="link"], input[type="submit"], input[type="button"], [onclick]';
          const allElements = <T extends Element>(query: string) => {
            const results: T[] = [];
            const visit = (root: Document | ShadowRoot | Element) => {
              let matches: Element[] = [];
              try {
                matches = Array.from(root.querySelectorAll(query));
              } catch {
                return;
              }
              for (const element of matches) {
                results.push(element as T);
              }
              for (const element of Array.from(root.querySelectorAll('*'))) {
                const shadow = (element as HTMLElement).shadowRoot;
                if (shadow) visit(shadow);
              }
            };
            visit(document);
            return results;
          };
          const deepQuerySelector = <T extends Element>(query: string) => {
            if (!query.includes('>>>')) {
              try {
                return document.querySelector<T>(query);
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
              if (index === parts.length - 1) return next as T;
              const shadow = (next as HTMLElement).shadowRoot;
              if (!shadow) return null;
              root = shadow;
            }
            return null;
          };
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
            const disabled =
              (element as HTMLButtonElement | HTMLInputElement).disabled === true ||
              element.getAttribute('aria-disabled') === 'true';
            if (disabled) return null;
            element.scrollIntoView({ block: 'center', inline: 'center' });
            const rect = element.getBoundingClientRect();
            const clientX = Math.round(rect.left + rect.width / 2);
            const clientY = Math.round(rect.top + rect.height / 2);
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
              buttons: 1,
            };
            eventTarget.focus?.();
            if (typeof PointerEvent !== 'undefined') {
              eventTarget.dispatchEvent(
                new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse' }),
              );
            }
            eventTarget.dispatchEvent(new MouseEvent('mousedown', eventInit));
            if (typeof PointerEvent !== 'undefined') {
              eventTarget.dispatchEvent(
                new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse' }),
              );
            }
            eventTarget.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
            eventTarget.click();
            return {
              success: true,
              strategy,
              matched: normalize(element.textContent || element.getAttribute('aria-label') || '').slice(0, 100),
              coordinates: { x: clientX, y: clientY },
              targetTag: eventTarget.tagName.toLowerCase(),
            };
          };
          const findClickables = () => allElements<HTMLElement>(clickableQuery);
          const findByText = (query: string) => {
            const needle = normalize(query).toLowerCase();
            if (!needle) return null;
            return (
              findClickables().find((element) => {
                const text = normalize(element.textContent || '').toLowerCase();
                const aria = normalize(element.getAttribute('aria-label') || '').toLowerCase();
                const title = normalize(element.getAttribute('title') || '').toLowerCase();
                const value = normalize((element as HTMLInputElement).value || '').toLowerCase();
                return (
                  text.includes(needle) || aria.includes(needle) || title.includes(needle) || value.includes(needle)
                );
              }) || null
            );
          };
          const findByAttributeHint = (hint: string) => {
            const needle = normalize(hint).toLowerCase();
            if (!needle) return null;
            return (
              allElements<HTMLElement>(
                '[aria-label], [title], [data-testid], button[name], input[name], [role="button"], [role="link"]',
              ).find((element) => {
                const aria = normalize(element.getAttribute('aria-label') || '').toLowerCase();
                const title = normalize(element.getAttribute('title') || '').toLowerCase();
                const testId = normalize(element.getAttribute('data-testid') || '').toLowerCase();
                const name = normalize(element.getAttribute('name') || '').toLowerCase();
                return (
                  aria.includes(needle) || title.includes(needle) || testId.includes(needle) || name.includes(needle)
                );
              }) || null
            );
          };
          for (let attempt = 1; attempt <= attempts; attempt += 1) {
            if (selectorText) {
              try {
                const exact = clickCandidate(deepQuerySelector<HTMLElement>(selectorText), 'frame_selector');
                if (exact) return { ...exact, attempt };
              } catch {
                // Invalid selector syntax - continue with fallback strategies.
              }
            }
            const byText = clickCandidate(findByText(textHint || selectorText), 'frame_text_match');
            if (byText) return { ...byText, attempt };
            const byHint = clickCandidate(findByAttributeHint(textHint || selectorText), 'frame_attribute_hint');
            if (byHint) return { ...byHint, attempt };
            if (attempt < attempts) await sleep(250 * attempt);
          }
          return {
            success: false,
            code: 'ELEMENT_NOT_FOUND',
            error: `Element not found in main document or accessible frames for selector: ${selectorText}`,
            attempts,
          };
        },
        [selector, 1],
        8000,
        true,
      );
    }
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  async hover(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'hover');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const selector = String(args.selector || '');
    const retries = typeof args.retries === 'number' ? Math.max(1, Math.min(5, Math.round(args.retries))) : 3;

    const bridged = await this.tryBridge(tabId, 'hover', { selector, retries });
    if (bridged) {
      return this.attachResolutionMeta(bridged, resolution);
    }

    const hoverScript = async (sel: string, maxAttempts: number, frameMode = false) => {
      const selectorText = String(sel || '').trim();
      const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
      const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
      const normalize = (value: string) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim();
      const hoverQuery =
        'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [aria-label], [title], [data-testid], [onclick]';
      const allElements = <T extends Element>(query: string) => {
        const results: T[] = [];
        const visit = (root: Document | ShadowRoot | Element) => {
          let matches: Element[] = [];
          try {
            matches = Array.from(root.querySelectorAll(query));
          } catch {
            return;
          }
          for (const element of matches) {
            results.push(element as T);
          }
          for (const element of Array.from(root.querySelectorAll('*'))) {
            const shadow = (element as HTMLElement).shadowRoot;
            if (shadow) visit(shadow);
          }
        };
        visit(document);
        return results;
      };
      const deepQuerySelector = <T extends Element>(query: string) => {
        if (!query.includes('>>>')) {
          try {
            return document.querySelector<T>(query);
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
          if (index === parts.length - 1) return next as T;
          const shadow = (next as HTMLElement).shadowRoot;
          if (!shadow) return null;
          root = shadow;
        }
        return null;
      };
      const textHint = (() => {
        const quoted = selectorText.match(/["']([^"']+)["']/);
        if (quoted?.[1]) return quoted[1].trim();
        const bare = selectorText.replace(/^[#.]/, '').replace(/[_-]+/g, ' ').trim();
        if (!bare || bare.length < 3) return '';
        if (/[ >:[\]()]/.test(selectorText)) return '';
        return bare;
      })();
      const findByText = (query: string) => {
        const needle = normalize(query).toLowerCase();
        if (!needle) return null;
        return (
          allElements<HTMLElement>(hoverQuery).find((element) => {
            const text = normalize(element.textContent || '').toLowerCase();
            const aria = normalize(element.getAttribute('aria-label') || '').toLowerCase();
            const title = normalize(element.getAttribute('title') || '').toLowerCase();
            const testId = normalize(element.getAttribute('data-testid') || '').toLowerCase();
            const value = normalize((element as HTMLInputElement).value || '').toLowerCase();
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
      const hoverCandidate = (element: HTMLElement | null, strategy: string) => {
        if (!element) return null;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        const clientX = Math.round(rect.left + rect.width / 2);
        const clientY = Math.round(rect.top + rect.height / 2);
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
          const exact = hoverCandidate(
            deepQuerySelector<HTMLElement>(selectorText),
            frameMode ? 'frame_selector' : 'selector',
          );
          if (exact) return { ...exact, attempt };
        }
        const byText = hoverCandidate(
          findByText(textHint || selectorText),
          frameMode ? 'frame_text_match' : 'text_match',
        );
        if (byText) return { ...byText, attempt };
        if (attempt < attempts) await sleep(250 * attempt);
      }
      const candidates = allElements<HTMLElement>(hoverQuery)
        .slice(0, 10)
        .map((element) => ({
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
    };

    let result = await this.runInTab(tabId, hoverScript, [selector, retries, false]);
    if (result?.success === false && result?.code === 'ELEMENT_NOT_FOUND') {
      result = await this.runInTab(tabId, hoverScript, [selector, retries, true], 8000, true);
    }
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  async mouse(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'mouse');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const selector = String(args.selector || '');
    const action = String(args.action || '');
    const retries = typeof args.retries === 'number' ? Math.max(1, Math.min(5, Math.round(args.retries))) : 3;

    const bridged = await this.tryBridge(tabId, 'mouse', { selector, action, retries });
    if (bridged) {
      return this.attachResolutionMeta(bridged, resolution);
    }

    const mouseScript = async (sel: string, act: string, maxAttempts: number, frameMode = false) => {
      const selectorText = String(sel || '').trim();
      const actionName = String(act || '');
      const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
      const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
      const normalize = (value: string) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim();
      const targetQuery =
        'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [aria-label], [title], [data-testid], [onclick]';
      const allElements = <T extends Element>(query: string) => {
        const results: T[] = [];
        const visit = (root: Document | ShadowRoot | Element) => {
          let matches: Element[] = [];
          try {
            matches = Array.from(root.querySelectorAll(query));
          } catch {
            return;
          }
          for (const element of matches) {
            results.push(element as T);
          }
          for (const element of Array.from(root.querySelectorAll('*'))) {
            const shadow = (element as HTMLElement).shadowRoot;
            if (shadow) visit(shadow);
          }
        };
        visit(document);
        return results;
      };
      const deepQuerySelector = <T extends Element>(query: string) => {
        if (!query.includes('>>>')) {
          try {
            return document.querySelector<T>(query);
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
          if (index === parts.length - 1) return next as T;
          const shadow = (next as HTMLElement).shadowRoot;
          if (!shadow) return null;
          root = shadow;
        }
        return null;
      };
      const textHint = (() => {
        const quoted = selectorText.match(/["']([^"']+)["']/);
        if (quoted?.[1]) return quoted[1].trim();
        const bare = selectorText.replace(/^[#.]/, '').replace(/[_-]+/g, ' ').trim();
        if (!bare || bare.length < 3) return '';
        if (/[ >:[\]()]/.test(selectorText)) return '';
        return bare;
      })();
      const findByText = (query: string) => {
        const needle = normalize(query).toLowerCase();
        if (!needle) return null;
        return (
          allElements<HTMLElement>(targetQuery).find((element) => {
            const text = normalize(element.textContent || '').toLowerCase();
            const aria = normalize(element.getAttribute('aria-label') || '').toLowerCase();
            const title = normalize(element.getAttribute('title') || '').toLowerCase();
            const testId = normalize(element.getAttribute('data-testid') || '').toLowerCase();
            const value = normalize((element as HTMLInputElement).value || '').toLowerCase();
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
      const performMouseAction = (element: HTMLElement | null, strategy: string) => {
        if (!element) return null;
        const disabled =
          (element as HTMLButtonElement | HTMLInputElement).disabled === true ||
          element.getAttribute('aria-disabled') === 'true';
        if (disabled) return null;
        element.scrollIntoView({ block: 'center', inline: 'center' });
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
          const exact = performMouseAction(
            deepQuerySelector<HTMLElement>(selectorText),
            frameMode ? 'frame_selector' : 'selector',
          );
          if (exact) return { ...exact, attempt };
        }
        const byText = performMouseAction(
          findByText(textHint || selectorText),
          frameMode ? 'frame_text_match' : 'text_match',
        );
        if (byText) return { ...byText, attempt };
        if (attempt < attempts) await sleep(250 * attempt);
      }
      const candidates = allElements<HTMLElement>(targetQuery)
        .slice(0, 10)
        .map((element) => ({
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
    };

    let result = await this.runInTab(tabId, mouseScript, [selector, action, retries, false]);
    if (result?.success === false && result?.code === 'ELEMENT_NOT_FOUND') {
      result = await this.runInTab(tabId, mouseScript, [selector, action, retries, true], 8000, true);
    }
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  async type(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'type');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const selector = String(args.selector || '');
    const text = String(args.text ?? '');
    const retries = typeof args.retries === 'number' ? Math.max(1, Math.min(5, Math.round(args.retries))) : 2;

    const bridged = await this.tryBridge(tabId, 'type', { selector, text, retries });
    if (bridged) {
      return this.attachResolutionMeta(bridged, resolution);
    }

    let result = await this.runInTab(
      tabId,
      async (sel, value, maxAttempts) => {
        const selectorText = String(sel || '').trim();
        const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
        const targetValue = String(value ?? '');
        const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
        const normalize = (input: string) =>
          String(input || '')
            .replace(/\s+/g, ' ')
            .trim();

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
            const labelByFor = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (labelByFor?.textContent) return normalize(labelByFor.textContent);
          }
          const parentLabel = inputElement.closest('label');
          if (parentLabel?.textContent) return normalize(parentLabel.textContent);
          return '';
        };

        const getInputCandidates = () =>
          (() => {
            const results: Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement> = [];
            const visit = (root: Document | ShadowRoot | Element) => {
              const matches = Array.from(
                root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement>(
                  'input, textarea, select, [contenteditable="true"]',
                ),
              );
              for (const element of matches) {
                results.push(element);
              }
              for (const element of Array.from(root.querySelectorAll('*'))) {
                const shadow = (element as HTMLElement).shadowRoot;
                if (shadow) visit(shadow);
              }
            };
            visit(document);
            return results;
          })();
        const deepQuerySelector = (query: string) => {
          if (!query.includes('>>>')) {
            try {
              return document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement>(
                query,
              );
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
            if (index === parts.length - 1) {
              return next as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;
            }
            const shadow = (next as HTMLElement).shadowRoot;
            if (!shadow) return null;
            root = shadow;
          }
          return null;
        };

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

        const applyValue = (
          element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement,
          nextValue: string,
        ) => {
          const isSelect = element instanceof HTMLSelectElement;
          const isTextFormField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
          const disabled =
            ((isTextFormField || isSelect) && element.disabled === true) ||
            element.getAttribute('aria-disabled') === 'true';
          const readOnly = isTextFormField && element.readOnly === true;
          if (disabled || readOnly) return false;

          element.scrollIntoView({ block: 'center', inline: 'nearest' });
          element.focus();

          if (isSelect) {
            const normalizedValue = normalize(nextValue).toLowerCase();
            const options = Array.from(element.options);
            const option =
              options.find((candidate) => candidate.value === nextValue) ||
              options.find((candidate) => normalize(candidate.textContent || '') === normalize(nextValue)) ||
              options.find(
                (candidate) =>
                  candidate.value.toLowerCase() === normalizedValue ||
                  normalize(candidate.textContent || '').toLowerCase() === normalizedValue,
              ) ||
              options.find(
                (candidate) =>
                  candidate.value.toLowerCase().includes(normalizedValue) ||
                  normalize(candidate.textContent || '')
                    .toLowerCase()
                    .includes(normalizedValue),
              );
            if (!option) return false;
            element.value = option.value;
            option.selected = true;
            element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
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
              element.setSelectionRange(0, element.value.length);
            } catch {
              // Some input types do not support text selection.
            }
            const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
            if (descriptor?.set) {
              descriptor.set.call(element, nextValue);
            } else {
              element.value = nextValue;
            }
          } else {
            element.textContent = nextValue;
          }
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
          return true;
        };

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          let target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement | null = null;
          let strategy = 'selector';
          if (selectorText) {
            try {
              target = deepQuerySelector(selectorText);
            } catch {
              target = null;
            }
          }
          if (!target) {
            target = findByHint(textHint || selectorText);
            strategy = 'hint_match';
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
    if (result?.success === false && result?.code === 'ELEMENT_NOT_FOUND') {
      result = await this.runInTab(
        tabId,
        async (sel, value, maxAttempts) => {
          const selectorText = String(sel || '').trim();
          const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
          const targetValue = String(value ?? '');
          const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
          const normalize = (input: string) =>
            String(input || '')
              .replace(/\s+/g, ' ')
              .trim();
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
              const labelByFor = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              if (labelByFor?.textContent) return normalize(labelByFor.textContent);
            }
            const parentLabel = inputElement.closest('label');
            if (parentLabel?.textContent) return normalize(parentLabel.textContent);
            return '';
          };
          const getInputCandidates = () => {
            const results: Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement> = [];
            const visit = (root: Document | ShadowRoot | Element) => {
              const matches = Array.from(
                root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement>(
                  'input, textarea, select, [contenteditable="true"]',
                ),
              );
              for (const element of matches) {
                results.push(element);
              }
              for (const element of Array.from(root.querySelectorAll('*'))) {
                const shadow = (element as HTMLElement).shadowRoot;
                if (shadow) visit(shadow);
              }
            };
            visit(document);
            return results;
          };
          const deepQuerySelector = (query: string) => {
            if (!query.includes('>>>')) {
              try {
                return document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement>(
                  query,
                );
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
              if (index === parts.length - 1) {
                return next as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;
              }
              const shadow = (next as HTMLElement).shadowRoot;
              if (!shadow) return null;
              root = shadow;
            }
            return null;
          };
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
          const applyValue = (
            element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement,
            nextValue: string,
          ) => {
            const isSelect = element instanceof HTMLSelectElement;
            const isTextFormField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
            const disabled =
              ((isTextFormField || isSelect) && element.disabled === true) ||
              element.getAttribute('aria-disabled') === 'true';
            const readOnly = isTextFormField && element.readOnly === true;
            if (disabled || readOnly) return false;

            element.scrollIntoView({ block: 'center', inline: 'nearest' });
            element.focus();

            if (isSelect) {
              const normalizedValue = normalize(nextValue).toLowerCase();
              const options = Array.from(element.options);
              const option =
                options.find((candidate) => candidate.value === nextValue) ||
                options.find((candidate) => normalize(candidate.textContent || '') === normalize(nextValue)) ||
                options.find(
                  (candidate) =>
                    candidate.value.toLowerCase() === normalizedValue ||
                    normalize(candidate.textContent || '').toLowerCase() === normalizedValue,
                ) ||
                options.find(
                  (candidate) =>
                    candidate.value.toLowerCase().includes(normalizedValue) ||
                    normalize(candidate.textContent || '')
                      .toLowerCase()
                      .includes(normalizedValue),
                );
              if (!option) return false;
              element.value = option.value;
              option.selected = true;
              element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
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
                element.setSelectionRange(0, element.value.length);
              } catch {
                // Some input types do not support text selection.
              }
              const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
              if (descriptor?.set) descriptor.set.call(element, nextValue);
              else element.value = nextValue;
            } else {
              element.textContent = nextValue;
            }
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
            return true;
          };
          for (let attempt = 1; attempt <= attempts; attempt += 1) {
            let target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement | null = null;
            let strategy = 'frame_selector';
            if (selectorText) {
              try {
                target = deepQuerySelector(selectorText);
              } catch {
                target = null;
              }
            }
            if (!target) {
              target = findByHint(textHint || selectorText);
              strategy = 'frame_hint_match';
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
            error: `Input not found in main document or accessible frames for selector: ${selectorText}`,
            attempts,
          };
        },
        [selector, text, 1],
        8000,
        true,
      );
    }
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  async pressKey(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'pressKey');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const key = String(args.key || '');
    const selector = args.selector ? String(args.selector) : '';

    const bridged = await this.tryBridge(tabId, 'pressKey', { key, selector: selector || undefined });
    if (bridged) {
      return this.attachResolutionMeta(bridged, resolution);
    }

    let result = await this.runInTab(
      tabId,
      (k, sel) => {
        const deepQuerySelector = (query: string) => {
          if (!query.includes('>>>')) return document.querySelector<HTMLElement>(query);
          const parts = query
            .split('>>>')
            .map((part) => part.trim())
            .filter(Boolean);
          let root: Document | ShadowRoot | Element = document;
          for (let index = 0; index < parts.length; index += 1) {
            const next = root.querySelector(parts[index]);
            if (!next) return null;
            if (index === parts.length - 1) return next as HTMLElement;
            const shadow = (next as HTMLElement).shadowRoot;
            if (!shadow) return null;
            root = shadow;
          }
          return null;
        };
        let target: HTMLElement | null = null;
        if (sel) {
          try {
            target = deepQuerySelector(sel);
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
        target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent('keypress', { key: k, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
        // React/Vue compatibility: dispatch input and change events
        if (typeof InputEvent !== 'undefined') {
          target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        } else {
          target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        }
        target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return { success: true };
      },
      [key, selector],
    );
    if (selector && result?.success === false) {
      result = await this.runInTab(
        tabId,
        (k, sel) => {
          const deepQuerySelector = (query: string) => {
            if (!query.includes('>>>')) return document.querySelector<HTMLElement>(query);
            const parts = query
              .split('>>>')
              .map((part) => part.trim())
              .filter(Boolean);
            let root: Document | ShadowRoot | Element = document;
            for (let index = 0; index < parts.length; index += 1) {
              const next = root.querySelector(parts[index]);
              if (!next) return null;
              if (index === parts.length - 1) return next as HTMLElement;
              const shadow = (next as HTMLElement).shadowRoot;
              if (!shadow) return null;
              root = shadow;
            }
            return null;
          };
          let target: HTMLElement | null = null;
          try {
            target = deepQuerySelector(sel);
          } catch {
            return {
              success: false,
              code: 'INVALID_SELECTOR',
              error: `Invalid selector syntax: ${String(sel)}`,
            };
          }
          if (!target) return { success: false, error: 'Target not found in main document or accessible frames.' };
          target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
          target.dispatchEvent(new KeyboardEvent('keypress', { key: k, bubbles: true, cancelable: true }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
          if (typeof InputEvent !== 'undefined') {
            target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
          } else {
            target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          }
          target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          return { success: true };
        },
        [key, selector],
        8000,
        true,
      );
    }
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(baseResult, resolution);
  }

  async scroll(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'scroll');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const direction = String(args.direction || 'down');
    const amount = typeof args.amount === 'number' ? args.amount : 600;

    const bridged = await this.tryBridge(tabId, 'scroll', { direction, amount });
    if (bridged) {
      return this.attachResolutionMeta(bridged, resolution);
    }

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

  async findElement(args: Record<string, any>) {
    return withResolvedTab(this, args, 'findElement', async (resolution) => {
      const tabId = resolution.tabId;
      const query = String(args.query || '');
      const typeFilter = String(args.type || 'any').toLowerCase();
      const maxResults = typeof args.maxResults === 'number' ? clampInt(args.maxResults, 1, 20) : 5;
      const scope = String(args.scope || 'auto').toLowerCase();

      const fuzzy = args.fuzzy !== false;

      const bridged = await this.tryBridge(tabId, 'findElement', {
        query,
        type: typeFilter,
        maxResults,
        fuzzy,
        scope,
      });
      if (bridged) {
        return this.attachResolutionMeta(bridged, resolution);
      }

      const findScript = (
        searchQuery: string,
        filterType: string,
        maxRes: number,
        useFuzzy: boolean,
        searchScope: string,
      ) => {
        // Selector helpers inlined (no eval) so injection works under strict page CSP (e.g. Instagram).
        function buildLocalSelector(element: any, options?: any) {
          options = options || {};
          if (element.id) return '#' + CSS.escape(element.id);
          const dataTestId = element.getAttribute('data-testid');
          if (dataTestId) return '[data-testid="' + CSS.escape(dataTestId) + '"]';
          const name = element.getAttribute('name');
          if (name) return '[name="' + CSS.escape(name) + '"]';
          const ariaLabel = element.getAttribute('aria-label');
          if (ariaLabel) return '[aria-label="' + CSS.escape(ariaLabel) + '"]';
          if (options.includePlaceholder) {
            const placeholder = element.placeholder;
            if (placeholder) return '[placeholder="' + CSS.escape(placeholder) + '"]';
          }
          const cls = Array.from(element.classList).find(
            (c: any) => /^[a-z][a-z0-9_-]{2,40}$/i.test(c) && !/[0-9]{5,}/.test(c),
          );
          if (cls) return '.' + cls;
          const parent = element.parentElement;
          if (parent) {
            const tag = element.tagName.toLowerCase();
            const siblings = Array.from(parent.children).filter((c: any) => c.tagName.toLowerCase() === tag);
            const index = siblings.indexOf(element) + 1;
            return tag + ':nth-child(' + index + ')';
          }
          return element.tagName.toLowerCase();
        }
        function buildOptimalSelector(element: any) {
          const localSelector = buildLocalSelector(element, { includePlaceholder: true });
          const root = element.getRootNode();
          if (root instanceof ShadowRoot) {
            return buildOptimalSelector(root.host) + ' >>> ' + localSelector;
          }
          return localSelector;
        }
        const normalize = (value: string) =>
          String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
        const needle = normalize(searchQuery).toLowerCase();
        if (!needle) return { success: false, error: 'Empty query.' };

        // Levenshtein with early length-band skip (avoids O(|a|�|b|) on long fields).
        const MAX_FUZZY_FIELD_LEN = 40;
        const MAX_CANDIDATE_SCAN = 300;
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

        // Cheap visibility: skip getComputedStyle unless offsetParent is null (and still not fixed/sticky edge cases).
        const isVisible = (element: HTMLElement) => {
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

        const INTERACTIVE =
          'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], label, [tabindex="0"]';
        const DIALOG_SEL =
          '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]';
        const allElements: HTMLElement[] = [];
        const collectElements = (root: Document | ShadowRoot | Element) => {
          if (allElements.length >= MAX_CANDIDATE_SCAN) return;
          const matches = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE));
          for (const element of matches) {
            allElements.push(element);
            if (allElements.length >= MAX_CANDIDATE_SCAN) return;
          }
          // Only walk open shadow roots (not every node) to pierce web components cheaply.
          const hosts = Array.from(root.querySelectorAll<HTMLElement>('*')).filter((el) => el.shadowRoot);
          for (const host of hosts) {
            if (allElements.length >= MAX_CANDIDATE_SCAN) return;
            if (host.shadowRoot) collectElements(host.shadowRoot);
          }
        };

        // Prefer open dialog/modal as search root (Instagram followers sheet, etc.).
        let searchRoot: Document | Element = document;
        const openDialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SEL)).filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (searchScope === 'dialog') {
          searchRoot = openDialogs[openDialogs.length - 1] || document;
        } else if (searchScope === 'auto' && openDialogs.length > 0) {
          searchRoot = openDialogs[openDialogs.length - 1];
        }
        collectElements(searchRoot);
        // If dialog scope found nothing useful, fall back to full page once.
        if (allElements.length === 0 && searchRoot !== document && searchScope !== 'dialog') {
          collectElements(document);
        }

        const exactCandidates: HTMLElement[] = [];
        const fuzzyCandidates: Array<{ element: HTMLElement; distance: number }> = [];
        const threshold = useFuzzy ? fuzzyThreshold(needle) : 0;

        const passesTypeFilter = (element: HTMLElement, tag: string) => {
          if (filterType === 'any') return true;
          if (
            filterType === 'button' &&
            !['button', 'input'].includes(tag) &&
            element.getAttribute('role') !== 'button'
          )
            return false;
          if (filterType === 'link' && tag !== 'a') return false;
          if (filterType === 'input' && !['input', 'textarea', 'select'].includes(tag)) return false;
          return true;
        };

        // Phase 1: exact match on short attributes only (aria/name/testid/placeholder/title).
        for (const element of allElements) {
          if (!isVisible(element)) continue;
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

          if (shortFields.some((field) => field.includes(needle) || needle.includes(field))) {
            exactCandidates.push(element);
            if (exactCandidates.length >= maxRes) break;
          }
        }

        // Phase 2: exact substring on visible text (only if still short of maxRes).
        if (exactCandidates.length < maxRes) {
          for (const element of allElements) {
            if (exactCandidates.includes(element)) continue;
            if (!isVisible(element)) continue;
            const tag = element.tagName.toLowerCase();
            if (!passesTypeFilter(element, tag)) continue;
            const text = normalize(element.innerText || element.textContent || '').toLowerCase();
            if (text && text.length <= 200 && text.includes(needle)) {
              exactCandidates.push(element);
              if (exactCandidates.length >= maxRes) break;
            }
          }
        }

        // Phase 3: fuzzy only on short attributes (never full innerText Levenshtein).
        if (useFuzzy && threshold > 0 && exactCandidates.length < maxRes) {
          for (const element of allElements) {
            if (exactCandidates.includes(element)) continue;
            if (!isVisible(element)) continue;
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
              // Word-level only for multi-word short labels.
              if (field.includes(' ')) {
                for (const word of field.split(/\s+/)) {
                  if (word.length < needle.length - threshold || word.length > needle.length + threshold) continue;
                  const wdist = levenshtein(needle, word.toLowerCase());
                  if (wdist < minDist) minDist = wdist;
                }
              }
            }
            if (minDist <= threshold) {
              fuzzyCandidates.push({ element, distance: minDist });
            }
          }
        }

        // Prioritize exact matches, then fuzzy sorted by distance
        const combined = exactCandidates.slice(0, maxRes);
        if (combined.length < maxRes && fuzzyCandidates.length > 0) {
          fuzzyCandidates.sort((a, b) => a.distance - b.distance);
          const remaining = maxRes - combined.length;
          for (const fc of fuzzyCandidates.slice(0, remaining)) {
            if (!combined.includes(fc.element)) {
              combined.push(fc.element);
            }
          }
        }

        const results = combined.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            selector: buildOptimalSelector(element),
            tag: element.tagName.toLowerCase(),
            text: normalize(element.innerText || element.textContent || element.getAttribute('aria-label') || '').slice(
              0,
              120,
            ),
            visible: isVisible(element),
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
      };
      let result = await this.runInTab(
        tabId,
        findScript,
        [query, typeFilter, maxResults, fuzzy, scope],
        8000,
        false,
      );
      if (!result?.success) {
        const frameResult = await this.runInTab(
          tabId,
          findScript,
          [query, typeFilter, maxResults, fuzzy, scope],
          8000,
          true,
        );
        if (frameResult?.success) result = frameResult;
      }
      const baseResult = result || { success: false, error: 'Script execution failed.' };
      return this.attachResolutionMeta(baseResult, resolution);
    });
  }

  async dismissModal(args: Record<string, any> = {}) {
    const resolved = await this.resolveExecutableTab(args, 'dismissModal');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;

    const bridged = await this.tryBridge(tabId, 'dismissModal', {});
    if (bridged) {
      return this.attachResolutionMeta(bridged, resolution);
    }

    const result = await this.runInTab(
      tabId,
      async () => {
        const dialogSel =
          '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]';
        const closeSel =
          'button[aria-label*="close" i], button[aria-label*="fechar" i], [role="button"][aria-label*="close" i], svg[aria-label="Close"], svg[aria-label="Fechar"]';
        const isVis = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const dialogs = Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVis);
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
          el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
          try {
            el.click();
          } catch {
            // ignore
          }
        };

        const before = dialogs.length;
        const root = dialogs[dialogs.length - 1] || document;
        let closeBtn =
          Array.from(root.querySelectorAll<HTMLElement>(closeSel)).find(isVis) ||
          Array.from(document.querySelectorAll<HTMLElement>(closeSel)).find(isVis) ||
          null;
        if (closeBtn?.tagName === 'svg') {
          closeBtn = (closeBtn.closest('button, [role="button"]') as HTMLElement | null) || closeBtn;
        }
        if (closeBtn) {
          richClick(closeBtn);
          return {
            success: true,
            strategy: 'close-button',
            dialogsRemaining: Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVis).length,
          };
        }
        pressEscape();
        await new Promise((r) => setTimeout(r, 200));
        const after = Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVis).length;
        if (after < before || before === 0) {
          return { success: true, strategy: 'escape', dialogsRemaining: after };
        }
        return {
          success: false,
          error: 'Could not dismiss modal.',
          hint: 'Try pressKey({ key: "Escape" }) or findElement({ query: "Close", scope: "dialog" }) then click.',
          dialogsRemaining: after,
        };
      },
      [],
    );
    return this.attachResolutionMeta(result || { success: false, error: 'dismissModal failed' }, resolution);
  }

  async wait(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'wait');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const condition = String(args.condition || '');

    if (condition === 'time') {
      const ms = typeof args.ms === 'number' ? Math.max(0, Math.min(15000, Math.round(args.ms))) : 1000;
      const bridged = await this.tryBridge(tabId, 'wait', { condition: 'time', ms });
      if (bridged) return this.attachResolutionMeta(bridged, resolution);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return this.attachResolutionMeta({ success: true, waited: ms, condition: 'time' }, resolution);
    }

    if (condition === 'dialog' || condition === 'modal') {
      const timeout =
        typeof args.timeout === 'number' ? Math.max(100, Math.min(15000, Math.round(args.timeout))) : 5000;
      const bridged = await this.tryBridge(tabId, 'wait', { condition: 'dialog', timeoutMs: timeout });
      if (bridged) return this.attachResolutionMeta(bridged, resolution);
      const result = await this.runInTab(
        tabId,
        (to: number) =>
          new Promise((resolve) => {
            const t0 = Date.now();
            const sel = '[role="dialog"], [aria-modal="true"], div[role="dialog"]';
            const tick = () => {
              const open = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              });
              if (open.length) {
                resolve({
                  success: true,
                  condition: 'dialog',
                  dialogsOpen: open.length,
                  elapsed: Date.now() - t0,
                });
                return;
              }
              if (Date.now() - t0 >= to) {
                resolve({ success: false, code: 'WAIT_TIMEOUT', error: 'No dialog appeared.', elapsed: Date.now() - t0 });
                return;
              }
              setTimeout(tick, 100);
            };
            tick();
          }),
        [timeout],
        Math.min(16000, timeout + 1000),
      );
      return this.attachResolutionMeta(result || { success: false, error: 'wait dialog failed' }, resolution);
    }

    // condition === 'selector'
    const selector = String(args.selector || '');
    const timeout = typeof args.timeout === 'number' ? Math.max(100, Math.min(15000, Math.round(args.timeout))) : 5000;
    const interval = 250;
    const bridged = await this.tryBridge(tabId, 'wait', { condition: 'selector', selector, timeoutMs: timeout });
    if (bridged) return this.attachResolutionMeta(bridged, resolution);

    let result = await this.runInTab(
      tabId,
      (sel: string, to: number, intv: number) => {
        return new Promise<{ success: boolean; found: boolean; elapsed: number; selector: string }>((resolve) => {
          const t0 = Date.now();
          const deepQuerySelector = (query: string) => {
            if (!query.includes('>>>')) return document.querySelector(query);
            const parts = query
              .split('>>>')
              .map((part) => part.trim())
              .filter(Boolean);
            let root: Document | ShadowRoot | Element = document;
            for (let index = 0; index < parts.length; index += 1) {
              const next = root.querySelector(parts[index]);
              if (!next) return null;
              if (index === parts.length - 1) return next;
              const shadow = (next as HTMLElement).shadowRoot;
              if (!shadow) return null;
              root = shadow;
            }
            return null;
          };
          const check = () => {
            try {
              const element = deepQuerySelector(sel);
              if (element) {
                resolve({ success: true, found: true, elapsed: Date.now() - t0, selector: sel });
                return;
              }
            } catch {
              // Invalid selector, keep waiting
            }
            if (Date.now() - t0 >= to) {
              resolve({ success: true, found: false, elapsed: Date.now() - t0, selector: sel });
              return;
            }
            setTimeout(check, intv);
          };
          check();
        });
      },
      [selector, timeout, interval],
      timeout + 1000,
    );
    if (result?.success === true && result?.found === false) {
      result = await this.runInTab(
        tabId,
        (sel: string, to: number, intv: number) => {
          return new Promise<{ success: boolean; found: boolean; elapsed: number; selector: string }>((resolve) => {
            const t0 = Date.now();
            const deepQuerySelector = (query: string) => {
              if (!query.includes('>>>')) return document.querySelector(query);
              const parts = query
                .split('>>>')
                .map((part) => part.trim())
                .filter(Boolean);
              let root: Document | ShadowRoot | Element = document;
              for (let index = 0; index < parts.length; index += 1) {
                const next = root.querySelector(parts[index]);
                if (!next) return null;
                if (index === parts.length - 1) return next;
                const shadow = (next as HTMLElement).shadowRoot;
                if (!shadow) return null;
                root = shadow;
              }
              return null;
            };
            const check = () => {
              try {
                const element = deepQuerySelector(sel);
                if (element) {
                  resolve({ success: true, found: true, elapsed: Date.now() - t0, selector: sel });
                  return;
                }
              } catch {
                // Invalid selector, keep waiting.
              }
              if (Date.now() - t0 >= to) {
                resolve({ success: true, found: false, elapsed: Date.now() - t0, selector: sel });
                return;
              }
              setTimeout(check, intv);
            };
            check();
          });
        },
        [selector, timeout, interval],
        timeout + 1000,
        true,
      );
    }

    let baseResult = result || { success: false, error: 'Script execution failed.' };
    if (baseResult?.found === false) {
      baseResult = {
        ...baseResult,
        success: false,
        code: 'WAIT_TIMEOUT',
        error: `Selector not found within ${timeout}ms: ${selector}`,
        hint: 'Use findElement or getContent({ mode: "structure" }) to verify the selector.',
      };
    }
    return this.attachResolutionMeta(baseResult, resolution);
  }

  async getContent(args: Record<string, any>) {
    return withResolvedTab(this, args, 'getContent', async (resolution) => {
      const tabId = resolution.tabId;
      const type = String(args.type || args.mode || 'text');
      const selector = args.selector ? String(args.selector) : '';
      const maxChars = typeof args.maxChars === 'number' && args.maxChars > 0 ? args.maxChars : 8000;
      const maxItems = typeof args.maxItems === 'number' && args.maxItems > 0 ? args.maxItems : 40;
      // Bridge serves text/structure/dialogs without a selector (shared dom-interact path).
      const canUseBridge =
        !selector && (type === 'text' || type === 'structure' || type === 'dialogs' || type === 'modals');
      if (canUseBridge) {
        const bridged = await this.tryBridge(tabId, 'getContent', {
          mode: type,
          maxChars,
          maxItems,
        });
        if (bridged) return this.attachResolutionMeta(bridged, resolution);
      }
      const result = await this.runInTab(
        tabId,
        (t: string, sel: string, limit: number, maxPerSection: number) => {
          // Selector helper inlined (no eval) so injection works under strict page CSP.
          function buildLocalSelector(element: any, options?: any) {
            options = options || {};
            if (element.id) return '#' + CSS.escape(element.id);
            const dataTestId = element.getAttribute('data-testid');
            if (dataTestId) return '[data-testid="' + CSS.escape(dataTestId) + '"]';
            const name = element.getAttribute('name');
            if (name) return '[name="' + CSS.escape(name) + '"]';
            const ariaLabel = element.getAttribute('aria-label');
            if (ariaLabel) return '[aria-label="' + CSS.escape(ariaLabel) + '"]';
            if (options.includePlaceholder) {
              const placeholder = element.placeholder;
              if (placeholder) return '[placeholder="' + CSS.escape(placeholder) + '"]';
            }
            const cls = Array.from(element.classList).find(
              (c: any) => /^[a-z][a-z0-9_-]{2,40}$/i.test(c) && !/[0-9]{5,}/.test(c),
            );
            if (cls) return '.' + cls;
            const parent = element.parentElement;
            if (parent) {
              const tag = element.tagName.toLowerCase();
              const siblings = Array.from(parent.children).filter((c: any) => c.tagName.toLowerCase() === tag);
              const index = siblings.indexOf(element) + 1;
              return tag + ':nth-child(' + index + ')';
            }
            return element.tagName.toLowerCase();
          }
          const deepQuerySelector = (query: string) => {
            if (!query.includes('>>>')) return document.querySelector<HTMLElement>(query);
            const parts = query
              .split('>>>')
              .map((part) => part.trim())
              .filter(Boolean);
            let root: Document | ShadowRoot | Element = document;
            for (let index = 0; index < parts.length; index += 1) {
              const next = root.querySelector(parts[index]);
              if (!next) return null;
              if (index === parts.length - 1) return next as HTMLElement;
              const shadow = (next as HTMLElement).shadowRoot;
              if (!shadow) return null;
              root = shadow;
            }
            return null;
          };
          const base = sel ? deepQuerySelector(sel) : document.body;
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
                const tag = parent.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                if (parent.hidden || parent.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
                // Prefer checkVisibility over getComputedStyle when available.
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
            const getSelector = (element: Element): string => buildLocalSelector(element);

            // Prefer scanning inside the topmost open dialog for Instagram/SPA sheets.
            const dialogNodes = Array.from(
              document.querySelectorAll<HTMLElement>(
                '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]',
              ),
            ).filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            const activeDialog = dialogNodes[dialogNodes.length - 1] || null;
            const scanRoot: HTMLElement = activeDialog || root;

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
                selector: getSelector(element),
              };
            };

            const structure: Record<string, any> = {
              title: clip(document.title || '', 220),
              url: clip(window.location.href || '', 420),
              dialogOpen: Boolean(activeDialog),
              dialogs: dialogNodes.slice(0, 5).map((el) => ({
                label: clip(
                  el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.textContent || 'dialog',
                  120,
                ),
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
            // Approximate JSON bytes — avoid JSON.stringify per item on the hot path.
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
              const add = approxBytes(item) + 1;
              if (structureSerializedLength + add > budgetLimit) {
                truncated = true;
                return false;
              }
              list.push(item);
              structureSerializedLength += add;
              return true;
            };

            const take = <T extends Element>(sel: string, limit: number): T[] => {
              const out: T[] = [];
              let nodes: NodeListOf<Element>;
              try {
                nodes = scanRoot.querySelectorAll(sel);
              } catch {
                return out;
              }
              const cap = Math.min(limit, nodes.length);
              for (let i = 0; i < cap; i += 1) out.push(nodes[i] as T);
              return out;
            };
            const overscan = maxPerSectionCount + 1;

            const headings = take<HTMLElement>('h1, h2, h3', overscan);
            for (let i = 0; i < headings.length && i < maxPerSectionCount; i += 1) {
              const heading = headings[i];
              const item = {
                level: heading.tagName.toLowerCase(),
                text: clip(heading.textContent || '', 220),
              };
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
                disabled:
                  (action as HTMLButtonElement).disabled === true || action.getAttribute('aria-disabled') === 'true',
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
                const t = clip(thNodes[h].textContent || '', 60);
                if (t) headers.push(t);
              }
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
              const item = {
                text,
                tag: badge.tagName.toLowerCase(),
              };
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
              const item = {
                label: labelText,
                value: valueText,
              };
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
            let estimatedLength = 2; // []
            let truncated = false;

            for (let i = 0; i < anchors.length && links.length < maxItems; i += 1) {
              const link = anchors[i];
              const item = {
                text: (link.textContent || '').trim(),
                href: link.href || '',
              };
              // Approx JSON size without full stringify per link.
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
    });
  }

  async screenshot(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'screenshot');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tab = resolution.tab;
    const requestedFormat = String(args.format || 'jpeg').toLowerCase();
    const format = requestedFormat === 'png' ? 'png' : 'jpeg';
    const quality = typeof args.quality === 'number' ? Math.max(1, Math.min(100, Math.round(args.quality))) : 90;
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

  async getTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return {
      success: true,
      tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
    };
  }

  async groupTabs(args: Record<string, any>) {
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

  async executeScript(args: Record<string, unknown>) {
    const code = String(args.code ?? '').trim();
    if (!code) {
      return { success: false, error: 'code is required and must be a non-empty string' };
    }
    return withResolvedTab(this, args, 'executeScript', async (resolution) => {
      try {
        const result = await this.runInTab(
          resolution.tabId,
          (codeStr: string) => {
            // eslint-disable-next-line no-new-func
            return new Function(codeStr)();
          },
          [code],
        );
        return {
          success: true,
          result: result ?? null,
          resultType: typeof result,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  async getNetworkRequests(args: Record<string, unknown>) {
    const maxEntries = Math.min(
      Number.isFinite(Number(args.maxEntries)) ? Math.max(1, Math.round(Number(args.maxEntries))) : 50,
      200,
    );
    const filterUrl = args.filterUrl != null ? String(args.filterUrl) : '';
    const filterStatus = Number.isFinite(Number(args.filterStatus)) ? Number(args.filterStatus) : 0;
    const shouldClear = args.clear === true;

    return withResolvedTab(this, args, 'getNetworkRequests', async (resolution) => {
      const result = await this.runInTab(
        resolution.tabId,
        (max: number, urlFilter: string, statusFilter: number, clear: boolean) => {
          const BUFFER_KEY = '__glide_network_buffer__';
          const INSTALLED_KEY = '__glide_network_installed__';
          const MAX_BUFFER = 150;
          const w = window as any;

          // Useful response headers to capture (lowercase)
          const USEFUL_HEADERS = [
            'content-type',
            'content-length',
            'cache-control',
            'x-request-id',
            'x-correlation-id',
            'location',
            'retry-after',
            'x-ratelimit-remaining',
            'www-authenticate',
          ];

          const extractHeaders = (headersStr: string): Record<string, string> => {
            const result: Record<string, string> = {};
            if (!headersStr) return result;
            for (const line of headersStr.split('\r\n')) {
              const idx = line.indexOf(':');
              if (idx === -1) continue;
              const name = line.slice(0, idx).trim().toLowerCase();
              if (USEFUL_HEADERS.includes(name)) {
                result[name] = line.slice(idx + 1).trim();
              }
            }
            return result;
          };

          // Install interception hooks
          if (!w[INSTALLED_KEY]) {
            w[BUFFER_KEY] = [];

            // --- Fetch interception ---
            const originalFetch = window.fetch.bind(window);
            (window as any).fetch = async (input: any, init?: any) => {
              const startTime = Date.now();
              let method = 'GET';
              let url = '';

              // Parse arguments
              if (typeof input === 'string') {
                url = input;
              } else if (input instanceof Request) {
                url = input.url;
                method = input.method || 'GET';
              } else if (input instanceof URL) {
                url = input.toString();
              }
              if (init?.method) method = init.method;

              try {
                const response = await originalFetch(input, init);
                const duration = Date.now() - startTime;
                const headers: Record<string, string> = {};
                response.headers.forEach((val: string, key: string) => {
                  if (USEFUL_HEADERS.includes(key.toLowerCase())) {
                    headers[key.toLowerCase()] = val;
                  }
                });

                const buffer = w[BUFFER_KEY] as any[];
                buffer.push({
                  type: 'fetch',
                  method: method.toUpperCase(),
                  url,
                  status: response.status,
                  statusText: response.statusText,
                  headers,
                  duration,
                  timestamp: startTime,
                });
                if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

                return response;
              } catch (err) {
                const duration = Date.now() - startTime;
                const buffer = w[BUFFER_KEY] as any[];
                buffer.push({
                  type: 'fetch',
                  method: method.toUpperCase(),
                  url,
                  status: 0,
                  statusText: 'NETWORK_ERROR',
                  headers: {},
                  duration,
                  error: (err as any)?.message || String(err),
                  timestamp: startTime,
                });
                if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
                throw err;
              }
            };

            // --- XHR interception ---
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function (
              this: any,
              method: string,
              url: string | URL,
              ...openArgs: any[]
            ) {
              this.__glide_method = String(method || 'GET').toUpperCase();
              this.__glide_url = String(url || '');
              return (originalOpen as any).call(this, method, url, ...openArgs);
            };

            XMLHttpRequest.prototype.send = function (this: any, body?: Document | XMLHttpRequestBodyInit | null) {
              const startTime = Date.now();
              const method = this.__glide_method || 'GET';
              const url = this.__glide_url || '';

              this.addEventListener('loadend', () => {
                const duration = Date.now() - startTime;
                const headerStr = this.getAllResponseHeaders?.() || '';
                const headers = extractHeaders(headerStr);

                const buffer = w[BUFFER_KEY] as any[];
                buffer.push({
                  type: 'xhr',
                  method,
                  url,
                  status: this.status || 0,
                  statusText: this.statusText || '',
                  headers,
                  duration,
                  timestamp: startTime,
                });
                if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
              });

              return originalSend.call(this, body);
            };

            w[INSTALLED_KEY] = true;
          }

          // Read intercepted buffer
          const intercepted = (w[BUFFER_KEY] || []) as any[];
          let filteredIntercepted = intercepted;
          if (urlFilter) {
            filteredIntercepted = filteredIntercepted.filter((r: any) => String(r.url || '').includes(urlFilter));
          }
          if (statusFilter > 0) {
            filteredIntercepted = filteredIntercepted.filter((r: any) => r.status === statusFilter);
          }

          // Read resource timing (passive, always available)
          const perfEntries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
          let resourceTimings = perfEntries;
          if (urlFilter) {
            resourceTimings = resourceTimings.filter((e) => e.name.includes(urlFilter));
          }
          const resources = resourceTimings.slice(-max).map((e) => ({
            type: 'resource',
            url: e.name,
            initiatorType: e.initiatorType,
            duration: Math.round(e.duration),
            transferSize: e.transferSize,
            encodedBodySize: e.encodedBodySize,
          }));

          const interceptedSlice = filteredIntercepted.slice(-max);

          if (clear) {
            (w[BUFFER_KEY] as any[]).length = 0;
          }

          return {
            success: true,
            hookInstalled: true,
            intercepted: interceptedSlice,
            interceptedCount: interceptedSlice.length,
            totalInterceptedBuffered: intercepted.length,
            resources,
            resourceCount: resources.length,
            cleared: clear,
          };
        },
        [maxEntries, filterUrl, filterStatus, shouldClear],
      );

      return result || { success: false, error: 'Script execution failed.' };
    });
  }

  async getStorageData(args: Record<string, unknown>) {
    const storeRaw = String(args.store || 'localStorage')
      .trim()
      .toLowerCase();
    const storeMap: Record<string, string> = {
      localstorage: 'localStorage',
      sessionstorage: 'sessionStorage',
      cookies: 'cookies',
    };
    const store = storeMap[storeRaw] || 'localStorage';
    const filterKey = args.filterKey != null ? String(args.filterKey) : '';
    const maxEntries = Math.min(
      Number.isFinite(Number(args.maxEntries)) ? Math.max(1, Math.round(Number(args.maxEntries))) : 50,
      200,
    );

    return withResolvedTab(this, args, 'getStorageData', async (resolution) => {
      const result = await this.runInTab(
        resolution.tabId,
        (storeName: string, filter: string, max: number) => {
          const clip = (v: string, len: number) => {
            if (v.length <= len) return v;
            return `${v.slice(0, len)}…[truncated]`;
          };
          const isSensitiveStorageKey = (key: string) =>
            /token|auth|session|password|secret|jwt|credential|apikey/i.test(key);
          const redactStorageValue = (value: string) => `<redacted:${value.length} chars>`;

          if (storeName === 'cookies') {
            const raw = document.cookie || '';
            if (!raw) return { success: true, store: 'cookies', entries: [], totalKeys: 0, returnedKeys: 0 };
            const pairs = raw.split(';').map((c) => {
              const idx = c.indexOf('=');
              if (idx === -1) return { name: c.trim(), value: '' };
              return { name: c.slice(0, idx).trim(), value: c.slice(idx + 1).trim() };
            });
            const filtered = filter ? pairs.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase())) : pairs;
            // Cookie values are session identifiers regardless of their name
            // (SID, PHPSESSID, __Secure-*, �). Always redact the value; the name
            // is enough for the model to reason about what exists.
            const entries = filtered.slice(0, max).map((p) => ({
              key: p.name,
              value: redactStorageValue(p.value),
            }));
            return {
              success: true,
              store: 'cookies',
              entries,
              totalKeys: pairs.length,
              returnedKeys: entries.length,
              truncatedResults: filtered.length > max,
            };
          }

          // localStorage or sessionStorage
          const storage = storeName === 'sessionStorage' ? window.sessionStorage : window.localStorage;
          if (!storage) return { success: false, error: `${storeName} is not available on this page.` };

          const totalKeys = storage.length;
          const entries: Array<{ key: string; value: string; valueLength: number }> = [];
          let matchingKeys = 0;
          for (let i = 0; i < totalKeys; i++) {
            const key = storage.key(i);
            if (!key) continue;
            if (filter && !key.toLowerCase().includes(filter.toLowerCase())) continue;
            matchingKeys++;
            if (entries.length >= max) continue;
            const rawValue = storage.getItem(key) || '';
            entries.push({
              key,
              value: isSensitiveStorageKey(key) ? redactStorageValue(rawValue) : clip(rawValue, 500),
              valueLength: rawValue.length,
            });
          }
          return {
            success: true,
            store: storeName,
            entries,
            totalKeys,
            matchingKeys,
            returnedKeys: entries.length,
            truncatedResults: matchingKeys > entries.length,
          };
        },
        [store, filterKey, maxEntries],
      );

      return result || { success: false, error: 'Script execution failed.' };
    });
  }

  async getPerformanceMetrics(args: Record<string, unknown>) {
    return withResolvedTab(this, args, 'getPerformanceMetrics', async (resolution) => {
      const result = await this.runInTab(
        resolution.tabId,
        () => {
          const round = (v: number) => Math.round(v * 100) / 100;

          // Navigation timing
          const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
          const nav = navEntries[0] || null;
          const navigation = nav
            ? {
                ttfb: round(nav.responseStart - nav.requestStart),
                domInteractive: round(nav.domInteractive - nav.startTime),
                domComplete: round(nav.domComplete - nav.startTime),
                loadComplete: round(nav.loadEventEnd - nav.startTime),
                domContentLoaded: round(nav.domContentLoadedEventEnd - nav.startTime),
                redirectTime: round(nav.redirectEnd - nav.redirectStart),
                dnsTime: round(nav.domainLookupEnd - nav.domainLookupStart),
                connectTime: round(nav.connectEnd - nav.connectStart),
                tlsTime: round(nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0),
                transferSize: nav.transferSize,
                encodedBodySize: nav.encodedBodySize,
                decodedBodySize: nav.decodedBodySize,
              }
            : null;

          // Paint timing (FCP, LCP)
          const paintEntries = performance.getEntriesByType('paint') as PerformancePaintTiming[];
          const fcp = paintEntries.find((e) => e.name === 'first-contentful-paint');
          const fp = paintEntries.find((e) => e.name === 'first-paint');
          const paint = {
            firstPaint: fp ? round(fp.startTime) : null,
            firstContentfulPaint: fcp ? round(fcp.startTime) : null,
          };

          // Resource counts by type
          const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
          const resourceCounts: Record<string, number> = {};
          let totalTransferSize = 0;
          for (const r of resources) {
            const type = r.initiatorType || 'other';
            resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            totalTransferSize += r.transferSize || 0;
          }

          // Memory (Chrome only)
          const mem = (performance as any).memory;
          const memory = mem
            ? {
                usedJSHeapSize: mem.usedJSHeapSize,
                totalJSHeapSize: mem.totalJSHeapSize,
                jsHeapSizeLimit: mem.jsHeapSizeLimit,
                usedMB: round(mem.usedJSHeapSize / 1048576),
                totalMB: round(mem.totalJSHeapSize / 1048576),
              }
            : null;

          return {
            success: true,
            url: window.location.href,
            navigation,
            paint,
            resourceSummary: {
              totalResources: resources.length,
              totalTransferSizeBytes: totalTransferSize,
              totalTransferSizeKB: round(totalTransferSize / 1024),
              byType: resourceCounts,
            },
            memory,
          };
        },
        [],
      );

      return result || { success: false, error: 'Script execution failed.' };
    });
  }

  async getConsoleOutput(args: Record<string, unknown>) {
    const maxEntries = Math.min(
      Number.isFinite(Number(args.maxEntries)) ? Math.max(1, Math.round(Number(args.maxEntries))) : 50,
      200,
    );
    const levelFilter = String(args.level || 'all')
      .toLowerCase()
      .trim();
    const shouldClear = args.clear === true;

    return withResolvedTab(this, args, 'getConsoleOutput', async (resolution) => {
      const result = await this.runInTab(
        resolution.tabId,
        (max: number, filter: string, clear: boolean) => {
          const BUFFER_KEY = '__glide_console_buffer__';
          const INSTALLED_KEY = '__glide_console_installed__';
          const MAX_BUFFER = 200;
          const MAX_MSG_LEN = 500;
          const w = window as any;

          // Safe serialization with circular reference detection
          const safeStringify = (val: unknown): string => {
            if (val === null) return 'null';
            if (val === undefined) return 'undefined';
            if (typeof val === 'string') return val;
            if (typeof val === 'number' || typeof val === 'boolean') return String(val);
            try {
              const seen = new WeakSet();
              return JSON.stringify(val, (_key, value) => {
                if (typeof value === 'object' && value !== null) {
                  if (seen.has(value)) return '[Circular]';
                  seen.add(value);
                }
                return value;
              });
            } catch {
              return String(val);
            }
          };

          // Install capture hook if not already installed
          if (!w[INSTALLED_KEY]) {
            w[BUFFER_KEY] = [];
            const originals: Record<string, (...a: any[]) => void> = {};
            const levels = ['log', 'warn', 'error', 'info'] as const;

            for (const level of levels) {
              originals[level] = console[level].bind(console);
              (console as any)[level] = (...logArgs: any[]) => {
                // Call original
                originals[level](...logArgs);
                // Buffer the entry
                const buffer = w[BUFFER_KEY] as any[];
                const message = logArgs.map((a) => safeStringify(a)).join(' ');
                buffer.push({
                  level,
                  message: message.length > MAX_MSG_LEN ? `${message.slice(0, MAX_MSG_LEN)}…` : message,
                  timestamp: Date.now(),
                });
                // Circular buffer: trim oldest if over limit
                if (buffer.length > MAX_BUFFER) {
                  buffer.splice(0, buffer.length - MAX_BUFFER);
                }
              };
            }

            // Capture unhandled errors and promise rejections
            window.addEventListener('error', (event) => {
              const buffer = w[BUFFER_KEY] as any[];
              buffer.push({
                level: 'error',
                message:
                  `[Uncaught] ${event.message || ''} at ${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`.slice(
                    0,
                    MAX_MSG_LEN,
                  ),
                timestamp: Date.now(),
              });
              if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
            });

            window.addEventListener('unhandledrejection', (event) => {
              const buffer = w[BUFFER_KEY] as any[];
              const reason = safeStringify(event.reason);
              buffer.push({
                level: 'error',
                message: `[UnhandledRejection] ${reason}`.slice(0, MAX_MSG_LEN),
                timestamp: Date.now(),
              });
              if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
            });

            w[INSTALLED_KEY] = true;
          }

          // Read buffer
          const buffer = (w[BUFFER_KEY] || []) as Array<{
            level: string;
            message: string;
            timestamp: number;
          }>;

          const filtered = filter === 'all' ? buffer : buffer.filter((e) => e.level === filter);

          const entries = filtered.slice(-max);

          if (clear) {
            (w[BUFFER_KEY] as any[]).length = 0;
          }

          return {
            success: true,
            hookInstalled: true,
            entries,
            returnedCount: entries.length,
            totalBuffered: buffer.length,
            levelFilter: filter,
            cleared: clear,
          };
        },
        [maxEntries, levelFilter, shouldClear],
      );

      return result || { success: false, error: 'Script execution failed.' };
    });
  }
}
