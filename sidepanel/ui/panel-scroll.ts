import { SidePanelUI } from './panel-ui.js';

(SidePanelUI.prototype as any).scrollToBottom = function scrollToBottom({ force = false } = {}) {
  if (!this.elements.chatMessages) return;
  if (!force && !this.shouldAutoScroll()) return;
  requestAnimationFrame(() => {
    this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    this.isNearBottom = true;
    this.userScrolledUp = false;
    this.updateScrollButton();
  });
};

(SidePanelUI.prototype as any).shouldAutoScroll = function shouldAutoScroll() {
  const autoScrollEnabled = this.elements.autoScroll?.value !== 'false';
  return autoScrollEnabled && !this.userScrolledUp;
};

(SidePanelUI.prototype as any).handleChatScroll = function handleChatScroll() {
  if (!this.elements.chatMessages) return;
  const { scrollTop, scrollHeight, clientHeight } = this.elements.chatMessages;
  const nearBottom = scrollHeight - scrollTop - clientHeight < 60;
  this.isNearBottom = nearBottom;
  this.userScrolledUp = !nearBottom;
  this.recordScrollPosition();
  this.updateScrollButton();
};

(SidePanelUI.prototype as any).recordScrollPosition = function recordScrollPosition() {
  if (!this.elements.chatMessages) return;
  this.scrollPositions.set(this.sessionId, this.elements.chatMessages.scrollTop);
  // Prune old entries to prevent unbounded growth
  if (this.scrollPositions.size > 50) {
    const keys = Array.from(this.scrollPositions.keys());
    for (let i = 0; i < keys.length - 50; i++) {
      this.scrollPositions.delete(keys[i]);
    }
  }
};

(SidePanelUI.prototype as any).restoreScrollPosition = function restoreScrollPosition() {
  if (!this.elements.chatMessages) return;
  const saved = this.scrollPositions.get(this.sessionId);
  if (saved !== undefined) {
    requestAnimationFrame(() => {
      this.elements.chatMessages.scrollTop = saved;
      this.handleChatScroll();
    });
  } else {
    this.scrollToBottom({ force: true });
  }
};

(SidePanelUI.prototype as any).updateScrollButton = function updateScrollButton() {
  if (!this.elements.scrollToLatestBtn) return;
  this.elements.scrollToLatestBtn.classList.toggle('hidden', !this.userScrolledUp);
};
