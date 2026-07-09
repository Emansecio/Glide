import { generateText, stepCountIs, streamText } from 'ai';
import { withAbortTimeout } from './ai/abort-timeout.js';
import { resolveProviderOptions, resolveTemperature } from './ai/anthropic-options.js';
import { ensureFreshAnthropicToken } from './ai/anthropic-oauth.js';
import { runCodexOAuthFlow } from './ai/codex-oauth.js';
import { compactValue } from './ai/compact-value.js';
import {
  DEFAULT_COMPACTION_SETTINGS,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  applyCompaction,
  buildCompactionSummaryMessage,
  buildTruncateOnlySummary,
  estimateContextTokens,
  findCutPoint,
  forceCompactionCut,
  serializeConversation,
  shouldCompact,
} from './ai/compaction.js';
import { STREAMLINED_AUTOMATION_PROMPT, isDefaultAutomationPrompt } from './ai/default-prompt.js';
import { resolveDirectBrowserAction } from './ai/direct-browser-command.js';
import { normalizeConversationHistory } from './ai/message-schema.js';
import type { Message } from './ai/message-schema.js';
import { toModelMessages } from './ai/model-convert.js';
import {
  createExponentialBackoff,
  extractProviderErrorStatus,
  isRetryableProviderError,
  isValidFinalResponse,
} from './ai/retry-engine.js';
import { getCachedLanguageModel, getCachedToolSet } from './ai/runtime-cache.js';
import { describeImageWithModel, migrateStoredProvider } from './ai/sdk-client.js';
import { detectTaskIntent } from './ai/task-intent.js';
import { extractRecoverableToolCalls, stripRecoverableToolCalls } from './ai/tool-call-recovery.js';
import { buildToolTurnMessages } from './ai/tool-history.js';
import { DomCacheLru } from './background/dom-cache.js';
import { fetchProviderModels } from './background/provider-fetch.js';
import { installProviderNetRequestRules } from './background/provider-net-rules.js';
import { RunPassCache } from './background/run-pass-cache.js';
import { PARENT_ONLY_TOOLS, type RunScope, isSubagentScope } from './background/run-scope.js';
import { RuntimeBatcher, type RuntimeDeltaPayload, isStreamDeltaPayload } from './background/runtime-batcher.js';
import { pruneScreenshotStore, storeScreenshotDataUrl } from './background/screenshot-store.js';
import { buildSessionTools } from './background/session-tools.js';
import { bindRuntimeSettingsCacheInvalidation, loadCachedRuntimeSettings } from './background/settings-cache.js';
import {
  isToolCategoryAllowed,
  getToolPermissionCategory as resolveToolPermissionCategory,
} from './background/tool-permissions.js';
import { VisionQueue, isVisionBridgeEnabled, isVisionBridgeSync } from './background/vision-queue.js';
import { BrowserTools } from './tools/browser-tools.js';
import { clampIntUnknown, isHttpUrl } from './tools/validation.js';
import { buildRunPlan } from './types/plan.js';
import type { RunPlan } from './types/plan.js';
import { RUNTIME_MESSAGE_SCHEMA_VERSION, isRuntimeMessage, validateRuntimeMessage } from './types/runtime-messages.js';

type RunMeta = {
  runId: string;
  turnId: string;
  sessionId: string;
};

type ExecutionEvent = {
  id: string;
  runId: string;
  turnId: string;
  sessionId: string;
  toolName: string;
  callId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  tabId: number | null;
  url: string;
  success: boolean;
  errorCode: string;
  errorMessage: string;
  resultPreview: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MIN_REQUEST_TIMEOUT_MS = 1000;
const MAX_REQUEST_TIMEOUT_MS = 90000;
const DEFAULT_MODEL_MAX_TOKENS = 8192;
const MIN_MODEL_MAX_TOKENS = 256;
const MAX_MODEL_MAX_TOKENS = 32000;
const DEFAULT_CONTEXT_LIMIT = 200000;
const MIN_CONTEXT_LIMIT = 16000;
const MAX_CONTEXT_LIMIT = 1000000;
const EXECUTION_EVENTS_KEY = 'executionEvents';
const MAX_EXECUTION_EVENTS = 200;
const EXECUTION_PREVIEW_LIMIT = 500;
const EXECUTION_TEXT_LIMIT = 500;
const BROWSER_ACTION_TOOLS = ['navigate', 'click', 'type', 'scroll', 'pressKey'] as const;
const DEDICATED_RUN_TAB_URL = 'https://example.com';

const ACTIVE_RUN_TIMEOUT_MS = 120000; // watchdog window: reset only after this long with zero run activity
const VISION_DESCRIBE_TIMEOUT_MS = 30000;
/** Cap concurrent subagent model loops (spawn queue holds the rest, max 10 total). */
const MAX_CONCURRENT_SUBAGENTS = 3;
const MAX_SUBAGENTS_PER_RUN = 10;
const SUBAGENT_MAX_MODEL_STEPS = 12;
const ORCHESTRATION_RETRY_NORMALIZE = { addIds: false, addTimestamps: false } as const;
/** Tools that mutate the page or tab set — invalidate DOM cache after them. */
const MUTATIVE_TOOLS = new Set([
  'click',
  'type',
  'pressKey',
  'scroll',
  'navigate',
  'openTab',
  'closeTab',
  'focusTab',
  'switchTab',
  'groupTabs',
]);
const LOCKED_TAB_ALLOWED_BROWSER_TOOLS = new Set([
  'navigate',
  'click',
  'hover',
  'mouse',
  'type',
  'pressKey',
  'scroll',
  'getContent',
  'screenshot',
  'findElement',
  'wait',
  'dismissModal',
]);

type FailureClass = 'selector' | 'timing' | 'permission' | 'navigation' | 'unknown';
type RecoveryStage = 'none' | 'structure' | 'retry' | 'screenshot' | 'vision';
type EvidenceConfidence = 'low' | 'medium' | 'high';
type QualityMode = 'speed' | 'balanced' | 'max';

type EvidenceEntry = {
  key: string;
  section:
    | 'sidebar'
    | 'workspace'
    | 'cards'
    | 'tables'
    | 'actions'
    | 'filters'
    | 'tabs'
    | 'badges'
    | 'kpis'
    | 'visual'
    | 'content'
    | 'unknown';
  source: string;
  mode?: string;
  text: string;
  url?: string;
  title?: string;
  timestamp: number;
};

const resolveTimeoutMs = (value: unknown, fallback = DEFAULT_REQUEST_TIMEOUT_MS) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.floor(parsed)));
};

const isAbortError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError';
};

const isNoOutputGeneratedError = (error: unknown) => {
  const message = String((error as { message?: string })?.message || error || '').toLowerCase();
  if (!message) return false;
  return message.includes('no output generated') || message.includes('check the stream for errors');
};

function humanizeProviderError(error: unknown, provider: string): string {
  const raw = String((error as any)?.message || error || 'Unknown error').trim();
  const lower = raw.toLowerCase();
  const prov = (provider || 'ollama').toLowerCase();

  if (lower.includes('cors')) {
    if (lower.includes('dangerous-direct-browser-access')) {
      return 'Erro da Anthropic: requisição ainda classificada como browser/CORS. Recarregue a extensão em chrome://extensions e tente novamente.';
    }
    if (prov === 'anthropic' || prov === 'claude') {
      if (lower.includes('not allowed')) {
        return 'Erro da Anthropic: CORS bloqueado pela configuração da organização. Contate o admin da org ou use outro provedor.';
      }
      return 'Erro da Anthropic: requisição classificada como browser/CORS. Recarregue a extensão e tente novamente.';
    }
    return `Erro de CORS no provedor ${prov}. Detecção de modelos e chamadas devem passar pelo service worker da extensão.`;
  }

  if (
    lower.includes('fetch failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('econnrefused') ||
    lower.includes('connect')
  ) {
    if (prov === 'ollama') {
      return 'Não foi possível conectar ao Ollama em http://localhost:11434. Verifique se o Ollama está rodando e se OLLAMA_ORIGINS=chrome-extension://* está definido no ambiente.';
    }
    if (prov === 'opencode') {
      return 'Falha de rede ao contatar OpenCode Zen. Verifique a chave de API, o endpoint https://opencode.ai/zen/v1 e sua conexão.';
    }
    return `Falha de rede ao contatar ${prov}. Verifique a URL/endpoint, a chave de API e sua conexão.`;
  }

  if (lower.includes('401') || lower.includes('unauthorized') || (lower.includes('invalid') && lower.includes('key'))) {
    return `Credencial inválida ou expirada para ${prov}. Verifique a API key nas configurações.`;
  }

  if (lower.includes('403') || lower.includes('forbidden')) {
    return `Acesso negado (403) no ${prov}. A chave pode não ter permissão, ou a organização bloqueia o acesso.`;
  }

  // Surface the original but keep it short for banner
  const short = raw.length > 180 ? raw.slice(0, 177) + '...' : raw;
  return `Erro no provedor (${prov}): ${short}`;
}

const GENERIC_TOOL_COMPLETION_TEXT = 'Task completed. See tool results above for details.';

const mapScreenshotQuality = (value: unknown) => {
  const normalized = String(value || 'high').toLowerCase();
  if (normalized === 'low') return 50;
  if (normalized === 'medium') return 70;
  return 90;
};

const clampInt = clampIntUnknown;

const fixedTemperatureForQuality = (qualityMode: QualityMode) => {
  if (qualityMode === 'max') return 0.2;
  if (qualityMode === 'balanced') return 0.3;
  return 0.5;
};

class BackgroundService {
  browserTools: BrowserTools;
  currentSettings: Record<string, any> | null;
  currentPlan: RunPlan | null;
  subAgentCount: number;
  activeRunId: string | null;
  activeRunAbortController: AbortController | null;
  activeRunLockOwnerRunId: string | null;
  activeRunTimeoutId: ReturnType<typeof setTimeout> | null;
  activeRunLastActivityAt: number;
  private activeSubagents: Map<string, AbortController>;
  activeInFlightToolCalls: number;
  dedicatedTabId: number | null;
  dedicatedTabWindowId: number | null;
  activeRunLockedTabId: number | null;
  sidePanelTabId: number | null;
  private pendingSidePanelOpenTabId: number | null;
  executionEvents: ExecutionEvent[];
  executionEventsHydrated: boolean;
  executionEventsFlushTimerId: ReturnType<typeof setTimeout> | null;
  // State tracking for enforcement
  lastBrowserAction: string | null;
  awaitingVerification: boolean;
  // Layer 2: Failure tracking for anti-desistance
  consecutiveFailures: number;
  failedTools: Array<{ tool: string; error: string; selector?: string }>;
  evidenceLedger: EvidenceEntry[];
  evidenceKeys: Set<string>;
  private _planPromptCache: { length: number; doneCount: number; currentIndex: number; planLines: string } | null;
  private visionQueue: VisionQueue;
  private pendingVisionByRun: Map<
    string,
    Array<{ tool: string; description: string; source: 'recovery' | 'screenshot' }>
  >;
  private runtimeBatcher: RuntimeBatcher;
  private _systemPromptCache: { key: string; prompt: string } | null;
  private _sessionToolsCache: Map<string, ReturnType<typeof buildSessionTools>>;

  private domCacheLru: DomCacheLru;
  private lockedTabAliveCache = new Map<number, number>();
  private modelScreenshotImages = new Map<string, string>();
  private findElementAttempts = new Set<string>();
  /** Per-run recovery budgets (Layer 3 find / Layer 4 screenshot). */
  private recoveryFindCount = 0;
  private recoveryScreenshotCount = 0;
  private subagentSlotsInFlight = 0;
  private subagentSlotWaiters: Array<() => void> = [];
  private deferredCompactionSessions = new Set<string>();

  invalidateDomCache(tabId?: number | null) {
    if (typeof tabId === 'number') {
      this.domCacheLru.invalidateTab(tabId);
    } else {
      this.domCacheLru.invalidateAll();
    }
  }

  // Side-channel for multimodal screenshot vision: the base64 image is stashed by
  // toolCallId (not on the tool result) and consumed by the AI SDK toModelOutput,
  // so it reaches Claude as an image without leaking into history/UI. Bounded to the
  // few most recent screenshots.
  stashModelScreenshotImage(toolCallId: string, dataUrl: string) {
    if (!toolCallId || typeof dataUrl !== 'string') return;
    this.modelScreenshotImages.set(toolCallId, dataUrl);
    while (this.modelScreenshotImages.size > 4) {
      const oldest = this.modelScreenshotImages.keys().next().value;
      if (oldest === undefined) break;
      this.modelScreenshotImages.delete(oldest);
    }
  }

  consumeModelScreenshotImage(toolCallId: string): string | undefined {
    const dataUrl = this.modelScreenshotImages.get(toolCallId);
    if (dataUrl !== undefined) this.modelScreenshotImages.delete(toolCallId);
    return dataUrl;
  }

  private async isLockedTabAlive(lockedTabId: number) {
    const cachedAt = this.lockedTabAliveCache.get(lockedTabId);
    if (cachedAt && Date.now() - cachedAt < 5000) return true;
    try {
      await chrome.tabs.get(lockedTabId);
      this.lockedTabAliveCache.set(lockedTabId, Date.now());
      return true;
    } catch {
      this.lockedTabAliveCache.delete(lockedTabId);
      return false;
    }
  }

  private async persistScreenshotHandle(result: Record<string, any>) {
    if (typeof result.dataUrl !== 'string' || !result.dataUrl) return result;
    const next = { ...result };
    next.dataUrlLength = result.dataUrl.length;
    delete next.dataUrl;
    try {
      next.screenshotId = await storeScreenshotDataUrl(result.dataUrl);
      // Fire-and-forget pruning must not surface as an unhandled rejection.
      Promise.resolve(pruneScreenshotStore()).catch((err) => console.warn('pruneScreenshotStore failed:', err));
    } catch (error) {
      // Session-storage quota/availability errors degrade gracefully instead of
      // failing the whole screenshot tool call.
      console.warn('Failed to persist screenshot handle:', error);
      next.screenshotPersistError = error instanceof Error ? error.message : String(error);
    }
    return next;
  }

  private touchActiveRun(runId: string) {
    if (this.activeRunId === runId) {
      this.activeRunLastActivityAt = Date.now();
    }
  }

  // Watchdog: only releases the run lock after ACTIVE_RUN_TIMEOUT_MS with zero
  // run activity (no runtime events and no tool executions). A fixed timeout is
  // unsafe here because legitimate runs routinely exceed 2 minutes.
  private armActiveRunWatchdog(runMeta: RunMeta) {
    const check = () => {
      if (this.activeRunId !== runMeta.runId) {
        this.activeRunTimeoutId = null;
        return;
      }
      if (this.activeInFlightToolCalls > 0) {
        this.touchActiveRun(runMeta.runId);
        this.activeRunTimeoutId = setTimeout(check, 15000);
        return;
      }
      const idleMs = Date.now() - this.activeRunLastActivityAt;
      if (idleMs >= ACTIVE_RUN_TIMEOUT_MS) {
        console.warn('[Glide] activeRunId watchdog - no run activity for', idleMs, 'ms, aborting run');
        this.sendRuntime(runMeta, {
          type: 'run_error',
          message: `Run aborted after ${Math.round(idleMs / 1000)}s without activity.`,
        });
        this.runtimeBatcher.flush(runMeta.runId);
        this.activeRunAbortController?.abort();
        this.activeRunId = null;
        this.activeRunTimeoutId = null;
        return;
      }
      this.activeRunTimeoutId = setTimeout(check, ACTIVE_RUN_TIMEOUT_MS - idleMs);
    };
    this.activeRunTimeoutId = setTimeout(check, ACTIVE_RUN_TIMEOUT_MS);
  }

  constructor() {
    this.browserTools = new BrowserTools();
    this.currentSettings = null;
    this.currentPlan = null;
    this.subAgentCount = 0;
    this.activeRunId = null;
    this.activeRunAbortController = null;
    this.activeRunLockOwnerRunId = null;
    this.activeRunTimeoutId = null;
    this.activeRunLastActivityAt = 0;
    this.activeSubagents = new Map();
    this.activeInFlightToolCalls = 0;
    this.dedicatedTabId = null;
    this.dedicatedTabWindowId = null;
    this.activeRunLockedTabId = null;
    this.sidePanelTabId = null;
    this.pendingSidePanelOpenTabId = null;
    this.executionEvents = [];
    this.executionEventsHydrated = false;
    this.executionEventsFlushTimerId = null;
    // State tracking for enforcement
    this.lastBrowserAction = null;
    this.awaitingVerification = false;
    this.consecutiveFailures = 0;
    this.failedTools = [];
    this.evidenceLedger = [];
    this.evidenceKeys = new Set();
    this._planPromptCache = null;
    this.visionQueue = new VisionQueue();
    this.pendingVisionByRun = new Map();
    this.domCacheLru = new DomCacheLru();
    this.runtimeBatcher = new RuntimeBatcher((payload) => this.sendStreamDeltaImmediate(payload));
    this._systemPromptCache = null;
    this._sessionToolsCache = new Map();
    this.resetRunState();
    this.init();
  }

  private resetRunState() {
    this.currentPlan = null;
    this._planPromptCache = null;
    this.subAgentCount = 0;
    this.lastBrowserAction = null;
    this.awaitingVerification = false;
    this.consecutiveFailures = 0;
    this.failedTools = [];
    this.evidenceLedger = [];
    this.evidenceKeys.clear();
    this._systemPromptCache = null;
    this._sessionToolsCache.clear();
    this.findElementAttempts.clear();
    this.recoveryFindCount = 0;
    this.recoveryScreenshotCount = 0;
    this.subagentSlotsInFlight = 0;
    this.subagentSlotWaiters = [];
    this.lockedTabAliveCache.clear();
    this.invalidateDomCache();
  }

  private getRecoveryBudget(settings: Record<string, any>): {
    maxFind: number;
    maxScreenshot: number;
    allowVision: boolean;
    forceAsyncVision: boolean;
  } {
    const mode = String(settings?.autoRecoveryMode || 'balanced')
      .trim()
      .toLowerCase();
    if (mode === 'off' || mode === 'none' || mode === 'false') {
      return { maxFind: 0, maxScreenshot: 0, allowVision: false, forceAsyncVision: true };
    }
    if (mode === 'speed' || mode === 'fast') {
      return { maxFind: 1, maxScreenshot: 1, allowVision: true, forceAsyncVision: true };
    }
    if (mode === 'max' || mode === 'full') {
      return { maxFind: 5, maxScreenshot: 4, allowVision: true, forceAsyncVision: false };
    }
    // balanced (default): enough signal without recovery storms
    return { maxFind: 3, maxScreenshot: 2, allowVision: true, forceAsyncVision: true };
  }

  private async acquireSubagentSlot() {
    while (this.subagentSlotsInFlight >= MAX_CONCURRENT_SUBAGENTS) {
      await new Promise<void>((resolve) => {
        this.subagentSlotWaiters.push(resolve);
      });
    }
    this.subagentSlotsInFlight += 1;
  }

  private releaseSubagentSlot() {
    this.subagentSlotsInFlight = Math.max(0, this.subagentSlotsInFlight - 1);
    const next = this.subagentSlotWaiters.shift();
    if (next) next();
  }

  private normalizeToolCallArgs(toolName: string, args: unknown) {
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      return { ok: true as const, args: { ...(args as Record<string, any>) } };
    }
    return {
      ok: false as const,
      result: {
        success: false,
        code: 'INVALID_TOOL_ARGS',
        error: `Tool "${toolName}" requires an object argument payload.`,
        hint: 'Retry with a JSON object that matches the tool input schema.',
      },
    };
  }

  private normalizeToolResultContract(toolName: string, rawResult: unknown) {
    if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
      return {
        success: false,
        code: 'INVALID_TOOL_RESULT',
        error: `Tool "${toolName}" returned a non-object result.`,
        details: {
          resultType: Array.isArray(rawResult) ? 'array' : typeof rawResult,
        },
      };
    }

    const normalized: Record<string, any> = { ...(rawResult as Record<string, any>) };
    if (typeof normalized.success !== 'boolean') {
      normalized.success = typeof normalized.error !== 'string';
    }
    if (typeof normalized.error !== 'string' && normalized.success === false) {
      normalized.error = `Tool "${toolName}" failed without an error message.`;
    }
    if (normalized.error !== undefined && typeof normalized.error !== 'string') {
      normalized.error = String(normalized.error);
    }
    if (normalized.code !== undefined && typeof normalized.code !== 'string') {
      normalized.code = String(normalized.code);
    }
    if (normalized.hint !== undefined && typeof normalized.hint !== 'string') {
      normalized.hint = String(normalized.hint);
    }
    if (normalized.message !== undefined && typeof normalized.message !== 'string') {
      normalized.message = String(normalized.message);
    }
    if (normalized.toolName === undefined) {
      normalized.toolName = toolName;
    }
    if (typeof normalized.toolName !== 'string') {
      normalized.toolName = String(normalized.toolName || toolName);
    }
    if (normalized.output === undefined) {
      const hasPrimaryFields =
        normalized.content !== undefined ||
        normalized.dataUrl !== undefined ||
        normalized.structure !== undefined ||
        normalized.tabs !== undefined;
      if (!hasPrimaryFields) {
        normalized.output = normalized.success === false ? normalized.error || 'Tool failed.' : 'Tool executed.';
      }
    }
    return normalized;
  }

  private emitConfigClampWarnings(
    runMeta: RunMeta,
    originalSettings: Record<string, any>,
    resolvedProfile: Record<string, any>,
  ) {
    const warnings: string[] = [];
    const rawTimeout = Number(originalSettings.timeout);
    if (Number.isFinite(rawTimeout) && rawTimeout !== resolvedProfile.timeout) {
      warnings.push(
        `timeout adjusted to ${resolvedProfile.timeout}ms (allowed range ${MIN_REQUEST_TIMEOUT_MS}-${MAX_REQUEST_TIMEOUT_MS}ms)`,
      );
    }
    const rawMaxTokens = Number(originalSettings.maxTokens);
    if (Number.isFinite(rawMaxTokens) && rawMaxTokens !== resolvedProfile.maxTokens) {
      warnings.push(
        `maxTokens adjusted to ${resolvedProfile.maxTokens} (allowed range ${MIN_MODEL_MAX_TOKENS}-${MAX_MODEL_MAX_TOKENS})`,
      );
    }
    const rawContextLimit = Number(originalSettings.contextLimit);
    if (Number.isFinite(rawContextLimit) && rawContextLimit !== resolvedProfile.contextLimit) {
      warnings.push(
        `contextLimit adjusted to ${resolvedProfile.contextLimit} (allowed range ${MIN_CONTEXT_LIMIT}-${MAX_CONTEXT_LIMIT})`,
      );
    }

    for (const warning of warnings) {
      this.sendRuntime(runMeta, {
        type: 'run_warning',
        message: `Config safety clamp applied: ${warning}`,
      });
    }
  }

  private async persistSidePanelTabId() {
    try {
      await chrome.storage.session.set({ glideSidePanelTabId: this.sidePanelTabId });
    } catch {
      // storage.session may be unavailable in some environments
    }
  }

  // Restricts the side panel to a single owner tab so it behaves like a contextual
  // (tab-scoped) panel instead of Chrome's default global/per-window panel. Disabling
  // the previous owner explicitly (always with a tabId) - never disabling the global
  // default here - is what keeps re-opening reliable; a bare setOptions({enabled:false})
  // with no tabId was tried before and broke re-opening because it clobbers the
  // manifest-level default for every tab, not just one.
  private async claimSidePanelOwnership(tabId: number) {
    const previousOwner = this.sidePanelTabId;
    if (typeof previousOwner === 'number' && previousOwner !== tabId) {
      await chrome.sidePanel.setOptions({ tabId: previousOwner, enabled: false }).catch(() => {});
    }
    this.sidePanelTabId = tabId;
    await this.persistSidePanelTabId();
  }

  init() {
    bindRuntimeSettingsCacheInvalidation();
    // openPanelOnActionClick would let Chrome auto-open the panel using whatever
    // options the clicked tab already has; we need to enable that specific tab
    // (and disable the previous owner) before opening, so we drive it manually.
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((error) => console.error(error));
    // Disabling the global default (no tabId) means tabs never get the panel
    // unless explicitly enabled below - this is what stops it from following
    // the user across tabs.
    chrome.sidePanel.setOptions({ enabled: false }).catch((error) => console.error(error));
    void this.hydrateExecutionEvents();
    void (async () => {
      try {
        const stored = await chrome.storage.session.get(['glideSidePanelTabId']);
        if (typeof stored?.glideSidePanelTabId === 'number') {
          this.sidePanelTabId = stored.glideSidePanelTabId;
        }
      } catch {
        // storage.session may be unavailable in some environments
      }
    })();

    chrome.action.onClicked.addListener((tab) => {
      const tabId = tab?.id;
      if (typeof tabId !== 'number') return;
      // Remember the opener tab for onOpened when Chrome omits info.tabId.
      this.pendingSidePanelOpenTabId = tabId;
      // sidePanel.open() must be initiated synchronously in the click handler;
      // awaiting setOptions first yields the event loop and loses the user-gesture token.
      void chrome.sidePanel.setOptions({ tabId, path: 'sidepanel/panel.html', enabled: true });
      void chrome.sidePanel.open({ tabId }).catch((error) => {
        console.error('[Glide] Failed to open side panel', error);
        if (this.pendingSidePanelOpenTabId === tabId) {
          this.pendingSidePanelOpenTabId = null;
        }
      });
      void this.claimSidePanelOwnership(tabId);
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      if (this.dedicatedTabId === tabId) {
        this.dedicatedTabId = null;
      }
      if (this.activeRunLockedTabId === tabId) {
        this.activeRunLockedTabId = null;
      }
      this.domCacheLru.invalidateTab(tabId);
      this.lockedTabAliveCache.delete(tabId);
      if (this.sidePanelTabId === tabId) {
        this.sidePanelTabId = null;
        void this.persistSidePanelTabId();
      }
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === 'loading') {
        this.domCacheLru.invalidateTab(tabId);
        this.lockedTabAliveCache.delete(tabId);
      }
    });

    const spAny = chrome.sidePanel as any;
    if (spAny?.onOpened) {
      spAny.onOpened.addListener(async (info: any) => {
        let tabId = typeof info?.tabId === 'number' ? info.tabId : undefined;
        if (typeof tabId !== 'number') {
          tabId = this.pendingSidePanelOpenTabId ?? this.sidePanelTabId ?? undefined;
        }
        this.pendingSidePanelOpenTabId = null;
        if (typeof tabId !== 'number') return;
        await this.claimSidePanelOwnership(tabId);
      });
    }
    if (spAny?.onClosed) {
      spAny.onClosed.addListener((_info: any) => {
        this.pendingSidePanelOpenTabId = null;
        this.sidePanelTabId = null;
        void this.persistSidePanelTabId();
      });
    }

    // Provider-specific request headers (User-Agent, Origin stripping) are applied
    // via declarativeNetRequest because MV3 service workers cannot set them in fetch().
    void installProviderNetRequestRules().catch((e) => console.warn('Failed to install provider net rules:', e));

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
      this.handleMessage(message, sender, sendResponse),
    );
  }

  isPrivilegedExtensionSender(sender: chrome.runtime.MessageSender | undefined): boolean {
    const url = String(sender?.url || '');
    if (url.startsWith('chrome-extension://')) return true;
    // Content scripts always run in a web tab; extension pages do not.
    return !sender?.tab;
  }

  handleMessage(message, sender, sendResponse) {
    try {
      // Privileged actions may only originate from an extension page (side
      // panel), never from a content script running in a web page.
      const privilegedTypes = new Set(['user_message', 'execute_tool']);
      if (privilegedTypes.has(message?.type) && !this.isPrivilegedExtensionSender(sender)) {
        sendResponse?.({ success: false, error: 'Rejected: privileged message from a non-extension context.' });
        return false;
      }
      switch (message.type) {
        case 'user_message': {
          sendResponse?.({ success: true, queued: true });
          void this.processUserMessage(
            message.conversationHistory,
            message.selectedTabs || [],
            message.sessionId || `session-${Date.now()}`,
            message.panelTabId,
          ).catch((error) => {
            console.error('Error processing user_message:', error);
            this.sendRunErrorFallback(message.sessionId || `session-${Date.now()}`, error?.message || String(error));
          });
          return false;
        }

        case 'execute_tool': {
          if (this.activeRunId) {
            sendResponse?.({
              success: false,
              error: 'A run is currently in progress. Wait for completion before using manual tools.',
            });
            return false;
          }
          const runMeta: RunMeta = {
            runId: `manual-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            turnId: `manual-turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            sessionId: message.sessionId || `manual-session-${Date.now()}`,
          };

          void this.loadRuntimeSettings()
            .then((settings) =>
              this.executeToolByName(
                String(message.tool || ''),
                (message.args && typeof message.args === 'object' ? message.args : {}) as Record<string, any>,
                { runMeta, settings, visionProfile: null },
                typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
              ),
            )
            .then((result: any) =>
              sendResponse?.({
                success: !(result && typeof result === 'object' && result.success === false),
                result,
              }),
            )
            .catch((error) =>
              sendResponse?.({
                success: false,
                error: error?.message || String(error),
              }),
            );
          return true;
        }

        case 'detect_provider_models': {
          void fetchProviderModels({
            provider: String(message.provider || 'ollama'),
            apiKey: String(message.apiKey || ''),
            customEndpoint: String(message.customEndpoint || ''),
          })
            .then((result) =>
              sendResponse?.({
                success: true,
                models: result.models,
                modelDetails: result.modelDetails,
                online: result.online,
                endpoint: result.endpoint,
                summary: result.summary,
                latencyMs: result.latencyMs,
              }),
            )
            .catch((error) =>
              sendResponse?.({
                success: false,
                error: error?.message || String(error),
                online: false,
                models: [],
                modelDetails: [],
              }),
            );
          return true;
        }

        case 'probe_ollama': {
          void fetchProviderModels({
            provider: 'ollama',
            apiKey: '',
            customEndpoint: String(message.customEndpoint || ''),
          })
            .then((result) =>
              sendResponse?.({
                success: true,
                online: result.online,
                models: result.models,
                modelDetails: result.modelDetails,
                endpoint: result.endpoint,
                summary: result.summary,
                latencyMs: result.latencyMs,
              }),
            )
            .catch((error) =>
              sendResponse?.({
                success: false,
                online: false,
                models: [],
                modelDetails: [],
                error: error?.message || String(error),
              }),
            );
          return true;
        }

        case 'session_deleted': {
          if (message.sessionId) {
            this.deferredCompactionSessions.delete(String(message.sessionId));
          }
          sendResponse?.({ success: true });
          return false;
        }

        case 'get_execution_events': {
          void this.hydrateExecutionEvents()
            .then(() => sendResponse?.({ success: true, events: this.getExecutionEventsSnapshot() }))
            .catch((error) =>
              sendResponse?.({
                success: false,
                error: error?.message || String(error) || 'Failed to load execution events.',
              }),
            );
          return true;
        }

        case 'codex_oauth': {
          void runCodexOAuthFlow()
            .then((result) => sendResponse?.({ success: true, ...result }))
            .catch((error) =>
              sendResponse?.({
                success: false,
                error: error?.message || String(error) || 'Falha no login OAuth.',
              }),
            );
          return true;
        }

        case 'content_script_ready': {
          sendResponse?.({ success: true, ack: true });
          return false;
        }

        default:
          console.warn('Unknown message type:', message.type);
          sendResponse?.({ success: false, error: `Unknown message type: ${message.type}` });
          return false;
      }
    } catch (error) {
      console.error('Error handling message:', error);
      this.sendRunErrorFallback(message?.sessionId || `session-${Date.now()}`, error?.message || String(error));
      sendResponse?.({ success: false, error: error?.message || String(error) });
      return false;
    }
  }

  async loadRuntimeSettings() {
    return loadCachedRuntimeSettings();
  }

  messageContentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            const candidate = part as Record<string, unknown>;
            if (typeof candidate.text === 'string') return candidate.text;
            if (typeof candidate.content === 'string') return candidate.content;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (content && typeof content === 'object') {
      try {
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    }
    return '';
  }

  getLatestUserText(messages: Message[]) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === 'user') return this.messageContentToText(message.content);
    }
    return '';
  }

  normalizeQualityMode(_value: unknown): QualityMode {
    return 'speed';
  }

  applyRuntimeQualityTuning(
    settings: Record<string, any>,
    profile: Record<string, any>,
  ): {
    tunedSettings: Record<string, any>;
    tunedProfile: Record<string, any>;
    qualityMode: QualityMode;
    minimumReportSections: number;
    maxOrchestrationPasses: number;
    maxModelSteps: number;
    adjustments: string[];
    strictPlanCompletion: boolean;
  } {
    // Fixed lean runtime: fast, low-reasoning, no auto-inflation of tokens/timeout
    // or report length. Provider + model are the only user-facing knobs.
    const tunedSettings = { ...settings, temperature: 0.5 };
    const tunedProfile = { ...profile, temperature: 0.5 };
    return {
      tunedSettings,
      tunedProfile,
      qualityMode: 'speed',
      minimumReportSections: 3,
      maxOrchestrationPasses: 12,
      maxModelSteps: 64,
      adjustments: [],
      strictPlanCompletion: false,
    };
  }

  async ensureDedicatedRunTab(preferredTabId?: number | null) {
    const candidates: number[] = [];
    const addCandidate = (tabId: unknown) => {
      if (typeof tabId === 'number' && !candidates.includes(tabId)) {
        candidates.push(tabId);
      }
    };

    addCandidate(preferredTabId);
    addCandidate(this.sidePanelTabId);

    const adoptDedicatedTab = (tab: chrome.tabs.Tab) => {
      if (typeof tab.id !== 'number') {
        throw new Error('Unable to adopt dedicated Glide run tab.');
      }
      this.dedicatedTabId = tab.id;
      this.dedicatedTabWindowId = typeof tab.windowId === 'number' ? tab.windowId : null;
      return tab.id;
    };

    const loadedCandidates: chrome.tabs.Tab[] = [];
    for (const tabId of candidates) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (typeof tab?.id === 'number') {
          loadedCandidates.push(tab);
        }
      } catch {
        // Tab was closed or is otherwise unavailable.
      }
    }

    const httpCandidate = loadedCandidates.find((tab) => isHttpUrl(tab.url));
    if (httpCandidate) {
      return adoptDedicatedTab(httpCandidate);
    }

    if (loadedCandidates.length > 0) {
      return adoptDedicatedTab(loadedCandidates[0]);
    }

    let targetWindowId: number | undefined;
    if (typeof this.dedicatedTabWindowId === 'number') {
      targetWindowId = this.dedicatedTabWindowId;
    } else if (typeof this.sidePanelTabId === 'number') {
      try {
        const ownerTab = await chrome.tabs.get(this.sidePanelTabId);
        if (typeof ownerTab.windowId === 'number') {
          targetWindowId = ownerTab.windowId;
        }
      } catch {
        // Owner tab unavailable.
      }
    }

    const activeQuery: chrome.tabs.QueryInfo = { active: true };
    if (typeof targetWindowId === 'number') {
      activeQuery.windowId = targetWindowId;
    } else {
      activeQuery.currentWindow = true;
    }
    const [activeTab] = await chrome.tabs.query(activeQuery);
    if (typeof activeTab?.id === 'number') {
      return adoptDedicatedTab(activeTab);
    }

    const createOptions: chrome.tabs.CreateProperties = {
      url: DEDICATED_RUN_TAB_URL,
      active: false,
    };
    if (typeof targetWindowId === 'number') {
      createOptions.windowId = targetWindowId;
    }

    const createdTab = await chrome.tabs.create(createOptions);
    if (!createdTab || typeof createdTab.id !== 'number') {
      throw new Error('Unable to create dedicated Glide run tab.');
    }
    return adoptDedicatedTab(createdTab);
  }

  async focusRunTab(tabId: number | null | undefined) {
    if (typeof tabId !== 'number') return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await chrome.tabs.update(tabId, { active: true });
    } catch (error) {
      console.warn('Failed to focus run tab:', error);
    }
  }

  async processUserMessage(
    conversationHistory: Message[],
    selectedTabs: chrome.tabs.Tab[],
    sessionId: string,
    panelTabId?: number | null,
  ) {
    const runMeta: RunMeta = {
      runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      turnId: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
    };
    let lockedTabId: number | null = null;

    try {
      if (this.activeRunId) {
        this.sendRuntime(runMeta, {
          type: 'run_error',
          message: 'Another run is already in progress. Wait for completion before starting a new one.',
        });
        return;
      }
      this.activeRunId = runMeta.runId;
      this.activeRunAbortController = new AbortController();
      this.activeRunLastActivityAt = Date.now();
      this.armActiveRunWatchdog(runMeta);
      const settings = await this.loadRuntimeSettings();
      const normalizedHistory = normalizeConversationHistory(conversationHistory || []);
      const latestUserText = this.getLatestUserText(normalizedHistory);
      const taskIntent = detectTaskIntent(latestUserText, {
        selectedTabCount: Array.isArray(selectedTabs) ? selectedTabs.length : 0,
      });

      this.currentSettings = settings;
      this.resetRunState();

      if (taskIntent.usesBrowserAutomation) {
        lockedTabId = await this.ensureDedicatedRunTab(panelTabId);
        this.activeRunLockedTabId = lockedTabId;
        this.activeRunLockOwnerRunId = runMeta.runId;

        let lockedTab: chrome.tabs.Tab;
        try {
          lockedTab = await chrome.tabs.get(lockedTabId);
        } catch (error) {
          throw new Error(`Failed to load run tab ${lockedTabId}: ${error?.message || String(error)}`);
        }

        try {
          await this.browserTools.configureSessionTabs([lockedTab], {
            title: 'Glide',
            color: 'blue',
          });
        } catch (error) {
          console.warn('Failed to configure session tab:', error);
        }
        this.sendRuntime(runMeta, {
          type: 'run_warning',
          message: `Automacao na aba atual (${lockedTabId}${lockedTab.title ? `: ${lockedTab.title}` : ''}).`,
        });
      } else {
        this.activeRunLockedTabId = null;
        this.activeRunLockOwnerRunId = null;
      }

      const orchestratorEnabled = false;
      const baseProfile = this.resolveProfile(settings);
      this.emitConfigClampWarnings(runMeta, settings, baseProfile);
      const qualityRuntime = this.applyRuntimeQualityTuning(settings, baseProfile);
      const runtimeSettings = qualityRuntime.tunedSettings;
      const runtimeProfile = qualityRuntime.tunedProfile;
      const visionProfile = runtimeSettings.visionBridge !== false ? runtimeProfile : null;
      this.currentSettings = runtimeSettings;
      this.browserTools.setUseContentBridge(runtimeSettings.useContentBridge !== false);
      if (String(runtimeProfile.provider) === 'anthropic') {
        const freshToken = await ensureFreshAnthropicToken(String(runtimeProfile.apiKey || ''));
        if (freshToken && freshToken !== runtimeProfile.apiKey) {
          runtimeProfile.apiKey = freshToken;
          runtimeSettings.apiKey = freshToken;
        }
      }
      if (qualityRuntime.adjustments.length > 0) {
        this.sendRuntime(runMeta, {
          type: 'run_warning',
          message: `Auto safety tuning applied (${qualityRuntime.qualityMode}): ${qualityRuntime.adjustments.join('; ')}`,
        });
      }

      const tools = taskIntent.usesBrowserAutomation
        ? this.getToolsForSession(runtimeSettings, orchestratorEnabled, lockedTabId)
        : [];

      const directBrowserAction = taskIntent.usesBrowserAutomation ? resolveDirectBrowserAction(latestUserText) : null;
      if (directBrowserAction) {
        const directResult = await this.executeToolByName(
          directBrowserAction.toolName,
          directBrowserAction.args,
          {
            runMeta,
            settings: runtimeSettings,
            visionProfile,
            lockedTabId,
          },
          `direct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        );
        const resultRecord =
          directResult && typeof directResult === 'object' && !Array.isArray(directResult)
            ? (directResult as Record<string, any>)
            : {};
        const finalContent =
          resultRecord.success === false
            ? `Não consegui abrir ${directBrowserAction.args.url}: ${String(resultRecord.error || 'erro desconhecido')}`
            : directBrowserAction.finalText;
        if (resultRecord.success !== false) {
          await this.focusRunTab(lockedTabId);
        }
        this.sendRuntime(runMeta, {
          type: 'assistant_final',
          content: finalContent,
          thinking: null,
          model: 'browser-direct',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          responseMessages: [{ role: 'assistant', content: finalContent }],
        });
        return;
      }

      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const sessionTabs = this.browserTools.getSessionTabSummaries();
      const sessionTabContext = sessionTabs
        .filter((tab) => typeof tab.id === 'number')
        .map((tab) => ({
          id: tab.id as number,
          title: tab.title,
          url: tab.url,
        }));
      const workingTabId: number | null = this.browserTools.getCurrentSessionTabId() ?? activeTab?.id ?? null;
      const workingTab = sessionTabs.find((tab) => tab.id === workingTabId);
      const context: Record<string, any> = {
        currentUrl: workingTab?.url || activeTab?.url || 'unknown',
        currentTitle: workingTab?.title || activeTab?.title || 'unknown',
        tabId: workingTabId,
        availableTabs: sessionTabContext,
        orchestratorEnabled,
        browserAutomation: taskIntent.usesBrowserAutomation,
        requiresDetailedReport: taskIntent.requiresDetailedReport,
        qualityMode: qualityRuntime.qualityMode,
        orchestrationPass: 1,
      };
      const model = getCachedLanguageModel({
        provider: String(runtimeProfile.provider || 'openai'),
        apiKey: String(runtimeProfile.apiKey || ''),
        model: String(runtimeProfile.model || runtimeSettings.model || ''),
        customEndpoint: String(runtimeProfile.customEndpoint || ''),
      });

      // Counts real tool executions so a provider retry never replays a pass
      // that already produced side effects (duplicate navigate/click/type).
      let toolExecutionsTotal = 0;
      const toolSet = taskIntent.usesBrowserAutomation
        ? getCachedToolSet(
            tools,
            async (toolName, args, options) => {
              toolExecutionsTotal += 1;
              return this.executeToolByName(
                toolName,
                args,
                {
                  runMeta,
                  settings: runtimeSettings,
                  visionProfile,
                  lockedTabId,
                },
                options.toolCallId,
              );
            },
            runtimeProfile.provider,
            (toolCallId: string) => this.consumeModelScreenshotImage(toolCallId),
          )
        : undefined;

      const streamEnabled = runtimeSettings.streamResponses !== false;
      // Claude-for-Chrome behaviour: recover instead of bailing after the first failed action.
      const maxRecoveryAttempts = 2;
      const maxInvalidFinalRetries = 1;
      const maxOrchestrationPasses = qualityRuntime.maxOrchestrationPasses;
      let recoveryAttempt = 0;
      let lastContinueReason: string | null = null;
      let sameContinueStreak = 0;
      const assertOrchestrationContinue = (reason: string) => {
        if (reason === lastContinueReason) {
          sameContinueStreak += 1;
          if (sameContinueStreak >= 2) {
            throw new Error(`Orchestration stopped: repeated "${reason}" without progress.`);
          }
        } else {
          lastContinueReason = reason;
          sameContinueStreak = 0;
        }
      };
      let invalidFinalRetryCount = 0;
      let currentHistory = normalizedHistory;
      const contextLimit = runtimeProfile.contextLimit || runtimeSettings.contextLimit || 200000;
      if (this.deferredCompactionSessions.delete(sessionId)) {
        const compactedHistory = await this.maybeCompactContext({
          runMeta,
          history: currentHistory,
          contextLimit,
          model,
          runtimeProfile,
          runtimeSettings,
        });
        if (compactedHistory) {
          currentHistory = compactedHistory;
        }
      }
      let finalText = '';
      let reasoningText: string | null = null;

      let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let toolResults: Array<Record<string, any>> = [];
      let toolCalls: Array<Record<string, any>> = [];
      let responseMessages: Message[] = [];
      let qualityReport: Record<string, any> | null = null;

      // Fix 3: Backoff for transient provider errors.
      const providerBackoff = createExponentialBackoff({ baseMs: 500, maxMs: 8000 });
      const MAX_PROVIDER_RETRIES = 3;

      const runPassCache = new RunPassCache();

      const runModelPass = async (messages: Message[]) => {
        const modelMessages = runPassCache.getModelMessages(messages, {
          systemMessageMode: runtimeProfile.provider === 'anthropic' ? 'user' : 'system',
        });
        const timeoutMs = resolveTimeoutMs(runtimeProfile.timeout ?? runtimeSettings.timeout);
        const runAbortSignal = this.activeRunAbortController?.signal;

        for (let providerAttempt = 0; providerAttempt < MAX_PROVIDER_RETRIES; providerAttempt += 1) {
          if (runAbortSignal?.aborted) {
            throw new Error('Run aborted.');
          }
          const toolExecutionsAtAttemptStart = toolExecutionsTotal;
          const abortController = new AbortController();
          let timedOut = false;
          let runAborted = false;
          let streamStopSent = false;
          let streamedTextBuffer = '';
          let streamProviderError: unknown = null;
          const timeoutId = setTimeout(() => {
            timedOut = true;
            abortController.abort();
          }, timeoutMs);
          if (runAbortSignal) {
            if (runAbortSignal.aborted) {
              runAborted = true;
              abortController.abort();
            } else {
              runAbortSignal.addEventListener(
                'abort',
                () => {
                  runAborted = true;
                  abortController.abort();
                },
                { once: true },
              );
            }
          }

          if (streamEnabled && providerAttempt === 0) {
            this.sendRuntime(runMeta, { type: 'assistant_stream_start' });
          }

          try {
            const result = streamText({
              model,
              ...resolveProviderOptions(runtimeProfile.provider),
              system: this.sanitizeSystemPrompt(
                this.enhanceSystemPrompt(runtimeProfile.systemPrompt || '', context),
                runtimeProfile.provider,
              ),
              messages: modelMessages,
              tools: toolSet,
              temperature: resolveTemperature(runtimeProfile.temperature ?? 0.3, runtimeProfile.provider),
              maxOutputTokens: runtimeProfile.maxTokens ?? 2048,
              stopWhen: stepCountIs(qualityRuntime.maxModelSteps),
              abortSignal: abortController.signal,
              onChunk: ({ chunk }) => {
                if (chunk.type === 'reasoning-delta') {
                  this.sendRuntime(runMeta, {
                    type: 'assistant_stream_delta',
                    content:
                      (chunk as { text?: string; delta?: string }).text || (chunk as { delta?: string }).delta || '',
                    channel: 'reasoning',
                  });
                }
              },
              onError: ({ error }) => {
                streamProviderError = error;
                console.error(error);
              },
            });

            if (streamEnabled) {
              try {
                for await (const textPart of result.textStream) {
                  streamedTextBuffer += textPart || '';
                  if (textPart) {
                    this.sendRuntime(runMeta, {
                      type: 'assistant_stream_delta',
                      content: textPart,
                      channel: 'text',
                    });
                  }
                }
              } finally {
                this.runtimeBatcher.flush(runMeta.runId);
                this.sendRuntime(runMeta, { type: 'assistant_stream_stop' });
                streamStopSent = true;
              }
            } else {
              const heartbeatId = setInterval(() => this.touchActiveRun(runMeta.runId), 15000);
              try {
                await result.text;
              } finally {
                clearInterval(heartbeatId);
              }
            }

            const textPromise = (async () => {
              try {
                return await result.text;
              } catch (error) {
                if (isNoOutputGeneratedError(error)) {
                  if (streamedTextBuffer) return streamedTextBuffer;
                  if (streamProviderError) throw streamProviderError;
                  return '';
                }
                throw error;
              }
            })();

            const [text, reasoning, usage, steps] = await Promise.all([
              textPromise,
              Promise.resolve(result?.reasoningText).catch((err) => {
                console.warn('reasoningText failed:', err);
                return null;
              }),
              Promise.resolve(result?.totalUsage).catch((err) => {
                console.warn('totalUsage failed:', err);
                return {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                };
              }),
              Promise.resolve(result?.steps).catch((err) => {
                console.warn('steps failed:', err);
                return [];
              }),
            ]);

            if (streamProviderError) {
              throw streamProviderError;
            }

            const normalizedUsage = {
              inputTokens: Number(usage?.inputTokens || 0),
              outputTokens: Number(usage?.outputTokens || 0),
              totalTokens: Number(usage?.totalTokens || 0),
            };

            const flatToolResults = steps.flatMap((step) => step.toolResults || []);
            const flatToolCalls = steps.flatMap((step) => step.toolCalls || []);
            if (!String(text || '').trim() && flatToolResults.length === 0 && flatToolCalls.length === 0) {
              throw new Error('Model returned an empty response.');
            }

            return {
              text: text || '',
              reasoningText: reasoning || null,
              totalUsage: normalizedUsage,
              toolResults: flatToolResults,
              toolCalls: flatToolCalls,
            };
          } catch (error) {
            if (streamEnabled && !streamStopSent) {
              this.runtimeBatcher.flush(runMeta.runId);
              this.sendRuntime(runMeta, { type: 'assistant_stream_stop' });
            }
            // Fatal errors: timeout, run abort, or explicit abort — do not retry.
            if (runAborted && !timedOut) {
              throw new Error('Run aborted.');
            }
            if (timedOut || isAbortError(error)) {
              throw new Error(`Model request timed out after ${timeoutMs}ms`);
            }
            const providerStatus = extractProviderErrorStatus(error);
            if (!isRetryableProviderError(providerStatus)) {
              throw error;
            }
            // Do not replay a pass that already executed tools — retrying would
            // repeat real-world side effects (navigate/click/type).
            if (toolExecutionsTotal > toolExecutionsAtAttemptStart) {
              throw new Error(
                `Provider error after ${toolExecutionsTotal - toolExecutionsAtAttemptStart} tool execution(s); not retrying to avoid repeating browser side effects. Cause: ${error?.message || String(error)}`,
              );
            }
            const attemptNumber = providerAttempt + 1;
            if (attemptNumber >= MAX_PROVIDER_RETRIES) {
              throw error;
            }
            const delayMs = providerBackoff(attemptNumber);
            this.sendRuntime(runMeta, {
              type: 'run_warning',
              message: `Provider error (attempt ${attemptNumber}/${MAX_PROVIDER_RETRIES}), retrying in ${delayMs}ms...`,
            });
            await new Promise((r) => setTimeout(r, delayMs));
          } finally {
            clearTimeout(timeoutId);
          }
        }
        throw new Error('Model retries exhausted before producing a response.');
      };

      let orchestrationPassCount = 0;
      while (true) {
        orchestrationPassCount += 1;
        context.orchestrationPass = orchestrationPassCount;
        if (this.activeRunId !== runMeta.runId) {
          throw new Error('Run superseded: the watchdog released this run after a period of inactivity.');
        }
        this.touchActiveRun(runMeta.runId);
        if (orchestrationPassCount > maxOrchestrationPasses) {
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: `Safety stop triggered after ${maxOrchestrationPasses} orchestration passes.`,
          });
          throw new Error(`Safety stop: exceeded ${maxOrchestrationPasses} orchestration passes.`);
        }
        const passResult = await runModelPass(currentHistory);
        const toolRecoverySource = [passResult.text, passResult.reasoningText || ''].filter(Boolean).join('\n\n');
        const availableToolNames = tools.map((tool) => tool.name);
        const recoveredToolCalls = this.dedupeRecoveredToolCalls([
          ...this.extractXmlToolCalls(toolRecoverySource),
          ...extractRecoverableToolCalls(toolRecoverySource, availableToolNames),
        ]);
        toolResults = passResult.toolResults || [];
        toolCalls = passResult.toolCalls || [];

        if (recoveredToolCalls.length > 0 && toolResults.length === 0 && recoveryAttempt < maxRecoveryAttempts) {
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: 'Detected textual tool call output. Executing tools and retrying.',
          });

          const cleanedText = stripRecoverableToolCalls(this.stripXmlToolCalls(passResult.text), availableToolNames);
          // Pre-assign a stable id per XML tool call so the assistant message
          // can declare a matching tool-call for every tool-result — otherwise
          // the replayed history would orphan the tool-results.
          const xmlCallEntries = recoveredToolCalls.map((call) => ({
            call,
            toolCallId: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          }));

          currentHistory = normalizeConversationHistory(
            [
              ...currentHistory,
              {
                role: 'assistant',
                content: cleanedText || '',
                thinking: passResult.reasoningText || null,
                toolCalls: xmlCallEntries.map(({ call, toolCallId }) => ({
                  id: toolCallId,
                  name: call.name,
                  args: call.args || {},
                })),
              },
            ],
            ORCHESTRATION_RETRY_NORMALIZE,
          );

          const toolMessages: Message[] = [];
          for (const { call, toolCallId } of xmlCallEntries) {
            const output = await this.executeToolByName(
              call.name,
              call.args,
              {
                runMeta,
                settings: runtimeSettings,
                visionProfile,
                lockedTabId,
              },
              toolCallId,
            );
            toolMessages.push({
              role: 'tool',
              toolCallId,
              toolName: call.name,
              content: [
                {
                  type: 'tool-result',
                  toolCallId,
                  toolName: call.name,
                  output: (() => {
                    const compactOutput = this.compactToolOutputForHistory(output, call.name);
                    return compactOutput && typeof compactOutput === 'object'
                      ? { type: 'json' as const, value: compactOutput }
                      : { type: 'text' as const, value: String(compactOutput ?? '') };
                  })(),
                },
              ],
            });
          }

          currentHistory = normalizeConversationHistory(
            [
              ...currentHistory,
              ...toolMessages,
              {
                role: 'system',
                content:
                  'Previous response included XML tool call markup. Tools were executed. Continue without XML tool tags.',
              },
            ],
            ORCHESTRATION_RETRY_NORMALIZE,
          );

          recoveryAttempt += 1;
          assertOrchestrationContinue('xml_recovery');
          continue;
        }

        // Quality gate: strict plan completion before finalizing.
        const hasFailedTools = (passResult.toolResults || []).some((r: Record<string, any>) => {
          const out = this.extractToolResultOutput(r);
          return out?.success === false;
        });
        const activePlan = this.currentPlan as RunPlan | null;
        const planSteps = activePlan ? activePlan.steps : [];
        const hasPlan = Boolean(activePlan && planSteps.length > 0);
        const pendingSteps = hasPlan ? planSteps.filter((s) => s.status !== 'done') : [];
        const hasPendingPlanSteps = !hasPlan || pendingSteps.length > 0;

        const modelUsedTools = toolResults.length > 0;
        if (
          taskIntent.requiresDetailedReport &&
          qualityRuntime.strictPlanCompletion &&
          hasPendingPlanSteps &&
          modelUsedTools
        ) {
          const gateReason = hasPlan ? 'plan_incomplete' : 'missing_plan';
          const gateRetryBudget =
            qualityRuntime.qualityMode === 'max' ? 6 : qualityRuntime.qualityMode === 'balanced' ? 4 : 2;
          if (recoveryAttempt < maxRecoveryAttempts + gateRetryBudget) {
            const partialText = this.stripXmlToolCalls(passResult.text);
            const pendingTitles = pendingSteps
              .slice(0, 4)
              .map((step) => step.title)
              .join(' | ');
            currentHistory = normalizeConversationHistory(
              [
                ...currentHistory,
                ...(partialText
                  ? [{ role: 'assistant' as const, content: partialText, thinking: passResult.reasoningText || null }]
                  : []),
                {
                  role: 'system' as const,
                  content: hasPlan
                    ? `QUALITY GATE: Final response blocked because ${pendingSteps.length} plan step(s) are still pending (${pendingTitles || 'untitled'}). Continue execution with evidence, then call update_plan.`
                    : 'QUALITY GATE: Final response blocked because no plan exists. Your next call must be set_plan with concrete actionable steps.',
                },
              ],
              ORCHESTRATION_RETRY_NORMALIZE,
            );
            recoveryAttempt += 1;
            assertOrchestrationContinue(`quality_gate:${gateReason}`);
            this.sendRuntime(runMeta, {
              type: 'run_quality_gate',
              state: 'forced_retry',
              reason: gateReason,
              details: {
                hasPlan,
                pendingSteps: pendingSteps.length,
                retryAttempt: recoveryAttempt,
                hasFailedTools,
                qualityMode: qualityRuntime.qualityMode,
              },
            });
            this.sendRuntime(runMeta, {
              type: 'run_warning',
              message: hasPlan
                ? `Quality gate retry ${recoveryAttempt}: ${pendingSteps.length} plan step(s) still pending.`
                : `Quality gate retry ${recoveryAttempt}: no plan created yet.`,
            });
            continue;
          }

          this.sendRuntime(runMeta, {
            type: 'run_quality_gate',
            state: 'blocked',
            reason: gateReason,
            details: {
              hasPlan,
              pendingSteps: pendingSteps.length,
              hasFailedTools,
              qualityMode: qualityRuntime.qualityMode,
            },
          });
          throw new Error(
            hasPlan
              ? `Quality gate blocked finalization: ${pendingSteps.length} plan steps are still pending.`
              : 'Quality gate blocked finalization: no active plan.',
          );
        }

        this.sendRuntime(runMeta, {
          type: 'run_quality_gate',
          state: 'passed',
          reason: 'plan_complete',
          details: {
            totalSteps: planSteps.length,
            qualityMode: qualityRuntime.qualityMode,
          },
        });

        reasoningText = passResult.reasoningText || null;
        totalUsage = passResult.totalUsage || totalUsage;
        const cleanedText = stripRecoverableToolCalls(this.stripXmlToolCalls(passResult.text), availableToolNames);
        const hadToolCalls = toolResults.length > 0;
        const fallbackText = hadToolCalls
          ? taskIntent.requiresDetailedReport
            ? GENERIC_TOOL_COMPLETION_TEXT
            : 'Pronto.'
          : 'Done.';
        const hasValidText = isValidFinalResponse(cleanedText, { allowEmpty: hadToolCalls });
        const structuredFallback =
          hadToolCalls && taskIntent.requiresDetailedReport
            ? this.buildComprehensiveFallbackReport(toolResults, qualityRuntime.minimumReportSections)
            : '';
        const shouldUseToolFallback =
          hadToolCalls && (!hasValidText || !cleanedText || this.isGenericCompletionText(cleanedText));
        const shouldRetryInvalidFinal =
          !hadToolCalls &&
          invalidFinalRetryCount < maxInvalidFinalRetries &&
          (!hasValidText || !cleanedText || this.isGenericCompletionText(cleanedText));

        if (shouldRetryInvalidFinal) {
          invalidFinalRetryCount += 1;
          const retryHistory = [...currentHistory];
          if (cleanedText) {
            retryHistory.push({
              role: 'assistant',
              content: cleanedText,
              thinking: passResult.reasoningText || null,
            });
          }
          retryHistory.push({
            role: 'system',
            content:
              'Previous attempt returned no usable final answer. Respond to the user now with a direct final answer in the user language. Do not mention internal errors or ask to retry unless strictly necessary. If you lack critical data, clearly say what is missing and provide the next concrete step.',
          });
          currentHistory = normalizeConversationHistory(retryHistory, ORCHESTRATION_RETRY_NORMALIZE);
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: 'Model returned no usable final text; retrying final answer once.',
          });
          assertOrchestrationContinue('invalid_final');
          continue;
        }

        if (shouldUseToolFallback) {
          finalText = structuredFallback || this.buildToolResultFallback(toolResults) || fallbackText;
        } else if (hasValidText) {
          const baseText = cleanedText || fallbackText;
          finalText =
            taskIntent.requiresDetailedReport &&
            structuredFallback &&
            this.isLowDetailFinal(baseText, qualityRuntime.minimumReportSections)
              ? `${baseText}\n\n${structuredFallback}`.trim()
              : baseText;
        } else if (hadToolCalls) {
          finalText =
            structuredFallback ||
            this.buildToolResultFallback(toolResults) ||
            'A acao foi executada, mas nao consegui gerar uma resposta final confiavel.';
        } else {
          finalText =
            'Nao consegui gerar uma resposta final confiavel neste turno. Tente novamente em alguns segundos.';
        }
        qualityReport = this.buildQualityReport({
          qualityMode: qualityRuntime.qualityMode,
          minimumReportSections: qualityRuntime.minimumReportSections,
          plan: this.currentPlan,
          toolResults,
          finalText,
        });

        responseMessages = buildToolTurnMessages(
          finalText,
          reasoningText || null,
          this.buildToolResultMessageContent(toolResults),
          toolCalls,
        );

        break;
      }

      this.sendRuntime(runMeta, {
        type: 'assistant_final',
        content: finalText,
        thinking: reasoningText || null,
        model: runtimeProfile.model || runtimeSettings.model || '',
        usage: {
          inputTokens: totalUsage.inputTokens || 0,
          outputTokens: totalUsage.outputTokens || 0,
          totalTokens: totalUsage.totalTokens || 0,
        },
        responseMessages,
        qualityReport,
      });

      const nextHistory = normalizeConversationHistory([...currentHistory, ...responseMessages]);
      const compactionSettings = DEFAULT_COMPACTION_SETTINGS;
      const contextUsage = estimateContextTokens(nextHistory);
      const compactionCheck = shouldCompact({
        contextTokens: contextUsage.tokens,
        contextLimit,
        settings: compactionSettings,
        sessionId,
      });

      if (compactionCheck.shouldCompact) {
        if (runtimeSettings.deferCompaction) {
          this.deferredCompactionSessions.add(sessionId);
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: 'Context compaction deferred until the next message.',
          });
        } else {
          await this.maybeCompactContext({
            runMeta,
            history: nextHistory,
            contextLimit,
            model,
            runtimeProfile,
            runtimeSettings,
          });
        }
      }
    } catch (error) {
      console.error('Error processing user message:', error);
      const providerForErr = this.currentSettings?.provider || 'ollama';
      const friendly = humanizeProviderError(error, providerForErr);
      this.sendRuntime(runMeta, {
        type: 'run_error',
        message: friendly,
        details: {
          runId: runMeta.runId,
          sessionId: runMeta.sessionId,
          timestamp: Date.now(),
        },
      });
    } finally {
      this.runtimeBatcher.flush(runMeta.runId);
      for (const controller of this.activeSubagents.values()) {
        controller.abort();
      }
      this.activeSubagents.clear();
      // Only tear down lock and watchdog if this run still owns them; a
      // superseding run may have armed its own watchdog timer by now.
      if (this.activeRunId === runMeta.runId) {
        if (this.activeRunTimeoutId) {
          clearTimeout(this.activeRunTimeoutId);
          this.activeRunTimeoutId = null;
        }
        this.pendingVisionByRun.delete(runMeta.runId);
        this.activeRunId = null;
        // Flush any buffered execution events now that the run has ended
        if (this._executionEventsDirty) {
          this._executionEventsDirty = false;
          void this.flushExecutionEvents();
        }
        this.activeRunAbortController = null;
      }
      if (this.activeRunLockOwnerRunId === runMeta.runId) {
        this.activeRunLockedTabId = null;
        this.activeRunLockOwnerRunId = null;
      }
    }
  }

  async executeToolByName(
    toolName: string,
    args: Record<string, any>,
    options: {
      runMeta: RunMeta;
      settings: Record<string, any>;
      visionProfile?: Record<string, any> | null;
      lockedTabId?: number | null;
      runScope?: RunScope;
    },
    toolCallId?: string,
  ) {
    this.touchActiveRun(options.runMeta.runId);
    const runScope: RunScope = options.runScope || 'parent';
    const isolatedRun = isSubagentScope(runScope);
    const effectiveSettings = (options.settings || this.currentSettings || {}) as Record<string, any>;
    const lockedTabId = typeof options.lockedTabId === 'number' ? options.lockedTabId : null;
    const callId = toolCallId || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const startedAt = Date.now();
    const normalizedArgsResult = this.normalizeToolCallArgs(toolName, args);
    const safeArgs = normalizedArgsResult.ok ? normalizedArgsResult.args : {};
    // Redact secrets (typed text, tokens, passwords…) from the args broadcast to
    // the side panel — same redaction the tool results already go through. The raw
    // args are still used internally (tool execution, tab/url resolution).
    const redactArgsForRuntime = (input: Record<string, any>) => {
      const redacted: Record<string, any> = {};
      for (const [key, value] of Object.entries(input || {})) {
        if (this.isSensitiveTelemetryKey(key)) {
          redacted[key] = typeof value === 'string' ? `<redacted:${value.length} chars>` : '<redacted>';
        } else {
          redacted[key] = this.sanitizeTelemetryValue(value, key, 0);
        }
      }
      return redacted;
    };
    const sendStart = () =>
      this.sendRuntime(options.runMeta, {
        type: 'tool_execution_start',
        tool: toolName,
        id: callId,
        args: redactArgsForRuntime(safeArgs),
      });
    const sendResult = (
      result: unknown,
      eventArgs: Record<string, any> = safeArgs,
      runtimeMeta: {
        recoveryStage?: RecoveryStage;
        evidenceConfidence?: EvidenceConfidence;
        failureClass?: FailureClass;
      } = {},
    ) => {
      this.sendRuntime(options.runMeta, {
        type: 'tool_execution_result',
        tool: toolName,
        id: callId,
        args: redactArgsForRuntime(eventArgs),
        result,
        ...runtimeMeta,
      });
      this.recordExecutionEvent(options.runMeta, {
        toolName,
        callId,
        args: eventArgs,
        result,
        startedAt,
      });
    };

    if (!normalizedArgsResult.ok) {
      sendStart();
      sendResult(normalizedArgsResult.result);
      return normalizedArgsResult.result;
    }

    if (isolatedRun && PARENT_ONLY_TOOLS.has(toolName)) {
      sendStart();
      const blocked = {
        success: false,
        code: 'SUBAGENT_SCOPE',
        error: `Tool "${toolName}" is not available inside a sub-agent run.`,
      };
      sendResult(blocked);
      return blocked;
    }

    sendStart();
    this.activeInFlightToolCalls += 1;

    try {
      if (!isolatedRun && MUTATIVE_TOOLS.has(toolName)) {
        const targetTab = typeof safeArgs?.tabId === 'number' ? safeArgs.tabId : lockedTabId || this.activeRunLockedTabId;
        this.invalidateDomCache(targetTab);
      }
      if (toolName === 'set_plan') {
        const plan = this.buildPlanFromArgs(args);
        if (!plan) {
          const errorResult = {
            success: false,
            error: 'Plan must include steps array with title for each step.',
            hint: 'Example: set_plan({ steps: [{ title: "Navigate to site" }, { title: "Click login" }] })',
            received: JSON.stringify(args).slice(0, 200),
          };
          sendResult(errorResult);
          return errorResult;
        }
        this.currentPlan = plan;
        this._planPromptCache = null;
        this._systemPromptCache = null;
        this.sendRuntime(options.runMeta, { type: 'plan_update', plan });
        const result = {
          success: true,
          plan,
          message: `Plan created with ${plan.steps.length} steps. Use update_plan({ step_index: 0, status: "done" }) after completing each step.`,
        };
        sendResult(result);
        return result;
      }

      if (toolName === 'update_plan') {
        if (!this.currentPlan) {
          const errorResult = {
            success: false,
            error: 'No active plan to update. Call set_plan first.',
            hint: 'Create a plan with set_plan({ steps: [{ title: "..." }, ...] }) before updating.',
          };
          sendResult(errorResult);
          return errorResult;
        }
        const rawIndex = args.step_index;
        const parsedIndex = typeof rawIndex === 'number' ? rawIndex : Number(rawIndex);
        const stepIndex = Number.isFinite(parsedIndex) ? parsedIndex : -1;
        const rawStatus = typeof args.status === 'string' ? args.status : 'done';
        const status = rawStatus === 'pending' || rawStatus === 'done' || rawStatus === 'blocked' ? rawStatus : 'done';
        const maxIndex = this.currentPlan.steps.length - 1;
        if (stepIndex < 0 || stepIndex > maxIndex) {
          const errorResult = {
            success: false,
            error: `Invalid step_index: ${stepIndex}. Valid range is 0-${maxIndex}.`,
            hint: `Plan has ${this.currentPlan.steps.length} steps (indices 0 to ${maxIndex}).`,
            currentPlan: this.currentPlan.steps.map((s, i) => `${i}: ${s.title} [${s.status}]`),
          };
          sendResult(errorResult);
          return errorResult;
        }
        this.currentPlan.steps[stepIndex].status = status;
        this.currentPlan.updatedAt = Date.now();
        this._planPromptCache = null;
        this._systemPromptCache = null;
        this.sendRuntime(options.runMeta, { type: 'plan_update', plan: this.currentPlan });
        const result = { success: true, step: stepIndex, status, plan: this.currentPlan };
        sendResult(result);
        return result;
      }

      if (toolName === 'spawn_subagent') {
        const result = await this.handleSpawnSubagent(options.runMeta, args);
        sendResult(result);
        return result;
      }

      if (toolName === 'subagent_complete') {
        const result = { success: true, ack: true, details: args || {} };
        sendResult(result);
        return result;
      }

      const available = this.browserTools?.tools ? Object.keys(this.browserTools.tools) : [];
      if (!available.includes(toolName)) {
        const errorResult = {
          success: false,
          error: `Unknown tool: ${toolName}`,
        };
        sendResult(errorResult);
        return errorResult;
      }

      const isBrowserTool = available.includes(toolName);
      if (lockedTabId && isBrowserTool) {
        if (!LOCKED_TAB_ALLOWED_BROWSER_TOOLS.has(toolName)) {
          const blocked = {
            success: false,
            code: 'TAB_LOCK_POLICY',
            error: `Tool "${toolName}" is blocked in dedicated locked-tab mode.`,
            policy: {
              type: 'tab_lock',
              lockedTabId,
              tool: toolName,
              reason: 'Tool is outside the dedicated-tab allowlist.',
            },
          };
          this.sendRuntime(options.runMeta, {
            type: 'run_warning',
            message: `Politica de lock bloqueou "${toolName}" fora da allowlist da aba dedicada ${lockedTabId}.`,
          });
          sendResult(blocked);
          return blocked;
        }
        if (typeof args?.tabId === 'number' && args.tabId !== lockedTabId) {
          const blocked = {
            success: false,
            code: 'TAB_LOCK_POLICY',
            error: `Tab mismatch: run is locked to tab ${lockedTabId}, received tabId ${args.tabId}.`,
            policy: {
              type: 'tab_lock',
              lockedTabId,
              requestedTabId: args.tabId,
              tool: toolName,
              reason: 'Explicit tabId does not match the dedicated run tab.',
            },
          };
          this.sendRuntime(options.runMeta, {
            type: 'run_warning',
            message: `Politica de lock bloqueou "${toolName}" com tabId ${args.tabId}. A execucao permanece na aba ${lockedTabId}.`,
          });
          sendResult(blocked);
          return blocked;
        }
        const lockedTabAlive = await this.isLockedTabAlive(lockedTabId);
        if (!lockedTabAlive) {
          const blocked = {
            success: false,
            code: 'TAB_LOCK_POLICY',
            error: `Dedicated locked tab ${lockedTabId} is unavailable.`,
            policy: {
              type: 'tab_lock',
              lockedTabId,
              tool: toolName,
              reason: 'Locked tab unavailable.',
            },
          };
          this.sendRuntime(options.runMeta, {
            type: 'run_warning',
            message: `A aba dedicada ${lockedTabId} nao esta disponivel; a ferramenta "${toolName}" foi bloqueada.`,
          });
          sendResult(blocked);
          return blocked;
        }
      }

      const permissionCheck = await this.checkToolPermission(toolName, args, effectiveSettings);
      if (!permissionCheck.allowed) {
        const blocked = {
          success: false,
          error: permissionCheck.reason || 'Tool blocked by permissions.',
          policy: permissionCheck.policy,
        };
        sendResult(blocked);
        return blocked;
      }

      if (toolName === 'screenshot' && effectiveSettings.enableScreenshots === false) {
        const blocked = {
          success: false,
          error: 'Screenshots are disabled in settings.',
        };
        sendResult(blocked);
        return blocked;
      }

      let result: any;
      let toolArgs = args;
      if (lockedTabId && isBrowserTool && LOCKED_TAB_ALLOWED_BROWSER_TOOLS.has(toolName)) {
        toolArgs = {
          ...args,
          tabId: lockedTabId,
          _strictTabId: true,
        };
      }
      if (toolName === 'screenshot') {
        const defaultFormat = typeof toolArgs?.format === 'string' ? toolArgs.format : 'jpeg';
        const defaultQuality =
          typeof toolArgs?.quality === 'number'
            ? toolArgs.quality
            : mapScreenshotQuality(effectiveSettings.screenshotQuality);
        toolArgs = {
          ...toolArgs,
          format: defaultFormat,
          quality: defaultQuality,
        };
      }

      // Interceptação de cache de DOM para getContent/findElement (parent run only)
      if (!isolatedRun && (toolName === 'getContent' || toolName === 'findElement')) {
        const targetTabId = toolArgs.tabId || lockedTabId || this.activeRunLockedTabId;
        if (typeof targetTabId === 'number') {
          const lookup =
            toolName === 'getContent'
              ? {
                  tabId: targetTabId,
                  tool: 'getContent' as const,
                  mode: String(toolArgs.type || toolArgs.mode || 'text'),
                  selector: toolArgs.selector ? String(toolArgs.selector) : '',
                  maxChars: typeof toolArgs.maxChars === 'number' ? toolArgs.maxChars : undefined,
                  maxItems: typeof toolArgs.maxItems === 'number' ? toolArgs.maxItems : undefined,
                }
              : {
                  tabId: targetTabId,
                  tool: 'findElement' as const,
                  query: String(toolArgs.query || ''),
                  mode: String(toolArgs.type || 'any'),
                  maxResults: typeof toolArgs.maxResults === 'number' ? toolArgs.maxResults : undefined,
                };
          const cachedResult = this.domCacheLru.get(lookup);
          if (cachedResult) {
            console.log(`[Glide] Serving ${toolName} from DOM cache for tabId: ${targetTabId}`);
            sendResult(cachedResult, toolArgs);
            return cachedResult;
          }
        }
      }

      try {
        result = await this.browserTools.executeTool(toolName, toolArgs);

        if (!isolatedRun && result?.success) {
          const targetTabId = toolArgs.tabId || lockedTabId || this.activeRunLockedTabId;
          if (typeof targetTabId === 'number') {
            if (toolName === 'getContent') {
              this.domCacheLru.set(
                {
                  tabId: targetTabId,
                  tool: 'getContent',
                  mode: String(toolArgs.type || toolArgs.mode || 'text'),
                  selector: toolArgs.selector ? String(toolArgs.selector) : '',
                  maxChars: typeof toolArgs.maxChars === 'number' ? toolArgs.maxChars : undefined,
                  maxItems: typeof toolArgs.maxItems === 'number' ? toolArgs.maxItems : undefined,
                },
                result,
              );
            } else if (toolName === 'findElement') {
              this.domCacheLru.set(
                {
                  tabId: targetTabId,
                  tool: 'findElement',
                  query: String(toolArgs.query || ''),
                  mode: String(toolArgs.type || 'any'),
                  maxResults: typeof toolArgs.maxResults === 'number' ? toolArgs.maxResults : undefined,
                },
                result,
              );
            }
          }
        }
      } catch (error) {
        const errorResult = {
          success: false,
          error: error?.message || String(error) || 'Tool execution failed',
        };
        sendResult(errorResult, toolArgs);
        return errorResult;
      }

      result = this.normalizeToolResultContract(toolName, result);

      const recoveryBudget = this.getRecoveryBudget(effectiveSettings);

      // Layer 3: Auto findElement on click/type failure (budgeted per run).
      // Prefer candidates already returned by the failed tool (similar_elements) to
      // avoid a second full-DOM findElement scan when the click path already listed peers.
      const failureSelector = String(toolArgs?.selector || '');
      const findAttemptKey = `${toolName}:${failureSelector}`;
      if (
        effectiveSettings.autoFindElementOnFailure !== false &&
        recoveryBudget.maxFind > 0 &&
        this.recoveryFindCount < recoveryBudget.maxFind &&
        (toolName === 'click' || toolName === 'type') &&
        !this.findElementAttempts.has(findAttemptKey) &&
        result &&
        typeof result === 'object' &&
        result.success === false &&
        (result.code === 'ELEMENT_NOT_FOUND' || String(result.error || '').includes('not found'))
      ) {
        try {
          this.findElementAttempts.add(findAttemptKey);
          this.recoveryFindCount += 1;

          const similar = Array.isArray((result as Record<string, any>).similar_elements)
            ? ((result as Record<string, any>).similar_elements as Array<Record<string, any>>)
            : [];
          const promoted = similar
            .map((el) => ({
              selector: String(el.selector || '').trim(),
              tag: String(el.tag || ''),
              text: String(el.text || el.aria || '').slice(0, 120),
            }))
            .filter((c) => c.selector || c.text);

          const hasUsefulSelectors = promoted.some((c) => Boolean(c.selector));
          if (hasUsefulSelectors) {
            // Reuse cheap click-failure candidates — skip full findElement scan.
            (result as Record<string, any>).findElementCandidates = promoted.slice(0, 5);
            const selectorList = promoted
              .map((c) => c.selector)
              .filter(Boolean)
              .slice(0, 5)
              .map((s) => `"${s}"`)
              .join(', ');
            (result as Record<string, any>).hint =
              `${(result as Record<string, any>).hint ? `${(result as Record<string, any>).hint} ` : ''}Try one of these selectors from the failed action: ${selectorList}.`;
            (result as Record<string, any>).recoveryStageHint = 'similar_elements';
          } else {
            const queryHint = failureSelector || (toolName === 'type' ? String(toolArgs?.text || '') : '');
            // Escalate only when similar_elements lack selectors; prefer exact match first.
            const findResult = (await this.browserTools.executeTool('findElement', {
              query: queryHint,
              type: 'any',
              maxResults: 5,
              fuzzy: recoveryBudget.maxFind > 1 && !promoted.length,
              ...(lockedTabId ? { tabId: lockedTabId, _strictTabId: true } : {}),
            })) as Record<string, any>;
            if (findResult?.success && Array.isArray(findResult.candidates)) {
              (result as Record<string, any>).findElementCandidates = findResult.candidates;
              (result as Record<string, any>).hint =
                `${(result as Record<string, any>).hint ? `${(result as Record<string, any>).hint} ` : ''}Try one of these selectors from findElement: ${findResult.candidates
                  .map((c: any) => `"${c.selector || ''}"`)
                  .filter(Boolean)
                  .join(', ')}.`;
            } else if (promoted.length > 0) {
              // Text-only peers still help the model pick a next target.
              (result as Record<string, any>).findElementCandidates = promoted.slice(0, 5);
            }
          }
        } catch (findError) {
          console.warn('[Glide] Auto findElement recovery failed:', findError);
        }
      }

      // Track state for enforcement (parent run only — sub-agents must not mutate orchestrator state)
      const isBrowserAction = BROWSER_ACTION_TOOLS.includes(toolName as (typeof BROWSER_ACTION_TOOLS)[number]);
      if (!isolatedRun && isBrowserAction) {
        this.lastBrowserAction = toolName;
        this.awaitingVerification = true;
        // Layer 2b: Track consecutive browser action failures
        if (result?.success === false) {
          this.consecutiveFailures = (this.consecutiveFailures || 0) + 1;
          if (!Array.isArray(this.failedTools)) this.failedTools = [];
          this.failedTools.push({
            tool: toolName,
            error: String(result?.error || '').slice(0, 120),
            selector: String(toolArgs?.selector || '').slice(0, 120),
          });
          // Bound failure log so long runs cannot grow unbounded.
          if (this.failedTools.length > 20) {
            this.failedTools = this.failedTools.slice(-20);
          }
        } else {
          this.consecutiveFailures = 0;
        }
      } else if (!isolatedRun && toolName === 'getContent') {
        this.awaitingVerification = false;
      }

      const finalResult: Record<string, any> = { ...(result as Record<string, any>) };
      let recoveryStage: RecoveryStage = 'none';

      // Layer 4: Auto-screenshot on browser action failure (budgeted; vision async by default)
      const mayScreenshot =
        isBrowserAction &&
        finalResult?.success === false &&
        effectiveSettings.screenshotOnFailure !== false &&
        recoveryBudget.maxScreenshot > 0 &&
        this.recoveryScreenshotCount < recoveryBudget.maxScreenshot;

      if (mayScreenshot) {
        try {
          this.recoveryScreenshotCount += 1;
          const recoveryScreenshotArgs: Record<string, any> = {
            format: 'jpeg',
            quality: 50,
          };
          if (lockedTabId) {
            recoveryScreenshotArgs.tabId = lockedTabId;
            recoveryScreenshotArgs._strictTabId = true;
          }
          const screenshotResult = (await this.browserTools.executeTool(
            'screenshot',
            recoveryScreenshotArgs,
          )) as Record<string, any>;
          if (screenshotResult?.success) {
            recoveryStage = 'screenshot';
            finalResult.recoveryScreenshotCaptured = true;
            finalResult.recoveryScreenshotFormat = screenshotResult.format || 'jpeg';
            if (typeof screenshotResult.tabId === 'number') {
              finalResult.recoveryTabId = screenshotResult.tabId;
            }
            if (this.shouldIncludeScreenshotData(effectiveSettings) && typeof screenshotResult.dataUrl === 'string') {
              finalResult.recoveryScreenshotDataUrl = screenshotResult.dataUrl;
            }
            if (
              recoveryBudget.allowVision &&
              options.visionProfile?.apiKey &&
              isVisionBridgeEnabled(effectiveSettings) &&
              typeof screenshotResult.dataUrl === 'string'
            ) {
              const visionSettings = recoveryBudget.forceAsyncVision
                ? { ...effectiveSettings, visionBridgeSync: false }
                : effectiveSettings;
              const vision = await this.describeImageForRun(options.runMeta, {
                dataUrl: screenshotResult.dataUrl as string,
                prompt: `A browser action "${toolName}" failed with error: "${finalResult.error}". Describe what is visible on screen so the agent can find an alternative approach. List any buttons, tabs, links, or interactive elements you can see.`,
                visionProfile: options.visionProfile,
                tool: toolName,
                callId,
                source: 'recovery',
                settings: visionSettings,
              });
              if (vision.description) {
                finalResult.visualContext = vision.description;
                finalResult.hint = `${finalResult.hint ? `${finalResult.hint} ` : ''}Use the visualContext above to find alternative selectors or actions.`;
                recoveryStage = 'vision';
              } else if (vision.pending) {
                finalResult.visualContext =
                  'Vision analysis is processing asynchronously. Use findElement or getContent({ mode: "structure" }) while waiting for visual context.';
                finalResult.visionPending = true;
                finalResult.hint = `${finalResult.hint ? `${finalResult.hint} ` : ''}Visual context will arrive via vision_context_ready. Retry with structure mode if needed.`;
              }
            } else {
              finalResult.visualContext =
                'Screenshot captured. Vision analysis is unavailable. Re-check page structure and retry with alternative selectors.';
              finalResult.hint = `${finalResult.hint ? `${finalResult.hint} ` : ''}Call getContent({ mode: "structure" }) and retry with a different selector strategy.`;
            }
          } else {
            finalResult.recoveryScreenshotError =
              screenshotResult?.error || 'Failed to capture screenshot for recovery.';
          }
        } catch (visionError) {
          console.warn('[Glide] Auto-screenshot recovery failed:', visionError);
          finalResult.recoveryScreenshotError = String(
            (visionError as { message?: string })?.message || visionError || '',
          );
        }
      }

      if (
        toolName === 'screenshot' &&
        finalResult?.success &&
        finalResult.dataUrl &&
        isVisionBridgeEnabled(effectiveSettings) &&
        options.visionProfile?.apiKey
      ) {
        try {
          const vision = await this.describeImageForRun(options.runMeta, {
            dataUrl: finalResult.dataUrl,
            prompt: 'Provide a concise description of this screenshot for a non-vision model.',
            visionProfile: options.visionProfile,
            tool: toolName,
            callId,
            source: 'screenshot',
            settings: effectiveSettings,
          });
          if (vision.description) {
            finalResult.visionDescription = vision.description;
            finalResult.message = 'Screenshot captured and described by vision model.';
            recoveryStage = 'vision';
          } else if (vision.pending) {
            finalResult.message = 'Screenshot captured. Vision description is processing asynchronously.';
            finalResult.visionPending = true;
          }
        } catch (visionError) {
          finalResult.visionError = (visionError as Error).message;
        }
      }

      if (
        (toolName === 'screenshot' || finalResult.recoveryScreenshotDataUrl) &&
        !this.shouldIncludeScreenshotData(effectiveSettings)
      ) {
        if (typeof finalResult.dataUrl === 'string') {
          const modelImageDataUrl = finalResult.dataUrl;
          const stored = await this.persistScreenshotHandle(finalResult);
          finalResult.screenshotId = stored.screenshotId;
          finalResult.dataUrlLength = stored.dataUrlLength;
          delete finalResult.dataUrl;
          if (
            toolName === 'screenshot' &&
            migrateStoredProvider(effectiveSettings?.provider, effectiveSettings?.customEndpoint) === 'anthropic'
          ) {
            // Side-channel keyed by toolCallId so the base64 reaches the AI SDK's
            // toModelOutput (multimodal vision) WITHOUT riding on the result object
            // (downstream spreads/serialization would drop or leak it otherwise).
            this.stashModelScreenshotImage(callId, modelImageDataUrl);
          }
        }
        if (typeof finalResult.recoveryScreenshotDataUrl === 'string') {
          const stored = await this.persistScreenshotHandle({
            dataUrl: finalResult.recoveryScreenshotDataUrl,
          });
          finalResult.recoveryScreenshotId = stored.screenshotId;
          finalResult.recoveryScreenshotDataUrlLength = stored.dataUrlLength;
          delete finalResult.recoveryScreenshotDataUrl;
        }
      }

      const failureClass = this.classifyFailure(toolName, finalResult);
      if (failureClass !== 'unknown') {
        finalResult.failureClass = failureClass;
      }
      finalResult.recoveryStage = finalResult.recoveryStage || recoveryStage;
      finalResult.evidenceConfidence =
        finalResult.evidenceConfidence || this.deriveEvidenceConfidence(toolName, finalResult);
      finalResult.attempt = typeof toolArgs?.attempt === 'number' ? toolArgs.attempt : 1;
      finalResult.nextHint = finalResult.nextHint || this.buildNextHint(toolName, finalResult, failureClass);
      if (!isolatedRun) {
        this.captureEvidenceFromToolResult(toolName, finalResult, toolArgs);
      }

      const sanitizedResult = this.sanitizeToolResultForRuntime(finalResult, toolName, effectiveSettings);
      const enrichedResult = isolatedRun ? sanitizedResult : this.attachPlanToResult(sanitizedResult, toolName);
      const resultRecord =
        enrichedResult && typeof enrichedResult === 'object' && !Array.isArray(enrichedResult)
          ? (enrichedResult as Record<string, any>)
          : {};
      sendResult(enrichedResult, toolArgs, {
        recoveryStage: resultRecord.recoveryStage as RecoveryStage | undefined,
        evidenceConfidence: resultRecord.evidenceConfidence as EvidenceConfidence | undefined,
        failureClass: resultRecord.failureClass as FailureClass | undefined,
      });
      return enrichedResult;
    } finally {
      this.activeInFlightToolCalls -= 1;
      this.touchActiveRun(options.runMeta.runId);
    }
  }

  async hydrateExecutionEvents() {
    if (this.executionEventsHydrated) return;
    let loaded: unknown[] = [];

    try {
      const stored = await chrome.storage.session.get([EXECUTION_EVENTS_KEY]);
      loaded = Array.isArray(stored?.[EXECUTION_EVENTS_KEY]) ? stored[EXECUTION_EVENTS_KEY] : [];
    } catch {
      // Session storage may be unavailable in some contexts.
    }

    if (!Array.isArray(loaded) || loaded.length === 0) {
      try {
        const fallback = await chrome.storage.local.get([EXECUTION_EVENTS_KEY]);
        loaded = Array.isArray(fallback?.[EXECUTION_EVENTS_KEY]) ? fallback[EXECUTION_EVENTS_KEY] : [];
      } catch {
        loaded = [];
      }
    }

    const normalized = loaded
      .map((event) => this.normalizeExecutionEvent(event))
      .filter((event): event is ExecutionEvent => Boolean(event));

    if (normalized.length > 0) {
      if (this.executionEvents.length > 0) {
        const map = new Map<string, ExecutionEvent>();
        normalized.forEach((event) => map.set(event.id, event));
        this.executionEvents.forEach((event) => map.set(event.id, event));
        this.executionEvents = Array.from(map.values()).slice(-MAX_EXECUTION_EVENTS);
      } else {
        this.executionEvents = normalized.slice(-MAX_EXECUTION_EVENTS);
      }
    }

    this.executionEventsHydrated = true;
  }

  normalizeExecutionEvent(event: unknown): ExecutionEvent | null {
    if (!event || typeof event !== 'object') return null;
    const raw = event as Record<string, unknown>;
    const startedAt = Number(raw.startedAt || 0);
    const endedAt = Number(raw.endedAt || startedAt);
    const success = raw.success !== false;
    const tabId = typeof raw.tabId === 'number' ? raw.tabId : null;

    return {
      id: this.trimExecutionText(String(raw.id || `evt_${Date.now()}`), 80),
      runId: this.trimExecutionText(String(raw.runId || ''), 80),
      turnId: this.trimExecutionText(String(raw.turnId || ''), 80),
      sessionId: this.trimExecutionText(String(raw.sessionId || ''), 80),
      toolName: this.trimExecutionText(String(raw.toolName || ''), 60),
      callId: this.trimExecutionText(String(raw.callId || ''), 80),
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      endedAt: Number.isFinite(endedAt) ? endedAt : Date.now(),
      durationMs: Math.max(0, Number(raw.durationMs || endedAt - startedAt || 0)),
      tabId,
      url: this.trimExecutionText(String(raw.url || ''), EXECUTION_TEXT_LIMIT),
      success,
      errorCode: this.trimExecutionText(String(raw.errorCode || ''), 80),
      errorMessage: this.trimExecutionText(String(raw.errorMessage || ''), EXECUTION_TEXT_LIMIT),
      resultPreview: this.trimExecutionText(String(raw.resultPreview || ''), EXECUTION_PREVIEW_LIMIT),
    };
  }

  trimExecutionText(value: string, limit: number) {
    const text = String(value || '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...`;
  }

  isSensitiveTelemetryKey(key: string) {
    const normalized = String(key || '').toLowerCase();
    if (!normalized) return false;
    return (
      normalized.includes('apikey') ||
      normalized.includes('api_key') ||
      normalized.includes('token') ||
      normalized.includes('secret') ||
      normalized.includes('password') ||
      normalized.includes('authorization') ||
      normalized.includes('cookie') ||
      normalized === 'text' ||
      normalized === 'value' ||
      normalized === 'content'
    );
  }

  sanitizeTelemetryValue(value: unknown, key = '', depth = 0): unknown {
    return compactValue(value, 'telemetry', key, depth);
  }

  stringifyExecutionPreview(value: unknown) {
    try {
      if (typeof value === 'string') {
        return this.trimExecutionText(value, EXECUTION_PREVIEW_LIMIT);
      }
      if (value && typeof value === 'object') {
        const sanitized = this.sanitizeTelemetryValue(value, '', 0);
        return this.trimExecutionText(JSON.stringify(sanitized), EXECUTION_PREVIEW_LIMIT);
      }
      return this.trimExecutionText(JSON.stringify(value), EXECUTION_PREVIEW_LIMIT);
    } catch {
      return this.trimExecutionText(String(value), EXECUTION_PREVIEW_LIMIT);
    }
  }

  getScreenshotRetentionMode(
    settings: Record<string, any> | null = this.currentSettings,
  ): 'ephemeral' | 'debug-short' | 'persistent' {
    const raw = String(settings?.screenshotRetention || 'ephemeral').toLowerCase();
    if (raw === 'persistent') return 'persistent';
    if (raw === 'debug-short') return 'debug-short';
    return 'ephemeral';
  }

  shouldIncludeScreenshotData(settings: Record<string, any> | null = this.currentSettings) {
    const retention = this.getScreenshotRetentionMode(settings);
    if (retention === 'persistent') return true;
    if (retention === 'debug-short') return settings?.sendScreenshotsAsImages === true;
    return false;
  }

  sanitizeToolResultForRuntime(
    result: Record<string, any>,
    toolName: string,
    settings: Record<string, any> | null = this.currentSettings,
  ) {
    const sanitized: Record<string, any> = { ...result };
    const dropDataUrlField = (field: string) => {
      if (typeof sanitized[field] !== 'string') return;
      sanitized[`${field}Length`] = sanitized[field].length;
      delete sanitized[field];
    };

    if (!this.shouldIncludeScreenshotData(settings)) {
      dropDataUrlField('dataUrl');
      dropDataUrlField('recoveryScreenshotDataUrl');
    }

    if (typeof sanitized.error === 'string') sanitized.error = this.trimExecutionText(sanitized.error, 300);
    if (typeof sanitized.hint === 'string') sanitized.hint = this.trimExecutionText(sanitized.hint, 400);
    if (typeof sanitized.nextHint === 'string') sanitized.nextHint = this.trimExecutionText(sanitized.nextHint, 400);
    if (typeof sanitized.visualContext === 'string') {
      sanitized.visualContext = this.trimExecutionText(sanitized.visualContext, 1200);
    }
    if (typeof sanitized.visionDescription === 'string') {
      sanitized.visionDescription = this.trimExecutionText(sanitized.visionDescription, 1200);
    }
    if (Array.isArray(sanitized.similar_elements) && sanitized.similar_elements.length > 12) {
      sanitized.similar_elements = sanitized.similar_elements.slice(0, 12);
    }

    if (toolName !== 'screenshot') {
      dropDataUrlField('dataUrl');
    }

    return sanitized;
  }

  summarizePlanForHistory(plan: unknown) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
    const source = plan as Record<string, any>;
    const steps = Array.isArray(source.steps) ? source.steps : [];
    let doneCount = 0;
    let runningCount = 0;
    for (const step of steps) {
      if (step?.status === 'done') doneCount++;
      else if (step?.status === 'running') runningCount++;
    }

    return {
      stepCount: steps.length,
      doneCount,
      runningCount,
      updatedAt: Number(source.updatedAt || 0) || null,
    };
  }

  compactToolValueForHistory(value: unknown, key: string, depth = 0): unknown {
    return compactValue(value, 'history', key, depth);
  }

  compactToolResultsForHistory(toolResults: Array<Record<string, any>> = []) {
    if (!Array.isArray(toolResults) || toolResults.length === 0) return [];
    return toolResults.map((resultItem) => {
      const toolName = String(resultItem?.toolName || resultItem?.name || '');
      const rawOutput = Object.prototype.hasOwnProperty.call(resultItem, 'output')
        ? resultItem.output
        : resultItem.result;
      const compactOutput = this.compactToolOutputForHistory(rawOutput, toolName);
      return {
        ...resultItem,
        output: compactOutput,
        result: compactOutput,
      };
    });
  }

  async maybeCompactContext({
    runMeta,
    history,
    contextLimit,
    model,
    runtimeProfile,
    runtimeSettings,
  }: {
    runMeta: RunMeta;
    history: Message[];
    contextLimit: number;
    model: ReturnType<typeof getCachedLanguageModel>;
    runtimeProfile: Record<string, any>;
    runtimeSettings: Record<string, any>;
  }): Promise<Message[] | null> {
    const compactionSettings = DEFAULT_COMPACTION_SETTINGS;
    const contextUsage = estimateContextTokens(history);
    const compactionCheck = shouldCompact({
      contextTokens: contextUsage.tokens,
      contextLimit,
      settings: compactionSettings,
      sessionId: runMeta.sessionId,
    });
    if (!compactionCheck.shouldCompact) return null;

    let summaryIndex = -1;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const msg = history[i];
      if (msg.role === 'system' && msg.meta?.kind === 'summary') {
        summaryIndex = i;
        break;
      }
    }

    const previousSummary =
      summaryIndex >= 0
        ? typeof history[summaryIndex].content === 'string'
          ? history[summaryIndex].content
          : JSON.stringify(history[summaryIndex].content)
        : undefined;

    const compactionStart = summaryIndex >= 0 ? summaryIndex + 1 : 0;
    let cutIndex = findCutPoint(history, compactionStart, compactionSettings.keepRecentTokens);
    let messagesToSummarize = history.slice(compactionStart, cutIndex);
    if (messagesToSummarize.length === 0) {
      const forced = forceCompactionCut(history, compactionStart, compactionSettings.keepRecentTokens);
      cutIndex = forced.cutIndex;
      messagesToSummarize = forced.messagesToSummarize;
    }
    const preserved = history.slice(cutIndex);
    if (messagesToSummarize.length === 0) return null;

    const conversationText = serializeConversation(messagesToSummarize);
    let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
    if (previousSummary) {
      promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    }
    promptText += previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;

    const compactionTimeoutMs = resolveTimeoutMs(runtimeProfile.timeout ?? runtimeSettings.timeout);
    const compactionBackoff = createExponentialBackoff({ baseMs: 1000, maxMs: 8000 });
    const MAX_COMPACTION_RETRIES = 3;
    let summaryText: string | null = null;

    for (let attempt = 0; attempt < MAX_COMPACTION_RETRIES; attempt += 1) {
      const compactionRun = await withAbortTimeout(compactionTimeoutMs, (signal) =>
        generateText({
          model,
          ...resolveProviderOptions(runtimeProfile.provider),
          system: this.sanitizeSystemPrompt(SUMMARIZATION_SYSTEM_PROMPT, runtimeProfile.provider),
          messages: [{ role: 'user', content: promptText }],
          temperature: resolveTemperature(0.2, runtimeProfile.provider),
          maxOutputTokens: Math.floor(0.8 * compactionSettings.reserveTokens),
          abortSignal: signal,
        }),
      );

      if (compactionRun.timedOut || (compactionRun.error && isAbortError(compactionRun.error))) {
        this.sendRuntime(runMeta, {
          type: 'run_warning',
          message: `Context compaction timed out after ${compactionTimeoutMs}ms (attempt ${attempt + 1}/${MAX_COMPACTION_RETRIES}).`,
        });
      } else if (compactionRun.error) {
        const status = extractProviderErrorStatus(compactionRun.error);
        console.warn('Context compaction failed:', compactionRun.error);
        if (!isRetryableProviderError(status)) break;
      } else if (compactionRun.result?.text?.trim()) {
        summaryText = compactionRun.result.text.trim();
        break;
      }

      if (attempt < MAX_COMPACTION_RETRIES - 1) {
        const delayMs = compactionBackoff(attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (!summaryText) {
      summaryText = buildTruncateOnlySummary(messagesToSummarize);
      this.sendRuntime(runMeta, {
        type: 'run_warning',
        message: 'Context compaction fell back to truncate-only summary.',
      });
    }

    const summaryMessage = buildCompactionSummaryMessage(summaryText, messagesToSummarize.length);
    const compaction = applyCompaction({
      summaryMessage,
      preserved,
      trimmedCount: messagesToSummarize.length,
    });
    const compactedUsage = estimateContextTokens(compaction.compacted);
    const newSessionId = `session-${Date.now()}`;

    this.sendRuntime(runMeta, {
      type: 'context_compacted',
      summary: summaryText,
      trimmedCount: messagesToSummarize.length,
      preservedCount: compaction.preservedCount,
      newSessionId,
      contextMessages: compaction.compacted,
      contextUsage: {
        approxTokens: compactedUsage.tokens,
        contextLimit,
        percent: Math.min(100, Math.round((compactedUsage.tokens / contextLimit) * 100)),
      },
    });

    return normalizeConversationHistory(compaction.compacted);
  }

  compactToolOutputForHistory(output: unknown, toolName: string) {
    if (output === null || output === undefined) return output;
    if (typeof output === 'string') return this.trimExecutionText(output, 1800);
    if (Array.isArray(output)) {
      return this.compactToolValueForHistory(output, '', 0);
    }
    if (!output || typeof output !== 'object') {
      return output;
    }

    const runtimeSanitized = this.sanitizeToolResultForRuntime(output as Record<string, any>, toolName);
    const compacted: Record<string, unknown> = {};
    const planSummary = this.summarizePlanForHistory(runtimeSanitized.plan);
    if (planSummary) {
      compacted.planSummary = planSummary;
    }

    const entries = Object.entries(runtimeSanitized).filter(([key]) => key !== 'plan');
    const maxEntries = 26;
    for (const [key, value] of entries.slice(0, maxEntries)) {
      compacted[key] = this.compactToolValueForHistory(value, key, 0);
    }
    if (entries.length > maxEntries) {
      compacted.truncatedFieldCount = entries.length - maxEntries;
    }

    return compacted;
  }

  buildToolResultMessageContent(toolResults: Array<Record<string, any>> = []) {
    if (!Array.isArray(toolResults) || toolResults.length === 0) return [];

    return toolResults.map((resultItem) => {
      const toolName = String(resultItem?.toolName || resultItem?.name || '');
      const rawOutput = Object.prototype.hasOwnProperty.call(resultItem, 'output')
        ? resultItem.output
        : (resultItem as Record<string, unknown>).result;
      const compactOutput = this.compactToolOutputForHistory(rawOutput, toolName);

      return {
        type: 'tool-result' as const,
        toolCallId: resultItem.toolCallId,
        toolName,
        output:
          compactOutput && typeof compactOutput === 'object'
            ? { type: 'json' as const, value: compactOutput }
            : { type: 'text' as const, value: String(compactOutput ?? '') },
      };
    });
  }

  classifyFailure(toolName: string, result: Record<string, any>): FailureClass {
    if (!result || result.success !== false) return 'unknown';
    const code = String(result.code || '').toLowerCase();
    const message = String(result.error || '').toLowerCase();
    const policyReason = String(result.policy?.reason || '').toLowerCase();

    if (
      code.includes('permission') ||
      message.includes('permission blocked') ||
      message.includes('allowlist') ||
      policyReason.includes('blocked')
    ) {
      return 'permission';
    }

    if (code.includes('timeout') || message.includes('timed out') || message.includes('timeout')) {
      return 'timing';
    }

    if (
      toolName === 'navigate' ||
      code === 'no_executable_tab' ||
      message.includes('invalid url') ||
      message.includes('navigation failed') ||
      message.includes('no active tab')
    ) {
      return 'navigation';
    }

    if (
      code === 'tab_inaccessible' ||
      message.includes('selector') ||
      message.includes('element not found') ||
      message.includes('target not found')
    ) {
      return 'selector';
    }

    return 'unknown';
  }

  deriveEvidenceConfidence(toolName: string, result: Record<string, any>): EvidenceConfidence {
    if (!result || result.success === false) return 'low';
    if (toolName === 'getContent') return 'high';
    if (toolName === 'screenshot' && (result.visionDescription || result.visualContext)) return 'high';
    if (result.visualContext || result.visionDescription) return 'medium';
    return 'medium';
  }

  buildNextHint(toolName: string, result: Record<string, any>, failureClass: FailureClass) {
    if (!result || result.success !== false) {
      if (toolName === 'getContent') return 'Use this evidence to update the plan step before continuing.';
      if (toolName === 'screenshot') return 'Use visionDescription or visualContext to pick the next interaction.';
      return 'Continue with the next plan step and verify with getContent.';
    }

    if (failureClass === 'selector') {
      return 'Call getContent({ mode: "structure" }) and retry with text-based or aria-label selectors.';
    }
    if (failureClass === 'timing') {
      return 'Wait briefly, then retry the same step or scroll to trigger lazy-rendered elements.';
    }
    if (failureClass === 'permission') {
      return 'Adjust tool permissions/allowlist in settings, then rerun the action.';
    }
    if (failureClass === 'navigation') {
      return 'Ensure you are on an accessible http(s) tab and retry navigation.';
    }
    return 'Call getContent({ mode: "structure" }), review visible elements, and retry with an alternative strategy.';
  }

  resolveExecutionTabId(args: Record<string, any> | undefined, result: Record<string, any> | undefined) {
    if (typeof args?.tabId === 'number') return args.tabId;
    if (typeof result?.resolvedTabId === 'number') return result.resolvedTabId;
    if (typeof result?.tabId === 'number') return result.tabId;
    return null;
  }

  resolveExecutionUrl(args: Record<string, any> | undefined, result: Record<string, any> | undefined) {
    if (typeof args?.url === 'string' && args.url.trim()) return this.trimExecutionText(args.url, EXECUTION_TEXT_LIMIT);
    if (typeof result?.resolvedUrl === 'string' && result.resolvedUrl.trim()) {
      return this.trimExecutionText(result.resolvedUrl, EXECUTION_TEXT_LIMIT);
    }
    if (typeof result?.url === 'string' && result.url.trim()) {
      return this.trimExecutionText(result.url, EXECUTION_TEXT_LIMIT);
    }
    if (typeof result?.policy?.domain === 'string' && result.policy.domain.trim()) {
      return this.trimExecutionText(result.policy.domain, EXECUTION_TEXT_LIMIT);
    }
    return '';
  }

  recordExecutionEvent(
    runMeta: RunMeta,
    payload: {
      toolName: string;
      callId: string;
      args?: Record<string, any>;
      result?: unknown;
      startedAt: number;
    },
  ) {
    const endedAt = Date.now();
    const resultRecord =
      payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
        ? (payload.result as Record<string, any>)
        : undefined;

    const success = !(resultRecord?.success === false || resultRecord?.error);
    const errorCode =
      typeof resultRecord?.code === 'string'
        ? this.trimExecutionText(resultRecord.code, 80)
        : success
          ? ''
          : 'TOOL_ERROR';
    const errorMessage = success
      ? ''
      : this.trimExecutionText(String(resultRecord?.error || 'Tool execution failed'), EXECUTION_TEXT_LIMIT);

    const executionEvent: ExecutionEvent = {
      id: `evt_${endedAt}_${Math.random().toString(36).slice(2, 8)}`,
      runId: runMeta.runId,
      turnId: runMeta.turnId,
      sessionId: runMeta.sessionId,
      toolName: this.trimExecutionText(payload.toolName, 60),
      callId: this.trimExecutionText(payload.callId, 80),
      startedAt: payload.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - payload.startedAt),
      tabId: this.resolveExecutionTabId(payload.args, resultRecord),
      url: this.resolveExecutionUrl(payload.args, resultRecord),
      success,
      errorCode,
      errorMessage,
      resultPreview: this.stringifyExecutionPreview(payload.result),
    };

    this.executionEvents.push(executionEvent);
    if (this.executionEvents.length > MAX_EXECUTION_EVENTS) {
      this.executionEvents = this.executionEvents.slice(-MAX_EXECUTION_EVENTS);
    }
    // Skip storage flush when a run is in progress — buffer in memory only.
    // The flush timer is still scheduled but just marks dirty; actual write
    // happens only once the run ends or after a quiet period.
    if (!this.activeRunId) {
      this.scheduleExecutionEventsFlush();
    } else {
      this._executionEventsDirty = true;
    }
  }

  private _executionEventsDirty = false;

  scheduleExecutionEventsFlush() {
    if (this.executionEventsFlushTimerId) {
      clearTimeout(this.executionEventsFlushTimerId);
    }
    // Fix: Increased debounce from 300ms to 2000ms to reduce storage writes during long tasks.
    this.executionEventsFlushTimerId = setTimeout(() => {
      this.executionEventsFlushTimerId = null;
      void this.flushExecutionEvents();
    }, 2000);
  }

  async flushExecutionEvents() {
    const payload = {
      [EXECUTION_EVENTS_KEY]: this.executionEvents.slice(-MAX_EXECUTION_EVENTS),
    };
    try {
      await chrome.storage.session.set(payload);
      return;
    } catch {
      // Fallback for environments where session storage is unavailable.
    }
    try {
      const minimalEvents = this.executionEvents.slice(-120).map((event) => ({
        ...event,
        errorMessage: this.trimExecutionText(event.errorMessage || '', 140),
        resultPreview: event.success ? '' : this.trimExecutionText(event.resultPreview || '', 160),
      }));
      await chrome.storage.local.set({
        [EXECUTION_EVENTS_KEY]: minimalEvents,
      });
    } catch (error) {
      console.warn('Failed to persist execution events:', error);
    }
  }

  getExecutionEventsSnapshot() {
    return this.executionEvents.slice(-MAX_EXECUTION_EVENTS);
  }

  addEvidenceEntry(
    section: EvidenceEntry['section'],
    source: string,
    text: unknown,
    options: {
      mode?: string;
      url?: string;
      title?: string;
    } = {},
  ) {
    const normalizedText = this.normalizeSummaryText(text || '');
    if (!normalizedText) return;
    const textPreview = this.truncateSummaryText(normalizedText, 320);
    const key = `${section}:${textPreview.toLowerCase()}`;
    if (this.evidenceKeys.has(key)) return;
    this.evidenceKeys.add(key);
    this.evidenceLedger.push({
      key,
      section,
      source: this.normalizeSummaryText(source || 'tool'),
      mode: options.mode ? this.normalizeSummaryText(options.mode) : undefined,
      text: textPreview,
      url: options.url ? this.truncateSummaryText(String(options.url), 260) : undefined,
      title: options.title ? this.truncateSummaryText(String(options.title), 200) : undefined,
      timestamp: Date.now(),
    });
    if (this.evidenceLedger.length > 120) {
      const removed = this.evidenceLedger.shift();
      if (removed) this.evidenceKeys.delete(removed.key);
      this.evidenceLedger = this.evidenceLedger.slice(-120);
    }
  }

  captureEvidenceFromStructure(structure: Record<string, any> = {}, source = 'getContent') {
    const title = this.normalizeSummaryText(structure.title || '');
    const url = this.normalizeSummaryText(structure.url || '');
    const addListEvidence = (
      list: unknown[],
      section: EvidenceEntry['section'],
      extractor: (value: unknown) => string,
      maxItems = 8,
    ) => {
      if (!Array.isArray(list)) return;
      for (const item of list.slice(0, maxItems)) {
        const text = extractor(item);
        if (!text) continue;
        this.addEvidenceEntry(section, source, text, { mode: 'structure', url, title });
      }
    };

    addListEvidence(structure.sidebarItems, 'sidebar', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || item?.label || item?.href || '').trim();
    });
    addListEvidence(structure.cards, 'cards', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.title || item?.heading || item?.summary || '').trim();
    });
    addListEvidence(structure.tables, 'tables', (value) => {
      const item = value as Record<string, unknown>;
      const label = String(item?.caption || item?.id || 'table').trim();
      const rowCount = Number(item?.rows || 0);
      return rowCount > 0 ? `${label} (${rowCount} rows)` : label;
    });
    addListEvidence(structure.filters, 'filters', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.label || item?.placeholder || item?.name || '').trim();
    });
    addListEvidence(structure.tabs, 'tabs', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || item?.label || '').trim();
    });
    addListEvidence(structure.badges, 'badges', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || item?.label || '').trim();
    });
    addListEvidence(structure.kpis, 'kpis', (value) => {
      const item = value as Record<string, unknown>;
      const label = String(item?.label || '').trim();
      const metric = String(item?.value || '').trim();
      return [label, metric].filter(Boolean).join(': ');
    });
    addListEvidence(structure.headings, 'workspace', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || '').trim();
    });
    addListEvidence(structure.actions, 'actions', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || item?.id || '').trim();
    });
  }

  captureEvidenceFromToolResult(toolName: string, result: Record<string, any>, args: Record<string, any> = {}) {
    if (!result || typeof result !== 'object') return;
    if (result.success === false) return;

    if (toolName === 'getContent') {
      const mode = String(result.mode || args.mode || args.type || 'text');
      if (mode === 'structure' && result.structure && typeof result.structure === 'object') {
        this.captureEvidenceFromStructure(result.structure as Record<string, any>, 'getContent');
      }
      if (typeof result.content === 'string' && result.content.trim()) {
        const parsed = this.tryParseStructuredSnapshot(result.content);
        if (parsed) {
          this.captureEvidenceFromStructure(parsed, 'getContent');
        } else {
          this.addEvidenceEntry('content', 'getContent', result.content, {
            mode,
            url: typeof result?.structure?.url === 'string' ? result.structure.url : '',
            title: typeof result?.structure?.title === 'string' ? result.structure.title : '',
          });
        }
      }
      return;
    }

    if (toolName === 'screenshot') {
      if (typeof result.visionDescription === 'string' && result.visionDescription.trim()) {
        this.addEvidenceEntry('visual', 'screenshot', result.visionDescription, { mode: 'vision' });
      } else if (typeof result.visualContext === 'string' && result.visualContext.trim()) {
        this.addEvidenceEntry('visual', 'screenshot', result.visualContext, { mode: 'context' });
      }
      return;
    }

    if (typeof result.message === 'string' && result.message.trim()) {
      this.addEvidenceEntry('unknown', toolName, result.message, { mode: String(args?.mode || '') });
    }
  }

  normalizeSummaryText(value: unknown) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  tryParseStructuredSnapshot(value: unknown) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') return null;
      const hasStructureSignals =
        Array.isArray((parsed as Record<string, unknown>).headings) ||
        Array.isArray((parsed as Record<string, unknown>).actions) ||
        Array.isArray((parsed as Record<string, unknown>).sidebarItems) ||
        Array.isArray((parsed as Record<string, unknown>).cards) ||
        Array.isArray((parsed as Record<string, unknown>).tables) ||
        Array.isArray((parsed as Record<string, unknown>).filters) ||
        Array.isArray((parsed as Record<string, unknown>).tabs) ||
        Array.isArray((parsed as Record<string, unknown>).badges) ||
        Array.isArray((parsed as Record<string, unknown>).kpis) ||
        typeof (parsed as Record<string, unknown>).title === 'string';
      return hasStructureSignals ? (parsed as Record<string, any>) : null;
    } catch {
      return null;
    }
  }

  summarizeStructuredSnapshot(snapshot: Record<string, any> = {}) {
    const title = this.normalizeSummaryText(snapshot.title || '');
    const url = this.normalizeSummaryText(snapshot.url || '');
    const headings = Array.isArray(snapshot.headings) ? snapshot.headings : [];
    const actions = Array.isArray(snapshot.actions) ? snapshot.actions : [];
    const sidebarItems = Array.isArray(snapshot.sidebarItems) ? snapshot.sidebarItems : [];
    const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
    const kpis = Array.isArray(snapshot.kpis) ? snapshot.kpis : [];

    const snippets: string[] = [];
    if (title) {
      snippets.push(`Pagina analisada: ${title}`);
    }

    if (url) {
      try {
        const urlObj = new URL(url);
        snippets.push(`Fonte: ${urlObj.hostname}`);
      } catch {
        // Ignore malformed URLs in summary text.
      }
    }

    const firstHeading = headings
      .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || ''))
      .find(Boolean);
    if (firstHeading) {
      snippets.push(`Destaque: ${firstHeading}`);
    }

    if (sidebarItems.length > 0) {
      const firstSidebar = sidebarItems
        .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || item?.label || ''))
        .filter(Boolean)
        .slice(0, 4);
      if (firstSidebar.length > 0) {
        snippets.push(`Sidebar: ${firstSidebar.join(', ')}`);
      }
    }

    if (cards.length > 0) {
      const firstCards = cards
        .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.title || item?.heading || ''))
        .filter(Boolean)
        .slice(0, 4);
      if (firstCards.length > 0) {
        snippets.push(`Cards: ${firstCards.join(', ')}`);
      }
    }

    if (kpis.length > 0) {
      const firstKpis = kpis
        .map((item: Record<string, unknown>) =>
          this.normalizeSummaryText(
            [item?.label || '', item?.value || '']
              .map((part) => String(part || '').trim())
              .filter(Boolean)
              .join(': '),
          ),
        )
        .filter(Boolean)
        .slice(0, 3);
      if (firstKpis.length > 0) {
        snippets.push(`KPIs: ${firstKpis.join(', ')}`);
      }
    }

    const actionLabels = actions
      .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || item?.label || ''))
      .filter((text: string) => Boolean(text) && text.length > 2)
      .slice(0, 3);
    if (actionLabels.length > 0) {
      snippets.push(`Opcoes visiveis: ${actionLabels.join(', ')}`);
    }

    return this.truncateSummaryText(snippets.join('. '), 700);
  }

  truncateSummaryText(value: string, limit = 900) {
    const normalized = this.normalizeSummaryText(value);
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, limit)}...`;
  }

  isGenericCompletionText(value: unknown) {
    const normalized = this.normalizeSummaryText(value).toLowerCase();
    return normalized === GENERIC_TOOL_COMPLETION_TEXT.toLowerCase();
  }

  extractToolResultOutput(toolResult: Record<string, any>) {
    if (toolResult && typeof toolResult === 'object') {
      if (toolResult.output && typeof toolResult.output === 'object') {
        return toolResult.output as Record<string, any>;
      }
      if (toolResult.result && typeof toolResult.result === 'object') {
        return toolResult.result as Record<string, any>;
      }
      return toolResult;
    }
    return {};
  }

  buildStructureFallback(structure: Record<string, any> = {}) {
    const structuredSummary = this.summarizeStructuredSnapshot(structure);
    if (structuredSummary) return structuredSummary;

    const headings = Array.isArray(structure.headings) ? structure.headings : [];
    const actions = Array.isArray(structure.actions) ? structure.actions : [];
    const snippets: string[] = [];

    if (headings.length > 0) {
      const firstHeadings = headings
        .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || ''))
        .filter(Boolean)
        .slice(0, 4);
      if (firstHeadings.length > 0) {
        snippets.push(`Titulos detectados: ${firstHeadings.join(', ')}`);
      }
    }

    if (actions.length > 0) {
      const actionLabels = actions
        .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || item?.label || ''))
        .filter(Boolean)
        .slice(0, 4);
      if (actionLabels.length > 0) {
        snippets.push(`Acoes visiveis: ${actionLabels.join(', ')}`);
      }
    }

    return snippets.join('. ');
  }

  buildToolResultFallback(toolResults: Array<Record<string, any>> = []) {
    if (!Array.isArray(toolResults) || toolResults.length === 0) return '';

    const errors = new Set<string>();
    const contentCandidates: string[] = [];

    for (const item of toolResults) {
      const toolName = String(item?.toolName || item?.name || '');
      const output = this.extractToolResultOutput(item);
      const success = !(output?.success === false || output?.error);

      if (!success && toolName) {
        errors.add(toolName);
      }

      if (toolName === 'getContent') {
        if (output?.mode === 'structure' && output?.structure && typeof output.structure === 'object') {
          const structureText = this.buildStructureFallback(output.structure as Record<string, any>);
          if (structureText) {
            contentCandidates.push(structureText);
          }
        }
        if (typeof output?.content === 'string' && output.content.trim()) {
          const parsedSnapshot = this.tryParseStructuredSnapshot(output.content);
          if (parsedSnapshot) {
            const structureText = this.buildStructureFallback(parsedSnapshot);
            if (structureText) {
              contentCandidates.push(structureText);
            }
          } else {
            contentCandidates.push(output.content);
          }
        }
      }

      if (typeof output?.visualContext === 'string' && output.visualContext.trim()) {
        contentCandidates.push(output.visualContext);
      }

      if (
        toolName === 'screenshot' &&
        typeof output?.visionDescription === 'string' &&
        output.visionDescription.trim()
      ) {
        contentCandidates.push(output.visionDescription);
      }
    }

    const primary =
      contentCandidates.length > 0
        ? this.truncateSummaryText(contentCandidates[contentCandidates.length - 1], 700)
        : '';
    const errorText = errors.size > 0 ? ` Algumas acoes falharam (${Array.from(errors).join(', ')}).` : '';

    if (primary) {
      const prefix = errors.size > 0 ? 'Coleta parcial concluida' : 'Resumo automatico com base nos dados coletados';
      return this.truncateSummaryText(`${prefix}: ${primary}.${errorText}`.trim(), 900);
    }

    return this.truncateSummaryText(
      `Consegui executar as ferramentas e coletar dados da pagina.${errorText} Verifique os detalhes tecnicos para confirmar os itens extraidos.`,
      900,
    );
  }

  collectStructuredCatalog(toolResults: Array<Record<string, any>> = []) {
    const catalog = {
      title: '',
      url: '',
      sidebar: new Set<string>(),
      cards: new Set<string>(),
      actions: new Set<string>(),
      filters: new Set<string>(),
      tabs: new Set<string>(),
      tables: new Set<string>(),
      badges: new Set<string>(),
      kpis: new Set<string>(),
      headings: new Set<string>(),
      visuals: new Set<string>(),
      evidenceSnippets: new Set<string>(),
    };
    const add = (target: Set<string>, value: unknown, limit = 140) => {
      const normalized = this.truncateSummaryText(String(value || ''), limit);
      if (!normalized) return;
      target.add(normalized);
    };
    const ingestStructure = (structure: Record<string, any> = {}) => {
      if (!catalog.title) catalog.title = this.normalizeSummaryText(structure.title || '');
      if (!catalog.url) catalog.url = this.normalizeSummaryText(structure.url || '');
      (Array.isArray(structure.sidebarItems) ? structure.sidebarItems : []).forEach((item: Record<string, unknown>) =>
        add(catalog.sidebar, item?.text || item?.label || item?.href),
      );
      (Array.isArray(structure.cards) ? structure.cards : []).forEach((item: Record<string, unknown>) =>
        add(catalog.cards, item?.title || item?.heading || item?.summary),
      );
      (Array.isArray(structure.actions) ? structure.actions : []).forEach((item: Record<string, unknown>) =>
        add(catalog.actions, item?.text || item?.id),
      );
      (Array.isArray(structure.filters) ? structure.filters : []).forEach((item: Record<string, unknown>) =>
        add(catalog.filters, item?.label || item?.placeholder || item?.name),
      );
      (Array.isArray(structure.tabs) ? structure.tabs : []).forEach((item: Record<string, unknown>) =>
        add(catalog.tabs, item?.text || item?.label),
      );
      (Array.isArray(structure.tables) ? structure.tables : []).forEach((item: Record<string, unknown>) => {
        const caption = String(item?.caption || item?.id || 'table').trim();
        const rows = Number(item?.rows || 0);
        add(catalog.tables, rows > 0 ? `${caption} (${rows} rows)` : caption);
      });
      (Array.isArray(structure.badges) ? structure.badges : []).forEach((item: Record<string, unknown>) =>
        add(catalog.badges, item?.text || item?.label),
      );
      (Array.isArray(structure.kpis) ? structure.kpis : []).forEach((item: Record<string, unknown>) =>
        add(
          catalog.kpis,
          [String(item?.label || '').trim(), String(item?.value || '').trim()].filter(Boolean).join(': '),
        ),
      );
      (Array.isArray(structure.headings) ? structure.headings : []).forEach((item: Record<string, unknown>) =>
        add(catalog.headings, item?.text),
      );
    };

    for (const toolResult of toolResults) {
      const toolName = String(toolResult?.toolName || toolResult?.name || '');
      const output = this.extractToolResultOutput(toolResult);
      if (!output || typeof output !== 'object') continue;
      if (toolName === 'getContent') {
        if (output.mode === 'structure' && output.structure && typeof output.structure === 'object') {
          ingestStructure(output.structure as Record<string, any>);
        } else if (typeof output.content === 'string') {
          const parsed = this.tryParseStructuredSnapshot(output.content);
          if (parsed) ingestStructure(parsed);
          else add(catalog.evidenceSnippets, output.content, 220);
        }
      }
      if (typeof output.visualContext === 'string') add(catalog.visuals, output.visualContext, 180);
      if (typeof output.visionDescription === 'string') add(catalog.visuals, output.visionDescription, 180);
    }

    const sectionToCatalog: Record<string, Set<string> | undefined> = {
      sidebar: catalog.sidebar,
      cards: catalog.cards,
      actions: catalog.actions,
      filters: catalog.filters,
      tabs: catalog.tabs,
      tables: catalog.tables,
      badges: catalog.badges,
      kpis: catalog.kpis,
      workspace: catalog.headings,
      visual: catalog.visuals,
    };
    for (const evidence of this.evidenceLedger.slice(-30)) {
      add(catalog.evidenceSnippets, evidence.text, 200);
      const target = sectionToCatalog[evidence.section];
      if (target) add(target, evidence.text);
    }

    return catalog;
  }

  buildComprehensiveFallbackReport(toolResults: Array<Record<string, any>> = [], minimumSections = 5) {
    const catalog = this.collectStructuredCatalog(toolResults);
    const activePlan = this.currentPlan as RunPlan | null;
    const pendingSteps = activePlan ? activePlan.steps.filter((s) => s.status !== 'done') : [];
    const errors = toolResults
      .map((item) => {
        const tool = String(item?.toolName || item?.name || '');
        const output = this.extractToolResultOutput(item);
        if (output?.success === false || output?.error) {
          return tool || 'tool';
        }
        return '';
      })
      .filter(Boolean);

    const toList = (set: Set<string>, max = 8) => Array.from(set).slice(0, max);
    const scopeLines: string[] = [];
    if (catalog.title) scopeLines.push(`- Pagina: ${catalog.title}`);
    if (catalog.url) scopeLines.push(`- URL: ${catalog.url}`);
    if (!scopeLines.length) scopeLines.push('- Pagina detectada, mas sem metadados completos de titulo/URL.');

    const sections: Array<{ title: string; lines: string[] }> = [
      {
        title: 'Escopo Analisado',
        lines: scopeLines,
      },
      {
        title: 'Sidebar e Navegacao',
        lines: toList(catalog.sidebar).map((item) => `- ${item}`),
      },
      {
        title: 'Area de Trabalho e Cards',
        lines: [...toList(catalog.cards, 10), ...toList(catalog.kpis, 6)].map((item) => `- ${item}`),
      },
      {
        title: 'Funcoes e Modulos Detectados',
        lines: [
          ...toList(catalog.actions, 10),
          ...toList(catalog.tabs, 6),
          ...toList(catalog.filters, 6),
          ...toList(catalog.tables, 6),
          ...toList(catalog.badges, 6),
        ].map((item) => `- ${item}`),
      },
      {
        title: 'Evidencias Coletadas',
        lines: [
          ...toList(catalog.headings, 8),
          ...toList(catalog.visuals, 5),
          ...toList(catalog.evidenceSnippets, 8),
        ].map((item) => `- ${item}`),
      },
      {
        title: 'Pendencias e Riscos',
        lines: [
          ...(pendingSteps.length
            ? pendingSteps.slice(0, 6).map((step) => `- Etapa pendente: ${step.title}`)
            : ['- Plano concluido sem etapas pendentes.']),
          ...(errors.length
            ? [`- Ferramentas com falha: ${Array.from(new Set(errors)).join(', ')}`]
            : ['- Nenhuma falha de ferramenta registrada no ultimo passe.']),
        ],
      },
    ];

    for (const section of sections) {
      if (section.lines.length === 0) {
        section.lines.push('- Sem itens detectados nesta secao com as evidencias atuais.');
      }
    }

    const selectedSections = sections.slice(0, Math.min(sections.length, Math.max(3, minimumSections + 1)));
    return selectedSections
      .map((section) => `## ${section.title}\n${section.lines.join('\n')}`)
      .join('\n\n')
      .trim();
  }

  isLowDetailFinal(text: string, minimumReportSections = 5) {
    const normalized = this.normalizeSummaryText(text);
    if (!normalized) return true;
    const headingMatches = text.match(/^#{1,3}\s+/gm) || [];
    if (headingMatches.length >= Math.max(3, minimumReportSections - 1)) return false;
    return normalized.length < Math.max(420, minimumReportSections * 120);
  }

  buildQualityReport({
    qualityMode,
    minimumReportSections,
    plan,
    toolResults,
    finalText,
  }: {
    qualityMode: QualityMode;
    minimumReportSections: number;
    plan: RunPlan | null;
    toolResults: Array<Record<string, any>>;
    finalText: string;
  }) {
    const totalSteps = plan?.steps?.length || 0;
    const completedSteps = plan?.steps?.reduce((c, s) => c + (s.status === 'done' ? 1 : 0), 0) || 0;
    const pendingSteps =
      plan?.steps?.reduce((acc, s) => {
        if (s.status !== 'done') acc.push(s.title);
        return acc;
      }, [] as string[]) || [];
    const coverageSections = [
      'sidebar',
      'workspace',
      'cards',
      'tables',
      'actions',
      'filters',
      'tabs',
      'badges',
      'kpis',
      'visual',
    ] as const;
    const sectionCounts: Record<string, number> = {};
    for (const item of this.evidenceLedger) {
      sectionCounts[item.section] = (sectionCounts[item.section] || 0) + 1;
    }
    const coverageMap = Object.fromEntries(coverageSections.map((section) => [section, sectionCounts[section] || 0]));
    const sectionsCovered = coverageSections.filter((section) => coverageMap[section] > 0);
    const finalTextLength = this.normalizeSummaryText(finalText).length;
    const planCompletionRate = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
    const qualityScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          planCompletionRate * 0.55 +
            Math.min(100, (sectionsCovered.length / Math.max(1, minimumReportSections)) * 100) * 0.3 +
            Math.min(100, finalTextLength / 12) * 0.15,
        ),
      ),
    );
    const hasEnoughSections = sectionsCovered.length >= Math.max(3, minimumReportSections - 1);
    const status = completedSteps === totalSteps && totalSteps > 0 && hasEnoughSections ? 'passed' : 'needs_review';

    return {
      status,
      qualityMode,
      qualityScore,
      finalTextLength,
      minimumReportSections,
      plan: {
        totalSteps,
        completedSteps,
        pendingSteps,
        completionRate: planCompletionRate,
      },
      evidence: {
        totalItems: this.evidenceLedger.length,
        sectionsCovered,
        sectionCounts: coverageMap,
      },
      tools: {
        totalCalls: Array.isArray(toolResults) ? toolResults.length : 0,
      },
    };
  }

  attachPlanToResult(result: unknown, toolName: string) {
    if (!this.currentPlan || toolName === 'set_plan') return result;
    const planSummary = this.summarizePlanForHistory(this.currentPlan);
    if (!planSummary) return result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return { ...(result as Record<string, unknown>), planSummary };
    }
    return { result, planSummary };
  }

  dedupeRecoveredToolCalls(calls: Array<{ name: string; args: Record<string, unknown>; raw: string }>) {
    const seen = new Set<string>();
    const unique: Array<{ name: string; args: Record<string, unknown>; raw: string }> = [];
    for (const call of calls) {
      const key = `${call.name}:${JSON.stringify(call.args)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(call);
    }
    return unique;
  }

  extractXmlToolCalls(text: string): Array<{ name: string; args: Record<string, unknown>; raw: string }> {
    if (!text || typeof text !== 'string') return [];
    const results: Array<{ name: string; args: Record<string, unknown>; raw: string }> = [];
    const blocks: string[] = [];

    const blockRegex = /<\s*(?:tool|function)_call[^>]*>[\s\S]*?<\s*\/\s*(?:tool|function)_call\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(text))) {
      blocks.push(match[0]);
    }

    const inlineRegex = /([A-Za-z0-9_]+)\s*<\s*argkey\s*>[\s\S]*?<\s*\/\s*tool_call\s*>/gi;
    while ((match = inlineRegex.exec(text))) {
      blocks.push(match[0]);
    }

    if (!blocks.length && /<\s*argkey\s*>/i.test(text)) {
      blocks.push(text);
    }

    for (const block of blocks) {
      const name = this.extractXmlToolName(block);
      if (!name) continue;
      const args = this.extractXmlArgs(block);
      results.push({ name, args, raw: block });
    }

    return results;
  }

  extractXmlToolName(block: string): string {
    const nameMatch =
      block.match(/<\s*(?:tool|function)_name\s*>([^<]+)<\s*\/\s*(?:tool|function)_name\s*>/i) ||
      block.match(/<\s*name\s*>([^<]+)<\s*\/\s*name\s*>/i) ||
      block.match(/<\s*tool\s*>([^<]+)<\s*\/\s*tool\s*>/i) ||
      block.match(/<\s*function\s*>([^<]+)<\s*\/\s*function\s*>/i) ||
      block.match(/([A-Za-z0-9_]+)\s*<\s*argkey\s*>/i);

    if (!nameMatch) return '';
    const name = nameMatch[1] ? String(nameMatch[1]) : '';
    return name.trim();
  }

  extractXmlArgs(block: string): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    const pairRegex = /<\s*argkey\s*>([\s\S]*?)<\s*\/\s*argkey\s*>\s*<\s*argvalue\s*>([\s\S]*?)<\s*\/\s*argvalue\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = pairRegex.exec(block))) {
      const key = String(match[1] || '').trim();
      const value = this.coerceXmlArgValue(String(match[2] || '').trim());
      if (key) args[key] = value;
    }

    const namedRegex = /<\s*arg\s+name\s*=\s*['\"]?([^'\">]+)['\"]?\s*>([\s\S]*?)<\s*\/\s*arg\s*>/gi;
    while ((match = namedRegex.exec(block))) {
      const key = String(match[1] || '').trim();
      const value = this.coerceXmlArgValue(String(match[2] || '').trim());
      if (key) args[key] = value;
    }

    return args;
  }

  coerceXmlArgValue(value: string): unknown {
    if (!value) return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (!Number.isNaN(Number(trimmed)) && trimmed.length < 18) return Number(trimmed);
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  stripXmlToolCalls(text: string): string {
    if (!text || typeof text !== 'string') return text;
    let cleaned = text;
    cleaned = cleaned.replace(/<\s*(?:tool|function)_call[^>]*>[\s\S]*?<\s*\/\s*(?:tool|function)_call\s*>/gi, '');
    cleaned = cleaned.replace(/[A-Za-z0-9_]+\s*<\s*argkey\s*>[\s\S]*?<\s*\/\s*tool_call\s*>/gi, '');
    cleaned = cleaned.replace(/<\s*argkey\s*>[\s\S]*?<\s*\/\s*argvalue\s*>/gi, '');
    return cleaned.trim();
  }

  parsePlanSteps(text: string) {
    if (!text) return [];
    return text
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*[-*]\s*/, '')
          .replace(/^\s*\d+[.)]\s*/, '')
          .trim(),
      )
      .filter(Boolean);
  }

  buildPlanFromArgs(args: Record<string, any>) {
    const stepInput = Array.isArray(args?.steps) ? args.steps : null;
    const planText = typeof args?.plan === 'string' ? args.plan : '';
    const parsedSteps = planText ? this.parsePlanSteps(planText) : [];
    const combined = stepInput && stepInput.length ? stepInput : parsedSteps;
    if (!combined || combined.length === 0) return null;
    return buildRunPlan(combined, {
      existingPlan: this.currentPlan,
      maxSteps: 12,
    });
  }

  getToolPermissionCategory(toolName) {
    return resolveToolPermissionCategory(toolName);
  }

  parseAllowedDomains(value = '') {
    return String(value)
      .split(/[\n,]/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
  }

  isUrlAllowed(url, allowlist) {
    if (!allowlist.length) return true;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return allowlist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch (error) {
      return false;
    }
  }

  async resolveToolUrl(args) {
    if (args?.url) return args.url;
    const tabId = args?.tabId || this.browserTools.getCurrentSessionTabId();
    try {
      if (tabId) {
        const tab = await chrome.tabs.get(tabId);
        return tab?.url || '';
      }
    } catch (error) {
      console.warn('Failed to resolve tab URL for permissions:', error);
    }
    const [active] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return active?.url || '';
  }

  async checkToolPermission(toolName, args, settingsOverride: Record<string, any> | null = null) {
    const settings = settingsOverride || this.currentSettings;
    if (!settings) return { allowed: true };
    const permissions = settings.toolPermissions || {};
    const category = this.getToolPermissionCategory(toolName);
    if (!isToolCategoryAllowed(category, permissions)) {
      const reason =
        category === 'scripting'
          ? 'Permission blocked: scripting (enable "Execução de scripts" in settings to allow executeScript).'
          : `Permission blocked: ${category}`;
      return {
        allowed: false,
        reason,
        policy: {
          type: 'permission',
          category,
          reason,
        },
      };
    }

    if (category === 'tabs') return { allowed: true };

    const allowlist = this.parseAllowedDomains(settings.allowedDomains || '');
    if (!allowlist.length) return { allowed: true };

    const targetUrl = await this.resolveToolUrl(args);
    if (!this.isUrlAllowed(targetUrl, allowlist)) {
      return {
        allowed: false,
        reason: 'Blocked by allowed domains list.',
        policy: {
          type: 'allowlist',
          domain: targetUrl,
          reason: 'Blocked by allowed domains list.',
        },
      };
    }

    return { allowed: true };
  }

  private sendStreamDeltaImmediate(payload: RuntimeDeltaPayload) {
    if (isRuntimeMessage(payload)) {
      this.sendToSidePanel(payload);
      return;
    }
    console.warn('Dropped invalid stream delta payload:', payload);
  }

  sendRuntime(runMeta: RunMeta, payload: Record<string, unknown>) {
    this.touchActiveRun(runMeta.runId);
    if (isStreamDeltaPayload(payload)) {
      const channel = payload.channel === 'reasoning' ? 'reasoning' : 'text';
      this.runtimeBatcher.enqueue(runMeta, payload.content, channel);
      return;
    }
    this.runtimeBatcher.flush(runMeta.runId);
    const candidateMessage = {
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      runId: runMeta.runId,
      turnId: runMeta.turnId,
      sessionId: runMeta.sessionId,
      timestamp: Date.now(),
      ...payload,
    };
    const validation = validateRuntimeMessage(candidateMessage);
    if (validation.ok) {
      this.sendToSidePanel(validation.message);
      return;
    }

    console.warn('Dropped invalid runtime message:', validation.reason, candidateMessage);
    const fallbackMessage = {
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      runId: runMeta.runId,
      turnId: runMeta.turnId,
      sessionId: runMeta.sessionId,
      timestamp: Date.now(),
      type: 'run_warning',
      message: `Internal warning: dropped invalid runtime message (${validation.reason})`,
    };
    if (isRuntimeMessage(fallbackMessage)) {
      this.sendToSidePanel(fallbackMessage);
    }
  }

  sendRunErrorFallback(sessionId: string, message: string) {
    const runMeta: RunMeta = {
      runId: `fallback-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      turnId: `fallback-turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId: String(sessionId || `session-${Date.now()}`),
    };
    this.sendRuntime(runMeta, {
      type: 'run_error',
      message: String(message || 'Unexpected runtime error'),
    });
  }

  sendToSidePanel(message) {
    chrome.runtime.sendMessage(message).catch(() => {
      // no-op: side panel simply not open
    });
  }

  enhanceSystemPrompt(basePrompt: string, context) {
    const browserAutomation = context.browserAutomation !== false;
    const requiresDetailedReport = context.requiresDetailedReport === true;
    const orchestrationPass = Number(context.orchestrationPass || 1);
    const qualityMode = String(context.qualityMode || 'balanced');
    const planUpdatedAt = this.currentPlan?.updatedAt || 0;
    const cacheKey = `${planUpdatedAt}:${this.consecutiveFailures}:${qualityMode}:${context.tabId}:${orchestrationPass}:${requiresDetailedReport}:${this.awaitingVerification}:${this.lastBrowserAction || ''}`;
    if (this._systemPromptCache?.key === cacheKey) {
      return this._systemPromptCache.prompt;
    }

    const effectiveBasePrompt = isDefaultAutomationPrompt(basePrompt) ? STREAMLINED_AUTOMATION_PROMPT : basePrompt;

    if (!browserAutomation) {
      const directPrompt = `${effectiveBasePrompt}

<turn_mode>
Direct chat only. Answer briefly. No plans, no browser tools, no audit/report sections unless explicitly requested.
</turn_mode>`;
      this._systemPromptCache = { key: cacheKey, prompt: directPrompt };
      return directPrompt;
    }

    const tabsSection =
      Array.isArray(context.availableTabs) && context.availableTabs.length
        ? `Tabs selected (${context.availableTabs.length}). Use focusTab or switchTab before acting:\n${context.availableTabs
            .map((tab) => `  - [${tab.id}] ${tab.title || 'Untitled'} - ${tab.url}`)
            .join('\n')}`
        : 'No additional tabs selected; actions target the current tab.';
    const orchestratorSection = context.orchestratorEnabled ? 'Orchestrator mode is enabled.' : '';

    // Build state section with enforcement - tracks exactly what model needs to do next
    let stateSection = '';
    let requiredNextCall = '';

    if (!this.currentPlan || this.currentPlan.steps.length === 0) {
      if (requiresDetailedReport) {
        // No plan - MUST create one first
        requiredNextCall = 'set_plan({ steps: [{ title: "..." }, ...] })';
        stateSection = `
<execution_state>
⛔ NO ACTIVE PLAN

REQUIRED NEXT CALL: ${requiredNextCall}

You CANNOT call navigate, click, type, scroll, or pressKey until you call set_plan.
Create 3-6 specific action steps, then proceed.
</execution_state>`;
      } else {
        requiredNextCall = 'Call the browser tool needed for this request now.';
        stateSection = `
<execution_state>
ACTION MODE

No plan required. Call the needed browser tool immediately, then confirm briefly.
</execution_state>`;
      }
    } else {
      const steps = this.currentPlan.steps;
      const cache = this._planPromptCache;
      const doneCount = steps.reduce((c, s) => c + (s.status === 'done' ? 1 : 0), 0);
      const currentIndex = steps.findIndex((s) => s.status !== 'done');
      let planLines: string[];
      if (
        cache &&
        cache.length === steps.length &&
        cache.doneCount === doneCount &&
        cache.currentIndex === currentIndex
      ) {
        planLines = cache.planLines.split('\n');
      } else {
        planLines = steps.map((step, i) => {
          const marker = step.status === 'done' ? '[✓]' : i === currentIndex ? '[→]' : '[ ]';
          return `${marker} step_index=${i}: ${step.title}`;
        });
        this._planPromptCache = {
          length: steps.length,
          doneCount,
          currentIndex,
          planLines: planLines.join('\n'),
        };
      }

      if (currentIndex === -1) {
        // All steps complete
        requiredNextCall = 'Provide final summary with findings';
        stateSection = `
<execution_state>
✅ ALL STEPS COMPLETE (${doneCount}/${steps.length})
${planLines.join('\n')}

REQUIRED: Provide your final summary now with evidence from getContent.
</execution_state>`;
      } else if (this.awaitingVerification && requiresDetailedReport) {
        requiredNextCall = 'getContent({ mode: "text" })';
        stateSection = `
<execution_state>
PROGRESS: ${doneCount}/${steps.length} steps complete
${planLines.join('\n')}

CURRENT STEP: "${steps[currentIndex].title}"
LAST ACTION: ${this.lastBrowserAction || 'unknown'}

Next: ${requiredNextCall}, then update_plan({ step_index: ${currentIndex}, status: "done" }).
</execution_state>`;
      } else {
        // Ready to mark step done or execute next action
        requiredNextCall = `update_plan({ step_index: ${currentIndex}, status: "done" })`;
        stateSection = `
<execution_state>
PROGRESS: ${doneCount}/${steps.length} steps complete
${planLines.join('\n')}

CURRENT STEP: "${steps[currentIndex].title}"
Next: ${requiredNextCall}, then continue to the next step.
</execution_state>`;
      }
    }

    const recoverySection = this.buildFailureRecoverySection();
    const visualRecoverySection =
      orchestrationPass === 1 && (recoverySection || requiresDetailedReport)
        ? `
<visual_recovery_policy>
- Retry with findElement or getContent({ mode: "structure" }) only after a failed action.
- Use screenshot() only when page state is ambiguous after a failure.
</visual_recovery_policy>`
        : '';

    const checkpointSection =
      this.currentPlan && this.currentPlan.steps.length > 0
        ? `
<checkpoint>
Next required call: ${requiredNextCall}
</checkpoint>`
        : '';

    const compactStateSection = orchestrationPass > 1 ? '' : stateSection;
    const prompt = `${effectiveBasePrompt}
${compactStateSection}

<browser_context>
URL: ${context.currentUrl}
Title: ${context.currentTitle}
Tab: ${context.tabId}
${orchestrationPass === 1 ? tabsSection : ''}
</browser_context>
${orchestratorSection && orchestrationPass === 1 ? `\n${orchestratorSection}` : ''}
${recoverySection}${visualRecoverySection}${checkpointSection}`;
    this._systemPromptCache = { key: cacheKey, prompt };
    return prompt;
  }

  sanitizeSystemPrompt(systemPrompt: string, provider?: string): string | Array<{ role: 'system'; content: string }> {
    if (provider?.toLowerCase() !== 'anthropic') {
      return systemPrompt;
    }

    let cleaned = systemPrompt;

    // Remove a identidade caso já venha embutida — ela será reinserida como
    // primeiro bloco de system separado (exigência do billing OAuth do Claude Code).
    cleaned = cleaned.replace(/You are Claude Code, Anthropic's official CLI for Claude\.\s*/gi, '');

    // Replace skill_manage with skill tool
    cleaned = cleaned.replace(/skill_manage/g, 'skill tool');

    // Replace product names
    cleaned = cleaned
      .replace(/Hermes Agent/g, 'Claude Code')
      .replace(/Hermes agent/g, 'Claude Code')
      .replace(/hermes-agent/g, 'claude-code')
      .replace(/Nous Research/g, 'Anthropic');

    // O OAuth do Claude Code exige que o PRIMEIRO bloco de system seja EXATAMENTE
    // esta identidade. O AI SDK converte um array de mensagens system em múltiplos
    // blocos, preservando o primeiro bloco intacto (ao contrário de uma string
    // combinada, que viraria um único bloco e seria rejeitada com 401/erro).
    return [
      { role: 'system', content: "You are Claude Code, Anthropic's official CLI for Claude." },
      { role: 'system', content: cleaned.trim() },
    ];
  }

  private appendPendingVision(
    runId: string,
    entry: { tool: string; description: string; source: 'recovery' | 'screenshot' },
  ) {
    const list = this.pendingVisionByRun.get(runId) || [];
    list.push(entry);
    while (list.length > 3) list.shift();
    this.pendingVisionByRun.set(runId, list);
  }

  private async describeImageForRun(
    runMeta: RunMeta,
    options: {
      dataUrl: string;
      prompt: string;
      visionProfile: Record<string, any>;
      tool: string;
      callId: string;
      source: 'recovery' | 'screenshot';
      settings: Record<string, any>;
    },
  ): Promise<{ description: string | null; pending: boolean }> {
    const visionSettings = {
      provider: options.visionProfile.provider,
      apiKey: options.visionProfile.apiKey,
      model: options.visionProfile.model,
      customEndpoint: options.visionProfile.customEndpoint,
    };

    if (isVisionBridgeSync(options.settings)) {
      const description = await describeImageWithModel({
        settings: visionSettings,
        dataUrl: options.dataUrl,
        prompt: options.prompt,
        abortSignal: AbortSignal.timeout(VISION_DESCRIBE_TIMEOUT_MS),
      });
      const text = description || '';
      if (text) {
        this.appendPendingVision(runMeta.runId, {
          tool: options.tool,
          description: text,
          source: options.source,
        });
      }
      return { description: text || null, pending: false };
    }

    // Persist once and queue by id so the backlog does not retain multi-MB dataURLs.
    let screenshotId: string | undefined;
    try {
      screenshotId = await storeScreenshotDataUrl(options.dataUrl);
      Promise.resolve(pruneScreenshotStore()).catch((err) => console.warn('pruneScreenshotStore failed:', err));
    } catch (error) {
      console.warn('[Glide] Failed to store vision screenshot handle:', error);
    }

    this.visionQueue.enqueue({
      screenshotId,
      // Fallback only when session storage fails — still capped by queue length.
      dataUrl: screenshotId ? undefined : options.dataUrl,
      prompt: options.prompt,
      settings: visionSettings,
      timeoutMs: VISION_DESCRIBE_TIMEOUT_MS,
      onComplete: ({ description }) => {
        const text = description || '';
        if (!text) return;
        if (this.activeRunId !== runMeta.runId) return;
        this.appendPendingVision(runMeta.runId, {
          tool: options.tool,
          description: text,
          source: options.source,
        });
        this.sendRuntime(runMeta, {
          type: 'vision_context_ready',
          tool: options.tool,
          id: options.callId,
          description: text,
          source: options.source,
        });
      },
      onError: ({ message }) => {
        console.warn(`[Glide] Async vision failed (${options.source}):`, message);
      },
    });

    return { description: null, pending: true };
  }

  buildFailureRecoverySection(): string {
    if (!this.consecutiveFailures || this.consecutiveFailures === 0) return '';
    const failedList = (this.failedTools || [])
      .slice(-3)
      .map((f) => `  - ${f.tool}(${f.selector || ''}): ${f.error}`)
      .join('\n');
    const pendingVision = this.activeRunId ? this.pendingVisionByRun.get(this.activeRunId) || [] : [];
    const visionHints =
      pendingVision.length > 0
        ? `\nVisual context from recent screenshots:\n${pendingVision
            .map((entry) => `  - [${entry.source}/${entry.tool}] ${entry.description.slice(0, 400)}`)
            .join('\n')}\n`
        : '';
    return `
<failure_recovery>
⚠️ ${this.consecutiveFailures} consecutive action(s) FAILED:
${failedList}
${visionHints}
DO NOT give up. You MUST try alternative approaches in this exact order:
1. Call findElement({ query: "button text" }) to get a reliable CSS selector before retrying click/type.
2. For Instagram profile lists, findElement({ query: "seguindo" }) or click({ selector: "a[href*='/following']" }) / "seguidores" / a[href*="/followers"] — never reuse generic .x* classes.
3. Call getContent({ mode: "structure" }) to inspect available elements with their selectors.
4. If the page is dynamic (React/SPA), call wait({ condition: "time", ms: 1500 }) before retrying.
5. Try scrolling to reveal hidden elements.
6. Capture screenshot() to gather visual context before the next retry.

NEVER repeat the exact same selector that just failed. Use findElement or structure mode to discover a new one.

You are PROHIBITED from generating a final response until you either:
- Successfully complete the action with an alternative approach, OR
- Have attempted at least 3 different selectors/strategies with evidence
</failure_recovery>`;
  }

  resolveProfile(settings: Record<string, any>) {
    const normalizedProvider = migrateStoredProvider(settings.provider, settings.customEndpoint);
    const qualityMode = this.normalizeQualityMode(settings.qualityMode);
    return {
      provider: normalizedProvider,
      apiKey: settings.apiKey || '',
      model: settings.model || '',
      customEndpoint: String(settings.customEndpoint || '').trim(),
      systemPrompt: settings.systemPrompt || '',
      sendScreenshotsAsImages: settings.sendScreenshotsAsImages !== false,
      screenshotQuality: settings.screenshotQuality || 'high',
      showThinking: settings.showThinking !== false,
      streamResponses: settings.streamResponses !== false,
      temperature: fixedTemperatureForQuality(qualityMode),
      maxTokens: clampInt(settings.maxTokens, DEFAULT_MODEL_MAX_TOKENS, MIN_MODEL_MAX_TOKENS, MAX_MODEL_MAX_TOKENS),
      timeout: resolveTimeoutMs(settings.timeout),
      contextLimit: clampInt(settings.contextLimit, DEFAULT_CONTEXT_LIMIT, MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT),
      enableScreenshots: settings.enableScreenshots !== false,
      autoRecoveryMode: settings.autoRecoveryMode,
      screenshotOnFailure: settings.screenshotOnFailure !== false,
      screenshotRetention: settings.screenshotRetention,
      qualityMode,
      autoTuneSafety: settings.autoTuneSafety !== false,
      minimumReportSections: settings.minimumReportSections,
    };
  }

  getToolsForSession(
    settings: Record<string, any>,
    includeOrchestrator = false,
    lockedTabId: number | null = null,
    options: { includePlanTools?: boolean; includeSubagentComplete?: boolean } = {},
  ) {
    const cacheKey = [
      lockedTabId ?? 'none',
      includeOrchestrator ? '1' : '0',
      settings?.enableScreenshots === false ? '0' : '1',
      options.includePlanTools === false ? '0' : '1',
      options.includeSubagentComplete ? '1' : '0',
    ].join(':');
    const cached = this._sessionToolsCache.get(cacheKey);
    if (cached) return cached;

    const built = buildSessionTools({
      browserToolDefinitions: this.browserTools.getToolDefinitions(),
      lockedTabId,
      lockedTabAllowlist: LOCKED_TAB_ALLOWED_BROWSER_TOOLS,
      enableScreenshots: settings?.enableScreenshots !== false,
      includeOrchestrator,
      includePlanTools: options.includePlanTools !== false,
      includeSubagentComplete: options.includeSubagentComplete === true,
    });
    this._sessionToolsCache.set(cacheKey, built);
    return built;
  }

  async handleSpawnSubagent(runMeta: RunMeta, args) {
    if (this.subAgentCount >= MAX_SUBAGENTS_PER_RUN) {
      return {
        success: false,
        error: `Sub-agent limit reached for this session (max ${MAX_SUBAGENTS_PER_RUN}).`,
      };
    }
    this.subAgentCount += 1;
    const subagentId = `subagent-${Date.now()}-${this.subAgentCount}`;
    const subagentName = args.name || `Sub-Agent ${this.subAgentCount}`;

    // Disparar o evento inicial para a UI imediatamente
    this.sendRuntime(runMeta, {
      type: 'subagent_start',
      id: subagentId,
      name: subagentName,
      tasks: args.tasks || [args.goal || args.task || 'Task'],
    });

    // Criar aba temporária isolada de forma assíncrona
    let subagentTabId: number | null = null;
    if (this.activeRunLockedTabId) {
      try {
        const parentTab = await chrome.tabs.get(this.activeRunLockedTabId);
        const newTab = await chrome.tabs.create({
          url: parentTab.url || DEDICATED_RUN_TAB_URL,
          active: false,
        });
        subagentTabId = newTab.id || null;
        console.log(`[Glide] Created dedicated subagent tab: ${subagentTabId} from parent URL: ${parentTab.url}`);
      } catch (err) {
        console.error('[Glide] Error cloning parent tab for subagent, creating default tab:', err);
      }
    }

    if (!subagentTabId) {
      try {
        const newTab = await chrome.tabs.create({
          url: DEDICATED_RUN_TAB_URL,
          active: false,
        });
        subagentTabId = newTab.id || null;
        console.log(`[Glide] Created default dedicated subagent tab: ${subagentTabId}`);
      } catch (err) {
        console.error('[Glide] Failed to create dedicated tab for subagent:', err);
      }
    }

    if (!subagentTabId) {
      this.sendRuntime(runMeta, {
        type: 'subagent_complete',
        id: subagentId,
        success: false,
        summary: 'Sub-agent failed: could not create an isolated tab.',
      });
      return {
        success: false,
        error: 'Failed to create isolated tab for sub-agent.',
      };
    }

    const subagentAbort = new AbortController();
    this.activeSubagents.set(subagentId, subagentAbort);

    // Queue behind the concurrency semaphore — return immediately to the orchestrator.
    this.runSubagentInBackground(runMeta, args, subagentId, subagentTabId, subagentAbort).catch((err) => {
      console.error(`[Glide] Error running subagent ${subagentId} in background:`, err);
    });

    const taskLines = Array.isArray(args.tasks)
      ? args.tasks.map((t, idx) => `${idx + 1}. ${t}`).join('\n')
      : args.goal || args.task || args.prompt || '';

    // Retorna imediatamente para o orquestrador sem travar a chamada da ferramenta!
    return {
      success: true,
      status: 'spawned',
      id: subagentId,
      name: subagentName,
      summary: `Sub-agent "${subagentName}" spawned successfully on isolated tab ${subagentTabId || 'unknown'} (max ${MAX_CONCURRENT_SUBAGENTS} concurrent).`,
      tasks: taskLines,
    };
  }

  async runSubagentInBackground(
    runMeta: RunMeta,
    args: any,
    subagentId: string,
    subagentTabId: number | null,
    subagentAbort: AbortController,
  ) {
    await this.acquireSubagentSlot();
    try {
      await this.executeSubagentLoop(runMeta, args, subagentId, subagentTabId, subagentAbort);
    } finally {
      this.releaseSubagentSlot();
    }
  }

  private async executeSubagentLoop(
    runMeta: RunMeta,
    args: any,
    subagentId: string,
    subagentTabId: number | null,
    subagentAbort: AbortController,
  ) {
    // Snapshot settings at start so concurrent parent mutations do not affect this loop.
    const settingsSnapshot = { ...(this.currentSettings || {}) };
    const profileSettings = this.resolveProfile(settingsSnapshot);
    const subagentName = args.name || `Sub-Agent ${this.subAgentCount}`;
    console.log(`[Glide] Iniciando subagente em background: ${subagentName} (${subagentId}) na tab: ${subagentTabId}`);
    const subagentTimeoutMs = resolveTimeoutMs(profileSettings.timeout ?? settingsSnapshot.timeout);

    const subAgentSystemPrompt = `${args.prompt || 'You are a focused sub-agent working under an orchestrator. Be concise and tool-driven.'}
Always cite evidence from tools. Finish by calling subagent_complete with a short summary and any structured findings.`;

    const targetTabId = subagentTabId;
    if (!targetTabId) {
      this.activeSubagents.delete(subagentId);
      this.sendRuntime(runMeta, {
        type: 'subagent_complete',
        id: subagentId,
        success: false,
        summary: 'Sub-agent failed: no isolated tab available.',
      });
      return;
    }
    let summary = 'Sub-agent finished without a final summary.';
    let success = true;
    let subagentTimedOut = false;
    // Declared before the try so setup failures still hit the finally that
    // closes the isolated tab and clears the activeSubagents entry.
    let subagentTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const tools = this.getToolsForSession(settingsSnapshot, false, targetTabId, {
        includePlanTools: false,
        includeSubagentComplete: true,
      });

      const toolSet = getCachedToolSet(
        tools,
        async (toolName, toolArgs, options) =>
          this.executeToolByName(
            toolName,
            toolArgs,
            {
              runMeta,
              settings: settingsSnapshot,
              visionProfile: null,
              lockedTabId: targetTabId,
              runScope: 'subagent',
            },
            options.toolCallId,
          ),
        profileSettings.provider,
      );

      const taskLines = Array.isArray(args.tasks)
        ? args.tasks.map((t, idx) => `${idx + 1}. ${t}`).join('\n')
        : args.goal || args.task || args.prompt || '';

      const subHistory: Message[] = [
        {
          role: 'user',
          content: `Task group:\n${taskLines || 'Follow the provided prompt and complete the goal.'}`,
        },
      ];

      const subModel = getCachedLanguageModel(profileSettings);
      subagentTimer = setTimeout(() => {
        subagentTimedOut = true;
        subagentAbort.abort();
      }, subagentTimeoutMs);

      const result = streamText({
        model: subModel,
        ...resolveProviderOptions(profileSettings.provider),
        system: this.sanitizeSystemPrompt(subAgentSystemPrompt, profileSettings.provider),
        messages: toModelMessages(subHistory, {
          systemMessageMode: profileSettings.provider === 'anthropic' ? 'user' : 'system',
        }),
        tools: toolSet,
        temperature: resolveTemperature(profileSettings.temperature ?? 0.3, profileSettings.provider),
        maxOutputTokens: profileSettings.maxTokens ?? 1024,
        stopWhen: stepCountIs(SUBAGENT_MAX_MODEL_STEPS),
        abortSignal: subagentAbort.signal,
      });
      summary = (await result.text) || summary;
    } catch (error) {
      if (subagentTimedOut || isAbortError(error)) {
        summary = `Sub-agent timed out after ${subagentTimeoutMs}ms.`;
      } else {
        summary = `Sub-agent failed: ${error?.message || String(error)}`;
      }
      success = false;
    } finally {
      if (subagentTimer) clearTimeout(subagentTimer);
      this.activeSubagents.delete(subagentId);
      if (subagentTabId) {
        try {
          console.log(`[Glide] Closing temporary subagent tab: ${subagentTabId}`);
          await chrome.tabs.remove(subagentTabId);
        } catch (err) {
          console.error(`[Glide] Failed to close subagent tab ${subagentTabId}:`, err);
        }
      }
    }

    if (subagentAbort.signal.aborted && subagentTimedOut) {
      success = false;
    }
    if (!subagentAbort.signal.aborted || subagentTimedOut) {
      this.sendRuntime(runMeta, {
        type: 'subagent_complete',
        id: subagentId,
        success,
        summary,
      });
    }
  }
}

new BackgroundService();
