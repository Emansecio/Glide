import { createMessage, normalizeConversationHistory } from '../../ai/message-schema.js';
import type { Message } from '../../ai/message-schema.js';
import { isRuntimeMessage } from '../../types/runtime-messages.js';
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

  // Provider change
  this.elements.provider?.addEventListener('change', () => {
    this.toggleCustomEndpoint();
    this.updateScreenshotToggleState();
  });

  // Custom endpoint validation
  this.elements.customEndpoint?.addEventListener('input', () => this.validateCustomEndpoint());

  this.elements.settingsTabGeneralBtn?.addEventListener('click', () => this.switchSettingsTab('general'));

  // View toggles
  this.elements.viewChatBtn?.addEventListener('click', () => this.switchView('chat'));
  this.elements.viewHistoryBtn?.addEventListener('click', () => this.switchView('history'));

  // Screenshot controls
  this.elements.enableScreenshots?.addEventListener('change', () => this.updateScreenshotToggleState());
  this.elements.sendScreenshotsAsImages?.addEventListener('change', () => this.updateScreenshotToggleState());

  // Save settings
  this.elements.saveSettingsBtn?.addEventListener('click', () => {
    void this.saveSettings();
  });

  // Cancel settings
  this.elements.cancelSettingsBtn?.addEventListener('click', () => {
    void this.cancelSettings();
  });

  this.elements.exportSettingsBtn?.addEventListener('click', () => this.exportSettings());
  this.elements.importSettingsBtn?.addEventListener('click', () => {
    this.elements.importSettingsInput?.click();
  });
  this.elements.importSettingsInput?.addEventListener('change', (event) => this.importSettings(event));

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
  userInput?.addEventListener('input', function () {
    userInput.style.height = 'auto';
    userInput.style.height = `${userInput.scrollHeight}px`;
  });

  // Model selector
  this.elements.modelSelect?.addEventListener('change', () => this.handleModelSelectChange());
  this.elements.modelSelectTrigger?.addEventListener('click', (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    this.toggleModelMenu();
  });
  this.elements.modelSelectTrigger?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      this.toggleModelMenu('selected');
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (this.isModelMenuOpen?.()) {
        this.moveModelMenuFocus(1);
      } else {
        this.toggleModelMenu('first');
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (this.isModelMenuOpen?.()) {
        this.moveModelMenuFocus(-1);
      } else {
        this.toggleModelMenu('last');
      }
      return;
    }
    if (event.key === 'Escape' && this.isModelMenuOpen?.()) {
      event.preventDefault();
      this.closeModelMenu({ focusTrigger: true });
    }
  });
  this.elements.modelSelectMenu?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeModelMenu({ focusTrigger: true });
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveModelMenuFocus(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveModelMenuFocus(-1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      const target = event.target as HTMLElement | null;
      const option = target?.closest('.model-option') as HTMLElement | null;
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      this.selectModelOptionByElement(option);
    }
  });
  document.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement | null;
    const withinSelector = target?.closest('.model-picker');
    if (!withinSelector) {
      this.closeModelMenu();
    }
  });
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.closeModelMenu();
    }
  });

  // File upload
  this.elements.fileBtn?.addEventListener('click', () => {
    this.elements.fileInput?.click();
  });
  this.elements.fileInput?.addEventListener('change', (event) => this.handleFileSelection(event));

  // Tab selector
  this.elements.tabSelectorBtn?.addEventListener('click', () => this.toggleTabSelector());
  this.elements.closeTabSelector?.addEventListener('click', () => this.closeTabSelector());
  this.elements.tabSelectorAddActive?.addEventListener('click', () => this.addActiveTabToSelection());
  this.elements.tabSelectorClear?.addEventListener('click', () => this.clearSelectedTabs());
  const tabBackdrop = this.elements.tabSelector?.querySelector('.modal-backdrop');
  tabBackdrop?.addEventListener('click', () => this.closeTabSelector());

  this.elements.chatMessages?.addEventListener('scroll', () => this.handleChatScroll());
  this.elements.scrollToLatestBtn?.addEventListener('click', () => this.scrollToBottom({ force: true }));

  this.elements.activityToggleBtn?.addEventListener('click', () => this.toggleActivityPanel());
  this.elements.activityCloseBtn?.addEventListener('click', () => this.toggleActivityPanel(false));
  this.elements.exportExecutionLogBtn?.addEventListener('click', () => {
    void this.exportExecutionLog?.();
  });

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message) => {
    if (isRuntimeMessage(message)) {
      this.handleRuntimeMessage(message);
    }
  });
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

(SidePanelUI.prototype as any).handleRuntimeMessage = function handleRuntimeMessage(message: any) {
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
  this.contextHistory = normalized;
  this.invalidateContextUsageCache?.();
  this.sessionId = message.newSessionId || this.sessionId;

  const summaryText = message.summary || 'Context compacted.';
  const summaryEntry = createMessage({
    role: 'system',
    content: summaryText,
    meta: {
      kind: 'summary',
      summaryOfCount: message.trimmedCount,
      source: 'auto',
    },
  });
  if (summaryEntry) {
    this.displayHistory.push(summaryEntry);
    this.displaySummaryMessage(summaryEntry);
  }

  if (message.contextUsage?.approxTokens) {
    this.updateContextUsage(message.contextUsage.approxTokens);
  }
};
