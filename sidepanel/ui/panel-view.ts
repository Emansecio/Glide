import { setSidebarOpen, showRightPanel as showRightPanelContent, updateNavActive } from './panel-navigation.js';
import { SidePanelUI } from './panel-ui.js';

(SidePanelUI.prototype as any).switchView = function switchView(view: 'chat' | 'history') {
  this.currentView = view;
  if (!this.elements.chatInterface || !this.elements.historyPanel) return;
  if (view === 'history') {
    this.recordScrollPosition();
    this.elements.chatInterface.classList.add('hidden');
    this.elements.historyPanel.classList.remove('hidden');
    this.elements.viewHistoryBtn?.classList.add('active');
    this.elements.viewChatBtn?.classList.remove('active', 'live-active');
  } else {
    this.elements.chatInterface.classList.remove('hidden');
    this.elements.historyPanel.classList.add('hidden');
    this.elements.viewChatBtn?.classList.add('active', 'live-active');
    this.elements.viewHistoryBtn?.classList.remove('active');
    this.restoreScrollPosition();
  }
};

(SidePanelUI.prototype as any).openSidebar = function openSidebar() {
  setSidebarOpen(this.elements, true);
};

(SidePanelUI.prototype as any).closeSidebar = function closeSidebar() {
  setSidebarOpen(this.elements, false);
};

(SidePanelUI.prototype as any).showRightPanel = function showRightPanel(
  panelName: 'history' | 'settings' | null,
) {
  showRightPanelContent(this.elements, panelName);
};

(SidePanelUI.prototype as any).setNavActive = function setNavActive(
  navName: 'chat' | 'history' | 'settings',
) {
  updateNavActive(this.elements, navName);
};

(SidePanelUI.prototype as any).openChatView = function openChatView() {
  this.settingsOpen = false;
  this.showRightPanel(null);
  this.switchView('chat');
  this.setNavActive('chat');
};

(SidePanelUI.prototype as any).openHistoryPanel = function openHistoryPanel() {
  this.settingsOpen = false;
  this.openSidebar();
  this.showRightPanel('history');
  this.setNavActive('history');
  if (this.historyListDirty) {
    this.loadHistoryList();
  }
};

(SidePanelUI.prototype as any).openSettingsPanel = function openSettingsPanel() {
  this.settingsOpen = true;
  this.openSidebar();
  this.showRightPanel('settings');
  this.switchSettingsTab(this.currentSettingsTab || 'general');
  this.setNavActive('settings');
};

(SidePanelUI.prototype as any).startNewSession = function startNewSession() {
  this.displayHistory = [];
  this.contextHistory = [];
  this.sessionId = `session-${Date.now()}`;
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
};
