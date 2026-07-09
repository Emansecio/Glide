import type { Message } from '../../ai/message-schema.js';
import type { RunPlan } from '../../types/plan.js';
import type { ModalController } from './modal-controller.js';
import { getSidePanelElements } from './panel-elements.js';
import { setSidebarOpen, showRightPanel, updateNavActive } from './panel-navigation-helpers.js';
import type { UsageStats } from './panel-types.js';

export class SidePanelUI {
  elements: Record<string, any>;
  displayHistory: Message[];
  contextHistory: Message[];
  sessionId: string;
  activeRunId: string | null;
  completedRunIds: Set<string>;
  acceptedSessionIds: Set<string>;
  pendingSessionId: string | null;
  sessionStartedAt: number;
  firstUserMessage: string;
  currentConfig: string;
  configs: Record<string, any>;
  toolCallViews: Map<string, any>;
  lastChatTurn: HTMLElement | null;
  selectedTabs: Map<number, any>;
  tabGroupInfo: Map<number, chrome.tabGroups.TabGroup>;
  scrollPositions: Map<string, number>;
  pendingToolCount: number;
  isStreaming: boolean;
  thinkingStartedAt: number | null;
  thinkingTimerId: number | null;
  streamTextRenderTimerId: number | null;
  streamReasoningRenderTimerId: number | null;
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
  sessionTokensUsed: number;
  lastUsage: UsageStats | null;
  sessionTokenTotals: UsageStats;
  historyPersistDebounceTimerId: number | null;
  historyListDirty: boolean;
  currentView: 'chat' | 'history';
  currentSettingsTab: 'general';
  settingsOpen: boolean;
  modelsFetchController: AbortController | null;
  modelsFetchSeq: number;
  subagents: Map<string, { name: string; status: string; messages: any[]; tasks?: string[] }>;
  activeAgent: string;
  activityPanelOpen: boolean;
  latestThinking: string | null;
  activeToolName: string | null;
  streamingReasoning: string;
  currentPlan: RunPlan | null;
  executionTurnSummaries: Map<string, unknown>;
  activeExecutionTurnKey: string | null;
  // Document-level event handlers for cleanup
  _documentClickHandler: ((event: Event) => void) | null;
  _documentKeydownHandler: ((event: KeyboardEvent) => void) | null;
  tabSelectorController: ModalController | null;
  oauthHelpModalController: ModalController | null;

  // Methods attached via prototype in panel-modules
  declare init: () => Promise<void>;
  declare recordScrollPosition: () => void;
  declare restoreScrollPosition: () => void;
  declare loadHistoryList: () => void | Promise<void>;
  declare switchSettingsTab: (tab: string) => void;
  declare abortActiveStreaming: () => void;
  declare invalidateContextUsageCache: () => void;
  declare hidePlanDrawer: () => void;
  declare stopThinkingTimer: () => void;
  declare updateChatEmptyState: () => void;
  declare resetActivityPanel: () => void;
  declare hideAgentNav: () => void;
  declare updateStatus: (message: string, tone?: string) => void;
  declare scheduleContextUsageRecompute: (options?: { force?: boolean }) => void;
  declare scrollToBottom: (options?: { force?: boolean }) => void;

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
    this.switchSettingsTab(this.currentSettingsTab || 'general');
    updateNavActive(this.elements, 'settings');
  }

  startNewSession() {
    this.abortActiveStreaming?.();
    this.displayHistory = [];
    this.contextHistory = [];
    this.sessionId = `session-${Date.now()}`;
    this.activeRunId = null;
    this.completedRunIds = new Set();
    this.acceptedSessionIds = new Set([this.sessionId]);
    this.pendingSessionId = null;
    this.sessionStartedAt = Date.now();
    this.firstUserMessage = '';
    this.sessionTokensUsed = 0;
    this.lastUsage = null;
    this.sessionTokenTotals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    this.currentPlan = null;
    this.executionTurnSummaries = new Map();
    this.activeExecutionTurnKey = null;
    this.invalidateContextUsageCache?.();
    this.hidePlanDrawer();
    this.stopThinkingTimer?.();
    this.subagents.clear();
    this.activeAgent = 'main';
    this.elements.chatMessages.innerHTML = '';
    this.toolCallViews.clear();
    this.updateChatEmptyState?.();
    this.resetActivityPanel();
    this.hideAgentNav();
    this.updateStatus('Ready for a new session', 'success');
    this.switchView('chat');
    this.scheduleContextUsageRecompute?.({ force: true });
    this.scrollToBottom({ force: true });
    setSidebarOpen(this.elements, false);
  }

  constructor() {
    this.elements = getSidePanelElements();

    this.displayHistory = [];
    this.contextHistory = [];
    this.sessionId = `session-${Date.now()}`;
    this.activeRunId = null;
    this.completedRunIds = new Set();
    this.acceptedSessionIds = new Set([this.sessionId]);
    this.pendingSessionId = null;
    this.sessionStartedAt = Date.now();
    this.firstUserMessage = '';
    this.currentConfig = 'default';
    this.configs = { default: {} };
    this.toolCallViews = new Map();
    this.lastChatTurn = null;
    this.selectedTabs = new Map();
    this.tabGroupInfo = new Map();
    this.scrollPositions = new Map();
    this.pendingToolCount = 0;
    this.isStreaming = false;
    this.thinkingStartedAt = null;
    this.thinkingTimerId = null;
    this.streamTextRenderTimerId = null;
    this.streamReasoningRenderTimerId = null;
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
    this.sessionTokensUsed = 0;
    this.lastUsage = null;
    this.sessionTokenTotals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    this.historyPersistDebounceTimerId = null;
    this.historyListDirty = false;
    this.currentView = 'chat';
    this.currentSettingsTab = 'general';
    this.settingsOpen = false;
    this.modelsFetchController = null;
    this.modelsFetchSeq = 0;
    this.subagents = new Map();
    this.activeAgent = 'main';
    this.activityPanelOpen = false;
    this.latestThinking = null;
    this.activeToolName = null;
    this.streamingReasoning = '';
    this.currentPlan = null;
    this.executionTurnSummaries = new Map();
    this.activeExecutionTurnKey = null;
    this._documentClickHandler = null;
    this._documentKeydownHandler = null;
    this.tabSelectorController = null;
    this.oauthHelpModalController = null;
    void this.init();
  }
}
