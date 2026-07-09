import { createMessage, normalizeConversationHistory } from '../../ai/message-schema.js';
import type { Message } from '../../ai/message-schema.js';
import { isRuntimeMessage } from '../../types/runtime-messages.js';
import { bindModelPicker } from './bind-model-picker.js';
import { bindSettings } from './bind-settings.js';
import { createModalController } from './modal-controller.js';
import { bindSidebarNavigation } from './panel-navigation.js';
import { SidePanelUI } from './panel-ui.js';

(SidePanelUI.prototype as any).init = async function init() {
  const _debug = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
  this._debug = _debug;
  if (_debug) console.log('[Glide] init() starting...');
  this.setupEventListeners();
  this.setupPlanDrawer();
  this.setupResizeObserver();
  // Start with sidebar closed by default
  this.elements.sidebar?.classList.add('closed');
  this.elements.sidebar?.setAttribute('aria-hidden', 'true');
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
  this.updateStatus('Pronto', 'success');
  this.updateModelDisplay();
  this.updateChatEmptyState?.();
  if (_debug) console.log('[Glide] init() complete');
};

(SidePanelUI.prototype as any).setupEventListeners = function setupEventListeners() {
  bindSidebarNavigation(this.elements, {
    onOpen: () => this.openSidebar(),
    onClose: () => this.closeSidebar(),
    onChat: () => this.openChatView(),
    onHistory: () => this.openHistoryPanel(),
    onSettings: () => this.openSettingsPanel(),
  });

  this.elements.startNewSessionBtn?.addEventListener('click', () => this.startNewSession());
  this.elements.clearHistoryBtn?.addEventListener('click', () => this.clearAllHistory());

  bindSettings(this);
  bindModelPicker(this);

  // Send message
  this.elements.sendBtn?.addEventListener('click', () => {
    this.sendMessage();
  });
  this.elements.newChatBtn?.addEventListener('click', () => this.startNewSession());

  // Enter to send (Shift+Enter for newline)
  this.elements.userInput?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  });

  // Auto-expand textarea height as user types
  const userInput = this.elements.userInput;
  userInput?.addEventListener('input', () => {
    requestAnimationFrame(() => {
      userInput.style.height = 'auto';
      userInput.style.height = `${userInput.scrollHeight}px`;
    });
  });

  // File upload
  this.elements.fileBtn?.addEventListener('click', () => {
    this.elements.fileInput?.click();
  });
  this.elements.fileInput?.addEventListener('change', (event) => this.handleFileSelection(event));

  this.tabSelectorController = createModalController({
    root: this.elements.tabSelector,
    closeButtons: [this.elements.closeTabSelector],
    backdrop: this.elements.tabSelector?.querySelector('.modal-backdrop') as HTMLElement | null,
    onOpen: async () => {
      await this.loadTabs();
      this.updateTabSelectorButton();
    },
  });

  this.oauthHelpModalController = createModalController({
    root: this.elements.oauthHelpModal,
    closeButtons: [this.elements.closeOauthHelpBtn, this.elements.closeOauthHelpBtnOk],
    backdrop: this.elements.oauthHelpModalBackdrop,
  });

  // Tab selector
  this.elements.tabSelectorBtn?.addEventListener('click', () => this.toggleTabSelector());
  this.elements.tabSelectorAddActive?.addEventListener('click', () => this.addActiveTabToSelection());
  this.elements.tabSelectorClear?.addEventListener('click', () => this.clearSelectedTabs());

  this.elements.oauthHelpBtn?.addEventListener('click', () => {
    void this.oauthHelpModalController?.open();
  });

  this.elements.chatMessages?.addEventListener('scroll', () => this.handleChatScroll());
  this.elements.scrollToLatestBtn?.addEventListener('click', () => this.scrollToBottom({ force: true }));

  this.elements.activityToggleBtn?.addEventListener('click', () => this.toggleActivityPanel());
  this.elements.activityCloseBtn?.addEventListener('click', () => this.toggleActivityPanel(false));
  this.elements.exportExecutionLogBtn?.addEventListener('click', () => {
    void this.exportExecutionLog?.();
  });

  this._pendingStreamMessages = [];
  this._streamDrainScheduled = false;

  // Listen for messages from background
  this._runtimeMessageHandler = (message: any) => {
    if (!isRuntimeMessage(message)) return;
    if (
      message.type === 'assistant_stream_start' ||
      message.type === 'assistant_stream_delta' ||
      message.type === 'assistant_stream_stop'
    ) {
      this._pendingStreamMessages.push(message);
      if (!this._streamDrainScheduled) {
        this._streamDrainScheduled = true;
        requestAnimationFrame(() => {
          this._streamDrainScheduled = false;
          const batch = this._pendingStreamMessages.splice(0);
          for (const queued of batch) {
            this.handleRuntimeMessage(queued);
          }
        });
      }
      return;
    }
    // Terminal/non-stream messages (e.g. assistant_final) are delivered
    // synchronously and can overtake stream deltas still queued for the next
    // animation frame. Drain the queue first so ordering is preserved and we
    // never build a duplicate or empty assistant bubble.
    if (this._pendingStreamMessages.length > 0) {
      const pending = this._pendingStreamMessages.splice(0);
      for (const queued of pending) {
        this.handleRuntimeMessage(queued);
      }
    }
    this.handleRuntimeMessage(message);
  };
  chrome.runtime.onMessage.addListener(this._runtimeMessageHandler);
};

(SidePanelUI.prototype as any).setupResizeObserver = function setupResizeObserver() {
  if (!this.elements.chatMessages || typeof ResizeObserver === 'undefined') return;
  this.destroyResizeObserver();
  this.chatResizeObserver = new ResizeObserver(() => {
    if (this.shouldAutoScroll() && this.isNearBottom) {
      this.scrollToBottom();
    }
    this.updateActivityState();
  });
  this.chatResizeObserver.observe(this.elements.chatMessages);
};

(SidePanelUI.prototype as any).destroyResizeObserver = function destroyResizeObserver() {
  if (this.chatResizeObserver) {
    this.chatResizeObserver.disconnect();
    this.chatResizeObserver = null;
  }
};

(SidePanelUI.prototype as any).destroy = function destroy() {
  // Clean up runtime message listener
  if (this._runtimeMessageHandler) {
    chrome.runtime.onMessage.removeListener(this._runtimeMessageHandler);
    this._runtimeMessageHandler = null;
  }
  // Clean up document-level event listeners
  if (this._documentClickHandler) {
    document.removeEventListener('click', this._documentClickHandler);
    this._documentClickHandler = null;
  }
  if (this._documentKeydownHandler) {
    document.removeEventListener('keydown', this._documentKeydownHandler);
    this._documentKeydownHandler = null;
  }
  // Clean up ResizeObserver
  this.destroyResizeObserver();
  // Clear any pending timers
  if (this.thinkingTimerId) {
    clearInterval(this.thinkingTimerId);
    this.thinkingTimerId = null;
  }
  if (this.streamTextRenderTimerId) {
    clearTimeout(this.streamTextRenderTimerId);
    this.streamTextRenderTimerId = null;
  }
  if (this.streamReasoningRenderTimerId) {
    clearTimeout(this.streamReasoningRenderTimerId);
    this.streamReasoningRenderTimerId = null;
  }
  if (this.contextUsageDebounceTimerId) {
    clearTimeout(this.contextUsageDebounceTimerId);
    this.contextUsageDebounceTimerId = null;
  }
  if (this.historyPersistDebounceTimerId) {
    clearTimeout(this.historyPersistDebounceTimerId);
    this.historyPersistDebounceTimerId = null;
  }
};

(SidePanelUI.prototype as any).finishActiveRun = function finishActiveRun() {
  if (this.pendingSessionId) {
    this.sessionId = this.pendingSessionId;
    this.acceptedSessionIds.add(this.pendingSessionId);
    this.pendingSessionId = null;
  }
  if (this.activeRunId) {
    this.completedRunIds.add(this.activeRunId);
  }
  this.activeRunId = null;
};

(SidePanelUI.prototype as any).handleRuntimeMessage = function handleRuntimeMessage(message: any) {
  const sessionOk =
    !message.sessionId || this.acceptedSessionIds.has(message.sessionId) || message.sessionId === this.sessionId;
  const incomingRunId = typeof message.runId === 'string' && message.runId.trim() ? message.runId.trim() : null;

  let runOk = false;
  if (!incomingRunId) {
    runOk = true;
  } else if (this.completedRunIds.has(incomingRunId)) {
    runOk = false;
  } else if (this.activeRunId === null) {
    runOk = sessionOk;
  } else {
    runOk = incomingRunId === this.activeRunId;
  }

  if (!sessionOk || !runOk) return;

  if (incomingRunId && this.activeRunId === null) {
    this.activeRunId = incomingRunId;
  }
  if (message.type === 'assistant_stream_start') {
    this.streamingReasoning = '';
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

  if (message.type === 'plan_update') {
    this.applyPlanUpdate(message.plan);
    return;
  }

  if (message.type === 'manual_plan_update') {
    this.applyManualPlanUpdate(message.steps);
    return;
  }

  if (message.type === 'tool_execution_start') {
    this.trackExecutionTurnStart?.(message);
    this.pendingToolCount += 1;
    this.clearErrorBanner();
    this.updateActivityState();
    this.activeToolName = message.tool || null;
    this.displayToolExecution(message.tool, message.args, null, message.id, message);
    return;
  }
  if (message.type === 'tool_execution_result') {
    this.trackExecutionToolResult?.(message);
    this.pendingToolCount = Math.max(0, this.pendingToolCount - 1);
    this.updateActivityState();
    this.activeToolName = null;
    this.displayToolExecution(message.tool, message.args, message.result, message.id, message);
    return;
  }

  if (message.type === 'assistant_final') {
    this.displayAssistantMessage(message.content, message.thinking, message.usage, message.model, message);
    this.appendContextMessages(message.responseMessages, message.content, message.thinking);
    if (message.usage?.inputTokens) {
      this.updateContextUsage(message.usage.inputTokens);
    } else if (message.contextUsage?.approxTokens) {
      this.updateContextUsage(message.contextUsage.approxTokens);
    } else {
      this.updateContextUsage();
    }
    this.finishActiveRun?.();
    return;
  }

  if (message.type === 'context_compacted') {
    this.handleContextCompaction(message);
    return;
  }

  if (message.type === 'run_error') {
    this.consumeExecutionTurnSummary?.(message.runId, message.turnId);
    this.stopThinkingTimer?.();
    this.elements.composer?.classList.remove('running');
    this.pendingToolCount = 0;
    this.isStreaming = false;
    this.activeToolName = null;
    this.updateActivityState();
    this.finishStreamingMessage();
    this.showErrorBanner(message.message);
    this.updateStatus('Error', 'error');
    this.finishActiveRun?.();
    return;
  }
  if (message.type === 'run_warning') {
    this.showErrorBanner(message.message);
    return;
  }
  if (message.type === 'run_quality_gate') {
    const state = String(message.state || '');
    const reason = String(message.reason || 'quality_gate');
    if (state === 'blocked') {
      this.showErrorBanner(`Quality gate blocked finalization (${reason}).`);
      this.updateStatus('Quality gate blocked', 'error');
    } else if (state === 'forced_retry') {
      this.updateStatus('Quality gate retrying', 'warning');
    }
    return;
  }
  if (message.type === 'subagent_start') {
    this.addSubagent(message.id, message.name, message.tasks);
    this.updateStatus(`Sub-agent "${message.name}" started`, 'active');
    return;
  }
  if (message.type === 'subagent_complete') {
    this.updateSubagentStatus(message.id, message.success ? 'completed' : 'error');
    return;
  }
  if (message.type === 'vision_context_ready') {
    this.updateStatus('Visual context ready', 'active');
    return;
  }
};

(SidePanelUI.prototype as any).appendContextMessages = function appendContextMessages(
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

(SidePanelUI.prototype as any).handleContextCompaction = function handleContextCompaction(message: any) {
  const normalized = normalizeConversationHistory(message.contextMessages as unknown as Message[]);
  if (message.newSessionId) {
    this.acceptedSessionIds.add(message.newSessionId);
    this.pendingSessionId = message.newSessionId;
  }
  this.abortActiveStreaming?.();
  this.contextHistory = normalized;
  this.displayHistory = normalized;
  this.resetContextUsageTracking?.();
  const trimmed = Number(message.trimmedCount) || 0;
  const preserved = Number(message.preservedCount) || 0;
  this.showSuccessToast?.(`Contexto compactado: ${trimmed} resumidas, ${preserved} preservadas`);

  if (message.contextUsage?.approxTokens) {
    this.applyContextUsageSnapshot?.(message.contextUsage);
  } else {
    this.scheduleContextUsageRecompute?.({ force: true });
  }

  this.renderConversationHistory?.();
};
