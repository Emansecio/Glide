import { cloneConversationHistory, createMessage, normalizeConversationHistory } from '../../ai/message-schema.js';
import type { Message } from '../../ai/message-schema.js';
import { isRuntimeMessage } from '../../types/runtime-messages.js';
import { bindModelPicker } from './bind-model-picker.js';
import { bindSettings } from './bind-settings.js';
import { createModalController } from './modal-controller.js';
import { shouldAcceptContextCompaction, shouldAppendAssistantFinalForCommit } from './panel-guards.js';
import { bindSidebarNavigation } from './panel-navigation.js';
import { connectPanelPort } from './panel-port.js';
import { getTerminalStatusPresentation } from './panel-status.js';
import { resolvePanelTabId } from './panel-tab-id.js';
import { SidePanelUI } from './panel-ui.js';
import { enqueueStreamMessage } from './stream-queue.js';

function parseRetryStatusFromWarning(message: string): string | null {
  const text = String(message || '').trim();
  if (!text) return null;
  const attemptMatch = text.match(/tentativa\s+(\d+)\s*\/\s*(\d+)/i);
  const isRetryLike =
    /Limite de uso do provedor|Instabilidade do provedor|repetindo sem cache|rate.?limit|sobrecarga|overload/i.test(
      text,
    ) ||
    (attemptMatch !== null && /repetindo|aguardando/i.test(text));
  if (!isRetryLike) return null;
  if (attemptMatch) {
    return `Tentando novamente… (${attemptMatch[1]}/${attemptMatch[2]})`;
  }
  return 'Tentando novamente…';
}

function preservePartialAssistantOutput(
  ui: SidePanelUI,
  finishReason: 'stopped' | 'failed' | 'interrupted' | 'ambiguous_action',
) {
  ui.finalizePartialStreamingMessage?.(finishReason);
}

function applyRunTransientNoticesClear(ui: SidePanelUI, options: { sweepTools?: boolean; toolError?: boolean } = {}) {
  ui.stopToolDurationTimer?.();
  if (options.sweepTools) {
    ui.sweepInFlightToolContainers?.({ error: options.toolError === true });
  }
  ui._retryStatusActive = false;
  if (ui._compactionNoticeActive) {
    ui.clearWarningBanner?.();
    ui._compactionNoticeActive = false;
  }
}

SidePanelUI.prototype.clearRunTransientNotices = function clearRunTransientNotices(
  options: { sweepTools?: boolean; toolError?: boolean } = {},
) {
  applyRunTransientNoticesClear(this, options);
};

SidePanelUI.prototype.init = async function init() {
  const _debug = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
  this._debug = _debug;
  if (_debug) console.log('[Glide] init() starting...');
  this.bindHistoryStorageSync?.();
  if (!this._pagehideBound) {
    window.addEventListener('pagehide', () => {
      this.flushPendingHistoryDeletes?.();
      void this.flushPendingHistoryPersist?.();
    });
    this._pagehideBound = true;
  }
  this.setupEventListeners();
  this.setupPlanDrawer();
  this.setupResizeObserver();
  // Start with sidebar closed by default
  this.elements.sidebar?.classList.add('closed');
  this.elements.sidebar?.toggleAttribute('inert', true);
  this.elements.sidebar?.setAttribute('aria-hidden', 'true');
  this.elements.activityPanel?.toggleAttribute('inert', true);
  this.elements.activityPanel?.setAttribute('aria-hidden', 'true');
  this.elements.sidebarBackdrop?.classList.remove('visible');
  if (_debug) console.log('[Glide] Calling loadSettings...');
  await this.loadSettings();
  if (_debug) {
    console.log('[Glide] loadSettings done, configs:', Object.keys(this.configs), 'current:', this.currentConfig);
    console.log('[Glide] Config details:', JSON.stringify(this.configs[this.currentConfig] || {}).slice(0, 200));
  }

  // Auto-detect local Ollama and fetch available models
  void this.fetchAvailableModels?.();

  await this.loadHistoryList();
  await this.adoptActiveRunIfAny();
  if (!this.activeRunId) this.updateStatus('Pronto', 'success');
  this.updateModelDisplay();
  this.updateChatEmptyState?.();
  if (_debug) console.log('[Glide] init() complete');
};

/**
 * Painel fechado e reaberto no meio de um run: o sessionId novo descartava todos os eventos e o
 * composer ficava ocioso, com o agente ainda agindo na página e sem botão Parar. Pergunta ao
 * worker e adota sessão/run ativos (histórico do worker já é o canônico: não reenviamos o nosso).
 */
SidePanelUI.prototype.adoptActiveRunIfAny = async function adoptActiveRunIfAny() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'run_status_query' });
    if (!status?.activeRunId || typeof status.sessionId !== 'string' || !status.sessionId || this.activeRunId) return;
    // Run de outra janela/aba: não adota (ficaria "ocupado" com eventos de um chat que não é este).
    if (typeof status.panelTabId === 'number' && status.panelTabId !== (await resolvePanelTabId())) return;
    this.sessionId = status.sessionId;
    this.acceptedSessionIds = new Set([status.sessionId]);
    this.noteAcceptedSessionId?.(status.sessionId);
    this.swContextSyncedSessions.add(status.sessionId);
    if (Number.isInteger(status.contextRevision) && status.contextRevision >= 0) {
      this.contextRevision = status.contextRevision;
    }
    this.activeRunId = String(status.activeRunId);
    this.setComposerBusy(true);
    this.startRunLiveness?.();
    this.updateStatus('Execução em andamento…', 'warning');
  } catch {
    // Worker indisponível: segue como painel ocioso.
  }
};

SidePanelUI.prototype.setupEventListeners = function setupEventListeners() {
  bindSidebarNavigation(this.elements, {
    onOpen: () => this.openSidebar(),
    onClose: () => this.closeSidebar(),
    onChat: () => this.openChatView(),
    onHistory: () => this.openHistoryPanel(),
    onSettings: () => this.openSettingsPanel(),
  });

  this.elements.startNewSessionBtn?.addEventListener('click', () => {
    void this.startNewSession();
  });
  this.elements.privateSessionBtn?.addEventListener('click', () => {
    void this.startNewSession({ privateSession: true });
  });
  this.elements.clearHistoryBtn?.addEventListener('click', () => this.clearAllHistory());
  this.elements.historySearch?.addEventListener('input', () => this.filterHistoryList());

  bindSettings(this);
  bindModelPicker(this);

  // Send message
  this.elements.sendBtn?.addEventListener('click', () => {
    this.sendMessage();
  });

  // Parar execução em andamento
  this.elements.stopBtn?.addEventListener('click', () => {
    void this.requestStopRun();
  });

  // Enter to send (Shift+Enter for newline); Esc interrompe a execução ativa.
  this.elements.userInput?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      // Enter que confirma uma composição IME (CJK) não é "enviar".
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      this.sendMessage();
      return;
    }
    if (event.key === 'Escape' && this.elements.composer?.classList.contains('running')) {
      // Esc que cancela uma composição IME não é "parar".
      if (event.isComposing) return;
      event.preventDefault();
      void this.requestStopRun();
    }
  });

  // Auto-expand textarea: um rAF, só escreve height se mudou (evita thrash).
  const userInput = this.elements.userInput;
  let composerHeightRaf = 0;
  let lastComposerScrollHeight = 0;
  userInput?.addEventListener('input', () => {
    if (composerHeightRaf) return;
    composerHeightRaf = requestAnimationFrame(() => {
      composerHeightRaf = 0;
      if (!userInput) return;
      userInput.style.height = 'auto';
      const next = userInput.scrollHeight;
      if (next !== lastComposerScrollHeight) {
        lastComposerScrollHeight = next;
        userInput.style.height = `${next}px`;
      } else {
        // restaura altura atual sem flash se scrollHeight não mudou
        userInput.style.height = `${next}px`;
      }
    });
  });

  // File / image upload + paste screenshot (Ctrl+V)
  this.elements.fileBtn?.addEventListener('click', () => {
    this.elements.fileInput?.click();
  });
  this.elements.fileInput?.addEventListener('change', (event) => {
    void this.handleFileSelection?.(event);
  });
  this.elements.userInput?.addEventListener('paste', (event: ClipboardEvent) => {
    void this.handleComposerPaste?.(event);
  });
  // Soltar um arquivo fora de um alvo tratado navegaria o painel para o arquivo e destruiria o
  // estado da conversa. Trata como anexo.
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    void this.ingestFiles?.(Array.from(event.dataTransfer?.files || []) as File[]);
  });
  // Also accept paste when focus is on the composer tray (not only textarea)
  this.elements.composer?.addEventListener('paste', (event: ClipboardEvent) => {
    if (event.target === this.elements.userInput) return; // already handled
    void this.handleComposerPaste?.(event);
  });

  this.oauthHelpModalController = createModalController({
    root: this.elements.oauthHelpModal,
    closeButtons: [this.elements.closeOauthHelpBtn, this.elements.closeOauthHelpBtnOk],
    backdrop: this.elements.oauthHelpModalBackdrop,
  });

  this.elements.oauthHelpBtn?.addEventListener('click', () => {
    void this.oauthHelpModalController?.open();
  });

  // passive: o handler nunca chama preventDefault, e sem a marcação o Chrome
  // precisa esperar por ele antes de rolar de fato.
  // queueChatScrollSync: a rolagem por inércia emite mais de um evento por
  // frame, e cada um lia scrollTop/scrollHeight/clientHeight. Uma leitura por
  // frame basta — a tela não atualiza mais rápido que isso.
  this.elements.chatMessages?.addEventListener('scroll', () => this.queueChatScrollSync(), { passive: true });
  this.elements.scrollToLatestBtn?.addEventListener('click', () => this.scrollToBottom({ force: true }));

  this.elements.activityToggleBtn?.addEventListener('click', () => this.toggleActivityPanel());
  this.elements.activityCloseBtn?.addEventListener('click', () => this.toggleActivityPanel(false));
  this.elements.exportExecutionLogBtn?.addEventListener('click', () => {
    void this.exportExecutionLog?.();
  });

  if (!this._notificationClickBound && chrome.notifications?.onClicked?.addListener) {
    chrome.notifications.onClicked.addListener(() => {
      void chrome.windows.getCurrent((win) => {
        if (win?.id != null) {
          void chrome.windows.update(win.id, { focused: true });
        }
      });
    });
    this._notificationClickBound = true;
  }

  this._pendingStreamMessages = [];
  this._streamDrainScheduled = false;
  const drainPendingStreamMessages = () => {
    const batch = this._pendingStreamMessages.splice(0);
    for (const queued of batch) {
      this.handleRuntimeMessage(queued);
    }
  };

  const deliverRuntimePush = (message: unknown) => {
    if (!isRuntimeMessage(message)) return;
    if (
      message.type === 'assistant_stream_start' ||
      message.type === 'assistant_stream_delta' ||
      message.type === 'assistant_stream_stop'
    ) {
      const shouldDrainImmediately = enqueueStreamMessage(this._pendingStreamMessages, message);
      if (shouldDrainImmediately) drainPendingStreamMessages();
      if (!this._streamDrainScheduled) {
        this._streamDrainScheduled = true;
        requestAnimationFrame(() => {
          this._streamDrainScheduled = false;
          drainPendingStreamMessages();
        });
      }
      return;
    }
    // Terminal/non-stream messages (e.g. assistant_final) are delivered
    // synchronously and can overtake stream deltas still queued for the next
    // animation frame. Drain the queue first so ordering is preserved and we
    // never build a duplicate or empty assistant bubble.
    if (this._pendingStreamMessages.length > 0) {
      drainPendingStreamMessages();
    }
    this.handleRuntimeMessage(message);
  };

  // SW→panel push events: port when connected, sendMessage fallback while reconnecting.
  const portConnection = connectPanelPort(deliverRuntimePush, {
    shouldReconnect: () =>
      Boolean(
        this.activeRunId ||
          this.elements.composer?.classList.contains('running') ||
          this.isStreaming ||
          this.pendingToolCount > 0,
      ),
  });
  this._panelPortDisconnect = portConnection.disconnect;
  this._panelPortEnsureConnected = portConnection.ensureConnected;

  this._visibilityChangeHandler = () => {
    if (!document.hidden) {
      this._panelPortEnsureConnected?.();
    }
  };
  if (!this._visibilityChangeBound) {
    document.addEventListener('visibilitychange', this._visibilityChangeHandler);
    this._visibilityChangeBound = true;
  }

  // Listen for push fallback and unrelated runtime messages while the port is down.
  this._runtimeMessageHandler = (message: any) => {
    deliverRuntimePush(message);
  };
  chrome.runtime.onMessage.addListener(this._runtimeMessageHandler);
};

SidePanelUI.prototype.setupResizeObserver = function setupResizeObserver() {
  if (!this.elements.chatMessages || typeof ResizeObserver === 'undefined') return;
  this.destroyResizeObserver();
  let lastObservedWidth = -1;
  this.chatResizeObserver = new ResizeObserver((entries) => {
    // A área visível mudou de tamanho (gaveta do plano, banners, composer): cola
    // no fim a cada frame. O acompanhamento suave ficaria para trás de uma
    // transição que já anima a própria altura.
    if (this.shouldAutoScroll() && this.isNearBottom) {
      this.scrollToBottom({ instant: true });
    }
    // O conteúdo do stream cresce em ALTURA a cada flush; a densidade do
    // composer só depende da LARGURA. Recalcular activity state (que lê
    // clientWidth) a cada crescimento reintroduziria o layout forçado que o
    // caminho de delta evita de propósito.
    const width = entries[0]?.contentRect?.width ?? 0;
    if (width !== lastObservedWidth) {
      lastObservedWidth = width;
      // Único ponto em que a densidade pode ter mudado — e o único em que vale
      // pagar a remedição (ver getComposerDensityCached).
      this.invalidateComposerDensity?.();
      this.updateActivityState();
    }
  });
  this.chatResizeObserver.observe(this.elements.chatMessages);
};

SidePanelUI.prototype.destroyResizeObserver = function destroyResizeObserver() {
  if (this.chatResizeObserver) {
    this.chatResizeObserver.disconnect();
    this.chatResizeObserver = null;
  }
};

SidePanelUI.prototype.finishActiveRun = function finishActiveRun() {
  if (this.pendingSessionId) {
    this.sessionId = this.pendingSessionId;
    this.noteAcceptedSessionId?.(this.pendingSessionId);
    this.pendingSessionId = null;
  }
  if (this.activeRunId) {
    this.noteCompletedRunId?.(this.activeRunId);
  }
  this.activeRunId = null;
  this.clearRunTargetTab?.();
};

SidePanelUI.prototype.maybeNotifyRunComplete = function maybeNotifyRunComplete(content: string) {
  if (!this.notifyOnComplete || !document.hidden) return;
  const body = String(content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!body) return;
  if (!chrome.notifications?.create) return;
  void chrome.notifications.create(`glide-complete-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Glide',
    message: body,
  });
};

SidePanelUI.prototype.handleRuntimeMessage = function handleRuntimeMessage(message: any) {
  if (message.type === 'context_commit') {
    if (
      !shouldAcceptContextCompaction({
        messageSessionId: message.sessionId,
        newSessionId: message.sessionId,
        previousSessionId: message.previousSessionId,
        messageRunId: message.runId,
        activeRunId: this.activeRunId,
        completedRunIds: this.completedRunIds,
        sessionId: this.sessionId,
        pendingSessionId: this.pendingSessionId,
        acceptedSessionIds: this.acceptedSessionIds,
      }) ||
      !Number.isInteger(message.revision) ||
      message.revision <= this.contextRevision
    ) {
      return;
    }
    const normalized = normalizeConversationHistory(message.messages as Message[]);
    this.contextHistory = cloneConversationHistory(normalized);
    this.contextRevision = message.revision;
    if (message.sessionId && message.sessionId !== this.sessionId) {
      this.noteAcceptedSessionId?.(this.sessionId);
      this.sessionId = message.sessionId;
      this.noteAcceptedSessionId?.(message.sessionId);
    }
    this.swContextSyncedSessions.add(this.sessionId);
    if (message.contextUsage) this.applyContextUsageSnapshot(message.contextUsage);
    return;
  }
  if (message.type === 'context_compacted') {
    if (
      !shouldAcceptContextCompaction({
        messageSessionId: message.sessionId,
        newSessionId: message.newSessionId,
        previousSessionId: message.previousSessionId,
        messageRunId: message.runId,
        activeRunId: this.activeRunId,
        completedRunIds: this.completedRunIds,
        sessionId: this.sessionId,
        pendingSessionId: this.pendingSessionId,
        acceptedSessionIds: this.acceptedSessionIds,
      })
    ) {
      return;
    }
    this.touchRunLiveness?.();
    this.handleContextCompaction(message);
    return;
  }

  const sessionOk =
    !message.sessionId || this.acceptedSessionIds.has(message.sessionId) || message.sessionId === this.sessionId;
  const incomingRunId = typeof message.runId === 'string' && message.runId.trim() ? message.runId.trim() : null;
  const resumesActiveRun =
    message.type === 'run_resume_started' &&
    typeof message.resumedFromRunId === 'string' &&
    message.resumedFromRunId === this.activeRunId;

  let runOk = false;
  if (!incomingRunId) {
    runOk = true;
  } else if (this.completedRunIds.has(incomingRunId)) {
    runOk = false;
  } else if (this.activeRunId === null) {
    runOk = sessionOk;
  } else {
    runOk = incomingRunId === this.activeRunId || resumesActiveRun;
  }

  if (!sessionOk || !runOk) return;

  if (incomingRunId && (this.activeRunId === null || resumesActiveRun)) {
    this.activeRunId = incomingRunId;
  }
  // Qualquer sinal do run reinicia a janela de silêncio do watchdog do painel.
  this.touchRunLiveness?.();
  if (message.type === 'run_resume_started') {
    this.awaitingRunAcceptance = false;
    this.setComposerBusy(true);
    this.startRunLiveness();
    this.updateStatus('Retomando execução…', 'active');
    return;
  }
  if (message.type === 'run_resume_required' || message.type === 'run_interrupted') {
    this.awaitingRunAcceptance = false;
    this.stopThinkingTimer?.();
    this.stopRunLiveness?.();
    this.pendingToolCount = 0;
    this.isStreaming = false;
    this.activeToolName = null;
    preservePartialAssistantOutput(this, message.type === 'run_resume_required' ? 'ambiguous_action' : 'interrupted');
    this.setComposerBusy(false);
    applyRunTransientNoticesClear(this, { sweepTools: true });
    if (message.type === 'run_resume_required') {
      this.showWarningBanner(message.message);
      this.updateStatus('Ação precisa de confirmação', 'warning');
    } else {
      this.showWarningBanner(message.message);
      this.updateStatus('Interrompida', 'warning');
    }
    this.finishActiveRun?.();
    return;
  }
  if (message.type === 'assistant_stream_start') {
    this.awaitingRunAcceptance = false;
    this.pendingUserTurn = null;
    this.streamingReasoning = '';
    if (this._retryStatusActive) {
      this._retryStatusActive = false;
    }
    this.handleAssistantStream({ status: 'start' });
    return;
  }
  if (message.type === 'assistant_stream_delta') {
    if (message.channel === 'reasoning') {
      const delta = message.content || '';
      this.streamingReasoning = `${this.streamingReasoning}${delta}`;
      this.updateStreamReasoning(delta);
      return;
    }
    this.handleAssistantStream({ status: 'delta', content: message.content });
    return;
  }
  if (message.type === 'assistant_stream_stop') {
    this.handleAssistantStream({ status: 'stop' });
    return;
  }

  if (message.type === 'plan_update_ack') {
    this.applyPlanUpdateAck(message);
    return;
  }

  if (message.type === 'plan_update') {
    this.applyPlanUpdate(message.plan);
    return;
  }

  if (message.type === 'tool_events_batch') {
    for (const event of message.events) {
      const expanded = {
        schemaVersion: message.schemaVersion,
        runId: message.runId,
        turnId: message.turnId,
        sessionId: message.sessionId,
        timestamp: message.timestamp,
        ...event,
      };
      if (expanded.type === 'tool_execution_start') {
        this.handleToolExecutionStart(expanded);
      } else if (expanded.type === 'tool_execution_result') {
        this.handleToolExecutionResult(expanded);
      }
    }
    return;
  }

  if (message.type === 'tool_execution_start') {
    this.handleToolExecutionStart(message);
    return;
  }
  if (message.type === 'tool_execution_result') {
    this.handleToolExecutionResult(message);
    return;
  }

  if (message.type === 'assistant_final') {
    this.awaitingRunAcceptance = false;
    const accepted = this.displayAssistantMessage(
      message.content,
      message.thinking,
      message.usage,
      message.model,
      message,
    );
    // Empty final that display rejects must not pollute contextHistory.
    if (
      accepted !== false &&
      shouldAppendAssistantFinalForCommit({
        contextRevision: this.contextRevision,
        finalRevision: message.contextRevision,
      })
    ) {
      this.appendContextMessages(message.responseMessages, message.content, message.thinking);
    }
    // Context-WINDOW occupancy = the real size of the conversation (bounded by the
    // limit / compaction), which the backend now reports. NEVER use usage.inputTokens
    // here — that is the cumulative per-turn spend (sum across every tool step) and
    // routinely exceeds the window (e.g. 659k), which is a cost figure, not context.
    if (message.contextUsage?.approxTokens) {
      this.applyContextUsageSnapshot(message.contextUsage);
    } else {
      this.updateContextUsage();
    }
    applyRunTransientNoticesClear(this, { sweepTools: true });
    this.swContextSyncedSessions.add(this.sessionId);
    this.maybeNotifyRunComplete?.(message.content);
    this.finishActiveRun?.();
    return;
  }

  if (message.type === 'run_error' || message.type === 'run_stopped') {
    const stopped = message.type === 'run_stopped';
    if (stopped) {
      this.resolveRunStopAckWaiter?.();
    }
    const concurrent =
      !stopped &&
      (message.details?.reason === 'concurrent_run' ||
        String(message.message || '').includes('Já existe uma execução'));
    if (concurrent || this.awaitingRunAcceptance) {
      this.rollbackPendingUserTurn?.();
    }
    this.awaitingRunAcceptance = false;
    const transcriptMessage =
      !stopped && message.details?.recordInTranscript === true
        ? String(message.details?.transcriptMessage || message.message || '').trim()
        : '';
    if (transcriptMessage) {
      this.displayAssistantMessage(transcriptMessage, null, null, null, message);
    } else {
      this.consumeExecutionTurnSummary?.(message.runId, message.turnId);
    }
    this.stopThinkingTimer?.();
    this.stopRunLiveness?.();
    this.setComposerBusy(false);
    this.pendingToolCount = 0;
    this.isStreaming = false;
    this.activeToolName = null;
    this.updateActivityState();
    preservePartialAssistantOutput(this, stopped ? 'stopped' : 'failed');
    applyRunTransientNoticesClear(this, { sweepTools: true, toolError: !stopped });
    if (stopped) {
      this.showWarningBanner(message.message || 'Execução interrompida.');
      const stoppedStatus = getTerminalStatusPresentation('stopped');
      this.updateStatus(stoppedStatus.text, stoppedStatus.tone);
    } else {
      // Erro de credencial/configuração ganha um atalho direto para as Configurações
      // em vez de só um texto — é o caminho que o usuário precisa seguir.
      const action = this.resolveErrorBannerAction?.({
        action: message.details?.action,
        code: message.details?.code,
      });
      this.showErrorBanner(message.message, { action });
      this.updateStatus('Erro', 'error');
    }
    this.finishActiveRun?.();
    return;
  }
  if (message.type === 'run_warning') {
    // Aviso é informativo (aba de trabalho escolhida, retry do provedor, compaction
    // adiada). Renderizar isso no banner de ERRO fazia todo run de automação começar
    // com um alerta vermelho.
    const retryStatus = parseRetryStatusFromWarning(message.message);
    if (retryStatus) {
      this._retryStatusActive = true;
      this.updateStatus(retryStatus, 'warning');
    }
    this.showWarningBanner(message.message);
    return;
  }
  if (message.type === 'run_quality_gate') {
    const state = String(message.state || '');
    const reason = String(message.reason || 'quality_gate');
    if (state === 'blocked') {
      this.showErrorBanner(`A verificação de qualidade bloqueou a finalização (${reason}).`);
      this.updateStatus('Qualidade: finalização bloqueada', 'error');
    } else if (state === 'forced_retry') {
      this.updateStatus('Qualidade: repetindo o passo', 'warning');
    }
    return;
  }
  if (message.type === 'vision_context_ready') {
    this.updateStatus('Contexto visual pronto', 'active');
    return;
  }
};

SidePanelUI.prototype.appendContextMessages = function appendContextMessages(
  responseMessages?: Array<Record<string, unknown>>,
  fallbackContent?: string,
  fallbackThinking?: string | null,
) {
  if (!responseMessages || responseMessages.length === 0) {
    const assistantEntry = createMessage({
      role: 'assistant',
      content: fallbackContent || '',
      thinking: fallbackThinking || null,
    });
    if (assistantEntry) {
      this.contextHistory.push(assistantEntry);
      this.bumpContextUsageWithMessages?.([assistantEntry]);
    }
    return;
  }
  const normalized = normalizeConversationHistory(responseMessages as unknown as Message[]);
  this.contextHistory.push(...normalized);
  this.bumpContextUsageWithMessages?.(normalized);
};

SidePanelUI.prototype.handleContextCompaction = function handleContextCompaction(message: any) {
  const normalized = normalizeConversationHistory(message.contextMessages as unknown as Message[]);
  const nextSessionId = String(message.newSessionId || '').trim();
  if (nextSessionId) {
    this.noteAcceptedSessionId?.(nextSessionId);
    this.pendingSessionId = nextSessionId;
    this.swContextSyncedSessions.delete(this.sessionId);
    this.swContextSyncedSessions.add(nextSessionId);
    // Aplica sessionId já se não há run ativo (evita lag até finishActiveRun).
    if (!this.activeRunId && !this.elements.composer?.classList.contains('running') && !this.isStreaming) {
      this.sessionId = nextSessionId;
      this.pendingSessionId = null;
      void chrome.runtime.sendMessage({ type: 'session_active', sessionId: this.sessionId });
    }
  }
  const runActive =
    Boolean(this.activeRunId) ||
    Boolean(this.elements.composer?.classList.contains('running')) ||
    this.isStreaming ||
    this.pendingToolCount > 0;
  // Post-terminal compaction: clear deferred run_warning banner/toast state.
  if (!runActive) {
    this.clearWarningBanner?.();
    this._compactionNoticeActive = false;
  }
  // NÃO chamar abortActiveStreaming no meio do run: isso desbusy o composer e
  // desliga liveness enquanto o modelo ainda trabalha (deferred compaction).
  // Só rebinda o histórico do modelo; a UI de display permanece intacta.
  this.contextHistory = cloneConversationHistory(normalized);
  this.resetContextUsageTracking?.();
  const trimmed = Number(message.trimmedCount) || 0;
  const preserved = Number(message.preservedCount) || 0;
  this.showSuccessToast?.(`Contexto compactado: ${trimmed} resumidas, ${preserved} preservadas`);

  if (runActive && trimmed > 0) {
    this.showWarningBanner(`Contexto compactado — ${trimmed} mensagens resumidas`, { timeoutMs: 0 });
    this._compactionNoticeActive = true;
  }

  if (message.contextUsage?.approxTokens) {
    this.applyContextUsageSnapshot?.(message.contextUsage);
  } else {
    this.scheduleContextUsageRecompute?.({ force: true });
  }

  // Fora de run: mostra o summary de compaction na UI sem apagar o transcript
  // de display com roles tool do modelo.
  if (!runActive) {
    const summary = normalized.find(
      (m: Message) => m.role === 'system' || (m as { meta?: { kind?: string } }).meta?.kind === 'summary',
    );
    if (summary) {
      const already = this.displayHistory.some(
        (m: Message) =>
          (m as { meta?: { kind?: string } }).meta?.kind === 'summary' ||
          (m.role === 'system' && String(m.content || '').slice(0, 40) === String(summary.content || '').slice(0, 40)),
      );
      if (!already) {
        this.displayHistory = [
          cloneConversationHistory([summary])[0],
          ...this.displayHistory.filter((m: Message) => m.role !== 'system'),
        ];
        this.renderConversationHistory?.();
      }
    }
    void this.persistHistory?.({ immediate: true });
  }
};

SidePanelUI.prototype.handleToolExecutionStart = function handleToolExecutionStart(message: any) {
  this.awaitingRunAcceptance = false;
  this.pendingUserTurn = null;
  if (this._retryStatusActive) {
    this._retryStatusActive = false;
    this.updateStatus('Executando ferramenta…', 'active');
  }
  this.trackExecutionTurnStart?.(message);
  this.pendingToolCount += 1;
  this.clearErrorBanner();
  this.updateActivityState();
  this.activeToolName = message.tool || null;
  this.displayToolExecution(message.tool, message.args, null, message.id, message);
};

SidePanelUI.prototype.handleToolExecutionResult = function handleToolExecutionResult(message: any) {
  this.trackExecutionToolResult?.(message);
  this.pendingToolCount = Math.max(0, this.pendingToolCount - 1);
  this.updateActivityState();
  this.activeToolName = null;
  this.displayToolExecution(message.tool, message.args, message.result, message.id, message);
  void this.updateRunTargetTab?.(message.tool, message.result);
};
