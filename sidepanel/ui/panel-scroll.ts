import { SidePanelUI } from './panel-ui.js';

SidePanelUI.prototype.scrollToBottom = function scrollToBottom({ force = false } = {}) {
  if (!this.elements.chatMessages) return;
  if (!force && !this.shouldAutoScroll()) return;
  // Um frame, um scroll. Sem esta trava, cada flush de texto (20×/s) e cada
  // passo de ferramenta enfileiravam o próprio rAF; vários deles caem no mesmo
  // frame e cada um lê `scrollHeight` — leituras de layout repetidas para
  // chegar exatamente à mesma posição.
  if (this._scrollRafId) return;
  this._scrollRafId = requestAnimationFrame(() => {
    this._scrollRafId = 0;
    const list = this.elements.chatMessages;
    if (!list) return;
    const target = list.scrollHeight;
    // Só escreve se mudou: reatribuir scrollTop idêntico ainda dispara o evento
    // de scroll, que reentra em handleChatScroll e relê o layout.
    if (Math.abs(list.scrollTop - target) > 1) {
      list.scrollTop = target;
    }
    this.isNearBottom = true;
    this.userScrolledUp = false;
    this.updateScrollButton();
  });
};

SidePanelUI.prototype.shouldAutoScroll = function shouldAutoScroll() {
  const autoScrollEnabled = this.elements.autoScroll?.value !== 'false';
  return autoScrollEnabled && !this.userScrolledUp;
};

/** Agrupa a sincronia de scroll num único frame (ver o listener em panel-core). */
SidePanelUI.prototype.queueChatScrollSync = function queueChatScrollSync() {
  if (this._scrollSyncRafId) return;
  this._scrollSyncRafId = requestAnimationFrame(() => {
    this._scrollSyncRafId = 0;
    this.handleChatScroll();
  });
};

SidePanelUI.prototype.handleChatScroll = function handleChatScroll() {
  if (!this.elements.chatMessages) return;
  const { scrollTop, scrollHeight, clientHeight } = this.elements.chatMessages;
  const nearBottom = scrollHeight - scrollTop - clientHeight < 60;
  this.isNearBottom = nearBottom;
  this.userScrolledUp = !nearBottom;
  this.recordScrollPosition();
  this.updateScrollButton();
};

SidePanelUI.prototype.recordScrollPosition = function recordScrollPosition() {
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

SidePanelUI.prototype.restoreScrollPosition = function restoreScrollPosition() {
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

SidePanelUI.prototype.updateScrollButton = function updateScrollButton() {
  if (!this.elements.scrollToLatestBtn) return;
  const shouldHide = !this.userScrolledUp;
  // classList.toggle escreve mesmo quando o estado não muda; este método é
  // chamado em todo evento de scroll.
  if (this.elements.scrollToLatestBtn.classList.contains('hidden') === shouldHide) return;
  this.elements.scrollToLatestBtn.classList.toggle('hidden', shouldHide);
};
