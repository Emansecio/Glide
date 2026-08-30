import {
  arrayBufferToBase64,
  clipIntersectsBitmap,
  computeClipRect,
  computeDownscale,
  needsScreenshotDownscale,
  rectIntersectsViewport,
} from '../background/image-scale.js';
import { cdpCommand } from './cdp-session.js';
import { type GlideBridgeOp, isMutativeBridgeOp, sendGlideBridge, shouldFallbackFromBridge } from './content-bridge.js';
import { isSameOriginUrl, isUrlAllowedByDomains, parseAllowedDomains } from './domain-policy.js';
import {
  type ExecuteScriptInjectionResult,
  buildUserScriptSource,
  isCspEvalError,
  isUserScriptsApiAvailable,
  resolveExecuteScriptTimeoutMs,
  resolveExecuteScriptWorld,
} from './execute-script-runner.js';
import { pickFrameIdForSelectorProbe, probeSelectorInFrame } from './frame-discovery.js';
import {
  FRAME_TARGET_TOOLS,
  type FrameInfo,
  type ResolveTargetFrameResult,
  absoluteFrameUrl,
  resolveTargetFrameId,
} from './frame-target.js';
import { performHttpRequest, sanitizeHttpHeaders } from './http-request.js';
import {
  getInjectedFnId,
  glideDispatchInjectedFn,
  glideInstallAndRunInjectedFn,
  isInjectedFnEvalBlocked,
  isInjectedFnMissing,
  isInjectedFnResult,
} from './injected-fn-registry.js';
import { highlightTargetOverlay, measureScreenshotTarget } from './ref-resolver.js';
import { waitForHistoryTransition, waitForTabReadiness } from './tab-readiness.js';
import { type TabResolution, withResolvedTab } from './tab-resolve.js';
import { type ToolExecutionContext, abortedToolResult, isToolContextAborted, sleepWithSignal } from './tool-context.js';
import { buildToolDefinitions } from './tool-definitions.js';
import { INLINE_TOOL_HANDLERS, TOOL_HANDLER_REGISTRY } from './tool-registry.js';
import type { ToolDefinition } from './tool-schema.js';
import { clampInt, isHttpUrl, requireHttpUrl } from './validation.js';

export { absoluteFrameUrl, matchFramesByUrlSubstring, resolveTargetFrameId } from './frame-target.js';
export type { FrameInfo, ResolveTargetFrameResult } from './frame-target.js';

export type RunInTabOptions = {
  allFrames?: boolean;
  frameId?: number;
  world?: chrome.scripting.ExecutionWorld;
};

function normalizeRunInTabOptions(
  optionsOrAllFrames?: RunInTabOptions | boolean,
  legacyWorld?: chrome.scripting.ExecutionWorld,
): RunInTabOptions {
  if (typeof optionsOrAllFrames === 'boolean') {
    return { allFrames: optionsOrAllFrames, world: legacyWorld };
  }
  if (optionsOrAllFrames && typeof optionsOrAllFrames === 'object') {
    return { ...optionsOrAllFrames, world: optionsOrAllFrames.world ?? legacyWorld };
  }
  return { world: legacyWorld };
}

export type SetInputFileSpec = {
  name: string;
  content?: string;
  contentBase64?: string;
  mimeType: string;
};

export const SET_INPUT_FILES_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export function normalizeSetInputFileSpecs(filesRaw: unknown): SetInputFileSpec[] | { error: string } {
  if (!Array.isArray(filesRaw)) return [];
  const specs: SetInputFileSpec[] = [];
  let totalBytes = 0;
  for (const f of filesRaw.filter((entry) => entry && typeof entry === 'object').slice(0, 10)) {
    const row = f as Record<string, unknown>;
    const name = String(row.name || 'upload.txt').slice(0, 200);
    const mimeType = String(row.mimeType || 'text/plain').slice(0, 100);
    const contentBase64 =
      row.contentBase64 != null && String(row.contentBase64).length > 0 ? String(row.contentBase64) : undefined;
    if (contentBase64) {
      const decodedBytes = Math.floor((contentBase64.length * 3) / 4);
      totalBytes += decodedBytes;
      if (totalBytes > SET_INPUT_FILES_MAX_TOTAL_BYTES) {
        return {
          error: `Total decoded file payload exceeds ${SET_INPUT_FILES_MAX_TOTAL_BYTES} bytes (~10MB).`,
        };
      }
      specs.push({ name, contentBase64, mimeType });
    } else {
      const content = String(row.content ?? '');
      totalBytes += new TextEncoder().encode(content).length;
      if (totalBytes > SET_INPUT_FILES_MAX_TOTAL_BYTES) {
        return {
          error: `Total decoded file payload exceeds ${SET_INPUT_FILES_MAX_TOTAL_BYTES} bytes (~10MB).`,
        };
      }
      specs.push({ name, content, mimeType });
    }
  }
  return specs;
}

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

// Não impõe limite artificial por sessão; o Chrome continua sendo a autoridade
// sobre a quantidade máxima de abas que o sistema consegue manter.
const MAX_SESSION_TABS = Number.POSITIVE_INFINITY;
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
  private injectedFnRegistry: Map<string, { installed: Set<string>; blocked: boolean }>;
  currentToolContext: ToolExecutionContext | null = null;

  constructor() {
    this.sessionTabs = new Map();
    this.currentSessionTabId = null;
    this.sessionTabGroupId = null;
    const toolNames = [...Object.keys(TOOL_HANDLER_REGISTRY), ...INLINE_TOOL_HANDLERS];
    this.tools = Object.fromEntries(toolNames.map((name) => [name, true as const]));
    this.injectedFnRegistry = new Map();
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

  validateToolArgs(toolName: string, args: unknown): ToolArgValidationResult {
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
      (toolName === 'click' ||
        toolName === 'hover' ||
        toolName === 'mouse' ||
        toolName === 'type' ||
        toolName === 'setInputFiles' ||
        toolName === 'selectOption' ||
        toolName === 'highlightElement') &&
      typeof normalizedArgs.selector === 'string'
    ) {
      normalizedArgs.selector = normalizedArgs.selector.trim();
      if (!normalizedArgs.selector) {
        return { ok: false, error: `Argument "selector" for ${toolName} cannot be empty.` };
      }
    }

    if (toolName === 'mouse') {
      const action = String(normalizedArgs.action || '')
        .trim()
        .toLowerCase();
      if (action === 'drag') {
        if (typeof normalizedArgs.toSelector !== 'string' || !normalizedArgs.toSelector.trim()) {
          return { ok: false, error: 'Argument "toSelector" for mouse is required when action="drag".' };
        }
        normalizedArgs.toSelector = normalizedArgs.toSelector.trim();
      }
    }

    if (toolName === 'clipboard') {
      const action = String(normalizedArgs.action || '')
        .toLowerCase()
        .trim();
      if (!['read', 'write'].includes(action)) {
        return { ok: false, error: 'Argument "action" for clipboard must be "read" or "write".' };
      }
      normalizedArgs.action = action;
      if (action === 'write' && typeof normalizedArgs.text !== 'string') {
        return { ok: false, error: 'Argument "text" for clipboard write is required.' };
      }
    }

    if (toolName === 'setInputFiles') {
      if (!Array.isArray(normalizedArgs.files) || normalizedArgs.files.length === 0) {
        return { ok: false, error: 'Argument "files" for setInputFiles must be a non-empty array.' };
      }
    }

    if (toolName === 'cdp') {
      const action = String(normalizedArgs.action || 'send')
        .toLowerCase()
        .trim();
      if (!['attach', 'detach', 'status', 'send'].includes(action)) {
        return { ok: false, error: 'Argument "action" for cdp must be attach|detach|status|send.' };
      }
      normalizedArgs.action = action;
      if (action === 'send' && (!normalizedArgs.method || !String(normalizedArgs.method).trim())) {
        return { ok: false, error: 'Argument "method" for cdp is required when action="send".' };
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
      const allowedModifiers = ['Control', 'Alt', 'Shift', 'Meta'];
      if (normalizedArgs.modifiers !== undefined) {
        if (!Array.isArray(normalizedArgs.modifiers)) {
          return { ok: false, error: 'Argument "modifiers" for pressKey must be an array.' };
        }
        const normalizedModifiers: string[] = [];
        for (const raw of normalizedArgs.modifiers) {
          if (typeof raw !== 'string' || !allowedModifiers.includes(raw.trim())) {
            return {
              ok: false,
              error: `Argument "modifiers" for pressKey must contain only: ${allowedModifiers.join(', ')}.`,
            };
          }
          const mod = raw.trim();
          if (!normalizedModifiers.includes(mod)) normalizedModifiers.push(mod);
        }
        normalizedArgs.modifiers = normalizedModifiers.length ? normalizedModifiers : undefined;
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
      if (normalizedArgs.strategy !== undefined) {
        const strategy = String(normalizedArgs.strategy).toLowerCase().trim();
        if (!['auto', 'wheel', 'intoview', 'intoView', 'top'].includes(strategy)) {
          return {
            ok: false,
            error: `Invalid scroll strategy "${String(normalizedArgs.strategy)}".`,
            hint: 'Use one of: auto, wheel, intoView, top.',
          };
        }
        normalizedArgs.strategy = strategy === 'intoview' ? 'intoView' : strategy;
      }
    }

    if (toolName === 'httpRequest') {
      if (typeof normalizedArgs.url !== 'string' || !normalizedArgs.url.trim()) {
        return { ok: false, error: 'Argument "url" for httpRequest is required.' };
      }
      const urlCheck = requireHttpUrl(normalizedArgs.url.trim(), 'httpRequest url');
      if (!urlCheck.ok) {
        return { ok: false, error: urlCheck.error, hint: urlCheck.hint };
      }
      normalizedArgs.url = urlCheck.url;
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

    if (toolName === 'annotatedScreenshot') {
      if (normalizedArgs.scope !== undefined) {
        const scope = String(normalizedArgs.scope).toLowerCase().trim();
        if (!['page', 'dialog'].includes(scope)) {
          return { ok: false, error: 'Argument "scope" for annotatedScreenshot must be "page" or "dialog".' };
        }
        normalizedArgs.scope = scope;
      }
      if (normalizedArgs.maxMarks !== undefined) {
        if (typeof normalizedArgs.maxMarks !== 'number' || !Number.isFinite(normalizedArgs.maxMarks)) {
          return { ok: false, error: 'Argument "maxMarks" for annotatedScreenshot must be a finite number.' };
        }
        normalizedArgs.maxMarks = clampInt(normalizedArgs.maxMarks, 1, 80);
      }
    }

    if (toolName === 'elementScreenshot') {
      const hasSelector = typeof normalizedArgs.selector === 'string' && normalizedArgs.selector.trim().length > 0;
      const hasRef = typeof normalizedArgs.ref === 'string' && normalizedArgs.ref.trim().length > 0;
      if (!hasSelector && !hasRef) {
        return { ok: false, error: 'Argument "selector" or "ref" for elementScreenshot is required.' };
      }
      if (hasSelector && hasRef) {
        return { ok: false, error: 'Provide either selector or ref for elementScreenshot, not both.' };
      }
      if (hasSelector) normalizedArgs.selector = normalizedArgs.selector.trim();
      if (hasRef) normalizedArgs.ref = normalizedArgs.ref.trim();
      if (normalizedArgs.padding !== undefined) {
        if (typeof normalizedArgs.padding !== 'number' || !Number.isFinite(normalizedArgs.padding)) {
          return { ok: false, error: 'Argument "padding" for elementScreenshot must be a finite number.' };
        }
        normalizedArgs.padding = clampInt(normalizedArgs.padding, 0, 100);
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
      if (normalizedArgs.deep !== undefined) {
        if (typeof normalizedArgs.deep !== 'boolean') {
          return { ok: false, error: 'Argument "deep" for findElement must be a boolean.' };
        }
      }
    }

    if ((FRAME_TARGET_TOOLS as readonly string[]).includes(toolName)) {
      for (const key of ['frameUrl', 'frameSelector'] as const) {
        if (normalizedArgs[key] !== undefined) {
          if (typeof normalizedArgs[key] !== 'string') {
            return { ok: false, error: `Argument "${key}" for ${toolName} must be a string.` };
          }
          const trimmed = normalizedArgs[key].trim();
          if (!trimmed) {
            return { ok: false, error: `Argument "${key}" for ${toolName} cannot be empty.` };
          }
          normalizedArgs[key] = trimmed.slice(0, 500);
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
      if (!['time', 'selector', 'visible', 'hidden', 'dialog', 'modal', 'networkidle'].includes(condition)) {
        return {
          ok: false,
          error:
            'Argument "condition" for wait must be "time", "selector", "visible", "hidden", "dialog", or "networkIdle".',
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
      if (['selector', 'visible', 'hidden'].includes(condition)) {
        if (typeof normalizedArgs.selector !== 'string' || !normalizedArgs.selector.trim()) {
          return {
            ok: false,
            error: `Argument "selector" for wait is required when condition="${condition}".`,
          };
        }
        normalizedArgs.selector = normalizedArgs.selector.trim();
      }
      if (condition === 'networkidle') {
        if (normalizedArgs.idleMs === undefined) {
          normalizedArgs.idleMs = 500;
        } else if (typeof normalizedArgs.idleMs !== 'number' || !Number.isFinite(normalizedArgs.idleMs)) {
          return { ok: false, error: 'Argument "idleMs" for wait must be a finite number.' };
        } else {
          normalizedArgs.idleMs = clampInt(normalizedArgs.idleMs, 100, 10000);
        }
      } else if (normalizedArgs.idleMs !== undefined) {
        if (typeof normalizedArgs.idleMs !== 'number' || !Number.isFinite(normalizedArgs.idleMs)) {
          return { ok: false, error: 'Argument "idleMs" for wait must be a finite number.' };
        }
        normalizedArgs.idleMs = clampInt(normalizedArgs.idleMs, 100, 10000);
      }
      if (normalizedArgs.timeout !== undefined) {
        if (typeof normalizedArgs.timeout !== 'number' || !Number.isFinite(normalizedArgs.timeout)) {
          return { ok: false, error: 'Argument "timeout" for wait must be a finite number.' };
        }
        normalizedArgs.timeout = clampInt(normalizedArgs.timeout, 100, 15000);
      }
    }

    if (toolName === 'selectOption') {
      const hasValue = normalizedArgs.value !== undefined;
      const hasLabel = normalizedArgs.label !== undefined;
      const hasIndex = normalizedArgs.index !== undefined;
      const count = [hasValue, hasLabel, hasIndex].filter(Boolean).length;
      if (count !== 1) {
        return {
          ok: false,
          error: 'Argument "value", "label", or "index" for selectOption — provide exactly one.',
        };
      }
      if (hasIndex) {
        if (typeof normalizedArgs.index !== 'number' || !Number.isFinite(normalizedArgs.index)) {
          return { ok: false, error: 'Argument "index" for selectOption must be a finite number.' };
        }
        if (normalizedArgs.index < 0) {
          return { ok: false, error: 'Argument "index" for selectOption must be >= 0.' };
        }
        normalizedArgs.index = Math.floor(normalizedArgs.index);
      }
      if (hasValue) normalizedArgs.value = String(normalizedArgs.value);
      if (hasLabel) normalizedArgs.label = String(normalizedArgs.label);
    }

    if (toolName === 'fillForm') {
      if (!Array.isArray(normalizedArgs.fields) || normalizedArgs.fields.length === 0) {
        return { ok: false, error: 'Argument "fields" for fillForm must be a non-empty array.' };
      }
      if (normalizedArgs.fields.length > 20) {
        normalizedArgs.fields = normalizedArgs.fields.slice(0, 20);
      }
      const normalizedFields: Record<string, unknown>[] = [];
      for (const rawField of normalizedArgs.fields) {
        if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) {
          return { ok: false, error: 'Each fillForm field must be an object with selector.' };
        }
        const field = rawField as Record<string, unknown>;
        if (typeof field.selector !== 'string' || !field.selector.trim()) {
          return { ok: false, error: 'Each fillForm field requires a non-empty selector.' };
        }
        const hasText = field.text !== undefined;
        const hasChecked = field.checked !== undefined;
        const hasOption = field.option !== undefined;
        const fieldModes = [hasText, hasChecked, hasOption].filter(Boolean).length;
        if (fieldModes !== 1) {
          return {
            ok: false,
            error: 'Each fillForm field needs exactly one of text, checked, or option.',
          };
        }
        if (hasText && typeof field.text !== 'string') {
          return { ok: false, error: 'fillForm field "text" must be a string.' };
        }
        if (hasChecked && typeof field.checked !== 'boolean') {
          return { ok: false, error: 'fillForm field "checked" must be a boolean.' };
        }
        if (hasOption) {
          if (!field.option || typeof field.option !== 'object' || Array.isArray(field.option)) {
            return { ok: false, error: 'fillForm field "option" must be an object.' };
          }
          const opt = field.option as Record<string, unknown>;
          const optCount = [opt.value, opt.label, opt.index].filter((v) => v !== undefined).length;
          if (optCount !== 1) {
            return { ok: false, error: 'fillForm field option needs exactly one of value, label, or index.' };
          }
        }
        normalizedFields.push({
          ...field,
          selector: field.selector.trim(),
        });
      }
      normalizedArgs.fields = normalizedFields;
      if (normalizedArgs.submitSelector !== undefined) {
        if (typeof normalizedArgs.submitSelector !== 'string' || !normalizedArgs.submitSelector.trim()) {
          return { ok: false, error: 'Argument "submitSelector" for fillForm must be a non-empty string.' };
        }
        normalizedArgs.submitSelector = normalizedArgs.submitSelector.trim();
      }
    }

    if (toolName === 'navigateHistory') {
      const action = String(normalizedArgs.action || '')
        .toLowerCase()
        .trim();
      if (!['back', 'forward', 'reload'].includes(action)) {
        return {
          ok: false,
          error: 'Argument "action" for navigateHistory must be back, forward, or reload.',
        };
      }
      normalizedArgs.action = action;
    }

    if (toolName === 'highlightElement') {
      const hasSelector = typeof normalizedArgs.selector === 'string' && normalizedArgs.selector.trim().length > 0;
      const hasRef = typeof normalizedArgs.ref === 'string' && normalizedArgs.ref.trim().length > 0;
      if (!hasSelector && !hasRef) {
        return { ok: false, error: 'Argument "selector" or "ref" for highlightElement is required.' };
      }
      if (hasSelector && hasRef) {
        return { ok: false, error: 'Provide either selector or ref for highlightElement, not both.' };
      }
      if (hasSelector) normalizedArgs.selector = normalizedArgs.selector.trim();
      if (hasRef) normalizedArgs.ref = normalizedArgs.ref.trim();
      if (normalizedArgs.durationMs !== undefined) {
        if (typeof normalizedArgs.durationMs !== 'number' || !Number.isFinite(normalizedArgs.durationMs)) {
          return { ok: false, error: 'Argument "durationMs" for highlightElement must be a finite number.' };
        }
        normalizedArgs.durationMs = clampInt(normalizedArgs.durationMs, 200, 5000);
      }
    }

    if (toolName === 'captureDownload') {
      if (normalizedArgs.saveAs === true) {
        return {
          ok: false,
          error: 'Argument "saveAs" for captureDownload must be false — Save-As prompts are not supported.',
        };
      }
      normalizedArgs.saveAs = false;
      normalizedArgs.timeoutMs = clampInt(
        normalizedArgs.timeoutMs !== undefined ? normalizedArgs.timeoutMs : 30000,
        1000,
        120000,
      );
      if (normalizedArgs.urlPattern != null) {
        normalizedArgs.urlPattern = String(normalizedArgs.urlPattern).trim();
      }
      if (normalizedArgs.filename != null) {
        normalizedArgs.filename = String(normalizedArgs.filename).trim();
      }
      if (normalizedArgs.url != null) {
        const trimmedUrl = String(normalizedArgs.url).trim();
        if (!trimmedUrl) {
          return { ok: false, error: 'Argument "url" for captureDownload cannot be empty.' };
        }
        const urlCheck = requireHttpUrl(trimmedUrl);
        if (!urlCheck.ok) {
          return {
            ok: false,
            error: `Invalid URL for captureDownload: "${trimmedUrl}". Only http(s) URLs are supported.`,
            ...(urlCheck.hint ? { hint: urlCheck.hint } : {}),
          };
        }
        normalizedArgs.url = urlCheck.url;
      }
      if (normalizedArgs.trigger != null) {
        if (!this.isRecord(normalizedArgs.trigger)) {
          return { ok: false, error: 'Argument "trigger" for captureDownload must be an object.' };
        }
        const selector = String(normalizedArgs.trigger.selector || '').trim();
        if (!selector) {
          return {
            ok: false,
            error: 'Argument "trigger.selector" for captureDownload is required when trigger is set.',
          };
        }
        normalizedArgs.trigger = { selector };
      }
    }

    if (toolName === 'findInPage') {
      if (typeof normalizedArgs.query !== 'string' || !normalizedArgs.query.trim()) {
        return { ok: false, error: 'Argument "query" for findInPage is required.' };
      }
      normalizedArgs.query = normalizedArgs.query.trim();
      normalizedArgs.caseSensitive = normalizedArgs.caseSensitive === true;
      normalizedArgs.maxMatches = clampInt(
        normalizedArgs.maxMatches !== undefined ? normalizedArgs.maxMatches : 20,
        1,
        100,
      );
      normalizedArgs.scrollToFirst = normalizedArgs.scrollToFirst !== false;
    }

    if (toolName === 'extractTable') {
      normalizedArgs.maxRows = clampInt(normalizedArgs.maxRows !== undefined ? normalizedArgs.maxRows : 100, 1, 1000);
      normalizedArgs.includeHeaders = normalizedArgs.includeHeaders !== false;
      if (typeof normalizedArgs.selector === 'string') {
        normalizedArgs.selector = normalizedArgs.selector.trim();
        if (!normalizedArgs.selector) {
          delete normalizedArgs.selector;
        }
      }
    }

    if (toolName === 'harvestScroll') {
      if (typeof normalizedArgs.itemSelector !== 'string' || !normalizedArgs.itemSelector.trim()) {
        return { ok: false, error: 'Argument "itemSelector" for harvestScroll is required.' };
      }
      normalizedArgs.itemSelector = normalizedArgs.itemSelector.trim();
      if (typeof normalizedArgs.scrollSelector === 'string') {
        normalizedArgs.scrollSelector = normalizedArgs.scrollSelector.trim();
        if (!normalizedArgs.scrollSelector) {
          delete normalizedArgs.scrollSelector;
        }
      }
      normalizedArgs.maxItems = clampInt(
        normalizedArgs.maxItems !== undefined ? normalizedArgs.maxItems : 100,
        1,
        1000,
      );
      normalizedArgs.stableRounds = clampInt(
        normalizedArgs.stableRounds !== undefined ? normalizedArgs.stableRounds : 2,
        1,
        5,
      );
    }

    return { ok: true, args: normalizedArgs };
  }

  private invalidateTabResolveMemo(tabId?: number) {
    if (typeof tabId !== 'number') {
      this.tabResolveMemo.clear();
      return;
    }
    for (const key of [...this.tabResolveMemo.keys()]) {
      // Keys: `${toolName}:${requestedTabId|none}:${strict}:${currentSessionTabId|none}`
      if (key.includes(`:${tabId}:`) || key.endsWith(`:${tabId}`)) {
        this.tabResolveMemo.delete(key);
      }
    }
    // Também invalida memos cujo currentSession era essa aba.
    for (const [key, entry] of [...this.tabResolveMemo.entries()]) {
      const resolvedId = entry?.value?.ok ? entry.value.resolution?.tabId : null;
      if (resolvedId === tabId) this.tabResolveMemo.delete(key);
    }
  }

  private bindTabLifecycleListeners() {
    if (typeof chrome === 'undefined' || !chrome?.tabs?.onRemoved?.addListener) return;
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.sessionTabs.delete(tabId);
      this.invalidateTabResolveMemo(tabId);
      this.dropInjectedFnRegistryForTab(tabId);
      if (this.currentSessionTabId === tabId) {
        const nextId = this.sessionTabs.keys().next().value;
        this.currentSessionTabId = typeof nextId === 'number' ? nextId : null;
      }
      if (this.sessionTabs.size === 0) {
        this.sessionTabGroupId = null;
      }
    });
    chrome.tabs.onUpdated?.addListener?.((tabId, changeInfo) => {
      if (changeInfo.status === 'loading' || changeInfo.url) {
        this.invalidateTabResolveMemo(tabId);
        // Navegação zera os globals da página — o registry instalado some junto.
        this.dropInjectedFnRegistryForTab(tabId);
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

  isSessionTab(tabId: number): boolean {
    return this.sessionTabs.has(tabId);
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

  async executeTool(toolName: string, args: Record<string, any> = {}, context?: ToolExecutionContext) {
    this.currentToolContext = context || null;
    try {
      if (isToolContextAborted(this.currentToolContext)) {
        return abortedToolResult();
      }
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
            maxTabs: null,
            canOpenMore: true,
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
    } finally {
      this.currentToolContext = null;
    }
  }

  private async quarantineSessionTab(
    tabId: number,
    options: { previousUrl?: string; closeIfRollbackFails?: boolean } = {},
  ): Promise<{ rolledBack: boolean; closed: boolean }> {
    this.sessionTabs.delete(tabId);
    if (this.currentSessionTabId === tabId) this.currentSessionTabId = null;
    this.invalidateTabResolveMemo(tabId);
    if (options.previousUrl && requireHttpUrl(options.previousUrl).ok) {
      try {
        await chrome.tabs.update(tabId, { url: options.previousUrl });
        return { rolledBack: true, closed: false };
      } catch {
        /* fall through to close */
      }
    }
    if (options.closeIfRollbackFails !== false) {
      try {
        await chrome.tabs.remove(tabId);
        return { rolledBack: false, closed: true };
      } catch {
        /* tab may already be gone */
      }
    }
    return { rolledBack: false, closed: false };
  }

  private rejectPrivateTab(toolName: string, tab: chrome.tabs.Tab | null | undefined) {
    const url = String(tab?.url || '');
    if (!isHttpUrl(url)) return null;
    const dest = requireHttpUrl(url, `${toolName} tab url`);
    if (dest.ok) return null;
    return dest;
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
   *
   * chrome.tabs.sendMessage has no frameId — callers skip the bridge when
   * frameUrl/frameSelector is set and use direct executeScript({ frameIds }) instead.
   */
  private async tryBridge(tabId: number, op: GlideBridgeOp, payload: Record<string, unknown>) {
    if (!this.useContentBridge) return null;
    const response = await sendGlideBridge(tabId, op, payload);
    if (!response) {
      if (isMutativeBridgeOp(op)) {
        return {
          success: false,
          code: 'BRIDGE_TIMEOUT',
          error:
            'Content bridge timed out or is unavailable. Mutative action was not retried via injection to avoid double execution.',
          hint: 'Wait for the page to settle, reload the tab, or retry with an explicit selector/frame target.',
        };
      }
      return null;
    }
    // Element misses can be top-frame-only; let the existing frame-probe injection path retry them.
    if (shouldFallbackFromBridge(response)) return null;
    if (typeof response.success === 'boolean' || response.bridge || response.code) {
      return response;
    }
    return null;
  }

  private async loadAllowedDomains(): Promise<string[]> {
    try {
      const stored = await chrome.storage.local.get('allowedDomains');
      return parseAllowedDomains(String(stored.allowedDomains || ''));
    } catch {
      return [];
    }
  }

  /** Read-only all-frames probe — returns the first frameId containing selector. */
  private async findFrameWithSelector(tabId: number, selector: string): Promise<number | null> {
    const trimmed = String(selector || '').trim();
    if (!trimmed) return null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const injectionPromise = chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: probeSelectorInFrame,
        args: [trimmed],
        world: 'ISOLATED',
      });
      void injectionPromise.catch(() => undefined);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Frame probe timed out')), 4000);
      });
      const results = (await Promise.race([injectionPromise, timeoutPromise])) as chrome.scripting.InjectionResult[];
      return pickFrameIdForSelectorProbe(results);
    } catch {
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
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
      // Só matricula se a sessão já dona a aba ou se navigate vai usá-la de
      // propósito. trackTab em qualquer strict id deixava closeTab/focusTab
      // operarem em abas do usuário só porque o modelo passou o tabId.
      if (this.sessionTabs.has(strictTab.id) || toolName === 'navigate') {
        this.trackTab(strictTab);
      }
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
      const privateStrict = this.rejectPrivateTab(toolName, strictTab);
      if (privateStrict && typeof strictTab.id === 'number') {
        await this.quarantineSessionTab(strictTab.id);
        return {
          ok: false as const,
          result: {
            success: false,
            code: 'PRIVATE_TAB_BLOCKED',
            error: privateStrict.error,
            hint: privateStrict.hint,
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
      // NÃO trackTab em todo candidato: a aba active do usuário entrava na
      // session e closeTab/focusTab passavam a controlá-la. Probe só lista.
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

    const privateSelected = this.rejectPrivateTab(toolName, selected);
    if (privateSelected) {
      await this.quarantineSessionTab(selected.id);
      return {
        ok: false as const,
        result: {
          success: false,
          code: 'PRIVATE_TAB_BLOCKED',
          error: privateSelected.error,
          hint: privateSelected.hint,
        },
      };
    }

    const fallbackUsed = selectedIndex > 0 || (requestedTabId !== null && requestedTabId !== selected.id);
    // Fix 8: Do NOT mutate this.currentSessionTabId here as a side-effect.
    // Callers that need to persist the resolved tab (navigate, openTab, focusTab) do so explicitly.
    // Matricula só o que a sessão já dona, ou navigate que adota a aba de propósito.
    // Aba active usada como fallback de execução NÃO entra em sessionTabs — o
    // agente pode agir nela nesta tool, mas closeTab/focusTab continuam bloqueados.
    const ownsSelected = this.sessionTabs.has(selected.id) || selected.id === this.currentSessionTabId;
    if (ownsSelected || toolName === 'navigate' || toolName === 'openTab') {
      this.trackTab(selected);
    }
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
    optionsOrAllFrames?: RunInTabOptions | boolean,
    legacyWorld?: chrome.scripting.ExecutionWorld,
  ): Promise<any> {
    const options = normalizeRunInTabOptions(optionsOrAllFrames, legacyWorld);
    const { allFrames = false, frameId, world = 'ISOLATED' } = options;
    const target: chrome.scripting.InjectionTarget =
      typeof frameId === 'number' ? { tabId, frameIds: [frameId] } : allFrames ? { tabId, allFrames: true } : { tabId };
    if (allFrames) {
      // Registry não se aplica: o payload iria para N frames de uma vez.
      return this.executeScriptWithTimeout(target, world, func, args, timeoutMs, { allFrames: true, frameId });
    }
    // Registry por tab/frame/world: instala a função UMA vez na página e
    // despacha por id (~100 bytes) nas chamadas seguintes, em vez de
    // re-serializar 9-26KB de source a cada tool call.
    const registryKey = `${tabId}|${world}|${typeof frameId === 'number' ? frameId : 0}`;
    const registryState = this.injectedFnRegistry.get(registryKey);
    if (!registryState?.blocked) {
      const fnId = getInjectedFnId(func);
      const installed = registryState?.installed.has(fnId) === true;
      const out = installed
        ? await this.executeScriptWithTimeout(target, world, glideDispatchInjectedFn, [fnId, args], timeoutMs, {
            frameId,
          })
        : await this.executeScriptWithTimeout(
            target,
            world,
            glideInstallAndRunInjectedFn,
            [fnId, String(func), args],
            timeoutMs,
            {
              frameId,
            },
          );
      if (isInjectedFnEvalBlocked(out)) {
        // CSP da página bloqueou o eval do install (a tool ainda NÃO rodou, é
        // seguro repetir): fallback permanente para injeção direta neste key.
        const entry = registryState ?? { installed: new Set<string>(), blocked: false };
        entry.blocked = true;
        this.injectedFnRegistry.set(registryKey, entry);
      } else if (isInjectedFnMissing(out)) {
        // A página navegou desde o install e os globals zeraram: esquece o
        // estado e reinstala (o shim de install já executa a tool na mesma ida).
        this.injectedFnRegistry.delete(registryKey);
        return this.runInTab(tabId, func, args, timeoutMs, { frameId, world });
      } else if (isInjectedFnResult(out)) {
        if (!installed) this.markInjectedFnInstalled(registryKey, fnId);
        return out.value ?? null;
      }
      // Forma de resultado inesperada: cai no caminho direto (comportamento anterior).
    }
    return this.executeScriptWithTimeout(target, world, func, args, timeoutMs, { frameId });
  }

  private markInjectedFnInstalled(registryKey: string, fnId: string) {
    const entry = this.injectedFnRegistry.get(registryKey) ?? { installed: new Set<string>(), blocked: false };
    entry.installed.add(fnId);
    this.injectedFnRegistry.set(registryKey, entry);
  }

  private dropInjectedFnRegistryForTab(tabId: number) {
    const prefix = `${tabId}|`;
    for (const key of Array.from(this.injectedFnRegistry.keys())) {
      if (key.startsWith(prefix)) this.injectedFnRegistry.delete(key);
    }
  }

  private async executeScriptWithTimeout(
    target: chrome.scripting.InjectionTarget,
    world: chrome.scripting.ExecutionWorld,
    func: (...args: any[]) => unknown,
    args: any[],
    timeoutMs: number,
    context: { allFrames?: boolean; frameId?: number } = {},
  ): Promise<any> {
    const { allFrames = false, frameId } = context;
    const tabId = target.tabId;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const injectionPromise = chrome.scripting.executeScript({
      target,
      func,
      args,
      world,
    });
    // executeScript cannot be cancelled once Chrome has accepted it. Consume a
    // late rejection so a timed-out call does not become an unhandled promise.
    void injectionPromise.catch(() => undefined);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(`Script execution timed out after ${timeoutMs}ms`) as Error & { code?: string };
        error.code = 'SCRIPT_TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    try {
      const results = await Promise.race([injectionPromise, timeoutPromise]);
      const injectionResults = (results as chrome.scripting.InjectionResult[]) || [];
      if (!allFrames) return injectionResults[0]?.result ?? null;
      const isUsefulFrameResult = (value: unknown) => {
        if (!value || typeof value !== 'object') return false;
        const result = value as Record<string, unknown>;
        if (result.success !== true) return false;
        if (result.found === false) return false;
        if (typeof result.count === 'number' && result.count <= 0) return false;
        if (typeof result.totalMatches === 'number' && result.totalMatches <= 0) return false;
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
        normalized.includes('extensions gallery cannot be scripted') ||
        normalized.includes('frame with id') ||
        normalized.includes('no frame with id')
      ) {
        if (typeof frameId === 'number') {
          return {
            success: false,
            code: 'FRAME_NOT_REACHABLE',
            error: 'Cannot inject into the targeted frame (blocked origin, chrome://, or missing frame).',
            details: { tabId, frameId, reason: message },
          };
        }
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

  private hasFrameTarget(args: Record<string, any>): boolean {
    return Boolean(
      (typeof args.frameUrl === 'string' && args.frameUrl.trim()) ||
        (typeof args.frameSelector === 'string' && args.frameSelector.trim()),
    );
  }

  private attachFrameMeta(result: Record<string, any>, frameMeta?: { targetFrameId: number; targetFrameUrl: string }) {
    if (!frameMeta) return result;
    return { ...result, ...frameMeta };
  }

  private async resolveFrameTarget(
    tabId: number,
    args: Record<string, any>,
    pageUrl: string,
  ): Promise<ResolveTargetFrameResult> {
    const frameUrl = typeof args.frameUrl === 'string' ? args.frameUrl.trim() : '';
    const frameSelector = typeof args.frameSelector === 'string' ? args.frameSelector.trim() : '';

    let urlNeedle = frameUrl;
    if (frameSelector) {
      const srcResult = await this.runInTab(
        tabId,
        (sel: string) => {
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
        },
        [frameSelector],
      );
      if (!srcResult?.success) {
        return {
          ok: false,
          code: 'FRAME_NOT_FOUND',
          error: String(srcResult?.error || 'Could not read iframe src from frameSelector.'),
        };
      }
      const absolute = absoluteFrameUrl(String(srcResult.src || ''), pageUrl);
      if (!absolute) {
        return { ok: false, code: 'FRAME_NOT_FOUND', error: 'Iframe has an empty src attribute.' };
      }
      if (frameUrl && !absolute.toLowerCase().includes(frameUrl.toLowerCase())) {
        return {
          ok: false,
          code: 'FRAME_NOT_FOUND',
          error: `Iframe src "${absolute}" does not contain frameUrl "${frameUrl}".`,
        };
      }
      urlNeedle = frameUrl || absolute;
    }

    if (!urlNeedle) {
      return { ok: false, code: 'FRAME_NOT_FOUND', error: 'Provide frameUrl and/or frameSelector.' };
    }

    let frames: FrameInfo[];
    try {
      const raw = await chrome.webNavigation.getAllFrames({ tabId });
      frames = (raw || []).map((frame) => ({
        frameId: frame.frameId,
        url: frame.url || '',
        parentFrameId: frame.parentFrameId,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingPermission = /webNavigation|permission/i.test(message);
      return {
        ok: false,
        code: 'FRAME_NOT_REACHABLE',
        error: missingPermission
          ? 'Could not enumerate tab frames (webNavigation permission missing or denied).'
          : 'Could not enumerate tab frames.',
        ...(missingPermission
          ? { hint: 'Ensure the extension manifest includes webNavigation and reload the extension.' }
          : {}),
      };
    }

    return resolveTargetFrameId(frames, { frameUrl: urlNeedle });
  }

  private async prepareFrameInjection(
    tabId: number,
    args: Record<string, any>,
    pageUrl: string,
  ): Promise<
    | {
        ok: true;
        runOptions: RunInTabOptions | undefined;
        frameMeta?: { targetFrameId: number; targetFrameUrl: string };
      }
    | { ok: false; result: Record<string, any> }
  > {
    if (!this.hasFrameTarget(args)) {
      return { ok: true, runOptions: undefined };
    }
    const frameRes = await this.resolveFrameTarget(tabId, args, pageUrl);
    if (!frameRes.ok) {
      return {
        ok: false,
        result: {
          success: false,
          code: frameRes.code,
          error: frameRes.error,
          ...(frameRes.candidates ? { candidateFrameUrls: frameRes.candidates } : {}),
        },
      };
    }
    return {
      ok: true,
      runOptions: { frameId: frameRes.frameId },
      frameMeta: { targetFrameId: frameRes.frameId, targetFrameUrl: frameRes.frameUrl },
    };
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
        const previousTab = await this.safeGetTab(tabId);
        const previousUrl = String(previousTab?.url || '');
        await chrome.tabs.update(tabId, { url: urlCheck.url });
        this.currentSessionTabId = tabId;
        const readiness = await waitForTabReadiness(tabId);
        const currentTab = await this.safeGetTab(tabId);
        const finalUrl = String(readiness.url || currentTab?.url || urlCheck.url || '');
        // Chrome follows redirects after tabs.update — re-check the landed URL so
        // a public open-redirect cannot put the session on private/metadata hosts.
        const finalCheck = requireHttpUrl(finalUrl, 'navigate final url');
        if (!finalCheck.ok) {
          const quarantine = await this.quarantineSessionTab(tabId, {
            previousUrl,
            closeIfRollbackFails: true,
          });
          return {
            success: false,
            code: 'PRIVATE_REDIRECT_BLOCKED',
            error: finalCheck.error,
            hint: finalCheck.hint,
            requestedUrl: urlCheck.url,
            finalUrl,
            rolledBack: quarantine.rolledBack,
            closed: quarantine.closed,
            ...readiness,
          };
        }
        if (currentTab) this.trackTab(currentTab);
        return { success: true, tabId, ...readiness, url: finalUrl };
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
      const readiness =
        typeof tab.id === 'number'
          ? await waitForTabReadiness(tab.id)
          : {
              ready: false,
              loadComplete: false,
              bridgeReady: false,
              url: urlCheck.url,
              warning: 'The tab opened without a usable tab id. Inspect session tabs before acting.',
            };
      const finalUrl = String(readiness.url || tab.url || urlCheck.url || '');
      const finalCheck = requireHttpUrl(finalUrl, 'openTab final url');
      if (!finalCheck.ok) {
        if (typeof tab.id === 'number') {
          this.sessionTabs.delete(tab.id);
          if (this.currentSessionTabId === tab.id) this.currentSessionTabId = null;
          try {
            await chrome.tabs.remove(tab.id);
          } catch {
            /* tab may already be gone */
          }
        }
        return {
          success: false,
          code: 'PRIVATE_REDIRECT_BLOCKED',
          error: finalCheck.error,
          hint: finalCheck.hint,
          requestedUrl: urlCheck.url,
          finalUrl,
          ...readiness,
        };
      }
      if (typeof tab.id === 'number') {
        const currentTab = await this.safeGetTab(tab.id);
        if (currentTab) this.trackTab(currentTab);
      }
      return { success: true, tabId: tab.id, ...readiness, url: finalUrl };
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
    const pageUrl = resolution.tab.url || '';
    const framePrep = await this.prepareFrameInjection(tabId, args, pageUrl);
    if (!framePrep.ok) {
      return this.attachResolutionMeta(framePrep.result, resolution);
    }
    const injOpts = framePrep.runOptions;
    const frameMeta = framePrep.frameMeta;

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

    // Content bridge (sendMessage) cannot target a child frame — skip when frameUrl/frameSelector set.
    if (!this.hasFrameTarget(args)) {
      const bridged = await this.tryBridge(tabId, 'click', { selector, retries, waitForDialog });
      if (bridged) {
        return this.attachResolutionMeta(bridged, resolution);
      }
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
        const dialogSelector = '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]';
        const allElements = <T extends Element>(query: string, root: Document | Element = document) => {
          const results: T[] = [];
          // Caps: este é o caminho de fallback (bridge indisponível); sem limite,
          // a varredura de shadow hosts com '*' percorre a página inteira
          // (dezenas de milhares de nós em SPAs) a cada tentativa de clique.
          const MAX_RESULTS = 800;
          const MAX_SHADOW_SCAN = 4000;
          let shadowScanned = 0;
          const walkShadowHosts = (
            node: Document | ShadowRoot | Element,
            visitShadow: (shadow: ShadowRoot) => void,
          ) => {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
            let current = walker.nextNode() as HTMLElement | null;
            while (current && shadowScanned < MAX_SHADOW_SCAN) {
              shadowScanned += 1;
              if (current.shadowRoot) visitShadow(current.shadowRoot);
              current = walker.nextNode() as HTMLElement | null;
            }
          };
          const visit = (node: Document | ShadowRoot | Element) => {
            if (results.length >= MAX_RESULTS) return;
            let matches: Element[] = [];
            try {
              matches = Array.from(node.querySelectorAll(query));
            } catch {
              return;
            }
            for (const element of matches) {
              results.push(element as T);
              if (results.length >= MAX_RESULTS) return;
            }
            if (shadowScanned >= MAX_SHADOW_SCAN) return;
            walkShadowHosts(node, visit);
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
      8000,
      injOpts,
    );
    // Targeted single-frame retry after read-only probe (never mutate all frames at once).
    if (!injOpts && result?.success === false && result?.code === 'ELEMENT_NOT_FOUND' && selector.trim()) {
      const frameId = await this.findFrameWithSelector(tabId, selector);
      if (frameId != null) {
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
              let shadowScanned = 0;
              const walkShadowHosts = (
                root: Document | ShadowRoot | Element,
                visitShadow: (shadow: ShadowRoot) => void,
              ) => {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
                let current = walker.nextNode() as HTMLElement | null;
                while (current && shadowScanned < 4000) {
                  shadowScanned += 1;
                  if (current.shadowRoot) visitShadow(current.shadowRoot);
                  current = walker.nextNode() as HTMLElement | null;
                }
              };
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
                walkShadowHosts(root, visit);
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
          { frameId },
        );
      }
    }
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(this.attachFrameMeta(baseResult, frameMeta), resolution);
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
        let shadowScanned = 0;
        const walkShadowHosts = (root: Document | ShadowRoot | Element, visitShadow: (shadow: ShadowRoot) => void) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let current = walker.nextNode() as HTMLElement | null;
          while (current && shadowScanned < 4000) {
            shadowScanned += 1;
            if (current.shadowRoot) visitShadow(current.shadowRoot);
            current = walker.nextNode() as HTMLElement | null;
          }
        };
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
          walkShadowHosts(root, visit);
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
    if (result?.success === false && result?.code === 'ELEMENT_NOT_FOUND' && selector.trim()) {
      const frameId = await this.findFrameWithSelector(tabId, selector);
      if (frameId != null) {
        result = await this.runInTab(tabId, hoverScript, [selector, retries, false], 8000, { frameId });
      }
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
    const toSelector = args.toSelector != null ? String(args.toSelector) : '';
    const retries = typeof args.retries === 'number' ? Math.max(1, Math.min(5, Math.round(args.retries))) : 3;

    // Bridge does not implement drag yet — fall through to injection.
    if (action !== 'drag') {
      const bridged = await this.tryBridge(tabId, 'mouse', { selector, action, retries });
      if (bridged) {
        return this.attachResolutionMeta(bridged, resolution);
      }
    }

    const mouseScript = async (sel: string, act: string, maxAttempts: number, frameMode = false, dropSel = '') => {
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
        let shadowScanned = 0;
        const walkShadowHosts = (root: Document | ShadowRoot | Element, visitShadow: (shadow: ShadowRoot) => void) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let current = walker.nextNode() as HTMLElement | null;
          while (current && shadowScanned < 4000) {
            shadowScanned += 1;
            if (current.shadowRoot) visitShadow(current.shadowRoot);
            current = walker.nextNode() as HTMLElement | null;
          }
        };
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
          walkShadowHosts(root, visit);
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
      const resolveTarget = (query: string) => {
        const q = String(query || '').trim();
        if (!q) return null;
        return deepQuerySelector<HTMLElement>(q) || findByText(q);
      };
      const centerOf = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
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
          const dropEl = resolveTarget(dropSel);
          if (!dropEl) {
            return {
              success: false,
              code: 'ELEMENT_NOT_FOUND',
              error: `Drag drop target not found: ${dropSel}`,
            };
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
            from: from,
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

    let result = await this.runInTab(tabId, mouseScript, [selector, action, retries, false, toSelector]);
    if (result?.success === false && result?.code === 'ELEMENT_NOT_FOUND' && selector.trim()) {
      const frameId = await this.findFrameWithSelector(tabId, selector);
      if (frameId != null) {
        result = await this.runInTab(tabId, mouseScript, [selector, action, retries, false, toSelector], 8000, {
          frameId,
        });
      }
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
    const pageUrl = resolution.tab.url || '';
    const framePrep = await this.prepareFrameInjection(tabId, args, pageUrl);
    if (!framePrep.ok) {
      return this.attachResolutionMeta(framePrep.result, resolution);
    }
    const injOpts = framePrep.runOptions;
    const frameMeta = framePrep.frameMeta;

    if (!this.hasFrameTarget(args)) {
      const bridged = await this.tryBridge(tabId, 'type', { selector, text, retries });
      if (bridged) {
        return this.attachResolutionMeta(bridged, resolution);
      }
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
            let shadowScanned = 0;
            const walkShadowHosts = (
              root: Document | ShadowRoot | Element,
              visitShadow: (shadow: ShadowRoot) => void,
            ) => {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let current = walker.nextNode() as HTMLElement | null;
              while (current && shadowScanned < 4000) {
                shadowScanned += 1;
                if (current.shadowRoot) visitShadow(current.shadowRoot);
                current = walker.nextNode() as HTMLElement | null;
              }
            };
            const visit = (root: Document | ShadowRoot | Element) => {
              const matches = Array.from(
                root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement>(
                  'input, textarea, select, [contenteditable="true"]',
                ),
              );
              for (const element of matches) {
                results.push(element);
              }
              walkShadowHosts(root, visit);
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
            return element.value === option.value;
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
            return String(element.value) === String(nextValue);
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
      8000,
      injOpts,
    );
    if (!injOpts && result?.success === false && result?.code === 'ELEMENT_NOT_FOUND' && selector.trim()) {
      const frameId = await this.findFrameWithSelector(tabId, selector);
      if (frameId != null) {
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
              let shadowScanned = 0;
              const walkShadowHosts = (
                root: Document | ShadowRoot | Element,
                visitShadow: (shadow: ShadowRoot) => void,
              ) => {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
                let current = walker.nextNode() as HTMLElement | null;
                while (current && shadowScanned < 4000) {
                  shadowScanned += 1;
                  if (current.shadowRoot) visitShadow(current.shadowRoot);
                  current = walker.nextNode() as HTMLElement | null;
                }
              };
              const visit = (root: Document | ShadowRoot | Element) => {
                const matches = Array.from(
                  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement>(
                    'input, textarea, select, [contenteditable="true"]',
                  ),
                );
                for (const element of matches) {
                  results.push(element);
                }
                walkShadowHosts(root, visit);
              };
              visit(document);
              return results;
            };
            const deepQuerySelector = (query: string) => {
              if (!query.includes('>>>')) {
                try {
                  return document.querySelector<
                    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement
                  >(query);
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
                return element.value === option.value;
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
                return String(element.value) === String(nextValue);
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
          { frameId },
        );
      }
    }
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(this.attachFrameMeta(baseResult, frameMeta), resolution);
  }

  async pressKey(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'pressKey');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const key = String(args.key || '');
    const selector = args.selector ? String(args.selector) : '';
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map(String) : [];
    const pageUrl = resolution.tab.url || '';
    const framePrep = await this.prepareFrameInjection(tabId, args, pageUrl);
    if (!framePrep.ok) {
      return this.attachResolutionMeta(framePrep.result, resolution);
    }
    const injOpts = framePrep.runOptions;
    const frameMeta = framePrep.frameMeta;

    if (!this.hasFrameTarget(args)) {
      const bridged = await this.tryBridge(tabId, 'pressKey', {
        key,
        selector: selector || undefined,
        modifiers: modifiers.length ? modifiers : undefined,
      });
      if (bridged) {
        return this.attachResolutionMeta(bridged, resolution);
      }
    }

    const pressKeyScript = (k: string, sel: string, mods: string[]) => {
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
      const allowed = new Set(['Control', 'Alt', 'Shift', 'Meta']);
      const normalizedMods = Array.isArray(mods)
        ? mods.map((m) => String(m || '').trim()).filter((m) => allowed.has(m))
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
          return {
            success: false,
            code: 'INVALID_SELECTOR',
            error: `Invalid selector syntax: ${String(sel)}`,
          };
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
    };

    let result = await this.runInTab(tabId, pressKeyScript, [key, selector, modifiers], 8000, injOpts);
    if (!injOpts && selector && result?.success === false && result?.code === 'ELEMENT_NOT_FOUND') {
      const frameId = await this.findFrameWithSelector(tabId, selector);
      if (frameId != null) {
        result = await this.runInTab(tabId, pressKeyScript, [key, selector, modifiers], 8000, { frameId });
      }
    }
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(this.attachFrameMeta(baseResult, frameMeta), resolution);
  }

  async scroll(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'scroll');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const direction = String(args.direction || 'down');
    const amount = typeof args.amount === 'number' ? args.amount : 600;
    const selector = typeof args.selector === 'string' ? args.selector : '';
    const strategy = typeof args.strategy === 'string' ? args.strategy : 'auto';

    const bridged = await this.tryBridge(tabId, 'scroll', {
      direction,
      amount,
      selector: selector || undefined,
      strategy,
    });
    if (bridged) {
      return this.attachResolutionMeta(bridged, resolution);
    }

    // Fallback when the content bridge is unavailable: self-contained mirror of
    // scrollPage — multi-wheel + intoView + scrollTop on modal list scroller.
    const result = await this.runInTab(
      tabId,
      (dir, amt, sel, strat) => {
        const step = Math.abs(amt) || 600;
        const mode = String(strat || 'auto').toLowerCase();
        const isScrollable = (el) => {
          if (!el || el.nodeType !== 1) return false;
          if (el.scrollHeight - el.clientHeight <= 4) return false;
          const oy = getComputedStyle(el).overflowY;
          return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
        };
        const nearest = (start) => {
          let node = start;
          for (let d = 0; node && d < 30; d += 1) {
            if (isScrollable(node)) return node;
            node = node.parentElement;
          }
          return null;
        };
        const DIALOG_SEL =
          '[role="dialog"], [aria-modal="true"], [data-testid*="modal" i], [class*="Dialog" i], [class*="modal" i]';
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const resolveTarget = () => {
          if (sel) {
            const scoped = nearest(document.querySelector(sel));
            if (scoped) return scoped;
          }
          const dialogs = Array.from(document.querySelectorAll(DIALOG_SEL)).filter(visible);
          const dialog = dialogs[dialogs.length - 1];
          if (!dialog) return null;
          let best = null;
          let bestOverflow = 0;
          const scan = (el) => {
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
        const container = resolveTarget();
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
      },
      [direction, amount, selector, strategy],
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
      const deep = args.deep === true;
      const pageUrl = resolution.tab.url || '';
      const framePrep = await this.prepareFrameInjection(tabId, args, pageUrl);
      if (!framePrep.ok) {
        return this.attachResolutionMeta(framePrep.result, resolution);
      }
      const injOpts = framePrep.runOptions;
      const frameMeta = framePrep.frameMeta;

      if (!this.hasFrameTarget(args)) {
        const bridged = await this.tryBridge(tabId, 'findElement', {
          query,
          type: typeFilter,
          maxResults,
          fuzzy,
          scope,
          deep,
        });
        if (bridged) {
          return this.attachResolutionMeta(bridged, resolution);
        }
      }

      const findScript = (
        searchQuery: string,
        filterType: string,
        maxRes: number,
        useFuzzy: boolean,
        searchScope: string,
        deepScan: boolean,
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
            return tag + ':nth-of-type(' + index + ')';
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
        const DIALOG_SEL = '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]';
        let shadowScanned = 0;
        const walkShadowHosts = (root: Document | ShadowRoot | Element, visitShadow: (shadow: ShadowRoot) => void) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let current = walker.nextNode() as HTMLElement | null;
          while (current && shadowScanned < 4000) {
            shadowScanned += 1;
            if (current.shadowRoot) visitShadow(current.shadowRoot);
            current = walker.nextNode() as HTMLElement | null;
          }
        };
        const collectInto = (root: Document | ShadowRoot | Element, bucket: HTMLElement[]) => {
          if (bucket.length >= MAX_CANDIDATE_SCAN) return;
          const matches = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE));
          for (const element of matches) {
            bucket.push(element);
            if (bucket.length >= MAX_CANDIDATE_SCAN) return;
          }
          walkShadowHosts(root, (shadow) => collectInto(shadow, bucket));
        };
        const collectElements = (root: Document | ShadowRoot | Element): HTMLElement[] => {
          const bucket: HTMLElement[] = [];
          collectInto(root, bucket);
          return bucket;
        };
        const resolveScopeRoot = (kind: string): Document | Element | null => {
          if (kind === 'page') return document;
          if (kind === 'dialog') {
            const dialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SEL)).filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
          }
          if (kind === 'form') {
            const forms = Array.from(document.querySelectorAll<HTMLFormElement>('form')).filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            return forms.length > 0 ? forms[0] : null;
          }
          if (kind === 'landmark') {
            for (const sel of ['main', '[role="main"]', 'nav']) {
              const el = document.querySelector(sel);
              if (el instanceof HTMLElement) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return el;
              }
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

        const matchCandidates = (allElements: HTMLElement[]) => {
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
            if (filterType === 'link' && tag !== 'a' && element.getAttribute('role') !== 'link') return false;
            if (filterType === 'input' && !['input', 'textarea', 'select'].includes(tag)) return false;
            return true;
          };

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
          const root = resolveScopeRoot(kind);
          if (!root) continue;
          combined = matchCandidates(collectElements(root));
          if (combined.length > 0) {
            searchRoot = root;
            break;
          }
        }

        const openDialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SEL)).filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

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
        [query, typeFilter, maxResults, fuzzy, scope, deep],
        8000,
        injOpts,
      );
      if (!injOpts && !result?.success) {
        const frameResult = await this.runInTab(
          tabId,
          findScript,
          [query, typeFilter, maxResults, fuzzy, scope, deep],
          8000,
          { allFrames: true },
        );
        if (frameResult?.success) result = frameResult;
      }
      const baseResult = result || { success: false, error: 'Script execution failed.' };
      return this.attachResolutionMeta(this.attachFrameMeta(baseResult, frameMeta), resolution);
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
        const dialogSel = '[role="dialog"], [aria-modal="true"], div[role="dialog"], [data-testid*="modal" i]';
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
          const remaining = Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVis).length;
          if (remaining < before) {
            return { success: true, strategy: 'close-button', dialogsRemaining: remaining };
          }
        }
        pressEscape();
        await new Promise((r) => setTimeout(r, 200));
        let after = Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVis).length;
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
            await new Promise((r) => setTimeout(r, 200));
            after = Array.from(document.querySelectorAll<HTMLElement>(dialogSel)).filter(isVis).length;
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
      const completed = await sleepWithSignal(ms, this.currentToolContext?.signal);
      if (!completed) return this.attachResolutionMeta(abortedToolResult(), resolution);
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
                resolve({
                  success: false,
                  code: 'WAIT_TIMEOUT',
                  error: 'No dialog appeared.',
                  elapsed: Date.now() - t0,
                });
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

    if (condition === 'networkidle') {
      return this.waitForNetworkIdle(tabId, resolution, args);
    }

    if (!['selector', 'visible', 'hidden'].includes(condition)) {
      return this.attachResolutionMeta(
        {
          success: false,
          code: 'INVALID_ARGS',
          error: `Unsupported wait condition: ${condition}`,
        },
        resolution,
      );
    }

    const selector = String(args.selector || '');
    const timeout = typeof args.timeout === 'number' ? Math.max(100, Math.min(15000, Math.round(args.timeout))) : 5000;
    const interval = 250;
    const waitHidden = condition === 'hidden';
    const pageUrl = resolution.tab.url || '';
    const framePrep = await this.prepareFrameInjection(tabId, args, pageUrl);
    if (!framePrep.ok) {
      return this.attachResolutionMeta(framePrep.result, resolution);
    }
    const injOpts = framePrep.runOptions;
    const frameMeta = framePrep.frameMeta;

    if (!this.hasFrameTarget(args)) {
      const bridged = await this.tryBridge(tabId, 'wait', {
        condition,
        selector,
        timeoutMs: timeout,
      });
      if (bridged) return this.attachResolutionMeta(bridged, resolution);
    }

    let result = await this.runInTab(
      tabId,
      (sel: string, to: number, intv: number, hidden: boolean, resolvedCondition: string) => {
        return new Promise<{
          success: boolean;
          found: boolean;
          elapsed: number;
          selector: string;
          condition: string;
        }>((resolve) => {
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
          const isVisible = (element: HTMLElement) => {
            if (!element || element.hidden) return false;
            if ((element as HTMLInputElement).type === 'hidden') return false;
            if (element.getAttribute('aria-hidden') === 'true') return false;
            const checkVisibility = (
              element as HTMLElement & {
                checkVisibility?: (options?: {
                  checkOpacity?: boolean;
                  checkVisibilityCSS?: boolean;
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
          const check = () => {
            try {
              const element = deepQuerySelector(sel);
              const ready = hidden
                ? !element || !isVisible(element as HTMLElement)
                : Boolean(element && isVisible(element as HTMLElement));
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
      },
      [selector, timeout, interval, waitHidden, condition],
      timeout + 1000,
      injOpts,
    );
    if (!injOpts && result?.success === true && result?.found === false && !waitHidden) {
      result = await this.runInTab(
        tabId,
        (sel: string, to: number, intv: number, hidden: boolean, resolvedCondition: string) => {
          return new Promise<{
            success: boolean;
            found: boolean;
            elapsed: number;
            selector: string;
            condition: string;
          }>((resolve) => {
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
                const isVisible = (el: HTMLElement) => {
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                };
                const ready = hidden
                  ? !element || !isVisible(element as HTMLElement)
                  : Boolean(element && isVisible(element as HTMLElement));
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
                // Invalid selector, keep waiting.
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
        },
        [selector, timeout, interval, waitHidden, condition],
        timeout + 1000,
        { allFrames: true },
      );
    }

    let baseResult = result || { success: false, error: 'Script execution failed.' };
    if (baseResult?.found === false) {
      baseResult = {
        ...baseResult,
        success: false,
        code: 'WAIT_TIMEOUT',
        error: waitHidden
          ? `Selector still visible within ${timeout}ms: ${selector}`
          : `Selector not found within ${timeout}ms: ${selector}`,
        hint: 'Use findElement or getContent({ mode: "structure" }) to verify the selector.',
      };
    }
    return this.attachResolutionMeta(this.attachFrameMeta(baseResult, frameMeta), resolution);
  }

  private async waitForNetworkIdle(tabId: number, resolution: TabResolution, args: Record<string, any>) {
    const idleMs = typeof args.idleMs === 'number' ? Math.max(100, Math.min(10000, Math.round(args.idleMs))) : 500;
    const timeout = typeof args.timeout === 'number' ? Math.max(100, Math.min(15000, Math.round(args.timeout))) : 5000;
    const HOOK_VERSION = 5;

    const hookState = await this.runInTab(
      tabId,
      (version: number) => {
        const w = window as any;
        return {
          installed: w.__glide_network_installed__ === version && w.__glide_network_active__ === true,
        };
      },
      [HOOK_VERSION],
      3000,
      false,
      'MAIN',
    );
    const hadHooks = hookState?.installed === true;

    const installResult = await this.getNetworkRequests({ tabId, installOnly: true });
    if (installResult?.hookInstalled !== true) {
      return this.attachResolutionMeta(
        {
          success: false,
          code: 'NETWORK_HOOK_FAILED',
          error: 'Could not install network idle hooks on the target page.',
        },
        resolution,
      );
    }

    const freshlyInstalled = !hadHooks;

    const result = await this.runInTab(
      tabId,
      (quietMs: number, timeoutMs: number, needsBootstrap: boolean) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const w = window as any;
          const INFLIGHT_KEY = '__glide_network_inflight__';
          const BUFFER_KEY = '__glide_network_buffer__';
          const bufferStart = Array.isArray(w[BUFFER_KEY]) ? w[BUFFER_KEY].length : 0;
          const t0 = Date.now();
          let idleSince = Date.now();
          let resourceBaseline = -1;
          let resourceSettled = !needsBootstrap;
          // Fresh hooks start with inflight=0 while the page may still be loading — grace + resource settling.
          const graceEnd = needsBootstrap ? t0 + Math.min(quietMs, 500) : t0;

          const tick = () => {
            const inflight = Number(w[INFLIGHT_KEY] || 0);
            const now = Date.now();

            if (needsBootstrap && document.readyState === 'loading') {
              idleSince = now;
              setTimeout(tick, 50);
              return;
            }

            if (needsBootstrap && !resourceSettled) {
              const resourceCount = performance.getEntriesByType('resource').length;
              if (resourceBaseline < 0) {
                resourceBaseline = resourceCount;
                idleSince = now;
                setTimeout(tick, 100);
                return;
              }
              if (resourceCount !== resourceBaseline) {
                resourceBaseline = resourceCount;
                idleSince = now;
                setTimeout(tick, 100);
                return;
              }
              resourceSettled = true;
            }

            if (needsBootstrap && now < graceEnd) {
              if (inflight > 0) idleSince = now;
              setTimeout(tick, 50);
              return;
            }

            if (inflight > 0) idleSince = now;
            const observedRequests = (Array.isArray(w[BUFFER_KEY]) ? w[BUFFER_KEY].length : 0) - bufferStart;
            if (now - idleSince >= quietMs) {
              resolve({
                success: true,
                condition: 'networkIdle',
                idleMs: quietMs,
                observedRequests: Math.max(0, observedRequests),
                elapsed: now - t0,
                bootstrapApplied: needsBootstrap,
              });
              return;
            }
            if (now - t0 >= timeoutMs) {
              resolve({
                success: false,
                code: 'WAIT_TIMEOUT',
                error: `Network did not become idle within ${timeoutMs}ms (in-flight: ${inflight}).`,
                condition: 'networkIdle',
                idleMs: quietMs,
                observedRequests: Math.max(0, observedRequests),
                inFlight: inflight,
                bootstrapApplied: needsBootstrap,
              });
              return;
            }
            setTimeout(tick, 50);
          };
          tick();
        }),
      [idleMs, timeout, freshlyInstalled],
      timeout + 2000,
      false,
      'MAIN',
    );

    if (freshlyInstalled) {
      await this.getNetworkRequests({ tabId, stop: true });
    }

    return this.attachResolutionMeta(result || { success: false, error: 'wait networkIdle failed' }, resolution);
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
              return tag + ':nth-of-type(' + index + ')';
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

  private async captureVisibleTabScreenshot(
    tab: chrome.tabs.Tab,
    options: { format?: 'jpeg' | 'png'; quality?: number; maxDim?: number; skipDownscale?: boolean } = {},
  ): Promise<Record<string, any>> {
    const format = options.format === 'png' ? 'png' : 'jpeg';
    const quality = typeof options.quality === 'number' ? Math.max(1, Math.min(100, Math.round(options.quality))) : 90;
    const maxDim = typeof options.maxDim === 'number' ? options.maxDim : 1280;
    const skipDownscale = options.skipDownscale === true;
    let focusedForCapture = false;
    let restoredFocus = false;
    const capturedTabId = typeof tab.id === 'number' ? tab.id : null;
    const previouslyFocusedWindowId = (await chrome.windows.getLastFocused()).id;
    const targetWindowTabs = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    const targetWindowPreviousActiveTabId = targetWindowTabs[0]?.id ?? capturedTabId;

    if (capturedTabId && targetWindowPreviousActiveTabId !== capturedTabId) {
      try {
        await chrome.tabs.update(capturedTabId, { active: true });
        focusedForCapture = true;
      } catch (error) {
        return {
          success: false,
          code: 'SCREENSHOT_FOCUS_FAILED',
          error: `Failed to focus target tab ${capturedTabId} for screenshot: ${error?.message || String(error)}`,
        };
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
      if (
        focusedForCapture &&
        targetWindowPreviousActiveTabId !== null &&
        targetWindowPreviousActiveTabId !== capturedTabId
      ) {
        try {
          await chrome.tabs.update(targetWindowPreviousActiveTabId, { active: true });
          restoredFocus = true;
        } catch {
          // Best effort focus restore within the target window.
        }
      }
      if (
        focusedForCapture &&
        typeof previouslyFocusedWindowId === 'number' &&
        previouslyFocusedWindowId !== tab.windowId
      ) {
        try {
          await chrome.windows.update(previouslyFocusedWindowId, { focused: true });
        } catch {
          // Best effort window focus restore.
        }
      }
    }

    if (!skipDownscale && captureResult.success && typeof captureResult.dataUrl === 'string') {
      const scaled = await this.downscaleScreenshotDataUrl(captureResult.dataUrl, maxDim, 0.8);
      if (scaled.downscaled) {
        captureResult.dataUrl = scaled.dataUrl;
        captureResult.format = 'jpeg';
        captureResult.downscaled = true;
        captureResult.width = scaled.width;
        captureResult.height = scaled.height;
      }
    }

    return {
      ...captureResult,
      focusedForCapture,
      restoredFocus,
      capturedTabId,
    };
  }

  private async cropScreenshotDataUrl(
    dataUrl: string,
    clip: { x: number; y: number; width: number; height: number },
    quality = 0.9,
  ): Promise<{ dataUrl: string; width: number; height: number } | null> {
    try {
      if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
        return null;
      }
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      const sx = Math.max(0, Math.min(Math.floor(clip.x), bitmap.width - 1));
      const sy = Math.max(0, Math.min(Math.floor(clip.y), bitmap.height - 1));
      const sw = Math.max(1, Math.min(Math.ceil(clip.width), bitmap.width - sx));
      const sh = Math.max(1, Math.min(Math.ceil(clip.height), bitmap.height - sy));
      const canvas = new OffscreenCanvas(sw, sh);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close?.();
        return null;
      }
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      bitmap.close?.();
      const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      const base64 = arrayBufferToBase64(await outBlob.arrayBuffer());
      return {
        dataUrl: `data:image/jpeg;base64,${base64}`,
        width: sw,
        height: sh,
      };
    } catch {
      return null;
    }
  }

  async screenshot(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'screenshot');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tab = resolution.tab;
    const requestedFormat = String(args.format || 'jpeg').toLowerCase();
    const format = requestedFormat === 'png' ? 'png' : 'jpeg';
    const quality = typeof args.quality === 'number' ? Math.max(1, Math.min(100, Math.round(args.quality))) : 90;
    const captureResult = await this.captureVisibleTabScreenshot(tab, { format, quality });
    return this.attachResolutionMeta(captureResult, resolution);
  }

  async annotatedScreenshot(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'annotatedScreenshot');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tab = resolution.tab;
    const tabId = resolution.tabId;
    const maxMarks = clampInt(args.maxMarks !== undefined ? args.maxMarks : 30, 1, 80);
    const scope = String(args.scope || 'page').toLowerCase();
    const pageUrl = resolution.tab.url || '';
    const framePrep = await this.prepareFrameInjection(tabId, args, pageUrl);
    if (!framePrep.ok) {
      return this.attachResolutionMeta(framePrep.result, resolution);
    }
    const injOpts = framePrep.runOptions;
    const frameMeta = framePrep.frameMeta;

    const overlayScript = (max: number, searchScope: string) => {
      const OVERLAY_ATTR = 'data-glide-som-overlay';
      document.querySelector(`[${OVERLAY_ATTR}]`)?.remove();

      function buildLocalSelector(element: Element) {
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
        const cls = Array.from(el.classList || []).find(
          (c) => /^[a-z][a-z0-9_-]{2,40}$/i.test(c) && !/[0-9]{5,}/.test(c),
        );
        if (cls) return `.${cls}`;
        const parent = el.parentElement;
        if (parent) {
          const tag = el.tagName.toLowerCase();
          const siblings = Array.from(parent.children).filter((c) => c.tagName.toLowerCase() === tag);
          return `${tag}:nth-of-type(${siblings.indexOf(el) + 1})`;
        }
        return el.tagName.toLowerCase();
      }
      function buildOptimalSelector(element: Element): string {
        const local = buildLocalSelector(element);
        const root = element.getRootNode();
        if (root instanceof ShadowRoot) {
          return `${buildOptimalSelector(root.host)} >>> ${local}`;
        }
        return local;
      }
      const normalize = (v: string) =>
        String(v || '')
          .replace(/\s+/g, ' ')
          .trim();
      const isVisible = (element: HTMLElement) => {
        if (!element || element.hidden) return false;
        if ((element as HTMLInputElement).type === 'hidden') return false;
        if (element.getAttribute('aria-hidden') === 'true') return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        return true;
      };
      const nameOf = (el: HTMLElement) =>
        normalize(
          el.getAttribute('aria-label') ||
            (el as HTMLInputElement).placeholder ||
            el.getAttribute('title') ||
            el.getAttribute('name') ||
            el.getAttribute('alt') ||
            el.textContent ||
            '',
        ).slice(0, 80);

      const DIALOG_SEL = '[role="dialog"], [aria-modal="true"], div[role="dialog"]';
      const INTERACTIVE =
        'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [contenteditable="true"], [tabindex="0"]';

      let root: Document | Element = document;
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SEL)).filter(isVisible);
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
        if (seen.has(el) || !isVisible(el)) continue;
        seen.add(el);
        idx += 1;
        const rect = el.getBoundingClientRect();
        marks.push({
          ref: `e${idx}`,
          selector: buildOptimalSelector(el),
          tag: el.tagName.toLowerCase(),
          text: nameOf(el),
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
    };

    const removeOverlayScript = () => {
      document.querySelector('[data-glide-som-overlay]')?.remove();
      return { success: true };
    };

    const overlayResult = await this.runInTab(tabId, overlayScript, [maxMarks, scope], 8000, injOpts);
    if (!overlayResult?.success) {
      return this.attachResolutionMeta(
        this.attachFrameMeta(overlayResult || { success: false, error: 'Failed to draw mark overlays.' }, frameMeta),
        resolution,
      );
    }

    const marks = Array.isArray(overlayResult.marks) ? overlayResult.marks : [];
    let captureResult: Record<string, any>;
    try {
      captureResult = await this.captureVisibleTabScreenshot(tab, { format: 'jpeg', quality: 90 });
    } finally {
      await this.runInTab(tabId, removeOverlayScript, [], 3000, injOpts).catch(() => {});
    }

    if (!captureResult.success) {
      return this.attachResolutionMeta(this.attachFrameMeta(captureResult, frameMeta), resolution);
    }

    const marksSummary = marks
      .map((mark: Record<string, unknown>) => {
        const ref = String(mark.ref || '');
        const tag = String(mark.tag || '');
        const text = String(mark.text || '');
        const selector = String(mark.selector || '');
        return `${ref}: <${tag}> "${text}" selector=${selector}`;
      })
      .join('\n');

    return this.attachResolutionMeta(
      this.attachFrameMeta(
        {
          ...captureResult,
          marks,
          marksCount: marks.length,
          scope,
          message: `Annotated screenshot with ${marks.length} mark(s). Use each mark's selector with click/type.`,
          marksSummary,
        },
        frameMeta,
      ),
      resolution,
    );
  }

  async elementScreenshot(args: Record<string, any>) {
    const resolved = await this.resolveExecutableTab(args, 'elementScreenshot');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tab = resolution.tab;
    const tabId = resolution.tabId;
    const selector = args.selector ? String(args.selector) : '';
    const ref = args.ref ? String(args.ref) : '';
    const padding = clampInt(args.padding !== undefined ? args.padding : 8, 0, 100);
    const pageUrl = resolution.tab.url || '';
    const framePrep = await this.prepareFrameInjection(tabId, args, pageUrl);
    if (!framePrep.ok) {
      return this.attachResolutionMeta(framePrep.result, resolution);
    }
    const injOpts = framePrep.runOptions;
    const frameMeta = framePrep.frameMeta;

    const measureResult = await this.runInTab(
      tabId,
      measureScreenshotTarget,
      [selector, ref, String(args.scope || 'auto').toLowerCase(), args.interactiveOnly !== false],
      8000,
      injOpts,
    );
    if (!measureResult?.success) {
      return this.attachResolutionMeta(
        this.attachFrameMeta(measureResult || { success: false, error: 'Failed to measure element.' }, frameMeta),
        resolution,
      );
    }

    let viewport = measureResult.viewport as { width: number; height: number };
    let elementRect = measureResult.rect as { x: number; y: number; width: number; height: number };

    if (this.hasFrameTarget(args)) {
      const frameSelector = typeof args.frameSelector === 'string' ? args.frameSelector.trim() : '';
      const frameUrl = typeof args.frameUrl === 'string' ? args.frameUrl.trim() : '';
      const iframeOffsetScript = (sel: string, urlNeedle: string) => {
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
      };
      const offsetResult = await this.runInTab(tabId, iframeOffsetScript, [frameSelector, frameUrl], 5000);
      if (!offsetResult?.success) {
        return this.attachResolutionMeta(
          this.attachFrameMeta(
            offsetResult || { success: false, error: 'Failed to measure iframe offset.' },
            frameMeta,
          ),
          resolution,
        );
      }
      const offset = offsetResult.offset as { x: number; y: number };
      elementRect = {
        x: offset.x + elementRect.x,
        y: offset.y + elementRect.y,
        width: elementRect.width,
        height: elementRect.height,
      };
      viewport = offsetResult.viewport as { width: number; height: number };
    }

    if (!rectIntersectsViewport(elementRect, viewport)) {
      return this.attachResolutionMeta(
        this.attachFrameMeta(
          {
            success: false,
            code: 'ELEMENT_OFFSCREEN',
            error: 'Element is not visible in the captured viewport.',
          },
          frameMeta,
        ),
        resolution,
      );
    }

    const captureResult = await this.captureVisibleTabScreenshot(tab, {
      format: 'jpeg',
      quality: 90,
      skipDownscale: true,
    });
    if (!captureResult.success || typeof captureResult.dataUrl !== 'string') {
      return this.attachResolutionMeta(this.attachFrameMeta(captureResult, frameMeta), resolution);
    }

    const fullBlob = await (await fetch(captureResult.dataUrl)).blob();
    const fullBitmap = await createImageBitmap(fullBlob);
    const bitmapWidth = fullBitmap.width;
    const bitmapHeight = fullBitmap.height;
    fullBitmap.close?.();
    const scaleX = bitmapWidth / Math.max(1, Number(viewport.width) || 1);
    const scaleY = bitmapHeight / Math.max(1, Number(viewport.height) || 1);

    const scaledRect = {
      x: elementRect.x * scaleX,
      y: elementRect.y * scaleY,
      width: elementRect.width * scaleX,
      height: elementRect.height * scaleY,
    };
    const scaledPadding = padding * Math.max(scaleX, scaleY);
    const clip = computeClipRect(scaledRect, scaledPadding, {
      width: bitmapWidth,
      height: bitmapHeight,
    });

    if (!clipIntersectsBitmap(clip, { width: bitmapWidth, height: bitmapHeight })) {
      return this.attachResolutionMeta(
        this.attachFrameMeta(
          {
            success: false,
            code: 'ELEMENT_OFFSCREEN',
            error: 'Element clip does not intersect the captured tab bitmap.',
          },
          frameMeta,
        ),
        resolution,
      );
    }

    const cropped = await this.cropScreenshotDataUrl(captureResult.dataUrl, clip, 0.9);
    if (!cropped) {
      return this.attachResolutionMeta(
        this.attachFrameMeta(
          {
            success: false,
            code: 'ELEMENT_SCREENSHOT_CROP_FAILED',
            error: 'Failed to crop element region from the captured tab screenshot.',
            hint: 'OffscreenCanvas crop unavailable in this environment.',
          },
          frameMeta,
        ),
        resolution,
      );
    }

    const downscaled = await this.downscaleScreenshotDataUrl(cropped.dataUrl, 1280, 0.8);
    const finalDataUrl = downscaled.downscaled ? downscaled.dataUrl : cropped.dataUrl;

    return this.attachResolutionMeta(
      this.attachFrameMeta(
        {
          success: true,
          dataUrl: finalDataUrl,
          format: 'jpeg',
          cropped: true,
          width: downscaled.width ?? cropped.width,
          height: downscaled.height ?? cropped.height,
          clip,
          selector: measureResult.selector,
          ref: measureResult.ref,
          padding,
          message: 'Element region captured and cropped from the visible tab.',
        },
        frameMeta,
      ),
      resolution,
    );
  }

  private async downscaleScreenshotDataUrl(
    dataUrl: string,
    maxDim: number,
    quality: number,
  ): Promise<{ dataUrl: string; downscaled: boolean; width?: number; height?: number }> {
    try {
      if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
        return { dataUrl, downscaled: false };
      }
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      const w = bitmap.width;
      const h = bitmap.height;
      if (!needsScreenshotDownscale(w, h, maxDim)) {
        bitmap.close?.();
        return { dataUrl, downscaled: false, width: w, height: h };
      }
      const target = computeDownscale(w, h, maxDim);
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close?.();
        return { dataUrl, downscaled: false };
      }
      ctx.drawImage(bitmap, 0, 0, target.width, target.height);
      bitmap.close?.();
      const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      const base64 = arrayBufferToBase64(await outBlob.arrayBuffer());
      return {
        dataUrl: `data:image/jpeg;base64,${base64}`,
        downscaled: true,
        width: target.width,
        height: target.height,
      };
    } catch {
      return { dataUrl, downscaled: false };
    }
  }

  async getTabs() {
    // Só abas da sessão de automação — listar a janela inteira vazava URLs de
    // e-mail/banco do usuário e contradizia o gate de closeTab/focusTab.
    await this.pruneSessionTabs();
    const tabs: Array<{ id: number; title?: string; url?: string }> = [];
    for (const [id, meta] of this.sessionTabs) {
      try {
        const live = await this.safeGetTab(id);
        if (live && typeof live.id === 'number') {
          tabs.push({ id: live.id, title: live.title, url: live.url });
          this.trackTab(live);
        } else {
          tabs.push({ id, title: meta.title, url: meta.url });
        }
      } catch {
        tabs.push({ id, title: meta.title, url: meta.url });
      }
    }
    return {
      success: true,
      tabs,
      sessionOnly: true,
      currentSessionTabId: this.currentSessionTabId,
    };
  }

  async groupTabs(args: Record<string, any>) {
    const tabIds = Array.isArray(args.tabIds) ? args.tabIds.filter((id) => typeof id === 'number') : [];
    if (!tabIds.length) {
      return { success: false, error: 'No tab ids provided.' };
    }
    const outside = tabIds.filter((id) => !this.sessionTabs.has(id));
    if (outside.length) {
      return {
        success: false,
        code: 'TAB_NOT_IN_SESSION',
        error: `Tab(s) not in this automation session: ${outside.join(', ')}.`,
        hint: 'Glide only groups tabs it opened during this session.',
      };
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
    const preferredWorld = resolveExecuteScriptWorld(args.world);
    const world = preferredWorld === 'ISOLATED' ? 'USER_SCRIPT' : preferredWorld;
    const timeoutMs = resolveExecuteScriptTimeoutMs(args.timeoutMs);
    if (!isUserScriptsApiAvailable()) {
      return {
        success: false,
        code: 'USER_SCRIPTS_UNAVAILABLE',
        error: 'executeScript requer Chrome 135+ e “Permitir scripts do usuário” nas configurações da extensão.',
        hint: 'chrome://extensions → Glide V2 → Allow User Scripts. A ferramenta fica desligada por padrão.',
        world,
      };
    }
    return withResolvedTab(this, args, 'executeScript', async (resolution) => {
      if (isToolContextAborted(this.currentToolContext)) {
        return abortedToolResult();
      }
      try {
        await chrome.userScripts.configureWorld?.({ messaging: false });
      } catch {
        /* already configured or permission not granted yet */
      }
      const source = buildUserScriptSource(code);
      const signal = this.currentToolContext?.signal;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(Object.assign(new Error('SCRIPT_TIMEOUT'), { code: 'SCRIPT_TIMEOUT' })),
          timeoutMs,
        );
      });
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            const onAbort = () => reject(Object.assign(new Error('RUN_ABORTED'), { code: 'RUN_ABORTED' }));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          })
        : null;
      try {
        const injectionPromise = chrome.userScripts.execute({
          target: { tabId: resolution.tabId },
          js: [{ code: source }],
          world: world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT',
          injectImmediately: true,
        });
        const races = [injectionPromise, timeoutPromise];
        if (abortPromise) races.push(abortPromise);
        const results = (await Promise.race(races)) as chrome.scripting.InjectionResult[];
        const injected = results?.[0]?.result as ExecuteScriptInjectionResult | undefined;
        if (!injected || typeof injected !== 'object' || !('ok' in injected)) {
          return {
            success: false,
            error: 'Script injection returned no result (empty injection result).',
            phase: 'runtime',
            world,
          };
        }
        if (injected.ok === false) {
          return {
            success: false,
            error: injected.error,
            phase: injected.phase,
            world,
            cspBlocked: Boolean(injected.cspLikely) || isCspEvalError(injected.error),
          };
        }
        return {
          success: true,
          result: injected.value ?? null,
          resultType: injected.valueType,
          world,
          serializedAs: injected.serializedAs,
          timeoutMs,
        };
      } catch (err) {
        const codeName = err && typeof err === 'object' ? String((err as { code?: unknown }).code || '') : '';
        if (codeName === 'RUN_ABORTED' || isToolContextAborted(this.currentToolContext)) {
          return abortedToolResult();
        }
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = codeName === 'SCRIPT_TIMEOUT' || /timeout/i.test(message);
        const allowScripts =
          /user scripts/i.test(message) || /userScripts/i.test(message) || /not allowed/i.test(message);
        return {
          success: false,
          error: timedOut
            ? `executeScript timed out after ${timeoutMs}ms`
            : allowScripts
              ? 'Ative “Permitir scripts do usuário” em chrome://extensions → Glide V2.'
              : message,
          code: timedOut ? 'SCRIPT_TIMEOUT' : allowScripts ? 'USER_SCRIPTS_DISABLED' : undefined,
          world,
          timedOut,
          hint: allowScripts
            ? 'A extensão precisa da permissão Allow User Scripts para executar código arbitrário.'
            : 'Use return <value>. Prefira as tools determinísticas (readPage, click, httpRequest) quando possível.',
        };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    });
  }

  /**
   * Extension-host HTTP. Bypasses page CSP/eval. Cookies for the target host
   * are included via credentials:include + host_permissions.
   */
  async httpRequest(args: Record<string, unknown>) {
    const headers = sanitizeHttpHeaders(args.headers);
    const requestUrl = String(args.url || '');
    const allowlist = await this.loadAllowedDomains();
    // Optional: pull csrftoken from the live tab when the model forgot X-CSRFToken.
    const needsCsrf =
      !Object.keys(headers).some((k) => k.toLowerCase() === 'x-csrftoken') &&
      (typeof args.tabId === 'number' || /instagram\.com/i.test(requestUrl));
    if (needsCsrf && requestUrl) {
      try {
        const resolved = await this.resolveExecutableTab(
          typeof args.tabId === 'number' ? { tabId: args.tabId } : {},
          'httpRequest',
        );
        if (resolved.ok) {
          const tabUrl = resolved.resolution.tab.url || '';
          const allowedDest =
            isUrlAllowedByDomains(requestUrl, allowlist) && tabUrl && isSameOriginUrl(requestUrl, tabUrl);
          if (allowedDest) {
            const csrf = await this.runInTab(
              resolved.resolution.tabId,
              () => {
                const m = document.cookie.match(/(?:^|; )csrftoken=([^;]*)/);
                return m ? decodeURIComponent(m[1]) : null;
              },
              [],
              4000,
              false,
              'ISOLATED',
            );
            if (typeof csrf === 'string' && csrf) {
              headers['X-CSRFToken'] = csrf;
              if (!headers['X-Requested-With']) headers['X-Requested-With'] = 'XMLHttpRequest';
            }
          }
        }
      } catch {
        // Non-fatal: caller may still succeed without CSRF on some endpoints.
      }
    }

    const result = await performHttpRequest({
      url: requestUrl,
      method: args.method != null ? String(args.method) : 'GET',
      headers,
      body: args.body != null ? String(args.body) : undefined,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      maxBodyChars: typeof args.maxBodyChars === 'number' ? args.maxBodyChars : undefined,
      allowedDomains: allowlist,
      signal: this.currentToolContext?.signal,
    });
    return result;
  }

  async getNetworkRequests(args: Record<string, unknown>) {
    const maxEntries = Math.min(
      Number.isFinite(Number(args.maxEntries)) ? Math.max(1, Math.round(Number(args.maxEntries))) : 50,
      200,
    );
    const filterUrl = args.filterUrl != null ? String(args.filterUrl) : '';
    const filterMethod = args.filterMethod != null ? String(args.filterMethod).trim().toUpperCase() : '';
    const filterStatus = Number.isFinite(Number(args.filterStatus)) ? Number(args.filterStatus) : 0;
    const shouldClear = args.clear === true;
    const shouldStop = args.stop === true;
    const installOnly = args.installOnly === true;
    // Default true: API discovery needs GraphQL/form payloads (doc_id, variables).
    const includeRequestBody = args.includeRequestBody !== false;
    const includeResponseBody = args.includeResponseBody === true;
    const maxBodyChars = Math.min(
      Number.isFinite(Number(args.maxBodyChars)) ? Math.max(200, Math.round(Number(args.maxBodyChars))) : 2500,
      16000,
    );

    return withResolvedTab(this, args, 'getNetworkRequests', async (resolution) => {
      const result = await this.runInTab(
        resolution.tabId,
        async (
          max: number,
          urlFilter: string,
          methodFilter: string,
          statusFilter: number,
          clear: boolean,
          stop: boolean,
          captureRequestBody: boolean,
          captureResponseBody: boolean,
          bodyCharLimit: number,
          installOnlyMode: boolean,
        ) => {
          const INFLIGHT_DRAIN_MS = 3000;
          const INFLIGHT_POLL_MS = 50;
          const BUFFER_KEY = '__glide_network_buffer__';
          const INSTALLED_KEY = '__glide_network_installed__';
          const ORIGINALS_KEY = '__glide_network_originals__';
          const OPTS_KEY = '__glide_network_opts__';
          const ACTIVE_KEY = '__glide_network_active__';
          const INFLIGHT_KEY = '__glide_network_inflight__';
          const HOOK_VERSION = 5;
          const MAX_BUFFER = 200;
          // Always buffer request bodies up to this limit; response only when opts say so.
          const CAPTURE_BODY_LIMIT = 16000;
          const w = window as any;

          // Live options: updated every tool call so later reads can enable response capture.
          w[OPTS_KEY] = {
            captureRequestBody: captureRequestBody,
            captureResponseBody: captureResponseBody,
            bodyCharLimit: bodyCharLimit,
          };

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
            'x-ig-request-elapsed-time-ms',
            'x-fb-request-id',
          ];

          const HINT_KEYS = [
            'doc_id',
            'query_id',
            'query_hash',
            'queryId',
            'fb_api_req_friendly_name',
            'fb_api_caller_class',
            'friendly_name',
            'variables',
            'server_timestamps',
          ];

          const extractHeaders = (headersStr: string): Record<string, string> => {
            const out: Record<string, string> = {};
            if (!headersStr) return out;
            for (const line of headersStr.split('\r\n')) {
              const idx = line.indexOf(':');
              if (idx === -1) continue;
              const name = line.slice(0, idx).trim().toLowerCase();
              if (USEFUL_HEADERS.includes(name)) {
                out[name] = line.slice(idx + 1).trim();
              }
            }
            return out;
          };

          const truncate = (text: string, limit: number): { text: string; truncated: boolean } => {
            if (text.length <= limit) return { text, truncated: false };
            return { text: text.slice(0, limit) + '…[truncated]', truncated: true };
          };

          const summarizeBody = (body: any, limit: number): string | undefined => {
            if (body == null || body === '') return undefined;
            try {
              if (typeof body === 'string') {
                return truncate(body, limit).text;
              }
              if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                return truncate(body.toString(), limit).text;
              }
              if (typeof FormData !== 'undefined' && body instanceof FormData) {
                const parts: string[] = [];
                body.forEach((value, key) => {
                  if (typeof value === 'string') {
                    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
                  } else {
                    const name = (value as File)?.name || 'blob';
                    const size = (value as Blob)?.size;
                    parts.push(`${encodeURIComponent(key)}=[File ${name}${size != null ? ` ${size}b` : ''}]`);
                  }
                });
                return truncate(parts.join('&'), limit).text;
              }
              if (typeof Blob !== 'undefined' && body instanceof Blob) {
                return `[Blob ${body.size} bytes type=${body.type || 'unknown'}]`;
              }
              if (body instanceof ArrayBuffer) {
                return `[ArrayBuffer ${body.byteLength} bytes]`;
              }
              if (ArrayBuffer.isView(body)) {
                return `[TypedArray ${body.byteLength} bytes]`;
              }
              if (typeof body === 'object') {
                return truncate(JSON.stringify(body), limit).text;
              }
              return truncate(String(body), limit).text;
            } catch {
              return '[unserializable body]';
            }
          };

          const extractApiHints = (url: string, bodyStr?: string): Record<string, string> => {
            const hints: Record<string, string> = {};
            const take = (key: string, value: unknown) => {
              if (value == null || value === '') return;
              const str = typeof value === 'string' ? value : JSON.stringify(value);
              if (!str) return;
              hints[key] = str.length > 500 ? str.slice(0, 500) + '…' : str;
            };

            try {
              const u = new URL(url, location.href);
              for (const key of HINT_KEYS) {
                const v = u.searchParams.get(key);
                if (v) take(key, v);
              }
            } catch {
              /* ignore invalid URL */
            }

            if (!bodyStr) return hints;

            // application/x-www-form-urlencoded or query-like bodies (Instagram GraphQL)
            try {
              if (
                bodyStr.includes('=') &&
                !bodyStr.trimStart().startsWith('{') &&
                !bodyStr.trimStart().startsWith('[')
              ) {
                const params = new URLSearchParams(bodyStr);
                for (const key of HINT_KEYS) {
                  const v = params.get(key);
                  if (v) take(key, v);
                }
              }
            } catch {
              /* ignore */
            }

            // JSON body
            try {
              const trimmed = bodyStr.trim();
              if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  for (const key of HINT_KEYS) {
                    if (key in parsed) take(key, (parsed as any)[key]);
                  }
                  // Nested common shapes
                  if ((parsed as any).extensions?.persistedQuery?.sha256Hash) {
                    take('query_hash', (parsed as any).extensions.persistedQuery.sha256Hash);
                  }
                  if ((parsed as any).operationName) take('operationName', (parsed as any).operationName);
                }
              }
            } catch {
              /* ignore non-JSON */
            }

            // Regex fallback for doc_id / friendly name in mixed payloads
            const patterns: Array<[string, RegExp]> = [
              ['doc_id', /(?:doc_id|docId)["'=\s:]+(\d{6,})/i],
              ['query_hash', /(?:query_hash|queryHash|sha256Hash)["'=\s:]+([a-f0-9]{16,})/i],
              ['fb_api_req_friendly_name', /fb_api_req_friendly_name["'=\s:]+([A-Za-z0-9_]+)/i],
            ];
            for (const [key, re] of patterns) {
              if (hints[key]) continue;
              const m = bodyStr.match(re);
              if (m?.[1]) take(key, m[1]);
            }

            return hints;
          };

          const getOpts = () => {
            const o = w[OPTS_KEY] || {};
            return {
              captureRequestBody: o.captureRequestBody !== false,
              captureResponseBody: o.captureResponseBody === true,
              bodyCharLimit:
                typeof o.bodyCharLimit === 'number' && o.bodyCharLimit > 0 ? o.bodyCharLimit : bodyCharLimit,
            };
          };

          const pushEntry = (entry: Record<string, unknown>) => {
            if (w[ACTIVE_KEY] !== true) return;
            const buffer = w[BUFFER_KEY] as any[];
            buffer.push(entry);
            if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
          };

          const ensureBuffer = () => {
            if (!Array.isArray(w[BUFFER_KEY])) w[BUFFER_KEY] = [];
          };

          const bumpInflight = (delta: number) => {
            const next = Math.max(0, Number(w[INFLIGHT_KEY] || 0) + delta);
            w[INFLIGHT_KEY] = next;
          };

          const drainInflightBeforeTeardown = async () => {
            const started = Date.now();
            while (Number(w[INFLIGHT_KEY] || 0) > 0 && Date.now() - started < INFLIGHT_DRAIN_MS) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, INFLIGHT_POLL_MS));
            }
          };

          const restoreHooks = () => {
            const prev = w[ORIGINALS_KEY];
            if (prev?.fetch) {
              try {
                window.fetch = prev.fetch;
              } catch {
                /* ignore */
              }
            }
            if (prev?.xhrOpen) {
              try {
                XMLHttpRequest.prototype.open = prev.xhrOpen;
              } catch {
                /* ignore */
              }
            }
            if (prev?.xhrSend) {
              try {
                XMLHttpRequest.prototype.send = prev.xhrSend;
              } catch {
                /* ignore */
              }
            }
            if (prev?.WebSocket) {
              try {
                (window as any).WebSocket = prev.WebSocket;
              } catch {
                /* ignore */
              }
            }
            delete w[INSTALLED_KEY];
            delete w[ORIGINALS_KEY];
            w[INFLIGHT_KEY] = 0;
          };

          ensureBuffer();
          w[ACTIVE_KEY] = !stop;

          if (stop) {
            await drainInflightBeforeTeardown();
            restoreHooks();
          }

          // Reinstall when hook version upgrades (restore originals if we saved them).
          if (!stop && w[INSTALLED_KEY] !== HOOK_VERSION) {
            restoreHooks();
            w[ACTIVE_KEY] = true;
            ensureBuffer();
            (w[BUFFER_KEY] as any[]).length = 0;
            w[INFLIGHT_KEY] = 0;

            const originalFetch = window.fetch.bind(window);
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            const OriginalWebSocket = window.WebSocket;
            w[ORIGINALS_KEY] = {
              fetch: originalFetch,
              xhrOpen: originalOpen,
              xhrSend: originalSend,
              WebSocket: OriginalWebSocket,
            };

            // --- Fetch interception ---
            (window as any).fetch = async (input: any, init?: any) => {
              const startTime = Date.now();
              let method = 'GET';
              let url = '';
              let requestBodySummary: string | undefined;
              const opts = getOpts();

              if (typeof input === 'string') {
                url = input;
              } else if (input instanceof Request) {
                url = input.url;
                method = input.method || 'GET';
              } else if (input instanceof URL) {
                url = input.toString();
              }
              if (init?.method) method = init.method;

              // Always buffer request body (needed for GraphQL doc_id); strip on read if disabled.
              if (init?.body != null) {
                requestBodySummary = summarizeBody(init.body, CAPTURE_BODY_LIMIT);
              }

              try {
                bumpInflight(1);
                const response = await originalFetch(input, init);
                bumpInflight(-1);
                const duration = Date.now() - startTime;
                const headers: Record<string, string> = {};
                response.headers.forEach((val: string, key: string) => {
                  if (USEFUL_HEADERS.includes(key.toLowerCase())) {
                    headers[key.toLowerCase()] = val;
                  }
                });

                const apiHints = extractApiHints(url, requestBodySummary);
                const entry: Record<string, unknown> = {
                  type: 'fetch',
                  method: method.toUpperCase(),
                  url,
                  status: response.status,
                  statusText: response.statusText,
                  headers,
                  duration,
                  timestamp: startTime,
                };
                if (requestBodySummary) {
                  entry.requestBody = requestBodySummary;
                  entry.requestBodyTruncated = requestBodySummary.endsWith('…[truncated]');
                }
                if (Object.keys(apiHints).length) entry.apiHints = apiHints;

                // Response preview only when currently enabled (avoids cloning every response).
                if (opts.captureResponseBody) {
                  try {
                    const clone = response.clone();
                    const text = await clone.text();
                    const preview = truncate(text, opts.bodyCharLimit);
                    entry.responseBodyPreview = preview.text;
                    entry.responseBodyTruncated = preview.truncated;
                  } catch {
                    entry.responseBodyPreview = '[unreadable response body]';
                  }
                }

                pushEntry(entry);
                return response;
              } catch (err) {
                bumpInflight(-1);
                const duration = Date.now() - startTime;
                const apiHints = extractApiHints(url, requestBodySummary);
                const entry: Record<string, unknown> = {
                  type: 'fetch',
                  method: method.toUpperCase(),
                  url,
                  status: 0,
                  statusText: 'NETWORK_ERROR',
                  headers: {},
                  duration,
                  error: (err as any)?.message || String(err),
                  timestamp: startTime,
                };
                if (requestBodySummary) entry.requestBody = requestBodySummary;
                if (Object.keys(apiHints).length) entry.apiHints = apiHints;
                pushEntry(entry);
                throw err;
              }
            };

            // --- XHR interception ---
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
              const requestBodySummary = summarizeBody(body, CAPTURE_BODY_LIMIT);
              const optsAtSend = getOpts();

              bumpInflight(1);
              this.addEventListener('loadend', () => {
                bumpInflight(-1);
                const duration = Date.now() - startTime;
                const headerStr = this.getAllResponseHeaders?.() || '';
                const headers = extractHeaders(headerStr);
                const apiHints = extractApiHints(url, requestBodySummary);
                const opts = getOpts();
                const entry: Record<string, unknown> = {
                  type: 'xhr',
                  method,
                  url,
                  status: this.status || 0,
                  statusText: this.statusText || '',
                  headers,
                  duration,
                  timestamp: startTime,
                };
                if (requestBodySummary) {
                  entry.requestBody = requestBodySummary;
                  entry.requestBodyTruncated = requestBodySummary.endsWith('…[truncated]');
                }
                if (Object.keys(apiHints).length) entry.apiHints = apiHints;
                if (opts.captureResponseBody || optsAtSend.captureResponseBody) {
                  try {
                    const text = String(this.responseText || '');
                    if (text) {
                      const preview = truncate(text, opts.bodyCharLimit);
                      entry.responseBodyPreview = preview.text;
                      entry.responseBodyTruncated = preview.truncated;
                    }
                  } catch {
                    entry.responseBodyPreview = '[unreadable response body]';
                  }
                }
                pushEntry(entry);
              });

              return originalSend.call(this, body);
            };

            // --- WebSocket (open + frames summary). Subclass keeps instanceof WebSocket. ---
            try {
              const WS = OriginalWebSocket;
              class GlideWebSocket extends WS {
                constructor(url: string | URL, protocols?: string | string[]) {
                  super(url as any, protocols as any);
                  const wsUrl = String(url);
                  const self = this as unknown as WebSocket;
                  pushEntry({
                    type: 'websocket',
                    method: 'WS_OPEN',
                    url: wsUrl,
                    status: 0,
                    statusText: 'OPENING',
                    headers: {},
                    duration: 0,
                    timestamp: Date.now(),
                  });
                  self.addEventListener('open', () => {
                    pushEntry({
                      type: 'websocket',
                      method: 'WS_OPENED',
                      url: wsUrl,
                      status: 101,
                      statusText: 'OPEN',
                      headers: {},
                      duration: 0,
                      timestamp: Date.now(),
                    });
                  });
                  self.addEventListener('message', (ev: MessageEvent) => {
                    let preview = '';
                    try {
                      preview =
                        typeof ev.data === 'string'
                          ? truncate(ev.data, Math.min(bodyCharLimit, 2000)).text
                          : `[${Object.prototype.toString.call(ev.data)}]`;
                    } catch {
                      preview = '[unreadable]';
                    }
                    // Keep a short preview on the entry even when response bodies are off
                    // (WS has no status/body otherwise). Full text still gated below on read.
                    pushEntry({
                      type: 'websocket',
                      method: 'WS_MESSAGE',
                      url: wsUrl,
                      status: 101,
                      statusText: 'MESSAGE',
                      headers: {},
                      duration: 0,
                      timestamp: Date.now(),
                      requestBody: preview,
                      responseBodyPreview: preview,
                    });
                  });
                  const origSend = self.send.bind(self);
                  self.send = (data: any) => {
                    const summary = summarizeBody(data, CAPTURE_BODY_LIMIT);
                    pushEntry({
                      type: 'websocket',
                      method: 'WS_SEND',
                      url: wsUrl,
                      status: 101,
                      statusText: 'SEND',
                      headers: {},
                      duration: 0,
                      timestamp: Date.now(),
                      requestBody: summary,
                    });
                    return origSend(data);
                  };
                }
              }
              (window as any).WebSocket = GlideWebSocket;
            } catch {
              /* WS hook optional — some pages freeze WebSocket */
            }

            w[INSTALLED_KEY] = HOOK_VERSION;
          }

          if (installOnlyMode) {
            return {
              success: true,
              hookInstalled: w[ACTIVE_KEY] === true && w[INSTALLED_KEY] === HOOK_VERSION,
              hookVersion: HOOK_VERSION,
              installOnly: true,
              intercepted: [],
              interceptedCount: 0,
              totalInterceptedBuffered: Array.isArray(w[BUFFER_KEY]) ? w[BUFFER_KEY].length : 0,
            };
          }

          // Read intercepted buffer
          ensureBuffer();
          const intercepted = (w[BUFFER_KEY] || []) as any[];
          let filteredIntercepted = intercepted;
          if (urlFilter) {
            filteredIntercepted = filteredIntercepted.filter((r: any) => String(r.url || '').includes(urlFilter));
          }
          if (methodFilter) {
            filteredIntercepted = filteredIntercepted.filter(
              (r: any) => String(r.method || '').toUpperCase() === methodFilter,
            );
          }
          if (statusFilter > 0) {
            filteredIntercepted = filteredIntercepted.filter((r: any) => r.status === statusFilter);
          }

          // Strip/resize bodies for this read (buffer may hold fuller capture)
          const mapEntry = (r: any) => {
            const copy = { ...r };
            if (!captureRequestBody) {
              delete copy.requestBody;
              delete copy.requestBodyTruncated;
            } else if (typeof copy.requestBody === 'string') {
              const preview = truncate(String(copy.requestBody).replace(/…\[truncated\]$/, ''), bodyCharLimit);
              copy.requestBody = preview.text;
              copy.requestBodyTruncated = preview.truncated || r.requestBodyTruncated === true;
            }
            if (!captureResponseBody) {
              delete copy.responseBodyPreview;
              delete copy.responseBodyTruncated;
            } else if (typeof copy.responseBodyPreview === 'string') {
              const preview = truncate(String(copy.responseBodyPreview).replace(/…\[truncated\]$/, ''), bodyCharLimit);
              copy.responseBodyPreview = preview.text;
              copy.responseBodyTruncated = preview.truncated || r.responseBodyTruncated === true;
            }
            return copy;
          };

          // Read resource timing (passive, always available — includes traffic before hooks)
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

          const interceptedSlice = filteredIntercepted.slice(-max).map(mapEntry);
          const autoStopped = !installOnlyMode && !stop && interceptedSlice.length > 0;

          if (clear) {
            (w[BUFFER_KEY] as any[]).length = 0;
          }
          if (autoStopped) {
            await drainInflightBeforeTeardown();
            w[ACTIVE_KEY] = false;
            restoreHooks();
          }

          const empty = interceptedSlice.length === 0;
          return {
            success: true,
            hookInstalled: !stop && !autoStopped,
            hookVersion: HOOK_VERSION,
            usageHint:
              stop || autoStopped
                ? 'Network hooks stopped after reading the buffered entries. Use another capture call to start a new window.'
                : 'Hooks capture Fetch/XHR/WebSocket after install. Pattern: install → UI action → read with filterUrl. requestBody/apiHints include GraphQL doc_id when present. For bulk APIs: then httpRequest with cookies.',
            nextAction: empty
              ? 'Buffer empty or filtered out. If this is the first call, hooks just installed — trigger the UI action, then call getNetworkRequests again with filterUrl. Or use httpRequest if you already know the endpoint.'
              : 'Use filterUrl/includeResponseBody as needed, then httpRequest for pagination outside page CSP.',
            intercepted: interceptedSlice,
            interceptedCount: interceptedSlice.length,
            totalInterceptedBuffered: intercepted.length,
            resources,
            resourceCount: resources.length,
            cleared: clear,
            options: {
              includeRequestBody: captureRequestBody,
              includeResponseBody: captureResponseBody,
              maxBodyChars: bodyCharLimit,
              filterUrl: urlFilter || null,
              filterMethod: methodFilter || null,
              filterStatus: statusFilter || null,
            },
          };
        },
        [
          maxEntries,
          filterUrl,
          filterMethod,
          filterStatus,
          shouldClear,
          shouldStop,
          includeRequestBody,
          includeResponseBody,
          maxBodyChars,
          installOnly,
        ],
        8000,
        false,
        // MAIN: o fetch/XHR reais da página vivem no mundo dela; hooks no mundo
        // isolado nunca interceptariam nada (buffer sempre vazio).
        'MAIN',
      );

      return result || { success: false, error: 'Script execution failed.' };
    });
  }

  async readPage(args: Record<string, unknown>) {
    const maxItems = Math.min(
      Number.isFinite(Number(args.maxItems)) ? Math.max(1, Math.round(Number(args.maxItems))) : 40,
      80,
    );
    const interactiveOnly = args.interactiveOnly !== false;
    const scope = String(args.scope || 'auto').toLowerCase();

    return withResolvedTab(this, args, 'readPage', async (resolution) => {
      const pageUrl = resolution.tab.url || '';
      const framePrep = await this.prepareFrameInjection(resolution.tabId, args as Record<string, any>, pageUrl);
      if (!framePrep.ok) {
        return this.attachResolutionMeta(framePrep.result, resolution);
      }
      const injOpts = framePrep.runOptions;
      const frameMeta = framePrep.frameMeta;

      const result = await this.runInTab(
        resolution.tabId,
        (max: number, interactive: boolean, searchScope: string) => {
          function buildLocalSelector(element: Element) {
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
            const cls = Array.from(el.classList || []).find(
              (c) => /^[a-z][a-z0-9_-]{2,40}$/i.test(c) && !/[0-9]{5,}/.test(c),
            );
            if (cls) return `.${cls}`;
            const parent = el.parentElement;
            if (parent) {
              const tag = el.tagName.toLowerCase();
              const siblings = Array.from(parent.children).filter((c) => c.tagName.toLowerCase() === tag);
              return `${tag}:nth-of-type(${siblings.indexOf(el) + 1})`;
            }
            return el.tagName.toLowerCase();
          }
          function buildOptimalSelector(element: Element): string {
            const local = buildLocalSelector(element);
            const root = element.getRootNode();
            if (root instanceof ShadowRoot) {
              return `${buildOptimalSelector(root.host)} >>> ${local}`;
            }
            return local;
          }
          const normalize = (v: string) =>
            String(v || '')
              .replace(/\s+/g, ' ')
              .trim();
          const isVisible = (element: HTMLElement) => {
            if (!element || element.hidden) return false;
            if ((element as HTMLInputElement).type === 'hidden') return false;
            if (element.getAttribute('aria-hidden') === 'true') return false;
            const checkVisibility = (
              element as HTMLElement & {
                checkVisibility?: (options?: {
                  checkOpacity?: boolean;
                  checkVisibilityCSS?: boolean;
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
          const nameOf = (el: HTMLElement) => {
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

          const DIALOG_SEL = '[role="dialog"], [aria-modal="true"], div[role="dialog"]';
          const INTERACTIVE =
            'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [contenteditable="true"], [tabindex="0"]';
          const LANDMARKS = 'main, nav, header, footer, h1, h2, h3, [role="navigation"], [role="main"]';

          let root: Document | Element = document;
          const dialogs = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SEL)).filter(isVisible);
          if (searchScope === 'dialog' || (searchScope === 'auto' && dialogs.length)) {
            root = dialogs[dialogs.length - 1] || document;
          }

          const collected: HTMLElement[] = [];
          let shadowScanned = 0;
          const walkShadowHosts = (
            base: Document | ShadowRoot | Element,
            visitShadow: (shadow: ShadowRoot) => void,
          ) => {
            const walker = document.createTreeWalker(base, NodeFilter.SHOW_ELEMENT);
            let current = walker.nextNode() as HTMLElement | null;
            while (current && shadowScanned < 4000) {
              shadowScanned += 1;
              if (current.shadowRoot) visitShadow(current.shadowRoot);
              current = walker.nextNode() as HTMLElement | null;
            }
          };
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
            walkShadowHosts(base, visit);
          };
          visit(root);

          const seen = new Set<HTMLElement>();
          const elements: Array<Record<string, unknown>> = [];
          let idx = 0;
          for (const el of collected) {
            if (seen.has(el) || !isVisible(el)) continue;
            seen.add(el);
            idx += 1;
            const rect = el.getBoundingClientRect();
            elements.push({
              ref: `e${idx}`,
              role: roleOf(el),
              name: nameOf(el),
              tag: el.tagName.toLowerCase(),
              selector: buildOptimalSelector(el),
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
        },
        [maxItems, interactiveOnly, scope],
        8000,
        injOpts,
      );
      const baseResult = result || { success: false, error: 'Script execution failed.' };
      return this.attachResolutionMeta(this.attachFrameMeta(baseResult, frameMeta), resolution);
    });
  }

  async clipboard(args: Record<string, unknown>) {
    const action = String(args.action || '')
      .toLowerCase()
      .trim();
    const text = args.text != null ? String(args.text) : '';

    return withResolvedTab(this, args, 'clipboard', async (resolution) => {
      const result = await this.runInTab(
        resolution.tabId,
        async (act: string, value: string) => {
          if (act === 'write') {
            try {
              if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
                return { success: true, action: 'write', length: value.length };
              }
            } catch {
              /* fall through */
            }
            try {
              const ta = document.createElement('textarea');
              ta.value = value;
              ta.style.cssText = 'position:fixed;left:-9999px;top:0';
              document.body.appendChild(ta);
              ta.focus();
              ta.select();
              const ok = document.execCommand('copy');
              ta.remove();
              return ok
                ? { success: true, action: 'write', length: value.length, via: 'execCommand' }
                : { success: false, error: 'Clipboard write blocked by the page.' };
            } catch (error) {
              return { success: false, error: (error as Error)?.message || String(error) };
            }
          }
          try {
            if (navigator.clipboard?.readText) {
              const clip = await navigator.clipboard.readText();
              return { success: true, action: 'read', text: clip, length: clip.length };
            }
            return { success: false, error: 'Clipboard read API unavailable in this page.' };
          } catch (error) {
            return {
              success: false,
              error: (error as Error)?.message || String(error),
              hint: 'Page denied clipboard read. Ask the user to grant permission or paste manually.',
            };
          }
        },
        [action, text],
      );
      return result || { success: false, error: 'Script execution failed.' };
    });
  }

  async setInputFiles(args: Record<string, unknown>) {
    const selector = String(args.selector || '').trim();
    const filesResult = normalizeSetInputFileSpecs(args.files);

    if (!Array.isArray(filesResult)) {
      return { success: false, code: 'INVALID_ARGS', error: filesResult.error };
    }
    const files = filesResult;

    if (!files.length) {
      return {
        success: false,
        error: 'files must be a non-empty array of { name, content?, contentBase64?, mimeType? }.',
      };
    }

    return withResolvedTab(this, args, 'setInputFiles', async (resolution) => {
      const result = await this.runInTab(
        resolution.tabId,
        (sel: string, fileSpecs: SetInputFileSpec[]) => {
          const deepQuery = (query: string): HTMLInputElement | null => {
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
              if (i === parts.length - 1) return next as HTMLInputElement;
              if (!(next as HTMLElement).shadowRoot) return null;
              root = (next as HTMLElement).shadowRoot!;
            }
            return null;
          };
          const input = deepQuery(sel);
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
              names: fileSpecs.map((f) => f.name),
            };
          } catch (error) {
            return { success: false, error: (error as Error)?.message || String(error) };
          }
        },
        [selector, files],
      );
      return result || { success: false, error: 'Script execution failed.' };
    });
  }

  async selectOption(args: Record<string, unknown>) {
    const resolved = await this.resolveExecutableTab(args, 'selectOption');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const selector = String(args.selector || '');
    const payload: Record<string, unknown> = { selector };
    if (args.value !== undefined) payload.value = String(args.value);
    if (args.label !== undefined) payload.label = String(args.label);
    if (args.index !== undefined) payload.index = args.index;
    const pageUrl = resolution.tab.url || '';
    const framePrep = await this.prepareFrameInjection(tabId, args as Record<string, any>, pageUrl);
    if (!framePrep.ok) {
      return this.attachResolutionMeta(framePrep.result, resolution);
    }
    const injOpts = framePrep.runOptions;
    const frameMeta = framePrep.frameMeta;

    if (!this.hasFrameTarget(args as Record<string, any>)) {
      const bridged = await this.tryBridge(tabId, 'selectOption', payload);
      if (bridged) {
        return this.attachResolutionMeta(bridged, resolution);
      }
    }

    const selectOptionScript = async (sel: string, value?: string, label?: string, index?: number) => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalizeOpt = (v: string) =>
        String(v || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
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
          const next = root.querySelector(parts[i]);
          if (!next) return null;
          if (i === parts.length - 1) return next as HTMLElement;
          const shadow = (next as HTMLElement).shadowRoot;
          if (!shadow) return null;
          root = shadow;
        }
        return null;
      };
      const isVisible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const criteriaCount = [value !== undefined, label !== undefined, index !== undefined].filter(Boolean).length;
      if (criteriaCount !== 1) {
        return { success: false, code: 'INVALID_ARGS', error: 'Provide exactly one of value, label, or index.' };
      }
      const element = deepQuery(sel);
      if (!element || !isVisible(element)) {
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
          const want = normalizeOpt(label);
          option = options.find((opt) => normalizeOpt(opt.textContent || opt.label) === want) || null;
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
        ).filter(isVisible);
      const listboxAlreadyOpen =
        trigger.getAttribute('aria-expanded') === 'true' ||
        listCustomOptions().length > 0 ||
        Boolean(
          document.querySelector('[role="listbox"]:not([hidden])') &&
            Array.from(document.querySelectorAll('[role="option"]')).some((el) => isVisible(el as HTMLElement)),
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
          const want = normalizeOpt(label);
          customOption =
            options.find((opt) => {
              const text = normalizeOpt(opt.textContent || '');
              const aria = normalizeOpt(opt.getAttribute('aria-label') || '');
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
    };

    let result = await this.runInTab(
      tabId,
      selectOptionScript,
      [
        selector,
        args.value !== undefined ? String(args.value) : undefined,
        args.label !== undefined ? String(args.label) : undefined,
        args.index !== undefined ? Number(args.index) : undefined,
      ],
      10000,
      injOpts,
    );
    if (!injOpts && result?.success === false && result?.code === 'ELEMENT_NOT_FOUND' && selector.trim()) {
      const frameId = await this.findFrameWithSelector(tabId, selector);
      if (frameId != null) {
        result = await this.runInTab(
          tabId,
          selectOptionScript,
          [
            selector,
            args.value !== undefined ? String(args.value) : undefined,
            args.label !== undefined ? String(args.label) : undefined,
            args.index !== undefined ? Number(args.index) : undefined,
          ],
          10000,
          { frameId },
        );
      }
    }
    const baseResult = result || { success: false, error: 'Script execution failed.' };
    return this.attachResolutionMeta(this.attachFrameMeta(baseResult, frameMeta), resolution);
  }

  async fillForm(args: Record<string, unknown>) {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    const tabIdArg = typeof args.tabId === 'number' ? args.tabId : undefined;
    const results: Array<{ selector: string; ok: boolean; error?: string }> = [];

    for (const rawField of fields) {
      const field = rawField as Record<string, unknown>;
      const selector = String(field.selector || '');
      let fieldResult: Record<string, unknown> = { success: false };

      if (field.text !== undefined) {
        fieldResult = await this.type({ selector, text: String(field.text), tabId: tabIdArg });
      } else if (field.checked !== undefined) {
        fieldResult = await this.runCheckedField(tabIdArg, selector, Boolean(field.checked));
      } else if (field.option !== undefined) {
        const opt = field.option as Record<string, unknown>;
        fieldResult = await this.selectOption({
          selector,
          tabId: tabIdArg,
          ...(opt.value !== undefined ? { value: String(opt.value) } : {}),
          ...(opt.label !== undefined ? { label: String(opt.label) } : {}),
          ...(opt.index !== undefined ? { index: Number(opt.index) } : {}),
        });
      }

      results.push({
        selector,
        ok: fieldResult.success === true,
        ...(fieldResult.error ? { error: String(fieldResult.error) } : {}),
      });
    }

    let submitAttempted = false;
    let submitOk = true;
    if (args.submitSelector && results.every((entry) => entry.ok)) {
      submitAttempted = true;
      const submitResult = await this.click({
        selector: String(args.submitSelector),
        tabId: tabIdArg,
      });
      submitOk = submitResult?.success === true;
    }

    return {
      success: results.every((entry) => entry.ok) && submitOk,
      results,
      ...(args.submitSelector ? { submitted: submitAttempted && submitOk } : {}),
    };
  }

  private async runCheckedField(tabId: number | undefined, selector: string, wantChecked: boolean) {
    const resolved = await this.resolveExecutableTab({ selector, tabId }, 'click');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const result = await this.runInTab(
      resolution.tabId,
      (sel: string, checked: boolean) => {
        const deepQuery = (query: string): HTMLElement | null => {
          try {
            return document.querySelector(query);
          } catch {
            return null;
          }
        };
        const element = deepQuery(sel);
        if (!element) {
          return { success: false, code: 'ELEMENT_NOT_FOUND', error: `Checkbox not found: ${sel}` };
        }
        const isInput = element instanceof HTMLInputElement;
        const inputType = isInput ? String(element.type || '').toLowerCase() : '';
        const isCheckable =
          (isInput && (inputType === 'checkbox' || inputType === 'radio')) ||
          element.getAttribute('role') === 'checkbox' ||
          element.getAttribute('role') === 'switch' ||
          element.getAttribute('role') === 'radio';
        if (!isCheckable) {
          return { success: false, error: 'Target is not a checkbox or radio.' };
        }
        const isRadio = (isInput && inputType === 'radio') || element.getAttribute('role') === 'radio';
        if (isRadio && !checked) {
          return {
            success: false,
            code: 'RADIO_UNCHECK_UNSUPPORTED',
            error: 'Cannot uncheck a radio without selecting another option in the group.',
          };
        }
        const current = isInput
          ? element.checked
          : element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-pressed') === 'true';
        if (current !== checked) {
          element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        return { success: true, checked };
      },
      [selector, wantChecked],
      8000,
      true,
    );
    return this.attachResolutionMeta(result || { success: false, error: 'Script execution failed.' }, resolution);
  }

  async navigateHistory(args: Record<string, unknown>) {
    return withResolvedTab(this, args, 'navigateHistory', async (resolution) => {
      const tabId = resolution.tabId;
      const actionRaw = String(args.action || '').toLowerCase();
      const action = actionRaw === 'back' || actionRaw === 'forward' || actionRaw === 'reload' ? actionRaw : 'reload';

      const preTab = await this.safeGetTab(tabId);
      const preUrl = String(preTab?.url || '');

      const runInjectedHistory = async () => {
        await this.runInTab(
          tabId,
          (act: string) => {
            if (act === 'back') window.history.back();
            else if (act === 'forward') window.history.forward();
            else window.location.reload();
            return { success: true, strategy: 'injected' };
          },
          [action],
        );
      };

      try {
        if (action === 'back' && chrome.tabs.goBack) {
          await chrome.tabs.goBack(tabId);
        } else if (action === 'forward' && chrome.tabs.goForward) {
          await chrome.tabs.goForward(tabId);
        } else if (action === 'reload') {
          await chrome.tabs.reload(tabId);
        } else {
          await runInjectedHistory();
        }
      } catch {
        await runInjectedHistory();
      }

      const transition = await waitForHistoryTransition(tabId, preUrl, action);
      if (!transition.moved && action !== 'reload') {
        return {
          success: false,
          code: 'NO_HISTORY',
          action,
          previousUrl: preUrl,
          url: transition.url,
          error: `No ${action} history entry — URL unchanged (${preUrl}).`,
        };
      }

      const readiness = await waitForTabReadiness(tabId);
      const currentTab = await this.safeGetTab(tabId);
      const finalUrl = String(readiness.url || currentTab?.url || transition.url);
      return { success: true, action, previousUrl: preUrl, ...readiness, url: finalUrl };
    });
  }

  async highlightElement(args: Record<string, unknown>) {
    const resolved = await this.resolveExecutableTab(args, 'highlightElement');
    if (!resolved.ok) return resolved.result;
    const { resolution } = resolved;
    const tabId = resolution.tabId;
    const selector = args.selector ? String(args.selector) : '';
    const ref = args.ref ? String(args.ref) : '';
    const durationMs =
      args.durationMs !== undefined && Number.isFinite(Number(args.durationMs)) ? Number(args.durationMs) : 1200;
    const pageUrl = resolution.tab.url || '';
    const framePrep = await this.prepareFrameInjection(tabId, args as Record<string, any>, pageUrl);
    if (!framePrep.ok) {
      return this.attachResolutionMeta(framePrep.result, resolution);
    }
    const injOpts = framePrep.runOptions;
    const frameMeta = framePrep.frameMeta;

    if (!this.hasFrameTarget(args as Record<string, any>)) {
      const bridged = await this.tryBridge(tabId, 'highlightElement', {
        selector: selector || undefined,
        ref: ref || undefined,
        durationMs,
      });
      if (bridged) {
        return this.attachResolutionMeta(bridged, resolution);
      }
    }

    const scope = String(args.scope || 'auto').toLowerCase();
    const interactiveOnly = args.interactiveOnly !== false;
    let highlightOpts = injOpts;
    if (!highlightOpts && selector.trim()) {
      const frameId = await this.findFrameWithSelector(tabId, selector);
      if (frameId != null) highlightOpts = { frameId };
    }

    const result = await this.runInTab(
      tabId,
      highlightTargetOverlay,
      [selector, ref, durationMs, scope, interactiveOnly],
      8000,
      highlightOpts,
    );
    return this.attachResolutionMeta(
      this.attachFrameMeta(result || { success: false, error: 'Script execution failed.' }, frameMeta),
      resolution,
    );
  }

  async captureDownload(args: Record<string, unknown>) {
    return withResolvedTab(this, args, 'captureDownload', async (resolution) => {
      const tabId = resolution.tabId;
      const urlPattern = args.urlPattern != null ? String(args.urlPattern) : '';
      const filenamePattern = args.filename != null ? String(args.filename) : '';
      const timeoutMs =
        args.timeoutMs !== undefined && Number.isFinite(Number(args.timeoutMs))
          ? clampInt(Number(args.timeoutMs), 1000, 120000)
          : 30000;
      const directUrl = args.url != null ? String(args.url) : '';
      const trigger =
        args.trigger && typeof args.trigger === 'object' && !Array.isArray(args.trigger)
          ? (args.trigger as Record<string, unknown>)
          : null;
      const triggerSelector = trigger?.selector ? String(trigger.selector).trim() : '';

      if (typeof chrome.downloads?.onCreated?.addListener !== 'function') {
        return {
          success: false,
          error: 'chrome.downloads API is unavailable. Ensure the extension has the "downloads" permission.',
        };
      }

      const armTime = Date.now();
      const expectedTabId = tabId;

      const matchesDownload = (item: chrome.downloads.DownloadItem) => {
        if (Date.parse(String(item.startTime || '')) < armTime) return false;
        if (
          typeof (item as { tabId?: number }).tabId === 'number' &&
          (item as { tabId?: number }).tabId !== expectedTabId
        ) {
          return false;
        }
        if (urlPattern && !String(item.url || '').includes(urlPattern)) return false;
        if (filenamePattern && !String(item.filename || '').includes(filenamePattern)) return false;
        return true;
      };

      const buildDownloadResult = async (downloadId: number) => {
        const items = await chrome.downloads.search({ id: downloadId });
        const item = items[0];
        if (!item) {
          return { success: false, error: `Download ${downloadId} not found.` };
        }
        return {
          success: true,
          id: item.id,
          url: item.url,
          filename: item.filename,
          mime: item.mime || '',
          fileSize: item.fileSize,
          state: item.state,
        };
      };

      return new Promise<Record<string, unknown>>((resolve) => {
        let settled = false;
        let trackedId: number | null = null;
        let expectedDownloadId: number | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        const finish = (result: Record<string, unknown>) => {
          if (settled) return;
          settled = true;
          chrome.downloads.onCreated.removeListener(onCreated);
          chrome.downloads.onChanged.removeListener(onChanged);
          if (timeoutId) clearTimeout(timeoutId);
          resolve(this.attachResolutionMeta(result, resolution));
        };

        const onCreated = (item: chrome.downloads.DownloadItem) => {
          if (settled || trackedId !== null) return;
          if (expectedDownloadId !== null && item.id !== expectedDownloadId) return;
          if (!matchesDownload(item)) return;
          trackedId = item.id;
          if (item.state === 'complete') {
            void buildDownloadResult(item.id).then((result) => finish(result));
          }
        };

        const onChanged = (delta: chrome.downloads.DownloadDelta) => {
          if (trackedId === null || delta.id !== trackedId) return;
          const nextState = delta.state?.current;
          if (nextState === 'complete') {
            void buildDownloadResult(trackedId).then((result) => finish(result));
          } else if (nextState === 'interrupted') {
            finish({
              success: false,
              error: delta.error?.current || 'Download interrupted.',
              id: trackedId,
              state: 'interrupted',
            });
          }
        };

        chrome.downloads.onCreated.addListener(onCreated);
        chrome.downloads.onChanged.addListener(onChanged);

        timeoutId = setTimeout(() => {
          finish({
            success: false,
            code: 'DOWNLOAD_TIMEOUT',
            error: `No matching download within ${timeoutMs}ms.`,
            timeoutMs,
          });
        }, timeoutMs);

        void (async () => {
          try {
            if (directUrl) {
              expectedDownloadId = await chrome.downloads.download({ url: directUrl, saveAs: false });
              trackedId = expectedDownloadId;
              return;
            }
            if (triggerSelector) {
              const clickResult = await this.click({
                selector: triggerSelector,
                tabId,
                waitForDialog: false,
              });
              if (clickResult?.success === false) {
                finish({
                  success: false,
                  error: String(clickResult.error || 'Trigger click failed.'),
                  code: clickResult.code || 'TRIGGER_FAILED',
                });
              }
            }
          } catch (error) {
            finish({
              success: false,
              error: String((error as Error)?.message || error || 'Download setup failed.'),
            });
          }
        })();
      });
    });
  }

  async findInPage(args: Record<string, unknown>) {
    const query = String(args.query || '').trim();
    const caseSensitive = args.caseSensitive === true;
    const maxMatches =
      args.maxMatches !== undefined && Number.isFinite(Number(args.maxMatches))
        ? clampInt(Number(args.maxMatches), 1, 100)
        : 20;
    const scrollToFirst = args.scrollToFirst !== false;

    return withResolvedTab(this, args, 'findInPage', async (resolution) => {
      const findScript = (searchQuery: string, sensitive: boolean, max: number, scrollFirst: boolean) => {
        const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
        const CONTEXT_RADIUS = 30;
        const needle = sensitive ? searchQuery : searchQuery.toLowerCase();

        const isVisibleNode = (el: Element | null) => {
          if (!el || !(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };

        const buildContext = (text: string, index: number) => {
          const start = Math.max(0, index - CONTEXT_RADIUS);
          const end = Math.min(text.length, index + needle.length + CONTEXT_RADIUS);
          return text.slice(start, end).replace(/\s+/g, ' ').trim();
        };

        const matches: Array<{ context: string; index: number }> = [];
        let totalMatches = 0;
        let scrolled = false;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
            if (!isVisibleNode(parent)) return NodeFilter.FILTER_REJECT;
            const raw = node.textContent || '';
            if (!raw.trim()) return NodeFilter.FILTER_REJECT;
            const hay = sensitive ? raw : raw.toLowerCase();
            return hay.includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          },
        });

        let node: Node | null = walker.nextNode();
        while (node) {
          const text = node.textContent || '';
          const hay = sensitive ? text : text.toLowerCase();
          let from = 0;
          while (from < hay.length) {
            const idx = hay.indexOf(needle, from);
            if (idx === -1) break;
            if (matches.length < max) {
              matches.push({ context: buildContext(text, idx), index: totalMatches });
            }
            if (scrollFirst && !scrolled && node.parentElement) {
              node.parentElement.scrollIntoView({ block: 'center', inline: 'nearest' });
              scrolled = true;
            }
            totalMatches += 1;
            from = idx + Math.max(1, needle.length);
          }
          node = walker.nextNode();
        }

        const legacyFind = (window as unknown as { find?: (...args: unknown[]) => boolean }).find;
        if (totalMatches === 0 && typeof legacyFind === 'function') {
          const selection = window.getSelection();
          const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
          window.getSelection()?.removeAllRanges();
          let findIndex = 0;
          while (legacyFind(searchQuery, sensitive, false, true, false, true, false)) {
            if (matches.length < max) {
              const active = window.getSelection()?.toString() || searchQuery;
              matches.push({
                context: active.slice(0, 120).replace(/\s+/g, ' ').trim() || searchQuery,
                index: findIndex,
              });
            }
            if (scrollFirst && findIndex === 0) {
              const anchor = window.getSelection()?.anchorNode?.parentElement;
              anchor?.scrollIntoView({ block: 'center', inline: 'nearest' });
            }
            findIndex += 1;
            totalMatches += 1;
          }
          window.getSelection()?.removeAllRanges();
          if (savedRange) {
            window.getSelection()?.addRange(savedRange);
          }
        }

        return {
          success: true,
          totalMatches,
          matches,
          truncated: totalMatches > max,
        };
      };

      const result = await this.runInTab(
        resolution.tabId,
        findScript,
        [query, caseSensitive, maxMatches, scrollToFirst],
        12000,
        true,
      );
      return this.attachResolutionMeta(result || { success: false, error: 'findInPage failed.' }, resolution);
    });
  }

  async extractTable(args: Record<string, unknown>) {
    const selector = args.selector != null ? String(args.selector) : '';
    const maxRows =
      args.maxRows !== undefined && Number.isFinite(Number(args.maxRows))
        ? clampInt(Number(args.maxRows), 1, 1000)
        : 100;
    const includeHeaders = args.includeHeaders !== false;

    return withResolvedTab(this, args, 'extractTable', async (resolution) => {
      const extractScript = (sel: string, max: number, withHeaders: boolean) => {
        const normalizeCell = (cell: Element) => (cell.textContent || '').replace(/\s+/g, ' ').trim();
        const isRowVisible = (row: HTMLTableRowElement) => {
          const style = window.getComputedStyle(row);
          return style.display !== 'none' && row.offsetParent !== null;
        };
        const expandRowCells = (row: HTMLTableRowElement) => {
          const expanded: string[] = [];
          for (const cell of Array.from(row.querySelectorAll('th, td'))) {
            const text = normalizeCell(cell);
            const colspan = Math.max(1, Number.parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
            for (let i = 0; i < colspan; i += 1) {
              expanded.push(text);
            }
          }
          return expanded;
        };

        let table: HTMLTableElement | null = null;
        let selectedVisibleRows: HTMLTableRowElement[] | null = null;
        if (sel) {
          try {
            table = document.querySelector(sel);
          } catch {
            table = null;
          }
        } else {
          const tables = Array.from(document.querySelectorAll('table'));
          let largestRowCount = 0;
          for (const candidate of tables) {
            const candidateRows = Array.from(candidate.querySelectorAll('tr')).filter((row) =>
              isRowVisible(row as HTMLTableRowElement),
            ) as HTMLTableRowElement[];
            if (candidateRows.length > largestRowCount) {
              table = candidate;
              selectedVisibleRows = candidateRows;
              largestRowCount = candidateRows.length;
            }
          }
        }

        if (!table) {
          return { success: false, error: sel ? `Table not found for selector "${sel}".` : 'No table found on page.' };
        }

        const caption = table.querySelector('caption')?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
        const visibleRows =
          selectedVisibleRows ??
          (Array.from(table.querySelectorAll('tr')).filter((row) =>
            isRowVisible(row as HTMLTableRowElement),
          ) as HTMLTableRowElement[]);

        let headers: string[] = [];
        let dataRows = visibleRows;
        if (withHeaders) {
          const headerRow = visibleRows.find((row) => row.querySelector('th')) || visibleRows[0];
          if (headerRow) {
            headers = expandRowCells(headerRow);
            dataRows = visibleRows.slice(visibleRows.indexOf(headerRow) + 1);
          }
        }

        const rows: string[][] = [];
        let colCount = headers.length;
        for (const row of dataRows.slice(0, max)) {
          const cells = expandRowCells(row);
          colCount = Math.max(colCount, cells.length);
          rows.push(cells);
        }
        for (const row of rows) {
          while (row.length < colCount) row.push('');
        }
        if (headers.length > 0 && headers.length < colCount) {
          while (headers.length < colCount) headers.push('');
        }

        return {
          success: true,
          headers,
          rows,
          rowCount: rows.length,
          colCount,
          caption,
        };
      };

      const result = await this.runInTab(
        resolution.tabId,
        extractScript,
        [selector, maxRows, includeHeaders],
        12000,
        true,
      );
      return this.attachResolutionMeta(result || { success: false, error: 'extractTable failed.' }, resolution);
    });
  }

  async harvestScroll(args: Record<string, unknown>) {
    const itemSelector = String(args.itemSelector || '').trim();
    const scrollSelector = args.scrollSelector != null ? String(args.scrollSelector) : '';
    const maxItems =
      args.maxItems !== undefined && Number.isFinite(Number(args.maxItems))
        ? clampInt(Number(args.maxItems), 1, 1000)
        : 100;
    const stableRounds =
      args.stableRounds !== undefined && Number.isFinite(Number(args.stableRounds))
        ? clampInt(Number(args.stableRounds), 1, 5)
        : 2;

    return withResolvedTab(this, args, 'harvestScroll', async (resolution) => {
      const harvestScript = async (itemsSel: string, scrollSel: string, max: number, stableTarget: number) => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const MAX_ROUNDS = 20;
        const WAIT_MS = 800;

        const getScrollContainer = (): Element | null => {
          if (scrollSel) {
            try {
              return document.querySelector(scrollSel);
            } catch {
              return null;
            }
          }
          return document.scrollingElement || document.documentElement;
        };

        const collectKeys = () => {
          const keys = new Map<string, string>();
          let elements: Element[] = [];
          try {
            elements = Array.from(document.querySelectorAll(itemsSel));
          } catch {
            return keys;
          }
          for (const el of elements) {
            const key = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!key || keys.has(key)) continue;
            keys.set(key, key.slice(0, 200));
          }
          return keys;
        };

        const items = collectKeys();
        let stable = 0;
        let rounds = 0;
        let stoppedReason: 'maxItems' | 'stableRounds' | 'roundCap' = 'roundCap';

        while (rounds < MAX_ROUNDS && items.size < max && stable < stableTarget) {
          const before = items.size;
          const container = getScrollContainer();
          if (!container) {
            stoppedReason = 'stableRounds';
            break;
          }
          if (container === document.scrollingElement || container === document.documentElement) {
            window.scrollBy({ top: window.innerHeight, behavior: 'instant' });
          } else {
            (container as HTMLElement).scrollTop += (container as HTMLElement).clientHeight;
            container.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
          await sleep(WAIT_MS);
          rounds += 1;
          for (const [key, value] of collectKeys()) {
            if (!items.has(key)) items.set(key, value);
            if (items.size >= max) break;
          }
          if (items.size >= max) {
            stoppedReason = 'maxItems';
            break;
          }
          if (items.size === before) stable += 1;
          else stable = 0;
        }

        if (items.size >= max) stoppedReason = 'maxItems';
        else if (stable >= stableTarget) stoppedReason = 'stableRounds';
        else if (rounds >= MAX_ROUNDS) stoppedReason = 'roundCap';

        return {
          success: true,
          items: Array.from(items.values()),
          count: items.size,
          rounds,
          stoppedReason,
        };
      };

      const scriptTimeoutMs = Math.min(120000, Math.max(25000, stableRounds * 20 * 900));
      const result = await this.runInTab(
        resolution.tabId,
        harvestScript,
        [itemSelector, scrollSelector, maxItems, stableRounds],
        scriptTimeoutMs,
        true,
      );
      return this.attachResolutionMeta(result || { success: false, error: 'harvestScroll failed.' }, resolution);
    });
  }

  async cdp(args: Record<string, unknown>) {
    return withResolvedTab(this, args, 'cdp', async (resolution) => {
      const action = String(args.action || 'send');
      const method = args.method != null ? String(args.method) : undefined;
      const params =
        args.params && typeof args.params === 'object' && !Array.isArray(args.params)
          ? (args.params as Record<string, unknown>)
          : undefined;
      return cdpCommand(resolution.tabId, action, method, params);
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
        8000,
        false,
        // MAIN: o console e os erros não tratados da página acontecem no mundo
        // dela; um hook no mundo isolado devolveria buffer sempre vazio.
        'MAIN',
      );

      return result || { success: false, error: 'Script execution failed.' };
    });
  }
}
