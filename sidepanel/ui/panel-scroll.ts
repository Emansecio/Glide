import { SidePanelUI } from './panel-ui.js';

/** Constante de tempo do acompanhamento: ~63% da distância a cada 55 ms. */
const FOLLOW_TIME_CONSTANT_MS = 55;

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Mantém a conversa colada no fim. Conteúdo que cresce durante o run (texto em
 * streaming, passos de ferramenta) é acompanhado com desaceleração, em vez de a
 * lista saltar uma linha inteira a cada flush. `force` e `instant` pulam direto:
 * valem para ação do usuário e para quando o layout muda ACIMA do que se lê —
 * ali um deslize mostraria o texto descendo e voltando.
 */
SidePanelUI.prototype.scrollToBottom = function scrollToBottom({ force = false, instant = force } = {}) {
  if (!this.elements.chatMessages) return;
  if (!force && !this.shouldAutoScroll()) return;
  if (instant) this._scrollInstant = true;
  // Um frame, um scroll: vários flushes no mesmo frame reaproveitam o rAF em
  // voo, que relê o alvo a cada passo.
  if (this._scrollRafId) return;
  this._scrollFollowTop = -1;
  let lastFrameAt = 0;
  const step = (now: number) => {
    this._scrollRafId = 0;
    const list = this.elements.chatMessages;
    if (!list) return;
    const instantNow = this._scrollInstant || document.hidden || prefersReducedMotion();
    // O usuário rolou para cima no meio do acompanhamento: a decisão é dele.
    if (this.userScrolledUp && !this._scrollInstant) return;
    const target = list.scrollHeight - list.clientHeight;
    const gap = target - list.scrollTop;
    if (gap > 1 && !instantNow) {
      const dt = lastFrameAt ? Math.min(64, now - lastFrameAt) : 16;
      lastFrameAt = now;
      list.scrollTop += Math.max(1, gap * (1 - Math.exp(-dt / FOLLOW_TIME_CONSTANT_MS)));
      this._scrollFollowTop = list.scrollTop;
      this._scrollRafId = requestAnimationFrame(step);
      return;
    }
    // Só escreve se mudou: reatribuir scrollTop idêntico ainda dispara o evento
    // de scroll, que reentra em handleChatScroll e relê o layout.
    if (Math.abs(gap) > 1) list.scrollTop = target;
    this._scrollInstant = false;
    this.isNearBottom = true;
    this.userScrolledUp = false;
    this.updateScrollButton();
  };
  this._scrollRafId = requestAnimationFrame(step);
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
  // Evento causado pelo nosso próprio acompanhamento: a distância até o fim
  // pode passar do limiar no meio do deslize sem o usuário ter feito nada. Só
  // conta como decisão dele se a posição voltou para CIMA do que escrevemos.
  if (this._scrollRafId && scrollTop >= (this._scrollFollowTop ?? 0) - 1) return;
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
