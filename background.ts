import { generateText, stepCountIs, streamText } from 'ai';
import type { ModelMessage } from 'ai';
import { withAbortTimeout } from './ai/abort-timeout.js';
import { runAnthropicOAuthFlow } from './ai/anthropic-login.js';
import { ensureFreshAnthropicToken, getAnthropicAuthHealth, readAnthropicOAuth } from './ai/anthropic-oauth.js';
import { resolveProviderOptions } from './ai/anthropic-options.js';
import {
  buildCodexChatGptBundleFromOAuth,
  ensureFreshCodexChatGptToken,
  getCodexAuthHealth,
  readCodexChatGptAuth,
  resolveCodexAuthMode,
  writeCodexChatGptAuth,
} from './ai/codex-auth.js';
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
  resetCompactionHysteresis,
  serializeConversation,
  shouldCompact,
} from './ai/compaction.js';
import { STREAMLINED_AUTOMATION_PROMPT, isDefaultAutomationPrompt } from './ai/default-prompt.js';
import { createMessage, normalizeConversationHistory } from './ai/message-schema.js';
import type { Message } from './ai/message-schema.js';
import { isEmptyModelPassResult } from './ai/model-pass-result.js';
import {
  applyPromptCacheBreakpoint,
  applyStepPromptCacheBreakpoints,
  disableAnthropicPromptCache,
  isAnthropicPromptCacheEnabled,
  isEmptyModelResponseError,
} from './ai/prompt-cache.js';
import {
  createExponentialBackoff,
  extractProviderErrorStatus,
  extractRetryAfterMs,
  isOverloadedProviderError,
  isRetryableProviderError,
  isValidFinalResponse,
} from './ai/retry-engine.js';
import { buildRunToolSet, getCachedLanguageModel } from './ai/runtime-cache.js';
import { describeImageWithModel, migrateStoredProvider } from './ai/sdk-client.js';
import { detectTaskIntent, hasRecentToolActivity } from './ai/task-intent.js';
import { extractRecoverableToolCalls, stripRecoverableToolCalls } from './ai/tool-call-recovery.js';
import { buildToolTurnMessages } from './ai/tool-history.js';
import { ensureFreshXaiToken, getXaiAuthHealth, readXaiOAuth } from './ai/xai-oauth.js';
import { ModelActivityWatchdog } from './background/activity-timeout.js';
import { shouldForceToolContinuation, textAwaitsUser } from './background/continuation-intent.js';
import { DomCacheLru } from './background/dom-cache.js';
import {
  FailureRecoveryTracker,
  advanceFailedToolRecovery,
  buildFailureSignature,
  buildTerminalToolFailure,
  isFailureTrackedTool,
  normalizeThrownToolError,
} from './background/failure-recovery.js';
import { bootstrapLocalCommandCodeSettings } from './background/local-provider-bootstrap.js';
import {
  bindPanelPortListener,
  bumpSidePanelClaimGeneration,
  getSidePanelClaimGeneration,
  hasConnectedPanelPorts,
  postToPanelPorts,
} from './background/panel-port.js';
import { checkProviderReadiness } from './background/preflight.js';
import {
  UNTRUSTED_DATA_POLICY,
  extractCdpNavigateUrl,
  isCdpNavigateMethod,
  wrapUntrustedToolPayload,
} from './background/prompt-delimiters.js';
import { fetchProviderModels } from './background/provider-fetch.js';
import { installProviderNetRequestRules } from './background/provider-net-rules.js';
import { RunAbortRegistry } from './background/run-abort-registry.js';
import { RunEventSequencer } from './background/run-event-sequencer.js';
import { RunPassCache } from './background/run-pass-cache.js';
import {
  RuntimeBatcher,
  type RuntimeDeltaPayload,
  type ToolEventsBatchPayload,
  isStreamDeltaPayload,
  isToolEventPayload,
} from './background/runtime-batcher.js';
import { selectRuntimePushChannel } from './background/runtime-push.js';
import { pruneScreenshotStore, storeScreenshotDataUrl } from './background/screenshot-store.js';
import {
  ACTIVE_RUN_TIMEOUT_MS,
  BROWSER_ACTION_TOOLS,
  COMPACTION_MAX_OUTPUT_TOKENS,
  DEDICATED_RUN_TAB_URL,
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_MODEL_MAX_TOKENS,
  EXECUTION_EVENTS_KEY,
  EXECUTION_PREVIEW_LIMIT,
  EXECUTION_TEXT_LIMIT,
  type EvidenceConfidence,
  type EvidenceEntry,
  type ExecutionEvent,
  type FailureClass,
  GENERIC_TOOL_COMPLETION_TEXT,
  LOCKED_TAB_ALLOWED_BROWSER_TOOLS,
  MAX_CONTEXT_LIMIT,
  MAX_EXECUTION_EVENTS,
  MAX_IN_FLIGHT_TOOL_WALL_MS,
  MAX_MODEL_MAX_TOKENS,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_CONTEXT_LIMIT,
  MIN_MODEL_MAX_TOKENS,
  MIN_REQUEST_TIMEOUT_MS,
  NON_STREAM_MODEL_HARD_TIMEOUT_MS,
  ORCHESTRATION_RETRY_NORMALIZE,
  type QualityMode,
  type RecoveryStage,
  type RunMeta,
  SCREENSHOT_TOOLS,
  TAB_MANAGEMENT_TOOLS,
  VISION_DESCRIBE_TIMEOUT_MS,
  humanizeProviderError,
  isAbortError,
  isDeliberateRunStop,
  isNoOutputGeneratedError,
  mapScreenshotQuality,
  resolveTimeoutMs,
  shouldInvalidateDomCache,
} from './background/service-config.js';
import { canApplyCompactionResult, contextTransactionStore } from './background/context-transaction.js';
import { resolveUserMessageContextAction, sessionContextStore } from './background/session-context-store.js';
import {
  ActiveRunSentinelRegistry,
  SessionCompactionQueue,
  SessionGenerationRegistry,
  SessionTombstoneRegistry,
  combineAbortSignals,
  createSentinelToken,
} from './background/session-lifecycle.js';
import { buildSessionTools } from './background/session-tools.js';
import { bindRuntimeSettingsCacheInvalidation, loadCachedRuntimeSettings } from './background/settings-cache.js';
import { restrictLocalStorageToTrustedContexts } from './background/storage-access.js';
import {
  isToolCategoryAllowed,
  getToolPermissionCategory as resolveToolPermissionCategory,
  toolPermissionsCacheKey,
} from './background/tool-permissions.js';
import {
  VisionQueue,
  isVisionBridgeEnabled,
  isVisionBridgeSync,
  resolveVisualDeliveryMode,
} from './background/vision-queue.js';
import { BrowserTools } from './tools/browser-tools.js';
import { cdpDetach, cdpDetachAll } from './tools/cdp-session.js';
import type { ToolExecutionContext } from './tools/tool-context.js';
import { clampIntUnknown, isHttpUrl } from './tools/validation.js';
import { buildRunPlan } from './types/plan.js';
import type { RunPlan } from './types/plan.js';
import {
  RUNTIME_MESSAGE_SCHEMA_VERSION,
  isRuntimeMessage,
  salvageToolEventsBatchEvents,
  validateRuntimeMessage,
} from './types/runtime-messages.js';

const clampInt = clampIntUnknown;

class BackgroundService {
  browserTools: BrowserTools;
  currentSettings: Record<string, any> | null;
  currentPlan: RunPlan | null;
  activeRunId: string | null;
  // Kept in sync with activeRunId so the tabs.onRemoved listener (which has no
  // access to a call-scoped runMeta) can still send a proper runtime message
  // when it aborts a run whose locked tab was closed.
  activeRunMeta: RunMeta | null;
  activeRunAbortController: AbortController | null;
  private runAbortRegistry: RunAbortRegistry;
  /** Run that owns global orchestration/recovery state — successors supersede predecessors. */
  private orchestrationOwnerRunId: string | null;
  activeRunLockOwnerRunId: string | null;
  activeRunTimeoutId: ReturnType<typeof setTimeout> | null;
  private activeRunWatchdogRunId: string | null;
  activeRunLastActivityAt: number;
  activeInFlightToolCalls: number;
  /** When the current in-flight tool batch started (for wall-clock watchdog). */
  private activeInFlightToolStartedAt: number;
  private runPhase: 'idle' | 'running' | 'stopping' | 'stopped';
  private inFlightByRun: Map<string, { count: number; startedAt: number }>;
  private quarantinedRunIds: Set<string>;
  private stopGraceTimerId: ReturnType<typeof setTimeout> | null;
  /** Manual execute_tool in flight — blocks agent runs from interleaving. */
  private manualToolBusy: boolean;
  dedicatedTabId: number | null;
  dedicatedTabWindowId: number | null;
  activeRunLockedTabId: number | null;
  // Marks tab ids the agent is closing itself via the closeTab tool, so the
  // tabs.onRemoved listener does not mistake that for the user closing the run's
  // locked tab (which should abort the run) — see agentInitiatedTabCloses usage.
  private agentInitiatedTabCloses: Set<number>;
  sidePanelTabId: number | null;
  private pendingSidePanelOpenTabId: number | null;
  executionEvents: ExecutionEvent[];
  executionEventsHydrated: boolean;
  private executionEventsHydration: Promise<void> | null = null;
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
  private _sessionToolsCache: Map<string, ReturnType<typeof buildSessionTools>>;

  private domCacheLru: DomCacheLru;
  private lockedTabAliveCache = new Map<number, number>();
  private modelScreenshotImages = new Map<string, string>();
  private findElementAttempts = new Set<string>();
  /** Per-run recovery budgets (Layer 3 find / Layer 4 screenshot). */
  private recoveryFindCount = 0;
  private recoveryScreenshotCount = 0;
  private deferredCompactionSessions = new Set<string>();
  private sessionTombstones = new SessionTombstoneRegistry();
  private sessionGenerations = new SessionGenerationRegistry();
  private sessionCompactionQueue = new SessionCompactionQueue();
  private activeRunSentinelRegistry = new ActiveRunSentinelRegistry();
  private runEventSequencer = new RunEventSequencer();
  private failureRecoveryTracker: FailureRecoveryTracker;

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
      // storeScreenshotDataUrl já poda idade/quantidade/bytes sob o lock do
      // índice; uma poda extra concorrente reabriria a janela de perda de índice.
      next.screenshotId = await storeScreenshotDataUrl(result.dataUrl);
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
    this.activeRunWatchdogRunId = runMeta.runId;
    const abortForWatchdog = (message: string) => {
      console.warn('[Glide] activeRunId watchdog -', message);
      this.sendRuntime(runMeta, { type: 'run_error', message });
      this.runtimeBatcher.flush(runMeta.runId);
      this.runAbortRegistry.abort(runMeta.runId);
      this.releaseRunExclusiveLock(runMeta.runId);
    };
    const check = () => {
      if (this.activeRunId !== runMeta.runId) {
        this.activeRunTimeoutId = null;
        return;
      }
      if (this.activeInFlightToolCalls > 0) {
        // NÃO touchActiveRun: renovar o idle só porque há tool em voo mascarava
        // hangs eternos de chrome.*. Usa wall-clock desde o início do batch.
        const wallMs = Date.now() - (this.activeInFlightToolStartedAt || this.activeRunLastActivityAt);
        if (wallMs >= MAX_IN_FLIGHT_TOOL_WALL_MS) {
          abortForWatchdog(
            `Execução encerrada: ferramenta em andamento há ${Math.round(wallMs / 1000)}s sem concluir.`,
          );
          return;
        }
        this.activeRunTimeoutId = setTimeout(check, 15000);
        return;
      }
      const idleMs = Date.now() - this.activeRunLastActivityAt;
      if (idleMs >= ACTIVE_RUN_TIMEOUT_MS) {
        abortForWatchdog(`Execução encerrada após ${Math.round(idleMs / 1000)}s sem atividade.`);
        return;
      }
      this.activeRunTimeoutId = setTimeout(check, ACTIVE_RUN_TIMEOUT_MS - idleMs);
    };
    this.activeRunTimeoutId = setTimeout(check, ACTIVE_RUN_TIMEOUT_MS);
  }

  /**
   * Libera o lock exclusivo do run (activeRunId) sem esperar o finally do loop.
   * Usado em stop_run e após assistant_final para o usuário poder enviar de novo
   * enquanto compaction/teardown ainda correm.
   */
  private releaseRunExclusiveLock(runId: string) {
    if (this.activeRunId === runId) {
      this.activeRunId = null;
      this.activeRunMeta = null;
    }
    if (this.activeRunWatchdogRunId === runId && this.activeRunTimeoutId) {
      clearTimeout(this.activeRunTimeoutId);
      this.activeRunTimeoutId = null;
      this.activeRunWatchdogRunId = null;
    }
    // Fire-and-forget OK no stop path síncrono; finally também awaita.
    void this.clearActiveRunSentinel(runId);
    // Cancela jobs de visão enfileirados deste run (não gasta modelo após stop).
    this.visionQueue?.cancelRun?.(runId);
    // O abort controller NÃO é descartado aqui: o run ainda está desenrolando
    // (loop de recuperação XML, pre-flight de executeToolByName) e consulta
    // isRunAborted — após dispose o lookup falha e o run parado voltaria a
    // executar ferramentas. O dispose acontece no finally do processUserMessage.
    if (this.orchestrationOwnerRunId === runId) {
      this.orchestrationOwnerRunId = null;
    }
  }

  private isOrchestrationOwner(runId: string): boolean {
    return this.orchestrationOwnerRunId === runId;
  }

  private getRunAbortSignal(runId: string): AbortSignal | undefined {
    return this.runAbortRegistry.getSignal(runId);
  }

  private buildToolExecutionContext(runMeta: RunMeta, lockedTabId: number | null): ToolExecutionContext {
    return {
      runId: runMeta.runId,
      sessionId: runMeta.sessionId,
      lockedTabId,
      signal: this.getRunAbortSignal(runMeta.runId) || new AbortController().signal,
      deadlineAt: Date.now() + 120_000,
    };
  }

  private isRunAborted(runId: string): boolean {
    return this.runAbortRegistry.isAborted(runId);
  }

  private getInFlightCount(runId: string): number {
    return this.inFlightByRun.get(runId)?.count || 0;
  }

  private incrementInFlight(runId: string) {
    const current = this.inFlightByRun.get(runId) || { count: 0, startedAt: Date.now() };
    if (current.count === 0) current.startedAt = Date.now();
    current.count += 1;
    this.inFlightByRun.set(runId, current);
    if (this.activeRunId === runId) {
      this.activeInFlightToolCalls = current.count;
      this.activeInFlightToolStartedAt = current.startedAt;
    }
  }

  private decrementInFlight(runId: string) {
    const current = this.inFlightByRun.get(runId);
    if (!current) {
      if (this.activeRunId === runId) this.activeInFlightToolCalls = 0;
      return;
    }
    current.count = Math.max(0, current.count - 1);
    if (current.count === 0) {
      this.inFlightByRun.delete(runId);
      if (this.activeRunId === runId) {
        this.activeInFlightToolCalls = 0;
        this.activeInFlightToolStartedAt = 0;
      }
      if (this.runPhase === 'stopping' && this.activeRunId === runId) {
        this.completeUserStop(runId);
      }
      return;
    }
    this.inFlightByRun.set(runId, current);
    if (this.activeRunId === runId) this.activeInFlightToolCalls = current.count;
  }

  private completeUserStop(runId: string) {
    if (this.stopGraceTimerId) {
      clearTimeout(this.stopGraceTimerId);
      this.stopGraceTimerId = null;
    }
    const runMeta = this.activeRunId === runId ? this.activeRunMeta : null;
    this.runPhase = 'stopped';
    this.releaseRunExclusiveLock(runId);
    if (runMeta) {
      this.sendRuntime(runMeta, {
        type: 'run_stopped',
        message: 'Execução interrompida por você.',
        details: { runId: runMeta.runId, sessionId: runMeta.sessionId, timestamp: Date.now() },
      });
    }
  }

  // Sentinel de "run em andamento" em storage.session. O estado do run vive só na
  // memória do service worker; se o Chrome matar o SW no meio de um run, nenhum
  // run_error/run_complete é emitido e a UI fica presa em "executando". Persistir
  // este sentinel permite destravar o painel no próximo boot do SW.
  private async writeActiveRunSentinel(runMeta: RunMeta): Promise<void> {
    try {
      const token = createSentinelToken(runMeta.runId);
      this.activeRunSentinelRegistry.remember(runMeta.runId, token);
      await chrome.storage.session.set({
        glideActiveRun: {
          runId: runMeta.runId,
          turnId: runMeta.turnId,
          sessionId: runMeta.sessionId,
          startedAt: Date.now(),
          token,
        },
      });
    } catch {
      // storage.session pode não existir em alguns ambientes (ex.: testes Node).
    }
  }

  private async clearActiveRunSentinel(runId: string): Promise<void> {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.session) return;
      const expectedToken = this.activeRunSentinelRegistry.expectedToken(runId);
      if (!expectedToken) return;
      const stored = await chrome.storage.session.get(['glideActiveRun']);
      const sentinel = stored?.glideActiveRun;
      if (sentinel?.token === expectedToken) {
        await chrome.storage.session.remove('glideActiveRun');
      }
      this.activeRunSentinelRegistry.forget(runId);
    } catch {
      // ignore
    }
  }

  private async recoverOrphanedRun(): Promise<void> {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.session) return;
      const stored = await chrome.storage.session.get(['glideActiveRun']);
      const sentinel = stored?.glideActiveRun;
      if (!sentinel || typeof sentinel.runId !== 'string') return;
      // Re-checa DEPOIS do await: um user_message pode ter iniciado um run novo
      // nesta janela de boot (o write do sentinel dele é fire-and-forget). Sem
      // este guard a recovery removia o sentinel do run VIVO e emitia run_error
      // para ele — o painel desbloqueava no meio de uma execução legítima.
      if (this.activeRunId) return;
      const knownToken = this.activeRunSentinelRegistry.expectedToken(sentinel.runId);
      if (knownToken && knownToken === sentinel.token) return;
      await chrome.storage.session.remove('glideActiveRun');
      // O SW reiniciou no meio de um run: destrava a UI (best-effort — o painel
      // pode estar fechado; a mensagem é ignorada com segurança nesse caso).
      const runMeta: RunMeta = {
        runId: sentinel.runId,
        turnId: String(sentinel.turnId || sentinel.runId),
        sessionId: String(sentinel.sessionId || ''),
      };
      this.sendRuntime(runMeta, {
        type: 'run_error',
        message: 'O run anterior foi interrompido porque a extensão reiniciou. Envie a mensagem novamente.',
        details: {
          runId: runMeta.runId,
          sessionId: runMeta.sessionId,
          timestamp: Date.now(),
          recovered: true,
        },
      });
    } catch {
      // ignore
    }
  }

  constructor() {
    this.browserTools = new BrowserTools();
    this.currentSettings = null;
    this.currentPlan = null;
    this.activeRunId = null;
    this.activeRunMeta = null;
    this.activeRunAbortController = null;
    this.runAbortRegistry = new RunAbortRegistry();
    this.orchestrationOwnerRunId = null;
    this.activeRunLockOwnerRunId = null;
    this.activeRunTimeoutId = null;
    this.activeRunWatchdogRunId = null;
    this.activeRunLastActivityAt = 0;
    this.activeInFlightToolCalls = 0;
    this.activeInFlightToolStartedAt = 0;
    this.runPhase = 'idle';
    this.inFlightByRun = new Map();
    this.quarantinedRunIds = new Set();
    this.stopGraceTimerId = null;
    this.manualToolBusy = false;
    this.dedicatedTabId = null;
    this.dedicatedTabWindowId = null;
    this.activeRunLockedTabId = null;
    this.agentInitiatedTabCloses = new Set();
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
    this.failureRecoveryTracker = new FailureRecoveryTracker(3);
    this.runtimeBatcher = new RuntimeBatcher(
      (payload) => this.sendStreamDeltaImmediate(payload),
      (payload) => this.sendToolEventsBatchImmediate(payload),
    );
    this._sessionToolsCache = new Map();
    this.resetRunState();
    this.init();
  }

  private resetRunState() {
    this.currentPlan = null;
    this._planPromptCache = null;
    this.lastBrowserAction = null;
    this.awaitingVerification = false;
    this.consecutiveFailures = 0;
    this.failedTools = [];
    this.evidenceLedger = [];
    this.evidenceKeys.clear();
    this._sessionToolsCache.clear();
    this.findElementAttempts.clear();
    this.recoveryFindCount = 0;
    this.recoveryScreenshotCount = 0;
    this.lockedTabAliveCache.clear();
    this.failureRecoveryTracker.reset();
    this.invalidateDomCache();
  }

  private getRecoveryBudget(settings: Record<string, any>): {
    maxFind: number;
    maxScreenshot: number;
    allowVision: boolean;
  } {
    const mode = String(settings?.autoRecoveryMode || 'balanced')
      .trim()
      .toLowerCase();
    if (mode === 'off' || mode === 'none' || mode === 'false') {
      return { maxFind: 0, maxScreenshot: 0, allowVision: false };
    }
    if (mode === 'speed' || mode === 'fast') {
      return { maxFind: 1, maxScreenshot: 1, allowVision: true };
    }
    if (mode === 'max' || mode === 'full') {
      return { maxFind: 5, maxScreenshot: 4, allowVision: true };
    }
    // balanced (default): enough signal without recovery storms
    return { maxFind: 3, maxScreenshot: 2, allowVision: true };
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
        message: `Ajuste de segurança na configuração: ${warning}`,
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
    bumpSidePanelClaimGeneration();
    const previousOwner = this.sidePanelTabId;
    if (typeof previousOwner === 'number' && previousOwner !== tabId) {
      await chrome.sidePanel.setOptions({ tabId: previousOwner, enabled: false }).catch(() => {});
    }
    this.sidePanelTabId = tabId;
    await this.persistSidePanelTabId();
  }

  init() {
    void restrictLocalStorageToTrustedContexts();
    void bootstrapLocalCommandCodeSettings();
    bindRuntimeSettingsCacheInvalidation();
    bindPanelPortListener();
    // openPanelOnActionClick would let Chrome auto-open the panel using whatever
    // options the clicked tab already has; we need to enable that specific tab
    // (and disable the previous owner) before opening, so we drive it manually.
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((error) => console.error(error));
    // Disabling the global default (no tabId) means tabs never get the panel
    // unless explicitly enabled below - this is what stops it from following
    // the user across tabs.
    chrome.sidePanel.setOptions({ enabled: false }).catch((error) => console.error(error));

    // Critical path first: panel request/response stays on sendMessage; push events
    // use the port when connected (see sendToSidePanel).
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
      this.handleMessage(message, sender, sendResponse),
    );

    // Correctness-critical but async — overlaps first message handling instead of
    // blocking the listener registration above.
    void this.recoverOrphanedRun();

    chrome.action.onClicked.addListener((tab) => {
      const tabId = tab?.id;
      if (typeof tabId !== 'number') return;
      // Remember the opener tab for onOpened when Chrome omits info.tabId.
      this.pendingSidePanelOpenTabId = tabId;
      // sidePanel.open() must be initiated synchronously in the click handler;
      // awaiting setOptions first yields the event loop and loses the user-gesture token.
      void chrome.sidePanel
        .setOptions({ tabId, path: 'sidepanel/panel.html', enabled: true })
        .catch((error) => console.warn('[Glide] sidePanel.setOptions failed:', error));
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
      // Closing the tab the active run is locked to is an explicit stop signal
      // from the user — not a cue to recover by opening a replacement tab and
      // continuing unsupervised. Abort the run before clearing the lock, so the
      // orchestration loop cannot "recover" via openTab and keep working invisibly.
      // Exception: the agent's OWN closeTab call on its locked tab (rare, e.g.
      // end-of-task cleanup) is not a user stop signal — don't abort for that.
      const wasAgentInitiatedClose = this.agentInitiatedTabCloses.delete(tabId);
      const wasActiveRunTab =
        Boolean(this.activeRunId) && this.activeRunLockedTabId === tabId && !wasAgentInitiatedClose;
      if (this.activeRunLockedTabId === tabId) {
        this.activeRunLockedTabId = null;
      }
      this.domCacheLru.invalidateTab(tabId);
      this.lockedTabAliveCache.delete(tabId);
      void cdpDetach(tabId);
      if (this.sidePanelTabId === tabId) {
        this.sidePanelTabId = null;
        void this.persistSidePanelTabId();
      }
      if (wasActiveRunTab && this.activeRunMeta) {
        console.warn('[Glide] Locked run tab', tabId, 'was closed by the user; aborting the active run.');
        this.sendRuntime(this.activeRunMeta, {
          type: 'run_error',
          message: 'A aba em que o Glide estava atuando foi fechada. Execução interrompida.',
        });
        this.runAbortRegistry.abort(this.activeRunMeta.runId);
        // Libera o lock na hora (como stop_run): o painel já desbloqueia com o
        // run_error; manter activeRunId até o finally fazia um reenvio rápido
        // falhar com concurrent_run (até 180s se uma tool estiver pendurada).
        this.releaseRunExclusiveLock(this.activeRunMeta.runId);
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
        const claimAtClose = getSidePanelClaimGeneration();
        queueMicrotask(() => {
          if (getSidePanelClaimGeneration() !== claimAtClose) return;
          this.sidePanelTabId = null;
          void this.persistSidePanelTabId();
        });
      });
    }

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

    // Non-critical boot work — deferred so the first panel message is not blocked.
    setTimeout(() => {
      void this.hydrateExecutionEvents();
      pruneScreenshotStore().catch((err) => console.warn('pruneScreenshotStore failed:', err));
      void installProviderNetRequestRules().catch((e) => console.warn('Failed to install provider net rules:', e));
    }, 0);
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
      // panel), never from a content script running in a web page. Inclui os
      // fluxos de OAuth, o log de execução e o controle de run: nenhum deles tem
      // motivo para nascer de uma página web.
      const privilegedTypes = new Set([
        'user_message',
        'execute_tool',
        'stop_run',
        'run_status_query',
        'codex_oauth',
        'anthropic_oauth',
        'get_execution_events',
        'session_deleted',
        'session_active',
      ]);
      if (privilegedTypes.has(message?.type) && !this.isPrivilegedExtensionSender(sender)) {
        sendResponse?.({ success: false, error: 'Rejected: privileged message from a non-extension context.' });
        return false;
      }
      switch (message.type) {
        // Parada explícita pedida pelo usuário. Antes disto, um run em curso só
        // podia ser encerrado fechando a aba travada ou esperando o watchdog de
        // inatividade (120s) — para um agente que clica e digita em páginas
        // reais, isso é obrigatório.
        case 'stop_run': {
          const activeRunId = this.activeRunId;
          const requestedRunId = typeof message.runId === 'string' ? message.runId : null;
          if (!activeRunId || (requestedRunId && requestedRunId !== activeRunId)) {
            sendResponse?.({ success: false, stopped: false, activeRunId });
            return false;
          }
          this.runPhase = 'stopping';
          this.runAbortRegistry.abort(activeRunId);
          const inFlight = this.getInFlightCount(activeRunId);
          if (inFlight === 0) {
            this.completeUserStop(activeRunId);
            sendResponse?.({ success: true, stopped: true, activeRunId });
            return false;
          }
          if (this.stopGraceTimerId) clearTimeout(this.stopGraceTimerId);
          this.stopGraceTimerId = setTimeout(() => {
            this.quarantinedRunIds.add(activeRunId);
            this.completeUserStop(activeRunId);
          }, 15_000);
          sendResponse?.({ success: true, stopped: false, stopping: true, activeRunId });
          return false;
        }

        // Sondagem de liveness do painel. O envio desta mensagem também RESSUSCITA
        // o service worker (que então roda recoverOrphanedRun); a resposta diz se
        // o run ainda existe, para o painel não destravar uma execução legítima.
        case 'run_status_query': {
          sendResponse?.({
            success: true,
            activeRunId: this.activeRunId,
            lastActivityAt: this.activeRunLastActivityAt || null,
            inFlightToolCalls: this.activeRunId ? this.getInFlightCount(this.activeRunId) : 0,
            stopping: this.runPhase === 'stopping',
          });
          return false;
        }
        case 'user_message': {
          const sessionId = String(message.sessionId || '').trim() || `session-${Date.now()}`;
          const hasProvidedHistory =
            Array.isArray(message.conversationHistory) && message.conversationHistory.length > 0;
          const action = resolveUserMessageContextAction(sessionContextStore.has(sessionId), hasProvidedHistory);

          if (action === 'history_needed') {
            // Cold session (SW restart, first send, loaded history). Panel resends once with
            // full conversationHistory — no user-visible error. recoverOrphanedRun/watchdog
            // flows are unaffected because no run is queued here.
            sendResponse?.({ success: false, history_needed: true, sessionId });
            return false;
          }

          sendResponse?.({ success: true, queued: true });

          let initialHistory: Message[];
          if (action === 'adopt') {
            initialHistory = normalizeConversationHistory(message.conversationHistory as Message[]);
            sessionContextStore.adopt(sessionId, initialHistory);
          } else {
            initialHistory = sessionContextStore.get(sessionId);
            const userEntry = createMessage({ role: 'user', content: String(message.message || '') });
            if (userEntry) {
              initialHistory = normalizeConversationHistory([...initialHistory, userEntry]);
              sessionContextStore.append(sessionId, [userEntry]);
            }
          }

          void this.processUserMessage(initialHistory, message.selectedTabs || [], sessionId, message.panelTabId).catch(
            (error) => {
              console.error('Error processing user_message:', error);
              this.sendRunErrorFallback(sessionId, error?.message || String(error));
            },
          );
          return false;
        }

        case 'execute_tool': {
          if (this.activeRunId || this.manualToolBusy) {
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
          // Mutex: impede user_message de começar no meio do await de settings/tool.
          this.manualToolBusy = true;
          this.runAbortRegistry.create(runMeta.runId);

          void this.loadRuntimeSettings()
            .then((settings) => {
              if (this.activeRunId) {
                throw new Error('A run started while preparing the manual tool.');
              }
              return this.executeToolByName(
                String(message.tool || ''),
                (message.args && typeof message.args === 'object' ? message.args : {}) as Record<string, any>,
                { runMeta, settings, visionProfile: null },
                typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
              );
            })
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
            )
            .finally(() => {
              this.manualToolBusy = false;
              this.runAbortRegistry.dispose(runMeta.runId);
            });
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

        case 'session_deleted': {
          if (message.sessionId) {
            const deletedId = String(message.sessionId);
            this.deferredCompactionSessions.delete(deletedId);
            sessionContextStore.delete(deletedId);
            resetCompactionHysteresis(deletedId);
            this.sessionGenerations.delete(deletedId);
            const tombstoneRunId = this.activeRunId || `delete-${Date.now()}`;
            this.sessionTombstones.mark(deletedId, tombstoneRunId);
          }
          sendResponse?.({ success: true });
          return false;
        }

        case 'session_active': {
          if (message.sessionId) {
            sessionContextStore.touch(String(message.sessionId));
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
            .then(async (result) => {
              let chatgptAuth = false;
              if (!result.apiKey) {
                const bundle = buildCodexChatGptBundleFromOAuth(result);
                if (bundle) {
                  await writeCodexChatGptAuth(bundle);
                  chatgptAuth = true;
                }
              }
              sendResponse?.({ success: true, ...result, chatgptAuth });
            })
            .catch((error) =>
              sendResponse?.({
                success: false,
                error: error?.message || String(error) || 'Falha no login OAuth.',
              }),
            );
          return true;
        }

        case 'anthropic_oauth': {
          void runAnthropicOAuthFlow()
            .then((bundle) => sendResponse?.({ success: true, accessToken: bundle.accessToken }))
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
    await restrictLocalStorageToTrustedContexts();
    await bootstrapLocalCommandCodeSettings();
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
            // Multimodal user messages may include image parts without text.
            if (candidate.type === 'image' || candidate.image || candidate.image_url) {
              return '[image attached]';
            }
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
  } {
    // Runtime enxuto e previsível: sem auto-inflação de tokens/timeout/tamanho de
    // relatório. Provedor + modelo são os únicos botões expostos ao usuário.
    // (Temperatura NÃO é enviada a nenhum provedor — ver ai/anthropic-options.ts.)
    const tunedSettings = { ...settings };
    const tunedProfile = { ...profile };
    return {
      tunedSettings,
      tunedProfile,
      qualityMode: 'speed',
      minimumReportSections: 3,
      maxOrchestrationPasses: 12,
      maxModelSteps: 64,
    };
  }

  async ensureDedicatedRunTab(preferredTabId?: number | null) {
    const candidates: number[] = [];
    const addCandidate = (tabId: unknown) => {
      if (typeof tabId === 'number' && !candidates.includes(tabId)) {
        candidates.push(tabId);
      }
    };

    // Prefer the tab that owns the side panel so the user can watch automation
    // and the panel at the same time. navigate() will move chrome:// / about:
    // pages onto http(s); creating a separate run tab breaks that pairing.
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

    // Prefer an already-http(s) owner tab, but still adopt chrome:// / NTP /
    // about:blank — those are normal places to open the panel; navigate fixes them.
    const httpCandidate = loadedCandidates.find((tab) => isHttpUrl(tab.url));
    if (httpCandidate) {
      return adoptDedicatedTab(httpCandidate);
    }
    if (loadedCandidates[0]) {
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

    // Last resort only: panel owner tab is gone.
    const createOptions: chrome.tabs.CreateProperties = {
      url: DEDICATED_RUN_TAB_URL,
      active: true,
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
      if (this.activeRunId || this.manualToolBusy) {
        this.sendRuntime(runMeta, {
          type: 'run_error',
          message:
            'Já existe uma execução em andamento. Aguarde ela terminar (ou use o botão de parar) antes de enviar outra.',
          details: {
            runId: runMeta.runId,
            sessionId: runMeta.sessionId,
            timestamp: Date.now(),
            reason: 'concurrent_run',
          },
        });
        return;
      }
      this.activeRunId = runMeta.runId;
      this.activeRunMeta = runMeta;
      this.runPhase = 'running';
      this.quarantinedRunIds.delete(runMeta.runId);
      this.activeRunAbortController = this.runAbortRegistry.create(runMeta.runId);
      this.orchestrationOwnerRunId = runMeta.runId;
      this.sessionGenerations.bump(sessionId);
      this.activeRunLastActivityAt = Date.now();
      this.armActiveRunWatchdog(runMeta);
      void this.writeActiveRunSentinel(runMeta);
      const settings = await this.loadRuntimeSettings();
      const normalizedHistory = normalizeConversationHistory(conversationHistory || []);
      const latestUserText = this.getLatestUserText(normalizedHistory);
      // A follow-up in an ongoing browser task ("e aí?", a correction) rarely
      // repeats action keywords itself; recent tool usage keeps tool access armed
      // for it instead of stranding the agent with no tool to act on its own reply.
      const taskIntent = detectTaskIntent(latestUserText, {
        selectedTabCount: Array.isArray(selectedTabs) ? selectedTabs.length : 0,
        recentToolActivity: hasRecentToolActivity(normalizedHistory),
      });

      this.currentSettings = settings;
      this.resetRunState();

      const baseProfile = this.resolveProfile(settings);
      this.emitConfigClampWarnings(runMeta, settings, baseProfile);
      const qualityRuntime = this.applyRuntimeQualityTuning(settings, baseProfile);
      const runtimeSettings = qualityRuntime.tunedSettings;
      const runtimeProfile = qualityRuntime.tunedProfile;
      const visionProfile = runtimeSettings.visionBridge !== false ? runtimeProfile : null;
      this.currentSettings = runtimeSettings;
      this.browserTools.setUseContentBridge(runtimeSettings.useContentBridge !== false);
      let anthropicAuthOk = true;
      let hasAnthropicOAuthSession = false;
      let codexAuthOk = true;
      let hasCodexChatGptSession = false;
      let xaiAuthOk = true;
      let hasXaiOAuthSession = false;
      if (String(runtimeProfile.provider) === 'anthropic') {
        const freshToken = await ensureFreshAnthropicToken(String(runtimeProfile.apiKey || ''));
        if (freshToken && freshToken !== runtimeProfile.apiKey) {
          runtimeProfile.apiKey = freshToken;
          runtimeSettings.apiKey = freshToken;
        }
        const authHealth = await getAnthropicAuthHealth();
        anthropicAuthOk = authHealth.ok;
        hasAnthropicOAuthSession = Boolean(await readAnthropicOAuth());
      }
      if (String(runtimeProfile.provider) === 'codex') {
        runtimeSettings.codexAuthMode = resolveCodexAuthMode(runtimeSettings);
        runtimeProfile.codexAuthMode = runtimeSettings.codexAuthMode;
        hasCodexChatGptSession = runtimeSettings.codexAuthMode === 'chatgpt';
        if (hasCodexChatGptSession) {
          await ensureFreshCodexChatGptToken();
          const codexHealth = await getCodexAuthHealth();
          codexAuthOk = codexHealth.ok;
        } else {
          hasCodexChatGptSession = Boolean(await readCodexChatGptAuth());
        }
      }
      if (String(runtimeProfile.provider) === 'xai' || String(runtimeProfile.provider) === 'grok') {
        const xaiBundle = await readXaiOAuth();
        hasXaiOAuthSession = Boolean(xaiBundle?.accessToken);
        const freshXai = await ensureFreshXaiToken(String(runtimeProfile.apiKey || ''));
        if (freshXai && freshXai !== runtimeProfile.apiKey) {
          runtimeProfile.apiKey = freshXai;
          runtimeSettings.apiKey = freshXai;
        }
        if (!runtimeProfile.apiKey && xaiBundle?.accessToken) {
          runtimeProfile.apiKey = xaiBundle.accessToken;
          runtimeSettings.apiKey = xaiBundle.accessToken;
        }
        const xaiHealth = await getXaiAuthHealth();
        xaiAuthOk = xaiHealth.ok;
      }

      // Pré-checagem de credencial: falha AQUI, com texto acionável e atalho para as
      // Configurações, em vez de deixar o run gastar tempo e voltar um erro cru do
      // provedor no meio da execução (ex.: "Invalid bearer token").
      const readiness = checkProviderReadiness({
        provider: runtimeProfile.provider,
        apiKey: runtimeProfile.apiKey,
        customEndpoint: runtimeProfile.customEndpoint,
        authHealthOk: anthropicAuthOk,
        hasOAuthSession: hasAnthropicOAuthSession,
        codexAuthHealthOk: codexAuthOk,
        hasCodexChatGptSession,
        xaiAuthHealthOk: xaiAuthOk,
        hasXaiOAuthSession,
      });
      if (readiness) {
        this.sendRuntime(runMeta, {
          type: 'run_error',
          message: readiness.message,
          details: {
            runId: runMeta.runId,
            sessionId: runMeta.sessionId,
            timestamp: Date.now(),
            action: readiness.action,
            reason: readiness.reason,
          },
        });
        return;
      }

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
          message: `Automação na aba atual (${lockedTabId}${lockedTab.title ? `: ${lockedTab.title}` : ''}).`,
        });
      } else {
        this.activeRunLockedTabId = null;
        this.activeRunLockOwnerRunId = null;
      }

      const tools = taskIntent.usesBrowserAutomation ? this.getToolsForSession(runtimeSettings, lockedTabId) : [];

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
        codexAuthMode: runtimeProfile.codexAuthMode ?? resolveCodexAuthMode(runtimeSettings),
      });

      // Counts real tool executions so a provider retry never replays a pass
      // that already produced side effects (duplicate navigate/click/type).
      let toolExecutionsTotal = 0;
      let modelActivityWatchdog: ModelActivityWatchdog | null = null;
      const toolSet = taskIntent.usesBrowserAutomation
        ? buildRunToolSet(
            tools,
            async (toolName, args, options) => {
              toolExecutionsTotal += 1;
              modelActivityWatchdog?.touch();
              try {
                return await this.executeToolByName(
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
              } finally {
                modelActivityWatchdog?.touch();
              }
            },
            runtimeProfile.provider,
            (toolCallId: string) => this.consumeModelScreenshotImage(toolCallId),
          )
        : undefined;

      const streamEnabled = runtimeSettings.streamResponses !== false;
      // Claude-for-Chrome behaviour: recover instead of bailing after the first failed action.
      const maxRecoveryAttempts = 2;
      const maxInvalidFinalRetries = 1;
      // A turn that promises / narrates more work (with or without prior tools in
      // the same pass) violates the execution contract. Force a bounded
      // continuation so the agent acts instead of ending the run mid-task.
      const maxContinuationForces = 3;
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
      let continuationForceCount = 0;
      let failedToolContinuationUsed = false;
      let currentHistory = normalizedHistory;
      const contextLimit = runtimeProfile.contextLimit || runtimeSettings.contextLimit || 200000;
      if (this.deferredCompactionSessions.delete(sessionId)) {
        if (!this.sessionTombstones.isTombstoned(sessionId)) {
          const compactedHistory = await this.sessionCompactionQueue.run(sessionId, () =>
            this.maybeCompactContext({
              runMeta,
              history: currentHistory,
              contextLimit,
              model,
              runtimeProfile,
              runtimeSettings,
              sessionIdAtStart: sessionId,
              sourceRevision: contextTransactionStore.read(sessionId).revision,
              abortSignal: this.getRunAbortSignal(runMeta.runId),
            }),
          );
          if (compactedHistory) {
            currentHistory = compactedHistory;
          }
        }
      }
      let finalText = '';
      let reasoningText: string | null = null;

      let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 };
      let toolResults: Array<Record<string, any>> = [];
      let toolCalls: Array<Record<string, any>> = [];
      let responseMessages: Message[] = [];
      let qualityReport: Record<string, any> | null = null;

      // Fix 3: Backoff for transient provider errors.
      const providerBackoff = createExponentialBackoff({ baseMs: 500, maxMs: 8000 });
      const MAX_PROVIDER_RETRIES = 3;

      const runPassCache = new RunPassCache();
      // Um único stream_start por run — re-orquestração não deve reabrir bolha de stream.
      let streamSessionStarted = false;

      const runModelPass = async (messages: Message[]) => {
        const modelMessages = runPassCache.getModelMessages(messages, {
          systemMessageMode: runtimeProfile.provider === 'anthropic' ? 'user' : 'system',
        });
        // O bloco `system` continua SEM breakpoint de cache: foi ele que fez o
        // endpoint OAuth do Claude Code devolver respostas vazias. O breakpoint vai
        // na última mensagem (ver ai/prompt-cache.ts), o que reaproveita todo o
        // prefixo — system + histórico + resultados de ferramenta — a ~10% do custo.
        const { base: systemBase, state: systemState } = this.enhanceSystemPrompt(
          runtimeProfile.systemPrompt || '',
          context,
          runMeta.runId,
        );
        // Anthropic: o <execution_state> é volátil (progresso do plano, URL,
        // recovery) e antes entrava concatenado no bloco system — o início do
        // prefixo — o que zerava o prompt cache ENTRE passes. Agora o estado vai
        // como mensagem user no FIM do array (depois da âncora de cache),
        // efêmero por passe: system+histórico ficam estáveis e o acerto de cache
        // sobrevive entre passes. Outros provedores: comportamento inalterado.
        const splitAnthropicState = runtimeProfile.provider === 'anthropic' && Boolean(systemState);
        const fullSystemPrompt = splitAnthropicState
          ? systemBase
          : systemState
            ? `${systemBase}\n\n${systemState}`
            : systemBase;
        const systemPayload = this.sanitizeSystemPrompt(fullSystemPrompt, runtimeProfile.provider);
        let promptCacheApplied = isAnthropicPromptCacheEnabled(runtimeProfile.provider);
        // callMessages é reatribuído se o cache for desligado no retry (ver empty response).
        const appendExecutionState = (base: ModelMessage[]): ModelMessage[] =>
          splitAnthropicState ? [...base, { role: 'user', content: systemState } as ModelMessage] : base;
        let callMessages = appendExecutionState(applyPromptCacheBreakpoint(modelMessages, runtimeProfile.provider));
        // Fim do prefixo inicial: a âncora de cache que não se move durante a
        // passe (ver applyStepPromptCacheBreakpoints). A mensagem de estado fica
        // DEPOIS da âncora — se ela fosse a âncora, mudar a cada passe voltaria
        // a invalidar o cache.
        let cacheAnchorIndex = splitAnthropicState ? callMessages.length - 2 : callMessages.length - 1;
        const timeoutMs = resolveTimeoutMs(runtimeProfile.timeout ?? runtimeSettings.timeout);
        const runAbortSignal = this.getRunAbortSignal(runMeta.runId);

        for (let providerAttempt = 0; providerAttempt < MAX_PROVIDER_RETRIES; providerAttempt += 1) {
          if (runAbortSignal?.aborted) {
            throw new Error('Run aborted.');
          }
          const toolExecutionsAtAttemptStart = toolExecutionsTotal;
          const abortController = new AbortController();
          let timedOut = false;
          let hardTimedOut = false;
          let runAborted = false;
          let streamStopSent = false;
          let streamedTextBuffer = '';
          let streamProviderError: unknown = null;
          const activityWatchdog = new ModelActivityWatchdog(
            timeoutMs,
            () => {
              timedOut = true;
              abortController.abort();
            },
            // Tools longas renovam via wall-clock no run watchdog; aqui só
            // evitamos abortar o modelo no meio de um tool legítimo curto.
            // Teto: se a tool estoura MAX_IN_FLIGHT_TOOL_WALL_MS o run watchdog aborta.
            () => this.activeInFlightToolCalls > 0,
          );
          modelActivityWatchdog = activityWatchdog;
          activityWatchdog.start();
          // Guardamos a referência para remover no finally: `once` só limpa se o
          // abort disparar; sem remoção explícita, cada tentativa de cada passo
          // acumularia um listener no signal que vive o run inteiro.
          let onRunAbort: (() => void) | null = null;
          if (runAbortSignal) {
            if (runAbortSignal.aborted) {
              runAborted = true;
              abortController.abort();
            } else {
              onRunAbort = () => {
                runAborted = true;
                abortController.abort();
              };
              runAbortSignal.addEventListener('abort', onRunAbort, { once: true });
            }
          }

          if (streamEnabled && providerAttempt === 0 && !streamSessionStarted) {
            streamSessionStarted = true;
            this.sendRuntime(runMeta, { type: 'assistant_stream_start' });
          }

          try {
            const result = streamText({
              model,
              ...resolveProviderOptions(runtimeProfile.provider),
              system: systemPayload,
              messages: callMessages,
              tools: toolSet,
              maxOutputTokens: runtimeProfile.maxTokens ?? 2048,
              stopWhen: stepCountIs(qualityRuntime.maxModelSteps),
              abortSignal: abortController.signal,
              // Reposiciona o breakpoint de cache a cada step para que os
              // resultados de ferramenta acumulados na passe também entrem no
              // prefixo cacheado, em vez de serem recobrados por step.
              prepareStep: ({ messages }) => ({
                messages: applyStepPromptCacheBreakpoints(messages, runtimeProfile.provider, cacheAnchorIndex),
              }),
              onChunk: ({ chunk }) => {
                activityWatchdog.touch();
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
                  activityWatchdog.touch();
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
              const heartbeatId = setInterval(() => {
                this.touchActiveRun(runMeta.runId);
                activityWatchdog.touch();
              }, 15000);
              // O heartbeat acima mantém os watchdogs vivos durante uma resposta
              // não-streaming legítima (que não emite chunks). Como isso também
              // mascararia uma conexão travada, corremos contra um teto rígido que
              // aborta e falha o run em vez de pendurar para sempre.
              let hardTimeoutId: ReturnType<typeof setTimeout> | null = null;
              try {
                await Promise.race([
                  result.text,
                  new Promise((_resolve, reject) => {
                    hardTimeoutId = setTimeout(() => {
                      hardTimedOut = true;
                      abortController.abort();
                      reject(new Error('Model response timed out with no output (non-streaming).'));
                    }, NON_STREAM_MODEL_HARD_TIMEOUT_MS);
                  }),
                ]);
              } finally {
                clearInterval(heartbeatId);
                if (hardTimeoutId) clearTimeout(hardTimeoutId);
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

            // cachedInputTokens > 0 means the static system/tools/history prefix
            // was read from the prompt cache (~10% cost) instead of re-billed.
            // Threaded into the usage payload so cache hits are visible in the UI.
            const cachedInputTokens = Number((usage as { cachedInputTokens?: number })?.cachedInputTokens || 0);
            const normalizedUsage = {
              inputTokens: Number(usage?.inputTokens || 0),
              outputTokens: Number(usage?.outputTokens || 0),
              totalTokens: Number(usage?.totalTokens || 0),
              cachedInputTokens,
            };

            const flatToolResults = steps.flatMap((step) => step.toolResults || []);
            const flatToolCalls = steps.flatMap((step) => step.toolCalls || []);
            // Reasoning conta: passe só com thinking (~20 tokens out) não é
            // "resposta vazia do provedor" — o retry de invalid_final cobre isso.
            if (
              isEmptyModelPassResult({
                text,
                reasoningText: reasoning,
                toolCalls: flatToolCalls,
                toolResults: flatToolResults,
              })
            ) {
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
            if (runAborted && !timedOut && !hardTimedOut) {
              throw new Error('Run aborted.');
            }
            if (hardTimedOut) {
              throw new Error(
                `Model response timed out with no output after ${Math.round(NON_STREAM_MODEL_HARD_TIMEOUT_MS / 1000)}s (non-streaming).`,
              );
            }
            if (timedOut || isAbortError(error)) {
              throw new Error(`Model request was inactive for ${timeoutMs}ms`);
            }
            // Resposta vazia com prompt caching ligado é o sintoma conhecido do
            // endpoint OAuth do Claude Code. Desligamos o cache pelo resto da vida
            // do worker e retentamos sem ele, em vez de falhar o run.
            if (
              promptCacheApplied &&
              isEmptyModelResponseError(error) &&
              toolExecutionsTotal === toolExecutionsAtAttemptStart
            ) {
              disableAnthropicPromptCache();
              // disableAnthropicPromptCache só flipa o flag — callMessages ainda
              // carrega providerOptions.cacheControl do mark inicial. Rebuild a
              // partir de modelMessages limpos; senão o "retry sem cache" continua
              // com breakpoints e gasta as tentativas em vão.
              promptCacheApplied = false;
              callMessages = appendExecutionState(modelMessages);
              cacheAnchorIndex = splitAnthropicState ? callMessages.length - 2 : callMessages.length - 1;
              this.sendRuntime(runMeta, {
                type: 'run_warning',
                message: 'Resposta vazia do provedor com cache de prompt; repetindo sem cache.',
              });
              continue;
            }
            const providerStatus = extractProviderErrorStatus(error);
            if (!isRetryableProviderError(providerStatus) && !isOverloadedProviderError(error)) {
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
            // Rate limit com `retry-after` manda: respeitar a janela do provedor evita
            // queimar as tentativas restantes em rajada e voltar 429 de novo.
            const retryAfterMs = extractRetryAfterMs(error);
            const delayMs = Math.max(providerBackoff(attemptNumber), retryAfterMs);
            const isRateLimited = providerStatus === 429 || retryAfterMs > 0;
            this.sendRuntime(runMeta, {
              type: 'run_warning',
              message: isRateLimited
                ? `Limite de uso do provedor atingido (tentativa ${attemptNumber}/${MAX_PROVIDER_RETRIES}); aguardando ${Math.round(delayMs / 1000)}s.`
                : `Instabilidade do provedor (tentativa ${attemptNumber}/${MAX_PROVIDER_RETRIES}); repetindo em ${Math.round(delayMs / 1000)}s.`,
            });
            // Sleep abortável: stop/tab-close durante backoff 429 não espera o delay inteiro.
            await new Promise<void>((resolve, reject) => {
              if (runAbortSignal?.aborted) {
                reject(new Error('Run aborted.'));
                return;
              }
              let settled = false;
              const onAbort = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error('Run aborted.'));
              };
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                runAbortSignal?.removeEventListener('abort', onAbort);
                resolve();
              }, delayMs);
              runAbortSignal?.addEventListener('abort', onAbort, { once: true });
            });
          } finally {
            activityWatchdog.stop();
            if (modelActivityWatchdog === activityWatchdog) modelActivityWatchdog = null;
            if (onRunAbort) runAbortSignal?.removeEventListener('abort', onRunAbort);
          }
        }
        throw new Error('Model retries exhausted before producing a response.');
      };

      let orchestrationPassCount = 0;
      while (true) {
        orchestrationPassCount += 1;
        context.orchestrationPass = orchestrationPassCount;
        if (!this.isOrchestrationOwner(runMeta.runId)) {
          throw new Error('Run superseded: orchestration state was taken by a newer run.');
        }
        if (this.activeRunId !== runMeta.runId) {
          throw new Error('Run superseded: the watchdog released this run after a period of inactivity.');
        }
        this.touchActiveRun(runMeta.runId);
        if (orchestrationPassCount > maxOrchestrationPasses) {
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: `Parada de segurança após ${maxOrchestrationPasses} ciclos de orquestração.`,
          });
          throw new Error(`Safety stop: exceeded ${maxOrchestrationPasses} orchestration passes.`);
        }
        // Compactação no MEIO do run: antes só rodava após o loop terminar, então
        // um run longo de automação podia estourar a janela (e ser recobrado
        // integralmente a cada passe) sem nunca compactar. deferCompaction é a
        // opção do usuário de adiar — respeitada aqui também.
        if (!runtimeSettings.deferCompaction && !this.sessionTombstones.isTombstoned(sessionId)) {
          const midRunCheck = shouldCompact({
            contextTokens: estimateContextTokens(currentHistory).tokens,
            contextLimit,
            settings: DEFAULT_COMPACTION_SETTINGS,
            sessionId,
          });
          if (midRunCheck.shouldCompact) {
            const compactedHistory = await this.sessionCompactionQueue.run(sessionId, () =>
              this.maybeCompactContext({
                runMeta,
                history: currentHistory,
                contextLimit,
                model,
                runtimeProfile,
                runtimeSettings,
                sessionIdAtStart: sessionId,
                sourceRevision: contextTransactionStore.read(sessionId).revision,
                abortSignal: this.getRunAbortSignal(runMeta.runId),
              }),
            );
            if (compactedHistory) {
              currentHistory = compactedHistory;
            }
          }
        }
        const passResult = await runModelPass(currentHistory);
        const toolRecoverySource = [passResult.text, passResult.reasoningText || ''].filter(Boolean).join('\n\n');
        const availableToolNames = tools.map((tool) => tool.name);
        // Filtra as chamadas XML pelo toolset da sessão — sem isto um modelo podia
        // emitir <tool_call>ferramenta_fora_do_toolset</tool_call> e contornar o gate
        // de permissões. extractRecoverableToolCalls já aplica esse filtro.
        const recoveredToolCalls = this.dedupeRecoveredToolCalls([
          ...this.extractXmlToolCalls(toolRecoverySource).filter((call) => availableToolNames.includes(call.name)),
          ...extractRecoverableToolCalls(toolRecoverySource, availableToolNames),
        ]);
        toolResults = passResult.toolResults || [];
        toolCalls = passResult.toolCalls || [];

        if (recoveredToolCalls.length > 0 && toolResults.length === 0 && recoveryAttempt < maxRecoveryAttempts) {
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: 'O modelo pediu ferramentas em texto; executando e retomando.',
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
            if (this.isRunAborted(runMeta.runId)) {
              break;
            }
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
        const failedToolDecision = taskIntent.usesBrowserAutomation
          ? advanceFailedToolRecovery({
              hasFailedTools,
              awaitingVerification: this.awaitingVerification,
              continuationUsed: failedToolContinuationUsed,
            })
          : { outcome: 'complete' as const, continuationUsed: false };
        failedToolContinuationUsed = failedToolDecision.continuationUsed;
        const failedToolOutcome = failedToolDecision.outcome;
        if (failedToolOutcome === 'continue') {
          const partialText = stripRecoverableToolCalls(this.stripXmlToolCalls(passResult.text), availableToolNames);
          const recoveryTurn = buildToolTurnMessages(
            partialText,
            passResult.reasoningText || null,
            this.buildToolResultMessageContent(toolResults),
            toolCalls,
          );
          currentHistory = normalizeConversationHistory(
            [
              ...currentHistory,
              ...recoveryTurn,
              {
                role: 'system',
                content:
                  'RECOVERY REQUIRED: Previous browser tools failed and no successful verification followed. Do not finalize yet. Call readPage or findElement (then getContent structure if needed), change selector or strategy, and make one bounded recovery attempt. If the result code is REPEATED_FAILURE, never retry the same target.',
              },
            ],
            ORCHESTRATION_RETRY_NORMALIZE,
          );
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: 'Uma ação no navegador falhou sem verificação; fazendo uma tentativa de recuperação.',
          });
          assertOrchestrationContinue('failed_tool_recovery');
          continue;
        }
        if (failedToolOutcome === 'fail') {
          let failedToolName = '';
          let failedToolResult: Record<string, unknown> = {};
          for (let index = toolResults.length - 1; index >= 0; index -= 1) {
            const candidate = toolResults[index];
            const output = this.extractToolResultOutput(candidate);
            if (output?.success !== false) continue;
            failedToolName = String(candidate?.toolName || candidate?.name || '');
            failedToolResult = output;
            break;
          }
          const terminalFailure = buildTerminalToolFailure(failedToolName, failedToolResult);
          this.sendRuntime(runMeta, {
            type: 'run_error',
            message: terminalFailure.message,
            details: terminalFailure.details,
          });
          this.releaseRunExclusiveLock(runMeta.runId);
          return;
        }
        const activePlan = this.currentPlan as RunPlan | null;
        const planSteps = activePlan ? activePlan.steps : [];

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
            message: 'O modelo não produziu resposta final utilizável; refazendo a resposta uma vez.',
          });
          assertOrchestrationContinue('invalid_final');
          continue;
        }

        // Execution contract: final prose that promises / narrates unfinished work
        // must not end the run — even if this pass already ran tools (e.g. navigate
        // then "vou rolar…"). User handoffs (question / CAPTCHA / login) are valid stops.
        const planHasPending =
          Array.isArray(this.currentPlan?.steps) &&
          this.currentPlan.steps.some((s) => s.status !== 'done' && s.status !== 'blocked');
        const incompleteNarration =
          taskIntent.usesBrowserAutomation &&
          hasValidText &&
          !this.isGenericCompletionText(cleanedText) &&
          !textAwaitsUser(cleanedText) &&
          continuationForceCount < maxContinuationForces &&
          (shouldForceToolContinuation(cleanedText) ||
            // Plan still open and this pass produced no tools → keep working.
            (planHasPending && !hadToolCalls));

        if (incompleteNarration) {
          continuationForceCount += 1;
          const toolTurn = hadToolCalls
            ? buildToolTurnMessages(
                cleanedText || '',
                passResult.reasoningText || null,
                this.buildToolResultMessageContent(toolResults),
                toolCalls,
              )
            : [{ role: 'assistant' as const, content: cleanedText, thinking: passResult.reasoningText || null }];
          currentHistory = normalizeConversationHistory(
            [
              ...currentHistory,
              ...toolTurn,
              {
                role: 'system',
                content:
                  'EXECUTION CONTRACT: You narrated or promised work instead of finishing it. Call the NEXT browser tool NOW (do not only describe it). Text without a tool call is allowed only when: (1) the task is fully done and you report the RESULT, (2) you need the user to confirm a decision, or (3) a blocker only the user can clear (CAPTCHA, login) — then ask explicitly. Prefer: act first, short result text last.',
              },
            ],
            ORCHESTRATION_RETRY_NORMALIZE,
          );
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: 'O modelo parou no meio da tarefa; forçando a continuação com ferramentas.',
          });
          // Reset streak key when we still make progress via forced tools later;
          // same-reason cap still applies across pure narration loops.
          assertOrchestrationContinue('promised_continuation');
          // Allow another forced pass of the same kind after tools actually ran.
          lastContinueReason = null;
          sameContinueStreak = 0;
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
            'A ação foi executada, mas não consegui gerar uma resposta final confiável.';
        } else {
          finalText =
            'Não consegui gerar uma resposta final confiável neste turno. Tente novamente em alguns segundos.';
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

      const nextHistory = normalizeConversationHistory([...currentHistory, ...responseMessages]);
      const contextSourceSessionId = sessionId;
      const sourceRevision = contextTransactionStore.read(contextSourceSessionId).revision;
      let terminalHistory = nextHistory;
      let compacted = false;
      const compactionSettings = DEFAULT_COMPACTION_SETTINGS;
      let contextUsage = estimateContextTokens(nextHistory);

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
            message: 'Compactação do contexto adiada para a próxima mensagem.',
          });
        } else if (!this.sessionTombstones.isTombstoned(sessionId)) {
          const compactedHistory = await this.sessionCompactionQueue.run(sessionId, () =>
            this.maybeCompactContext({
              runMeta,
              history: nextHistory,
              contextLimit,
              model,
              runtimeProfile,
              runtimeSettings,
              sessionIdAtStart: sessionId,
              sourceRevision,
              abortSignal: this.getRunAbortSignal(runMeta.runId),
            }),
          );
          if (compactedHistory) {
            terminalHistory = compactedHistory;
            compacted = true;
            contextUsage = estimateContextTokens(compactedHistory);
          }
        }
      }

      if (this.sessionTombstones.isTombstoned(contextSourceSessionId) || this.isRunAborted(runMeta.runId)) {
        throw new Error('Run aborted before context commit.');
      }
      const contextCommit = contextTransactionStore.commit({
        sessionId,
        ...(sessionId !== contextSourceSessionId ? { previousSessionId: contextSourceSessionId } : {}),
        sourceRevision,
        runId: runMeta.runId,
        turnId: runMeta.turnId,
        messages: terminalHistory,
        compacted,
        contextUsage: { approxTokens: contextUsage.tokens, contextLimit },
      });
      sessionContextStore.set(contextCommit.sessionId, contextCommit.messages);
      if (contextCommit.previousSessionId && contextCommit.previousSessionId !== contextCommit.sessionId) {
        sessionContextStore.delete(contextCommit.previousSessionId);
      }
      this.runtimeBatcher.flush(runMeta.runId);
      this.sendRuntime(runMeta, {
        type: 'context_commit',
        previousSessionId: contextCommit.previousSessionId,
        revision: contextCommit.revision,
        messages: contextCommit.messages,
        compacted: contextCommit.compacted,
        contextUsage: contextCommit.contextUsage,
      });
      this.sendRuntime(runMeta, {
        type: 'assistant_final',
        content: finalText,
        thinking: reasoningText || null,
        model: runtimeProfile.model || runtimeSettings.model || '',
        usage: {
          inputTokens: totalUsage.inputTokens || 0,
          outputTokens: totalUsage.outputTokens || 0,
          totalTokens: totalUsage.totalTokens || 0,
          cachedInputTokens: (totalUsage as { cachedInputTokens?: number }).cachedInputTokens || 0,
        },
        // Real size of the conversation that will be re-sent next turn — this is
        // the context-WINDOW occupancy (bounded by contextLimit / compaction), NOT
        // the cumulative per-turn input which sums across every tool step.
        contextUsage: { approxTokens: contextUsage.tokens, contextLimit },
        responseMessages,
        contextRevision: contextCommit.revision,
        qualityReport,
      });
      // Turn terminal: libera o lock após assistant_final. Compaction/warnings
      // terminam antes do evento terminal para o painel não descartá-los.
      this.releaseRunExclusiveLock(runMeta.runId);
    } catch (error) {
      console.error('Error processing user message:', error);
      // Deliberate stops (idle watchdog, locked tab closed) already sent their
      // own specific run_error before aborting — don't pile a generic "Erro no
      // provedor: Run aborted." toast on top of the real reason.
      if (!isDeliberateRunStop(error)) {
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
      }
    } finally {
      this.sessionTombstones.clearForRun(runMeta.runId);
      this.runtimeBatcher.flush(runMeta.runId);
      this.runtimeBatcher.drop(runMeta.runId);
      this.runEventSequencer.drop(runMeta.runId);

      // Limpeza run-scoped: sempre roda para ESTE run, mesmo quando o watchdog já
      // zerou activeRunId antes do finally (o guard antigo `activeRunId === runId`
      // ficava falso nesse caminho e vazava pendingVisionByRun permanentemente).
      this.pendingVisionByRun.delete(runMeta.runId);
      this.visionQueue.cancelRun(runMeta.runId);
      await this.clearActiveRunSentinel(runMeta.runId);
      this.runAbortRegistry.dispose(runMeta.runId);
      if (this.orchestrationOwnerRunId === runMeta.runId) {
        this.orchestrationOwnerRunId = null;
      }

      // "superseded" = um run sucessor já assumiu o estado global (e tem o próprio
      // watchdog). Nesse caso NÃO tocamos no estado global — o run B cuida do que é dele.
      const superseded = this.activeRunId !== null && this.activeRunId !== runMeta.runId;
      if (!superseded) {
        // Drop yellow debugger banner when the run ends (stop, success, or error).
        void cdpDetachAll();
        if (this.activeRunWatchdogRunId === runMeta.runId && this.activeRunTimeoutId) {
          clearTimeout(this.activeRunTimeoutId);
          this.activeRunTimeoutId = null;
          this.activeRunWatchdogRunId = null;
        }
        if (this._executionEventsDirty) {
          this._executionEventsDirty = false;
          void this.flushExecutionEvents();
        }
        if (this.activeRunId === runMeta.runId) {
          this.activeRunId = null;
          this.activeRunMeta = null;
          this.activeRunAbortController = null;
        }
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
    },
    toolCallId?: string,
  ) {
    this.touchActiveRun(options.runMeta.runId);
    const effectiveSettings = (options.settings || this.currentSettings || {}) as Record<string, any>;
    const lockedTabId = typeof options.lockedTabId === 'number' ? options.lockedTabId : null;
    const toolContext = this.buildToolExecutionContext(options.runMeta, lockedTabId);
    const callId = toolCallId || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const startedAt = Date.now();
    const normalizedArgsResult = this.normalizeToolCallArgs(toolName, args);
    const safeArgs = normalizedArgsResult.ok ? normalizedArgsResult.args : {};
    // NB: a marca de "fechamento iniciado pelo agente" (agentInitiatedTabCloses)
    // é adicionada só DEPOIS da checagem de permissão (mais abaixo). Marcar aqui,
    // antes da checagem, deixava uma entrada órfã quando o closeTab era bloqueado
    // — e aí um fechamento MANUAL posterior da aba pelo usuário era confundido com
    // ação do agente e NÃO abortava o run.
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

    sendStart();
    this.incrementInFlight(options.runMeta.runId);

    try {
      if (this.isRunAborted(options.runMeta.runId)) {
        const cancelled = {
          success: false,
          code: 'RUN_ABORTED',
          error: 'Run was stopped before the tool executed.',
        };
        sendResult(cancelled);
        return cancelled;
      }
      if (shouldInvalidateDomCache(toolName, safeArgs as Record<string, unknown>)) {
        const targetTab =
          typeof safeArgs?.tabId === 'number' ? safeArgs.tabId : lockedTabId || this.activeRunLockedTabId;
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
        this.sendRuntime(options.runMeta, { type: 'plan_update', plan: this.currentPlan });
        const result = { success: true, step: stepIndex, status, plan: this.currentPlan };
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
      const isTabManagementTool = TAB_MANAGEMENT_TOOLS.has(toolName);
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
            message: `Política de lock bloqueou "${toolName}" fora da allowlist da aba dedicada ${lockedTabId}.`,
          });
          sendResult(blocked);
          return blocked;
        }
        // Tab-management tools work across the whole session tab set, so they are not
        // pinned or blocked by a single-tab mismatch. Element/navigation tools stay
        // within the session: they may target the current working tab or any tab Glide
        // opened, but never a foreign user tab.
        if (!isTabManagementTool) {
          const workingTabId = this.browserTools.getCurrentSessionTabId() ?? lockedTabId;
          if (
            typeof args?.tabId === 'number' &&
            args.tabId !== workingTabId &&
            !this.browserTools.isSessionTab(args.tabId)
          ) {
            const blocked = {
              success: false,
              code: 'TAB_LOCK_POLICY',
              error: `Tab mismatch: tabId ${args.tabId} is not part of this session (working tab ${workingTabId}).`,
              policy: {
                type: 'tab_lock',
                lockedTabId,
                requestedTabId: args.tabId,
                tool: toolName,
                reason: 'Explicit tabId is not a session tab.',
              },
            };
            this.sendRuntime(options.runMeta, {
              type: 'run_warning',
              message: `Política de lock bloqueou "${toolName}" com tabId ${args.tabId} fora da sessão. A execução permanece na aba ${workingTabId}.`,
            });
            sendResult(blocked);
            return blocked;
          }
          const workingTabAlive = await this.isLockedTabAlive(workingTabId);
          if (!workingTabAlive) {
            const blocked = {
              success: false,
              code: 'TAB_LOCK_POLICY',
              error: `Session tab ${workingTabId} is unavailable.`,
              policy: {
                type: 'tab_lock',
                lockedTabId,
                tool: toolName,
                reason: 'Working tab unavailable.',
              },
            };
            this.sendRuntime(options.runMeta, {
              type: 'run_warning',
              message: `A aba de trabalho ${workingTabId} não está disponível; a ferramenta "${toolName}" foi bloqueada.`,
            });
            sendResult(blocked);
            return blocked;
          }
        }
      }

      const cdpNavigateUrl =
        toolName === 'cdp' && String(args?.action || '') === 'send' && isCdpNavigateMethod(args?.method)
          ? extractCdpNavigateUrl(args?.params)
          : null;
      if (cdpNavigateUrl) {
        const allowlist = this.parseAllowedDomains(effectiveSettings.allowedDomains || '');
        if (allowlist.length && !this.isUrlAllowed(cdpNavigateUrl, allowlist)) {
          const blocked = {
            success: false,
            error: 'Blocked by allowed domains list.',
            policy: {
              type: 'allowlist',
              domain: cdpNavigateUrl,
              reason: 'CDP Page.navigate target is outside allowed domains.',
            },
          };
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

      // Marca closeTab como "agente" só se o fechamento de fato for tentado
      // (permissão OK). Em falha após o mark, removemos a entrada (ver abaixo)
      // — senão um close falho deixava o id sticky e o usuário fechar a aba
      // travada não abortava o run.
      if (toolName === 'closeTab' && typeof safeArgs.tabId === 'number') {
        this.agentInitiatedTabCloses.add(safeArgs.tabId);
      }

      if (SCREENSHOT_TOOLS.has(toolName) && effectiveSettings.enableScreenshots === false) {
        const blocked = {
          success: false,
          error: 'Screenshots are disabled in settings.',
        };
        sendResult(blocked);
        return blocked;
      }

      let result: any;
      let toolArgs = args;
      if (lockedTabId && isBrowserTool && !isTabManagementTool && LOCKED_TAB_ALLOWED_BROWSER_TOOLS.has(toolName)) {
        const workingTabId = this.browserTools.getCurrentSessionTabId() ?? lockedTabId;
        const targetTabId =
          typeof args?.tabId === 'number' && this.browserTools.isSessionTab(args.tabId) ? args.tabId : workingTabId;
        toolArgs = {
          ...args,
          tabId: targetTabId,
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
      if (toolName === 'getContent' || toolName === 'findElement') {
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
                  scope: String(toolArgs.scope || 'auto'),
                  fuzzy: toolArgs.fuzzy !== false,
                  deep: toolArgs.deep === true,
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
        if (this.isRunAborted(options.runMeta.runId)) {
          if (toolName === 'closeTab' && typeof safeArgs.tabId === 'number') {
            this.agentInitiatedTabCloses.delete(safeArgs.tabId);
          }
          const cancelled = {
            success: false,
            code: 'RUN_ABORTED',
            error: 'Run was stopped before the tool executed.',
          };
          sendResult(cancelled, toolArgs);
          return cancelled;
        }
        result = await this.browserTools.executeTool(toolName, toolArgs, toolContext);
        if (
          this.quarantinedRunIds.has(options.runMeta.runId) ||
          this.orchestrationOwnerRunId !== options.runMeta.runId
        ) {
          const discarded = {
            success: false,
            code: 'RUN_SUPERSEDED',
            error: 'Tool result discarded because the run was stopped or superseded.',
          };
          sendResult(discarded, toolArgs);
          return discarded;
        }

        // closeTab falhou: remove a marca "agente" para o usuário poder fechar a
        // aba travada e o run abortar de verdade.
        if (toolName === 'closeTab' && typeof safeArgs.tabId === 'number' && !result?.success) {
          this.agentInitiatedTabCloses.delete(safeArgs.tabId);
        }

        if (result?.success) {
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
                  scope: String(toolArgs.scope || 'auto'),
                  fuzzy: toolArgs.fuzzy !== false,
                  deep: toolArgs.deep === true,
                },
                result,
              );
            }
          }
        }
      } catch (error) {
        if (toolName === 'closeTab' && typeof safeArgs.tabId === 'number') {
          this.agentInitiatedTabCloses.delete(safeArgs.tabId);
        }
        result = normalizeThrownToolError(error);
      }

      result = this.normalizeToolResultContract(toolName, result);

      const isBrowserAction = BROWSER_ACTION_TOOLS.includes(toolName as (typeof BROWSER_ACTION_TOOLS)[number]);
      const recoveryTabId =
        typeof toolArgs?.tabId === 'number'
          ? toolArgs.tabId
          : (this.browserTools.getCurrentSessionTabId() ?? lockedTabId ?? null);
      const recoveryTabUrl =
        String(result?.resolvedUrl || '') ||
        this.browserTools.getSessionTabSummaries().find((tab) => tab.id === recoveryTabId)?.url ||
        '';
      const failureAction = {
        toolName,
        args: toolArgs as Record<string, unknown>,
        tabId: recoveryTabId,
        url: recoveryTabUrl,
      };
      if (isFailureTrackedTool(toolName) && result?.success === false) {
        const repeated = this.failureRecoveryTracker.recordFailure(failureAction);
        if (repeated.repeated) {
          result = {
            ...result,
            success: false,
            code: 'REPEATED_FAILURE',
            originalCode: result.code,
            originalError: result.error,
            error: `Stopped after ${repeated.count} identical failed ${toolName} attempts on the same tab and page.`,
            failureSignature: repeated.signature,
            hint: 'Do not retry this target. Inspect fresh structure or use a different verified strategy.',
          };
        }
      } else if (result?.success && (isBrowserAction || toolName === 'getContent')) {
        this.failureRecoveryTracker.reset();
      }

      const recoveryBudget = this.getRecoveryBudget(effectiveSettings);

      // Layer 3: Auto findElement on click/type failure (budgeted per run).
      // Prefer candidates already returned by the failed tool (similar_elements) to
      // avoid a second full-DOM findElement scan when the click path already listed peers.
      const failureSelector = String(toolArgs?.selector || '');
      const findAttemptKey = buildFailureSignature(failureAction);
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
            const findResult = (await this.browserTools.executeTool(
              'findElement',
              {
                query: queryHint,
                type: 'any',
                maxResults: 5,
                fuzzy: recoveryBudget.maxFind > 1 && !promoted.length,
                ...(toolArgs?.tabId ? { tabId: toolArgs.tabId, _strictTabId: true } : {}),
              },
              toolContext,
            )) as Record<string, any>;
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
      if (isBrowserAction) {
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
      } else if (toolName === 'getContent') {
        this.awaitingVerification = false;
      }

      const finalResult: Record<string, any> = { ...(result as Record<string, any>) };
      let recoveryStage: RecoveryStage = 'none';

      // Layer 4: Auto-screenshot on browser action failure (budgeted; vision async by default).
      // Skip when Layer 3 already supplied actionable selectors — screenshot/vision only adds
      // latency and noise when the model can retry with candidates immediately.
      const hasRecoveryCandidates =
        (Array.isArray(finalResult.findElementCandidates) && finalResult.findElementCandidates.length > 0) ||
        (Array.isArray(finalResult.similar_elements) &&
          finalResult.similar_elements.some(
            (entry: unknown) =>
              entry &&
              typeof entry === 'object' &&
              Boolean(String((entry as { selector?: string }).selector || '').trim()),
          ));

      const mayScreenshot =
        isBrowserAction &&
        finalResult?.success === false &&
        effectiveSettings.screenshotOnFailure !== false &&
        recoveryBudget.maxScreenshot > 0 &&
        this.recoveryScreenshotCount < recoveryBudget.maxScreenshot &&
        !hasRecoveryCandidates;

      const visualDeliveryMode = options.visionProfile
        ? resolveVisualDeliveryMode(options.visionProfile)
        : 'unavailable';

      if (mayScreenshot) {
        try {
          this.recoveryScreenshotCount += 1;
          const recoveryScreenshotArgs: Record<string, any> = {
            format: 'jpeg',
            quality: 50,
          };
          if (toolArgs?.tabId) {
            recoveryScreenshotArgs.tabId = toolArgs.tabId;
            recoveryScreenshotArgs._strictTabId = true;
          }
          const screenshotResult = (await this.browserTools.executeTool(
            'screenshot',
            recoveryScreenshotArgs,
            toolContext,
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
              options.visionProfile &&
              visualDeliveryMode !== 'unavailable' &&
              isVisionBridgeEnabled(effectiveSettings) &&
              typeof screenshotResult.dataUrl === 'string'
            ) {
              if (visualDeliveryMode === 'direct') {
                this.stashModelScreenshotImage(callId, screenshotResult.dataUrl);
                finalResult.visualContext = 'The recovery screenshot is attached directly to this tool result.';
                recoveryStage = 'vision';
              } else {
                const vision = await this.describeImageForRun(options.runMeta, {
                  dataUrl: screenshotResult.dataUrl as string,
                  prompt: `A browser action "${toolName}" failed with error: "${finalResult.error}". Describe what is visible on screen so the agent can find an alternative approach. List any buttons, tabs, links, or interactive elements you can see.`,
                  visionProfile: options.visionProfile,
                  tool: toolName,
                  callId,
                  source: 'recovery',
                  // Respeita a config do usuário (visionBridgeSync). Forçar true
                  // aqui tornava a fila assíncrona código morto e bloqueava o tool
                  // result por até 30s em cada screenshot de recovery.
                  settings: effectiveSettings,
                });
                if (vision.description) {
                  finalResult.visualContext = vision.description;
                  finalResult.hint = `${finalResult.hint ? `${finalResult.hint} ` : ''}Use visualContext to choose a different verified selector or action.`;
                  recoveryStage = 'vision';
                }
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
          finalResult.hint = `${finalResult.hint ? `${finalResult.hint} ` : ''}Visual analysis failed; call getContent({ mode: "structure" }) for fresh DOM context.`;
        }
      }

      if (
        SCREENSHOT_TOOLS.has(toolName) &&
        finalResult?.success &&
        finalResult.dataUrl &&
        isVisionBridgeEnabled(effectiveSettings) &&
        options.visionProfile &&
        visualDeliveryMode === 'describe'
      ) {
        try {
          const visionPrompt =
            toolName === 'annotatedScreenshot'
              ? 'Describe this set-of-marks screenshot. List numbered overlays and interactive elements visible for grounding.'
              : toolName === 'elementScreenshot'
                ? 'Describe this cropped element screenshot for a non-vision model.'
                : 'Provide a concise description of this screenshot for a non-vision model.';
          const vision = await this.describeImageForRun(options.runMeta, {
            dataUrl: finalResult.dataUrl,
            prompt: visionPrompt,
            visionProfile: options.visionProfile,
            tool: toolName,
            callId,
            source: 'screenshot',
            // Respeita a config do usuário (visionBridgeSync); ver nota no path de recovery.
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
          finalResult.message = 'Screenshot captured, but visual analysis failed. Inspect fresh page structure next.';
          finalResult.hint = 'Call getContent({ mode: "structure" }) before the next browser action.';
        }
      }

      if (
        SCREENSHOT_TOOLS.has(toolName) &&
        finalResult?.success &&
        typeof finalResult.dataUrl === 'string' &&
        visualDeliveryMode === 'direct'
      ) {
        this.stashModelScreenshotImage(callId, finalResult.dataUrl);
        finalResult.message = 'Screenshot captured and attached directly to the model.';
        recoveryStage = 'vision';
      }

      if (
        (SCREENSHOT_TOOLS.has(toolName) || finalResult.recoveryScreenshotDataUrl) &&
        !this.shouldIncludeScreenshotData(effectiveSettings)
      ) {
        if (typeof finalResult.dataUrl === 'string') {
          const stored = await this.persistScreenshotHandle(finalResult);
          finalResult.screenshotId = stored.screenshotId;
          finalResult.dataUrlLength = stored.dataUrlLength;
          delete finalResult.dataUrl;
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
      this.captureEvidenceFromToolResult(toolName, finalResult, toolArgs);

      const sanitizedResult = this.sanitizeToolResultForRuntime(finalResult, toolName, effectiveSettings);
      const enrichedResult = this.attachPlanToResult(sanitizedResult, toolName);
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
      this.decrementInFlight(options.runMeta.runId);
      this.touchActiveRun(options.runMeta.runId);
    }
  }

  async hydrateExecutionEvents() {
    if (this.executionEventsHydrated) return;
    // init() e get_execution_events podem chegar antes de qualquer um concluir;
    // memoizar a promise evita leituras duplicadas de storage no boot.
    this.executionEventsHydration ??= this.hydrateExecutionEventsOnce().finally(() => {
      this.executionEventsHydration = null;
    });
    return this.executionEventsHydration;
  }

  private async hydrateExecutionEventsOnce() {
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

    if (!SCREENSHOT_TOOLS.has(toolName)) {
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
    sessionIdAtStart,
    sourceRevision,
    abortSignal,
  }: {
    runMeta: RunMeta;
    history: Message[];
    contextLimit: number;
    model: ReturnType<typeof getCachedLanguageModel>;
    runtimeProfile: Record<string, any>;
    runtimeSettings: Record<string, any>;
    sessionIdAtStart?: string;
    sourceRevision: number;
    abortSignal?: AbortSignal;
  }): Promise<Message[] | null> {
    const sourceSessionId = sessionIdAtStart || runMeta.sessionId;
    if (this.sessionTombstones.isTombstoned(sourceSessionId) || abortSignal?.aborted) return null;
    const generationAtStart = this.sessionGenerations.get(sourceSessionId);

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
      if (abortSignal?.aborted) return null;
      const compactionRun = await withAbortTimeout(compactionTimeoutMs, (timeoutSignal) =>
        generateText({
          model,
          ...resolveProviderOptions(runtimeProfile.provider),
          system: this.sanitizeSystemPrompt(SUMMARIZATION_SYSTEM_PROMPT, runtimeProfile.provider),
          messages: [{ role: 'user', content: promptText }],
          // Cap de SAÍDA — reserveTokens é orçamento de input/contexto, não de sumário.
          maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
          abortSignal: combineAbortSignals(
            abortSignal ? [abortSignal, timeoutSignal] : [timeoutSignal],
          ),
        }),
      );

      if (compactionRun.timedOut || (compactionRun.error && isAbortError(compactionRun.error))) {
        this.sendRuntime(runMeta, {
          type: 'run_warning',
          message: `A compactação do contexto excedeu ${compactionTimeoutMs}ms (tentativa ${attempt + 1}/${MAX_COMPACTION_RETRIES}).`,
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
      const truncated = buildTruncateOnlySummary(messagesToSummarize);
      summaryText = previousSummary ? `${previousSummary}\n\n${truncated}` : truncated;
      this.sendRuntime(runMeta, {
        type: 'run_warning',
        message: 'A compactação do contexto usou o resumo simplificado (sem sumarização pelo modelo).',
      });
    }

    if (
      !canApplyCompactionResult({
        abortSignal,
        runOwned: this.isOrchestrationOwner(runMeta.runId) && !this.isRunAborted(runMeta.runId),
        tombstoned: this.sessionTombstones.isTombstoned(sourceSessionId),
        generationMatches: this.sessionGenerations.matches(sourceSessionId, generationAtStart),
        sourceRevision,
        currentRevision: contextTransactionStore.read(sourceSessionId).revision,
      })
    ) {
      return null;
    }

    const summaryMessage = buildCompactionSummaryMessage(summaryText, messagesToSummarize.length);
    const compaction = applyCompaction({
      summaryMessage,
      preserved,
      trimmedCount: messagesToSummarize.length,
    });
    resetCompactionHysteresis(sourceSessionId);
    return normalizeConversationHistory(compaction.compacted);
  }

  compactToolOutputForHistory(output: unknown, toolName: string) {
    if (output === null || output === undefined) return output;
    if (typeof output === 'string') {
      const trimmed = this.trimExecutionText(output, 1800);
      return toolName === 'getContent' || toolName === 'findInPage' || toolName === 'readPage'
        ? wrapUntrustedToolPayload(trimmed)
        : trimmed;
    }
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
    if (SCREENSHOT_TOOLS.has(toolName) && (result.visionDescription || result.visualContext)) return 'high';
    if (result.visualContext || result.visionDescription) return 'medium';
    return 'medium';
  }

  buildNextHint(toolName: string, result: Record<string, any>, failureClass: FailureClass) {
    if (!result || result.success !== false) {
      if (toolName === 'getContent') return 'Use this evidence to update the plan step before continuing.';
      if (SCREENSHOT_TOOLS.has(toolName))
        return 'Use visionDescription, marksSummary, or visualContext to pick the next interaction.';
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

    if (SCREENSHOT_TOOLS.has(toolName)) {
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
        SCREENSHOT_TOOLS.has(toolName) &&
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
      `Consegui executar as ferramentas e coletar dados da página.${errorText} Verifique os detalhes técnicos para confirmar os itens extraídos.`,
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
        title: 'Sidebar e Navegação',
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
          ? 'Permission blocked: scripting (opt-in). Enable executeScript in Settings and Allow User Scripts.'
          : category === 'debugger'
            ? 'Permission blocked: debugger (opt-in). Enable “CDP / debugger” in Settings or set toolPermissions.debugger=true, then reload the run.'
            : category === 'sensitiveDataRead'
              ? 'Permission blocked: sensitiveDataRead (opt-in). Enable storage/network/console inspection in Settings.'
              : category === 'clipboard' || category === 'fileUpload' || category === 'downloads'
                ? `Permission blocked: ${category} (opt-in). Enable it in Settings.`
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

    const allowlist = this.parseAllowedDomains(settings.allowedDomains || '');
    if (!allowlist.length) {
      // tabs without allowlist: session membership is the real isolation gate
      return { allowed: true };
    }

    // Mesmo na categoria tabs, openTab/navigate/httpRequest com URL explícita
    // devem respeitar allowedDomains — antes o early-return de "tabs" ignorava a lista.
    if (category === 'tabs') {
      const explicitUrl = typeof args?.url === 'string' ? args.url.trim() : '';
      if (explicitUrl && !this.isUrlAllowed(explicitUrl, allowlist)) {
        return {
          allowed: false,
          reason: 'Blocked by allowed domains list.',
          policy: {
            type: 'allowlist',
            domain: explicitUrl,
            reason: 'Blocked by allowed domains list.',
          },
        };
      }
      return { allowed: true };
    }

    if (toolName === 'navigateHistory') {
      const targetUrl = await this.resolveToolUrl(args);
      if (!this.isUrlAllowed(targetUrl, allowlist)) {
        return {
          allowed: false,
          reason: 'Blocked by allowed domains list.',
          policy: {
            type: 'allowlist',
            domain: targetUrl,
            reason: 'navigateHistory blocked: current tab URL is outside allowed domains.',
          },
        };
      }
      return { allowed: true };
    }

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
    const withSeq = {
      ...payload,
      seq: payload.seq ?? this.runEventSequencer.next(payload.runId),
    };
    if (isRuntimeMessage(withSeq)) {
      this.sendToSidePanel(withSeq);
      return;
    }
    console.warn('Dropped invalid stream delta payload:', withSeq);
  }

  private sendToolEventsBatchImmediate(payload: ToolEventsBatchPayload) {
    if (!payload || payload.type !== 'tool_events_batch' || !Array.isArray(payload.events)) {
      console.warn('Dropped invalid tool events batch payload:', payload);
      return;
    }
    const validEvents = salvageToolEventsBatchEvents(payload.events);
    if (validEvents.length === 0) {
      console.warn('Dropped tool events batch: all events invalid');
      return;
    }
    if (validEvents.length < payload.events.length) {
      console.warn(
        `Salvaged tool events batch: dropped ${payload.events.length - validEvents.length} invalid event(s)`,
      );
    }
    const salvaged = {
      ...payload,
      events: validEvents,
      seq: payload.seq ?? this.runEventSequencer.next(payload.runId),
    };
    if (isRuntimeMessage(salvaged)) {
      this.sendToSidePanel(salvaged);
      return;
    }
    console.warn('Dropped invalid tool events batch payload after salvage:', salvaged);
  }

  sendRuntime(runMeta: RunMeta, payload: Record<string, unknown>) {
    this.touchActiveRun(runMeta.runId);
    if (isStreamDeltaPayload(payload)) {
      const channel = payload.channel === 'reasoning' ? 'reasoning' : 'text';
      this.runtimeBatcher.enqueue(runMeta, payload.content, channel);
      return;
    }
    if (isToolEventPayload(payload)) {
      this.runtimeBatcher.enqueueToolEvent(runMeta, payload);
      return;
    }
    this.runtimeBatcher.flush(runMeta.runId);
    const seq = this.runEventSequencer.next(runMeta.runId);
    const candidateMessage = {
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      runId: runMeta.runId,
      turnId: runMeta.turnId,
      sessionId: runMeta.sessionId,
      timestamp: Date.now(),
      seq,
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
      seq: this.runEventSequencer.next(runMeta.runId),
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
    if (selectRuntimePushChannel(hasConnectedPanelPorts()) === 'port') {
      if (postToPanelPorts(message)) return;
    }
    chrome.runtime.sendMessage(message).catch(() => {
      // no-op: side panel simply not open
    });
  }

  // Returns the system prompt split into a STATIC `base` and a volatile `state`
  // (URL/plan/recovery). The caller recombines them into a single system prompt;
  // the split is kept as a seam so prompt caching can be reintroduced later without
  // reshaping this builder.
  enhanceSystemPrompt(basePrompt: string, context, runId?: string): { base: string; state: string } {
    const browserAutomation = context.browserAutomation !== false;
    const requiresDetailedReport = context.requiresDetailedReport === true;
    const orchestrationPass = Number(context.orchestrationPass || 1);
    const ownsOrchestration = !runId || this.isOrchestrationOwner(runId);

    const effectiveBasePrompt = isDefaultAutomationPrompt(basePrompt) ? STREAMLINED_AUTOMATION_PROMPT : basePrompt;
    const baseWithPolicy = `${effectiveBasePrompt}\n\n${UNTRUSTED_DATA_POLICY}`;

    if (!browserAutomation) {
      return {
        base: `${baseWithPolicy}

<turn_mode>
Direct chat only. Answer briefly. No plans, no browser tools, no audit/report sections unless explicitly requested.
</turn_mode>`,
        state: '',
      };
    }

    const tabsSection =
      Array.isArray(context.availableTabs) && context.availableTabs.length
        ? `Tabs selected (${context.availableTabs.length}). Use focusTab or switchTab before acting:\n${context.availableTabs
            .map((tab) => `  - [${tab.id}] ${tab.title || 'Untitled'} - ${tab.url}`)
            .join('\n')}`
        : 'No additional tabs selected; actions target the current tab.';

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

    const recoverySection = ownsOrchestration ? this.buildFailureRecoverySection(runId) : '';
    const visualRecoverySection =
      orchestrationPass === 1 && (recoverySection || requiresDetailedReport)
        ? `
<visual_recovery_policy>
- After a failed action: readPage → findElement → getContent({ mode: "structure" }), then retry with a new selector.
- Use screenshot() only when page state is still ambiguous after those.
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
    const debuggerOn =
      (this.currentSettings?.toolPermissions as Record<string, unknown> | undefined)?.debugger === true;
    const toolSurface =
      orchestrationPass === 1
        ? `
<tool_surface>
Schema tools are live. Prefer: readPage/findElement → click/type; getNetworkRequests → httpRequest for APIs; executeScript only when listed (requires Allow User Scripts); clipboard/setInputFiles/mouse drag when permitted.${debuggerOn ? ' cdp is enabled (opt-in debugger).' : ' cdp not in schema unless user enables debugger in Settings.'}
</tool_surface>`
        : '';
    const state = `${compactStateSection}
${toolSurface}

<browser_context>
URL: ${context.currentUrl}
Title: ${context.currentTitle}
Tab: ${context.tabId}
${orchestrationPass === 1 ? tabsSection : ''}
</browser_context>
${recoverySection}${visualRecoverySection}${checkpointSection}`.trim();
    return { base: baseWithPolicy, state };
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
      runId: runMeta.runId,
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
        if (/cancelled \(run ended\)/i.test(message)) return;
        console.warn(`[Glide] Async vision failed (${options.source}):`, message);
      },
    });

    return { description: null, pending: true };
  }

  buildFailureRecoverySection(runId?: string): string {
    if (!runId || !this.isOrchestrationOwner(runId)) return '';
    if (!this.consecutiveFailures || this.consecutiveFailures === 0) return '';
    const failedList = (this.failedTools || [])
      .slice(-3)
      .map((f) => `  - ${f.tool}(${f.selector || ''}): ${f.error}`)
      .join('\n');
    const pendingVision = this.pendingVisionByRun.get(runId) || [];
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
1. Call readPage() for an interactive inventory (use returned selectors with click/type — not ref labels alone).
2. Call findElement({ query: "button text" }) to get a reliable CSS selector before retrying click/type.
3. For Instagram profile lists, findElement({ query: "seguindo" }) or click({ selector: "a[href*='/following']" }) / "seguidores" / a[href*="/followers"] — never reuse generic .x* classes.
4. Call getContent({ mode: "structure" }) to inspect available elements with their selectors.
5. If the page is dynamic (React/SPA), call wait({ condition: "time", ms: 1500 }) before retrying.
6. Try scrolling to reveal hidden elements.
7. Capture screenshot() to gather visual context before the next retry.

NEVER repeat the exact same selector that just failed. Use readPage, findElement, or structure mode to discover a new one.

You are PROHIBITED from generating a final response until you either:
- Successfully complete the action with an alternative approach, OR
- Have attempted at least 3 different selectors/strategies with evidence
</failure_recovery>`;
  }

  resolveProfile(settings: Record<string, any>) {
    const normalizedProvider = migrateStoredProvider(settings.provider, settings.customEndpoint);
    // Runtime enxuto fixo: quality mode foi aposentado como knob do usuário.
    const qualityMode: QualityMode = 'speed';
    return {
      provider: normalizedProvider,
      apiKey: settings.apiKey || '',
      model: settings.model || '',
      customEndpoint: String(settings.customEndpoint || '').trim(),
      systemPrompt: settings.systemPrompt || '',
      sendScreenshotsAsImages: settings.sendScreenshotsAsImages !== false,
      screenshotQuality: settings.screenshotQuality || 'high',
      streamResponses: settings.streamResponses !== false,
      maxTokens: clampInt(settings.maxTokens, DEFAULT_MODEL_MAX_TOKENS, MIN_MODEL_MAX_TOKENS, MAX_MODEL_MAX_TOKENS),
      timeout: resolveTimeoutMs(settings.timeout),
      contextLimit: clampInt(settings.contextLimit, DEFAULT_CONTEXT_LIMIT, MIN_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT),
      enableScreenshots: settings.enableScreenshots !== false,
      autoRecoveryMode: settings.autoRecoveryMode,
      screenshotOnFailure: settings.screenshotOnFailure !== false,
      screenshotRetention: settings.screenshotRetention,
      qualityMode,
    };
  }

  getToolsForSession(
    settings: Record<string, any>,
    lockedTabId: number | null = null,
    options: { includePlanTools?: boolean } = {},
  ) {
    const permissions = (settings?.toolPermissions || {}) as Record<string, unknown>;
    const permissionKey = toolPermissionsCacheKey(permissions);
    const cacheKey = [
      lockedTabId ?? 'none',
      settings?.enableScreenshots === false ? '0' : '1',
      options.includePlanTools === false ? '0' : '1',
      permissionKey,
    ].join(':');
    const cached = this._sessionToolsCache.get(cacheKey);
    if (cached) return cached;

    const built = buildSessionTools({
      browserToolDefinitions: this.browserTools.getToolDefinitions(),
      lockedTabId,
      lockedTabAllowlist: LOCKED_TAB_ALLOWED_BROWSER_TOOLS,
      enableScreenshots: settings?.enableScreenshots !== false,
      includePlanTools: options.includePlanTools !== false,
      toolPermissions: permissions,
    });
    this._sessionToolsCache.set(cacheKey, built);
    return built;
  }
}

new BackgroundService();
