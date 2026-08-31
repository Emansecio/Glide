import type { CodexChatGptAuthBundle } from '../../ai/codex-auth.js';
import type { Message } from '../../ai/message-schema.js';
import type { RunPlan } from '../../types/plan.js';
import type { MarkdownIdleHandle } from './markdown-render-defer.js';
import type { ModalController } from './modal-controller.js';
import { getSidePanelElements } from './panel-elements.js';
import { setSidebarOpen, showRightPanel, updateNavActive } from './panel-navigation-helpers.js';
import type { UsageStats } from './panel-types.js';
import { SerialTaskQueue } from './serial-task-queue.js';

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge — the SidePanelUI interface below declares methods attached to the prototype by the split panel-* modules.
export class SidePanelUI {
  elements: Record<string, any>;
  displayHistory: Message[];
  contextHistory: Message[];
  contextRevision: number;
  sessionId: string;
  activeRunId: string | null;
  completedRunIds: Set<string>;
  acceptedSessionIds: Set<string>;
  /** Sessions whose model context the service worker is believed to hold (warm send path). */
  swContextSyncedSessions: Set<string>;
  pendingSessionId: string | null;
  sessionStartedAt: number;
  firstUserMessage: string;
  currentConfig: string;
  configs: Record<string, any>;
  /** Credencial por provedor (`anthropic`, `codex`, …) — ver settings-keys.ts. */
  providerKeys: Record<string, string>;
  toolCallViews: Map<string, any>;
  /** Ids das tool views ainda com a classe `running` — o tick de duração itera
   *  este set em vez de varrer o toolCallViews inteiro a cada evento/segundo. */
  runningToolViewIds: Set<string>;
  lastChatTurn: HTMLElement | null;
  /** Pending composer attachments (text files + images/prints) for the next send. */
  pendingAttachments: Array<{
    id: string;
    kind: 'text' | 'image';
    name: string;
    mime: string;
    sizeLabel: string;
    text?: string;
    dataUrl?: string;
    previewUrl?: string;
  }>;
  scrollPositions: Map<string, number>;
  pendingToolCount: number;
  /** True until first stream/tool or terminal run event after send. */
  awaitingRunAcceptance: boolean;
  /** User turn pushed before SW acceptance — rolled back on concurrent/preflight reject. */
  pendingUserTurn: {
    displayId?: string;
    contextId?: string;
    turnEl?: HTMLElement | null;
    restoreText?: string;
    restoreAttachments?: Array<{
      id: string;
      kind: 'text' | 'image';
      name: string;
      mime: string;
      sizeLabel: string;
      text?: string;
      dataUrl?: string;
      previewUrl?: string;
    }>;
  } | null;
  isStreaming: boolean;
  thinkingStartedAt: number | null;
  thinkingTimerId: number | null;
  /** Intervalo compartilhado de duração ao vivo das ferramentas em execução. */
  _toolDurationTimerId: number | null;
  /** Status line reflete retry do provedor até stream/ferramenta retomar. */
  _retryStatusActive: boolean;
  /** Aviso de compactação inline (sem auto-dismiss) durante run ativo. */
  _compactionNoticeActive: boolean;
  streamTextRenderTimerId: number | null;
  streamReasoningRenderTimerId: number | null;
  /** Idle/setTimeout handle for deferred stream_stop markdown parse. */
  pendingMarkdownIdleHandle: MarkdownIdleHandle | null;
  /** Target bubble + token while markdown parse is deferred off the critical frame. */
  pendingMarkdownRender: {
    el: HTMLElement;
    token: number;
    buffer: string;
    sourceDigest: string;
    onRendered?: () => void;
  } | null;
  /** Monotonic token — bumped on schedule/cancel so stale idle callbacks no-op. */
  markdownRenderToken: number;
  streamingState: {
    container: HTMLElement;
    eventsEl: HTMLElement | null;
    lastEventType?: 'text' | 'reasoning' | 'tool' | 'plan';
    textEventEl?: HTMLElement | null;
    reasoningEventEl?: HTMLElement | null;
    textBuffer?: string;
    textPendingBuffer?: string;
    reasoningBuffer?: string;
    reasoningRawBuffer?: string;
    planEl?: HTMLElement | null;
    planListEl?: HTMLOListElement | null;
    planMetaEl?: HTMLElement | null;
    accumulated?: boolean;
    executionTurnKey?: string | null;
    executionDetailsEl?: HTMLElement | null;
    executionSummaryTitleEl?: HTMLElement | null;
    executionSummaryMetaEl?: HTMLElement | null;
    executionHumanSummaryEl?: HTMLElement | null;
    _lastMdPos?: number;
    // Nós de texto dedicados para flush incremental (appendData) durante o
    // streaming — reatribuir textContent com o buffer inteiro é O(n²).
    textNode?: Text | null;
    reasoningTextNode?: Text | null;
    thinkingPanelTextNode?: Text | null;
    reasoningFlushedLength?: number;
    // Marcado no stop: deltas atrasados não podem reviver a bolha finalizada.
    completed?: boolean;
  } | null;
  userScrolledUp: boolean;
  isNearBottom: boolean;
  chatResizeObserver: ResizeObserver | null;
  contextUsage: {
    approxTokens: number;
    maxContextTokens: number;
    percent: number;
  };
  contextCharCount: number;
  contextTrackedMessageCount: number;
  contextUsageDebounceTimerId: number | null;
  lastUsage: UsageStats | null;
  sessionTokenTotals: UsageStats;
  /** Label compacto da aba-alvo durante runs de automação (ex.: "Aba: host/path"). */
  _runTargetTabLabel: string | null;
  /** Preferência: notificar quando a resposta concluir com o painel oculto. */
  notifyOnComplete: boolean;
  _notificationClickBound?: boolean;
  historyPersistDebounceTimerId: number | null;
  privateSession: boolean;
  historyPersistence: 'full' | 'redacted' | 'off';
  historyWriteQueue: SerialTaskQueue;
  historyListDirty: boolean;
  currentView: 'chat' | 'history';
  settingsOpen: boolean;
  modelsFetchController: AbortController | null;
  modelsFetchSeq: number;
  modelsFetchRequestKey: string;
  /** True while loadSettings is hydrating the form — blocks early persist/save. */
  settingsHydrated: boolean;
  /** User picked a model explicitly (composer/settings) — blocks auto-detect overwrite. */
  userModelSelectionLocked: boolean;
  /** Monotonic token for renderConversationHistory rAF guards. */
  renderSessionGeneration: number;
  /** Pending rAF id for deferred history render — cancelled on session switch. */
  renderConversationRafId: number;
  /** Bumped on delete/clear to invalidate debounced persist/resurrect. */
  historyDeletionBarrier: number;
  /** Bumped whenever history list reload starts — stale async renders are dropped. */
  historyListLoadToken: number;
  /** True while waiting for stop_run acknowledgement during session switch. */
  stoppingRun: boolean;
  /** Resolves when run_stopped arrives during an intentional stop handshake. */
  _runStopAckWaiter: (() => void) | null;
  /** Provider that initiated a pending OAuth flow — result ignored if changed. */
  pendingOAuthProvider: string | null;
  /** Cached ChatGPT Codex OAuth bundle for settings display (not mirrored into apiKey_codex). */
  codexChatGptSession: CodexChatGptAuthBundle | null;
  /** Document visibility listener for port reconnect — removed in destroy. */
  _visibilityChangeBound?: boolean;
  _visibilityChangeHandler?: (() => void) | null;
  activityPanelOpen: boolean;
  /** Buffered activity-log entries while the panel is closed (lazy render on open). */
  toolLogBuffer: import('./tool-log-buffer.js').ToolLogBufferEntry[];
  /** Watchdog do painel: detecta run morto (service worker despejado) e destrava a UI. */
  runLivenessTimerId: number | null;
  runLivenessLastSignalAt: number;
  runLivenessProbeSent: boolean;
  latestThinking: string | null;
  activeToolName: string | null;
  streamingReasoning: string;
  currentPlan: RunPlan | null;
  executionTurnSummaries: Map<string, unknown>;
  activeExecutionTurnKey: string | null;
  // Document-level event handlers for cleanup
  _documentClickHandler: ((event: Event) => void) | null;
  _documentKeydownHandler: ((event: KeyboardEvent) => void) | null;
  oauthHelpModalController: ModalController | null;
  // Dynamic caches/handlers attached lazily by the split panel-* modules.
  _debug?: boolean;
  _cachedChatSessionsIndex?: import('./history-storage.js').ChatSessionIndexEntry[];
  _historyStorageMigrated?: boolean;
  _historyLoadToken: number;
  _historyIndexWriteInFlight?: boolean;
  _historyStorageChangeListener?: (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: chrome.storage.AreaName,
  ) => void;
  _pagehideBound?: boolean;
  _detectedModels?: any;
  _pendingStreamMessages: any[];
  _streamDrainScheduled?: boolean;
  /** rAF de auto-scroll em voo — garante um scroll por frame (panel-scroll). */
  _scrollRafId?: number;
  /** rAF de sincronia do scroll do usuário — uma leitura de layout por frame. */
  _scrollSyncRafId?: number;
  /** Tool-log auto-scroll rAF; at most one callback per frame. */
  _toolLogScrollRafId?: number;
  /** Densidade do composer memorizada; null = precisa remedir (panel-tools). */
  _composerDensity?: 'tight' | 'compact' | 'normal' | null;
  _planChecklistClickBound?: boolean;
  _runtimeMessageHandler?: ((...args: any[]) => any) | null;
  /** Disconnects the SW→panel push port (panel-port.ts). */
  _panelPortDisconnect?: (() => void) | null;
  /** Lazily reconnects the push port when idle (panel-port.ts). */
  _panelPortEnsureConnected?: (() => void) | null;
  lastPersistedHistorySignature?: string;

  // Methods attached via prototype in panel-modules

  switchView(view: 'chat' | 'history') {
    this.currentView = view;
    if (!this.elements.chatInterface || !this.elements.historyPanel) return;
    if (view === 'history') {
      this.recordScrollPosition();
      this.elements.chatInterface.classList.add('hidden');
      this.elements.historyPanel.classList.remove('hidden');
    } else {
      this.elements.chatInterface.classList.remove('hidden');
      this.elements.historyPanel.classList.add('hidden');
      this.restoreScrollPosition();
    }
  }

  openChatView() {
    this.settingsOpen = false;
    showRightPanel(this.elements, null);
    this.switchView('chat');
    updateNavActive(this.elements, 'chat');
    setSidebarOpen(this.elements, false);
  }

  openHistoryPanel() {
    this.settingsOpen = false;
    setSidebarOpen(this.elements, true);
    showRightPanel(this.elements, 'history');
    updateNavActive(this.elements, 'history');
    if (this.historyListDirty) {
      void this.loadHistoryList();
    }
  }

  openSettingsPanel() {
    this.settingsOpen = true;
    setSidebarOpen(this.elements, true);
    showRightPanel(this.elements, 'settings');
    updateNavActive(this.elements, 'settings');
  }

  async startNewSession(options: { privateSession?: boolean } = {}) {
    await this.flushPendingHistoryPersist?.();
    await this.waitForRunStopAck?.();
    this.bumpRenderSessionGeneration?.();
    this.clearRunTransientNotices?.();
    this.abortActiveStreaming?.();
    this.displayHistory = [];
    this.contextHistory = [];
    this.contextRevision = 0;
    this.sessionId = `session-${Date.now()}`;
    this.activeRunId = null;
    this.completedRunIds = new Set();
    this.acceptedSessionIds = new Set([this.sessionId]);
    this.noteAcceptedSessionId?.(this.sessionId);
    this.swContextSyncedSessions = new Set();
    this.pendingSessionId = null;
    this.sessionStartedAt = Date.now();
    this.firstUserMessage = '';
    this.privateSession = options.privateSession === true;
    void chrome.runtime.sendMessage({ type: 'session_active', sessionId: this.sessionId });
    this.lastUsage = null;
    this.sessionTokenTotals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    this._runTargetTabLabel = null;
    this.clearRunTargetTab?.();
    this.currentPlan = null;
    this.executionTurnSummaries = new Map();
    this.activeExecutionTurnKey = null;
    this.invalidateContextUsageCache?.();
    this.hidePlanDrawer();
    this.stopThinkingTimer?.();
    this.stopRunLiveness?.();
    this.setComposerBusy?.(false);
    this.elements.chatMessages.innerHTML = '';
    this.toolCallViews.clear();
    this.runningToolViewIds.clear();
    this.updateChatEmptyState?.();
    this.resetActivityPanel();
    this.updateSessionUsageDisplay?.();
    this.updateStatus(
      this.privateSession
        ? 'Sessão privada — o histórico desta conversa não será salvo'
        : 'Pronto para uma nova conversa',
      this.privateSession ? 'warning' : 'success',
    );
    this.switchView('chat');
    this.scheduleContextUsageRecompute?.({ force: true });
    this.scrollToBottom({ force: true });
    setSidebarOpen(this.elements, false);
  }

  constructor() {
    this.elements = getSidePanelElements();

    this.displayHistory = [];
    this.contextHistory = [];
    this.contextRevision = 0;
    this.sessionId = `session-${Date.now()}`;
    this.activeRunId = null;
    this.completedRunIds = new Set();
    this.acceptedSessionIds = new Set([this.sessionId]);
    this.swContextSyncedSessions = new Set();
    this.pendingSessionId = null;
    this.sessionStartedAt = Date.now();
    this.firstUserMessage = '';
    this.currentConfig = 'default';
    this.configs = { default: {} };
    this.providerKeys = {};
    this.toolCallViews = new Map();
    this.runningToolViewIds = new Set();
    this.lastChatTurn = null;
    this.awaitingRunAcceptance = false;
    this.pendingUserTurn = null;
    this.pendingAttachments = [];
    this.scrollPositions = new Map();
    this.pendingToolCount = 0;
    this.isStreaming = false;
    this.thinkingStartedAt = null;
    this.thinkingTimerId = null;
    this._toolDurationTimerId = null;
    this._retryStatusActive = false;
    this._compactionNoticeActive = false;
    this.streamTextRenderTimerId = null;
    this.streamReasoningRenderTimerId = null;
    this.pendingMarkdownIdleHandle = null;
    this.pendingMarkdownRender = null;
    this.markdownRenderToken = 0;
    this.streamingState = null;
    this.userScrolledUp = false;
    this.isNearBottom = true;
    this.chatResizeObserver = null;
    this.contextUsage = {
      approxTokens: 0,
      maxContextTokens: 196000,
      percent: 0,
    };
    this.contextCharCount = 0;
    this.contextTrackedMessageCount = 0;
    this.contextUsageDebounceTimerId = null;
    this.lastUsage = null;
    this.sessionTokenTotals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    this._runTargetTabLabel = null;
    this.notifyOnComplete = false;
    this.historyPersistDebounceTimerId = null;
    this.historyWriteQueue = new SerialTaskQueue();
    this.historyListDirty = false;
    this.currentView = 'chat';
    this.settingsOpen = false;
    this.modelsFetchController = null;
    this.modelsFetchSeq = 0;
    this.modelsFetchRequestKey = '';
    this.settingsHydrated = false;
    this.userModelSelectionLocked = false;
    this.renderSessionGeneration = 0;
    this.renderConversationRafId = 0;
    this.historyDeletionBarrier = 0;
    this.historyListLoadToken = 0;
    this.stoppingRun = false;
    this.privateSession = false;
    this.historyPersistence = 'redacted';
    this._runStopAckWaiter = null;
    this.pendingOAuthProvider = null;
    this.codexChatGptSession = null;
    this.activityPanelOpen = false;
    this.toolLogBuffer = [];
    this.runLivenessTimerId = null;
    this.runLivenessLastSignalAt = 0;
    this.runLivenessProbeSent = false;
    this.latestThinking = null;
    this.activeToolName = null;
    this.streamingReasoning = '';
    this.currentPlan = null;
    this.executionTurnSummaries = new Map();
    this.activeExecutionTurnKey = null;
    this._documentClickHandler = null;
    this._documentKeydownHandler = null;
    this.oauthHelpModalController = null;
    this._panelPortDisconnect = null;
    this._historyLoadToken = 0;
    void this.init();
  }
}

// Methods attached to SidePanelUI.prototype across the split panel-* modules.
// Declaration-merged here so each method body is typed `this: SidePanelUI`
// (real member checking) instead of the previous `(prototype as any)` escape hatch.
// Permissive param/return signatures keep the split modules assignable.
export interface SidePanelUI {
  abortActiveStreaming(): void;
  addImageFromBlob(...args: any[]): any;
  addPendingAttachment(...args: any[]): any;
  appendContextMessages(...args: any[]): any;
  applyContextUsageFromChars(...args: any[]): any;
  applyPermissionCheckboxes(...args: any[]): any;
  applyContextUsageSnapshot(...args: any[]): any;
  applyDetectedModels(...args: any[]): any;
  applyPlanUpdate(...args: any[]): any;
  bindHistoryPersistenceControl(...args: any[]): any;
  bindHistoryStorageSync(...args: any[]): any;
  bindThinkingToggle(...args: any[]): any;
  bindAssistantActions(...args: any[]): any;
  buildAssistantHeaderHtml(...args: any[]): any;
  buildSessionUsageLabel(...args: any[]): any;
  buildUsageLabel(...args: any[]): any;
  clearRunTransientNotices(...args: any[]): any;
  clearRunTargetTab(...args: any[]): any;
  buildAttachmentDisplayHtml(...args: any[]): any;
  buildAttachmentModelContent(...args: any[]): any;
  buildExecutionChipsHtml(...args: any[]): any;
  buildExecutionSemanticRows(...args: any[]): any;
  buildExecutionTurnKey(...args: any[]): any;
  buildHistoryPersistSignature(...args: any[]): any;
  buildHistoryTranscript(...args: any[]): any;
  buildMessageMeta(...args: any[]): any;
  appendToolStepDetails(...args: any[]): any;
  buildToolStepDetailsSummary(...args: any[]): any;
  bumpContextUsageWithMessages(...args: any[]): any;
  cancelPendingMarkdownRender(): void;
  cancelSettings(...args: any[]): any;
  clearAllHistory(...args: any[]): any;
  clearErrorBanner(...args: any[]): any;
  clearWarningBanner(...args: any[]): any;
  clearPendingAttachments(...args: any[]): any;
  clearPlan(...args: any[]): any;
  clearRunIncompleteBanner(...args: any[]): any;
  clearStreamingRenderTimers(...args: any[]): any;
  closeModelMenu(...args: any[]): any;
  closeSidebar(...args: any[]): any;
  collectPermissionCheckboxes(...args: any[]): any;
  collectCurrentFormProfile(...args: any[]): any;
  completeStreamingMessage(...args: any[]): any;
  consumeExecutionTurnSummary(...args: any[]): any;
  countAttachmentsByKind(...args: any[]): any;
  createExecutionTurnSummary(...args: any[]): any;
  createToolTreeItem(...args: any[]): any;
  deleteSession(...args: any[]): any;
  ensureHistoryStorageMigrated(...args: any[]): any;
  destroy(...args: any[]): any;
  destroyResizeObserver(...args: any[]): any;
  detectOllamaDetailed(...args: any[]): any;
  detectProviderModels(...args: any[]): any;
  displayAssistantMessage(...args: any[]): any;
  displaySummaryMessage(...args: any[]): any;
  displayToolExecution(...args: any[]): any;
  displayUserMessage(...args: any[]): any;
  downloadJsonFile(...args: any[]): any;
  ensureAttachmentsState(...args: any[]): any;
  ensureExecutionTurnSummary(...args: any[]): any;
  ensurePlanBlock(...args: any[]): any;
  ensureStreamingExecutionDetailsVisible(...args: any[]): any;
  escapeAttribute(...args: any[]): any;
  escapeHtml(...args: any[]): any;
  escapeHtmlBasic(...args: any[]): any;
  estimateBaseContextTokens(...args: any[]): any;
  estimateContextContentChars(...args: any[]): any;
  estimateContextMessageChars(...args: any[]): any;
  estimateUsageFromContent(...args: any[]): any;
  exportExecutionLog(...args: any[]): any;
  fetchAvailableModels(...args: any[]): any;
  fetchExecutionEvents(...args: any[]): any;
  finalizeExecutionDetails(...args: any[]): any;
  finalizePartialStreamingMessage(...args: any[]): any;
  finishActiveRun(...args: any[]): any;
  finishStreamingMessage(...args: any[]): any;
  flushStreamingReasoningRender(...args: any[]): any;
  flushStreamingTextRender(...args: any[]): any;
  focusModelOptionByIndex(...args: any[]): any;
  focusSelectedModelOption(...args: any[]): any;
  flushPendingHistoryPersist(...args: any[]): any;
  flushToolLogBuffer(): void;
  formatExecutionDuration(...args: any[]): any;
  formatTimeAgo(...args: any[]): any;
  formatTargetTabLabel(...args: any[]): any;
  formatTokenCount(...args: any[]): any;
  formatToolErrorMessage(...args: any[]): any;
  getActiveModelLabel(...args: any[]): any;
  getArgsPreview(...args: any[]): any;
  getConfiguredContextLimit(...args: any[]): any;
  getDefaultSystemPrompt(...args: any[]): any;
  getExecutionSummariesStore(...args: any[]): any;
  getLastUserMessageText(...args: any[]): any;
  getModelSourceContext(...args: any[]): any;
  getSelectedProvider(...args: any[]): any;
  getVisibleModelOptions(...args: any[]): any;
  handleAssistantStream(...args: any[]): any;
  handleChatScroll(...args: any[]): any;
  queueChatScrollSync(): void;
  handleComposerPaste(...args: any[]): any;
  handleContextCompaction(...args: any[]): any;
  handleFileSelection(...args: any[]): any;
  handleModelSelectChange(...args: any[]): any;
  handleProviderChange(...args: any[]): any;
  handleRuntimeMessage(...args: any[]): any;
  handleToolExecutionStart(...args: any[]): any;
  handleToolExecutionResult(...args: any[]): any;
  hasPendingMarkdownRender(el: HTMLElement): boolean;
  hidePlanDrawer(): void;
  inferModelFamily(...args: any[]): any;
  init(): Promise<void>;
  invalidateContextUsageCache(): void;
  isHistoryPanelVisible(...args: any[]): any;
  isModelMenuOpen(...args: any[]): any;
  loadHistoryList(): void | Promise<void>;
  loadSession(...args: any[]): any;
  loadSessionById(...args: any[]): any;
  loadSettings(...args: any[]): any;
  mapToolToExecutionStep(...args: any[]): any;
  maybeNotifyRunComplete(...args: any[]): any;
  resolveErrorBannerAction(...args: any[]): any;
  resolveToolErrorBannerAction(...args: any[]): any;
  measureHistoryBytes(...args: any[]): any;
  moveModelMenuFocus(...args: any[]): any;
  normalizeUsage(...args: any[]): any;
  openSidebar(...args: any[]): any;
  persistAllSettings(...args: any[]): any;
  persistHistory(...args: any[]): any;
  persistHistoryNow(...args: any[]): any;
  populateModelSelect(...args: any[]): any;
  fillSettingsModelSelect(...args: any[]): any;
  readHistoryIndex(...args: any[]): any;
  readSessionPayload(...args: any[]): any;
  removeHistorySessionKeys(...args: any[]): any;
  recomputeContextCharCount(...args: any[]): any;
  reconcileTerminalMarkdownRender(el: HTMLElement, finalContent: string, onRendered?: () => void): void;
  recordScrollPosition(): void;
  refreshAvailableModels(...args: any[]): any;
  removePendingAttachment(...args: any[]): any;
  requestStopRun(...args: any[]): any;
  waitForRunStopAck(...args: any[]): any;
  noteAcceptedSessionId(...args: any[]): any;
  noteCompletedRunId(...args: any[]): any;
  bumpHistoryDeletionBarrier(...args: any[]): any;
  bumpRenderSessionGeneration(...args: any[]): any;
  cancelDeferredConversationRender(...args: any[]): any;
  setSettingsControlsEnabled(...args: any[]): any;
  resolveRunStopAckWaiter(...args: any[]): any;
  rollbackPendingUserTurn(...args: any[]): any;
  renderConversationHistory(...args: any[]): any;
  renderExecutionSemanticSummary(...args: any[]): any;
  renderMarkdown(...args: any[]): any;
  renderModelMenu(...args: any[]): any;
  renderPendingAttachments(...args: any[]): any;
  renderPlanDrawer(...args: any[]): any;
  resetActivityPanel(): void;
  sweepInFlightToolContainers(...args: any[]): any;
  syncHistoryPersistenceSegments(...args: any[]): any;
  syncAssistantActionButtons(...args: any[]): any;
  setComposerBusy(busy: boolean): void;
  resetContextUsageTracking(...args: any[]): any;
  resolveModelFamilyBySource(...args: any[]): any;
  restoreScrollPosition(): void;
  safeJsonStringify(...args: any[]): any;
  sanitizeHistoryMessage(...args: any[]): any;
  sanitizeToolResultForDisplay(...args: any[]): any;
  saveSessionPayloadWithRetry(...args: any[]): any;
  saveSettings(...args: any[]): any;
  scheduleContextUsageRecompute(options?: { force?: boolean }): void;
  scheduleStreamingReasoningRender(...args: any[]): any;
  scheduleStreamingTextRender(...args: any[]): any;
  scheduleDeferredMarkdownRender(el: HTMLElement, buffer: string): void;
  scrollToBottom(options?: { force?: boolean }): void;
  scrollToolLogToBottom(...args: any[]): any;
  selectModelOptionByElement(...args: any[]): any;
  sendMessage(...args: any[]): any;
  setupEventListeners(...args: any[]): any;
  setupPlanDrawer(...args: any[]): any;
  setupResizeObserver(...args: any[]): any;
  shouldAutoScroll(...args: any[]): any;
  showErrorBanner(...args: any[]): any;
  showWarningBanner(...args: any[]): any;
  showPlanDrawer(...args: any[]): any;
  showSuccessToast(...args: any[]): any;
  startAnthropicOAuth(...args: any[]): any;
  startCodexOAuth(...args: any[]): any;
  startStreamingMessage(...args: any[]): any;
  startRunLiveness(...args: any[]): any;
  startThinkingTimer(...args: any[]): any;
  stopRunLiveness(): void;
  stopThinkingTimer(): void;
  stopToolDurationTimer(): void;
  ensureToolDurationTimer(): void;
  tickRunningToolDurations(): void;
  touchRunLiveness(): void;
  syncModelTrigger(...args: any[]): any;
  toggleActivityPanel(...args: any[]): any;
  toggleCustomEndpoint(...args: any[]): any;
  toggleModelMenu(...args: any[]): any;
  togglePlanDrawer(...args: any[]): any;
  togglePlanStep(...args: any[]): any;
  trackExecutionToolResult(...args: any[]): any;
  trackExecutionTurnStart(...args: any[]): any;
  truncateHistoryField(...args: any[]): any;
  truncateText(...args: any[]): any;
  updateSessionUsageDisplay(...args: any[]): any;
  updateRunTargetTab(...args: any[]): any;
  updateStatusTargetDisplay(...args: any[]): any;
  updateActivityState(...args: any[]): any;
  updateActivityToggle(...args: any[]): any;
  getComposerDensityCached(): 'tight' | 'compact' | 'normal';
  invalidateComposerDensity(): void;
  updateChatEmptyState(): void;
  updateContextUsage(...args: any[]): any;
  updateExecutionDetailsHeader(...args: any[]): any;
  updateModelDisplay(...args: any[]): any;
  updateScrollButton(...args: any[]): any;
  updateStatus(message: string, tone?: string): void;
  updateStreamReasoning(...args: any[]): any;
  updateStreamingMessage(...args: any[]): any;
  updateThinkingPanel(...args: any[]): any;
  updateToolLogEntry(...args: any[]): any;
  updateToolMessage(...args: any[]): any;
  updateToolTreeItem(...args: any[]): any;
  updateUsageStats(...args: any[]): any;
}
