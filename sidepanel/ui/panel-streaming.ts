import type { RunPlan } from '../../types/plan.js';
import { shouldWriteThinkingTimerLabel } from './history-storage.js';
import {
  cancelMarkdownIdleWork,
  scheduleMarkdownIdleWork,
  shouldDeferMarkdownRender,
} from './markdown-render-defer.js';
import { SidePanelUI } from './panel-ui.js';

const STREAM_TEXT_RENDER_INTERVAL_MS = 50;
const STREAM_REASONING_RENDER_INTERVAL_MS = 100;

const formatElapsed = (elapsedMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minuteLabel = minutes.toString().padStart(1, '0');
  const secondLabel = seconds.toString().padStart(2, '0');
  return `${minuteLabel}:${secondLabel}`;
};

SidePanelUI.prototype.cancelPendingMarkdownRender = function cancelPendingMarkdownRender() {
  cancelMarkdownIdleWork(this.pendingMarkdownIdleHandle);
  this.pendingMarkdownIdleHandle = null;
  const pending = this.pendingMarkdownRender;
  if (pending) {
    if (pending.el.dataset.mdRenderToken === String(pending.token)) {
      delete pending.el.dataset.mdRenderToken;
    }
    this.pendingMarkdownRender = null;
  }
  this.markdownRenderToken += 1;
};

SidePanelUI.prototype.hasPendingMarkdownRender = function hasPendingMarkdownRender(el: HTMLElement) {
  return this.pendingMarkdownRender?.el === el;
};

SidePanelUI.prototype.scheduleDeferredMarkdownRender = function scheduleDeferredMarkdownRender(
  el: HTMLElement,
  buffer: string,
) {
  this.cancelPendingMarkdownRender();
  const token = this.markdownRenderToken;
  el.dataset.mdRenderToken = String(token);
  this.pendingMarkdownRender = { el, token, buffer };

  const run = () => {
    this.pendingMarkdownIdleHandle = null;
    const pending = this.pendingMarkdownRender;
    if (!pending || pending.token !== token) return;
    if (!pending.el.isConnected || pending.el.dataset.mdRenderToken !== String(token)) {
      this.pendingMarkdownRender = null;
      return;
    }
    const stickBottom = this.shouldAutoScroll() && this.isNearBottom;
    pending.el.innerHTML = this.renderMarkdown(pending.buffer);
    delete pending.el.dataset.mdRenderToken;
    this.pendingMarkdownRender = null;
    if (stickBottom) {
      this.scrollToBottom();
    }
  };

  this.pendingMarkdownIdleHandle = scheduleMarkdownIdleWork(run);
};

SidePanelUI.prototype.handleAssistantStream = function handleAssistantStream(event: any) {
  if (event.status === 'start') {
    this.isStreaming = true;
    this.clearErrorBanner();
    this.startStreamingMessage();
    this.startThinkingTimer();
    this.updateActivityState();
  } else if (event.status === 'delta') {
    this.isStreaming = true;
    this.updateStreamingMessage(event.content || '');
    // Skip per-delta activity/meta refresh — statusMeta + clientWidth force layout.
    // Text flush + stop already keep the UI honest.
  } else if (event.status === 'stop') {
    this.isStreaming = false;
    this.completeStreamingMessage();
    this.stopThinkingTimer();
    this.updateActivityState();
  }
};

SidePanelUI.prototype.clearStreamingRenderTimers = function clearStreamingRenderTimers() {
  if (this.streamTextRenderTimerId) {
    window.clearTimeout(this.streamTextRenderTimerId);
    this.streamTextRenderTimerId = null;
  }
  if (this.streamReasoningRenderTimerId) {
    window.clearTimeout(this.streamReasoningRenderTimerId);
    this.streamReasoningRenderTimerId = null;
  }
};

SidePanelUI.prototype.scheduleStreamingTextRender = function scheduleStreamingTextRender() {
  if (this.streamTextRenderTimerId) return;
  this.streamTextRenderTimerId = window.setTimeout(() => {
    this.streamTextRenderTimerId = null;
    this.flushStreamingTextRender();
  }, STREAM_TEXT_RENDER_INTERVAL_MS);
};

SidePanelUI.prototype.flushStreamingTextRender = function flushStreamingTextRender() {
  if (!this.streamingState?.textEventEl) return;
  const pending = this.streamingState.textPendingBuffer || '';
  if (!pending) return;
  // Anexa só o delta a um Text node dedicado: ler + reatribuir textContent
  // reprocessa a string acumulada inteira a cada flush (O(n²) na resposta).
  let node = this.streamingState.textNode;
  if (!node || node.parentNode !== this.streamingState.textEventEl) {
    node = document.createTextNode('');
    this.streamingState.textEventEl.appendChild(node);
    this.streamingState.textNode = node;
  }
  node.appendData(pending);
  this.streamingState.textPendingBuffer = '';
  if (this.shouldAutoScroll() && this.isNearBottom) {
    this.scrollToBottom();
  }
};

SidePanelUI.prototype.scheduleStreamingReasoningRender = function scheduleStreamingReasoningRender() {
  if (this.streamReasoningRenderTimerId) return;
  this.streamReasoningRenderTimerId = window.setTimeout(() => {
    this.streamReasoningRenderTimerId = null;
    this.flushStreamingReasoningRender();
  }, STREAM_REASONING_RENDER_INTERVAL_MS);
};

SidePanelUI.prototype.flushStreamingReasoningRender = function flushStreamingReasoningRender() {
  if (!this.streamingState?.reasoningEventEl) return;
  const raw = this.streamingState.reasoningRawBuffer || '';
  if (!raw.trim()) return;
  const flushed = this.streamingState.reasoningFlushedLength || 0;
  const delta = raw.slice(flushed);
  if (!delta) return;

  this.streamingState.reasoningBuffer = raw;
  // Mesmo racional do texto: appendData do delta em vez de reatribuir o buffer
  // completo a cada flush (aqui em DOIS elementos — evento e thinkingPanel).
  let node = this.streamingState.reasoningTextNode;
  if (!node || node.parentNode !== this.streamingState.reasoningEventEl) {
    this.streamingState.reasoningEventEl.textContent = '';
    node = document.createTextNode(raw);
    this.streamingState.reasoningEventEl.appendChild(node);
    this.streamingState.reasoningTextNode = node;
  } else {
    node.appendData(delta);
  }

  const panel = this.elements.thinkingPanel as HTMLElement | null;
  if (panel) {
    this.latestThinking = raw;
    let panelNode = this.streamingState.thinkingPanelTextNode;
    if (!panelNode || panelNode.parentNode !== panel) {
      panel.textContent = '';
      panelNode = document.createTextNode(raw);
      panel.appendChild(panelNode);
      this.streamingState.thinkingPanelTextNode = panelNode;
    } else {
      panelNode.appendData(delta);
    }
    panel.classList.remove('empty');
    panel.classList.add('streaming');
  }
  this.streamingState.reasoningFlushedLength = raw.length;
  if (this.shouldAutoScroll() && this.isNearBottom) {
    this.scrollToBottom();
  }
};

SidePanelUI.prototype.startThinkingTimer = function startThinkingTimer() {
  if (this.thinkingTimerId) {
    window.clearInterval(this.thinkingTimerId);
  }
  this.thinkingStartedAt = Date.now();
  let lastActivitySnapshot = `${this.pendingToolCount}|${this.isStreaming ? 1 : 0}`;
  const statusDot = this.elements.statusDot || document.getElementById('statusDot');
  if (statusDot && !statusDot.classList.contains('active')) {
    statusDot.className = 'status-dot active';
  }
  const updateTimer = () => {
    const elapsed = formatElapsed(Date.now() - (this.thinkingStartedAt || Date.now()));
    if (shouldWriteThinkingTimerLabel(this._retryStatusActive)) {
      const label = `Pensando ${elapsed}`;
      if (this.elements.statusText && this.elements.statusText.textContent !== label) {
        this.elements.statusText.textContent = label;
      }
    }
    const snapshot = `${this.pendingToolCount}|${this.isStreaming ? 1 : 0}`;
    if (snapshot !== lastActivitySnapshot) {
      lastActivitySnapshot = snapshot;
      this.updateActivityState();
    }
  };
  updateTimer();
  this.thinkingTimerId = window.setInterval(updateTimer, 1000);
};

SidePanelUI.prototype.stopThinkingTimer = function stopThinkingTimer() {
  if (this.thinkingTimerId) {
    window.clearInterval(this.thinkingTimerId);
    this.thinkingTimerId = null;
  }
  this.thinkingStartedAt = null;
  this.clearStreamingRenderTimers();
};

SidePanelUI.prototype.startStreamingMessage = function startStreamingMessage() {
  if (this.streamingState) return;
  this.clearStreamingRenderTimers();
  const container = document.createElement('div');
  container.className = 'message assistant streaming';
  container.innerHTML = `
      <div class="message-content streaming-content markdown-body">
        <div class="typing-indicator"><span></span><span></span><span></span></div>
        <div class="execution-human-summary hidden"></div>
        <details class="execution-details working hidden">
          <summary class="execution-details-summary">
            <svg class="execution-details-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
            <span class="execution-details-title shimmer">Trabalhando…</span>
            <span class="execution-details-meta"></span>
          </summary>
          <div class="stream-events"></div>
        </details>
        <div class="stream-main-text stream-event-text"></div>
      </div>
    `;

  this.elements.chatMessages.appendChild(container);
  const executionDetailsEl = container.querySelector('.execution-details') as HTMLDetailsElement | null;
  const executionSummaryTitleEl = container.querySelector('.execution-details-title') as HTMLElement | null;
  const executionSummaryMetaEl = container.querySelector('.execution-details-meta') as HTMLElement | null;
  this.streamingState = {
    container,
    eventsEl: container.querySelector('.stream-events') as HTMLElement | null,
    lastEventType: undefined,
    textEventEl: container.querySelector('.stream-main-text') as HTMLElement | null,
    reasoningEventEl: null,
    textBuffer: '',
    textPendingBuffer: '',
    _lastMdPos: 0,
    reasoningBuffer: '',
    reasoningRawBuffer: '',
    planEl: null,
    planListEl: null,
    planMetaEl: null,
    executionDetailsEl,
    executionSummaryTitleEl,
    executionSummaryMetaEl,
    executionHumanSummaryEl: container.querySelector('.execution-human-summary') as HTMLElement | null,
    executionTurnKey: null,
  };
  this.updateExecutionDetailsHeader?.();
  this.updateThinkingPanel(null, true);
  this.scrollToBottom();
};

SidePanelUI.prototype.updateStreamingMessage = function updateStreamingMessage(content: string) {
  // Delta atrasado (depois do stop, antes do assistant_final) não pode reviver
  // a bolha já finalizada — o conteúdo completo chega no assistant_final.
  if (this.streamingState?.completed) return;
  if (!this.streamingState) {
    this.startStreamingMessage();
  }
  if (!this.streamingState?.textEventEl) return;

  this.streamingState.textBuffer = `${this.streamingState.textBuffer || ''}${content || ''}`;
  this.streamingState.textPendingBuffer = `${this.streamingState.textPendingBuffer || ''}${content || ''}`;
  this.streamingState.accumulated = true;
  this.scheduleStreamingTextRender();
};

SidePanelUI.prototype.completeStreamingMessage = function completeStreamingMessage() {
  if (!this.streamingState?.container) return;

  this.flushStreamingTextRender();
  this.flushStreamingReasoningRender();
  this.clearStreamingRenderTimers();
  this.streamingState.completed = true;

  const indicator = this.streamingState.container.querySelector('.typing-indicator');
  if (indicator) indicator.remove();
  this.streamingState.container.classList.remove('streaming');
  if (this.streamingState.textEventEl) {
    const buf = this.streamingState.textBuffer || '';
    const offset = this.streamingState._lastMdPos || 0;
    if (offset < buf.length) {
      const el = this.streamingState.textEventEl;
      if (shouldDeferMarkdownRender(buf.length)) {
        this.scheduleDeferredMarkdownRender(el, buf);
      } else {
        el.innerHTML = this.renderMarkdown(buf);
      }
      this.streamingState._lastMdPos = buf.length;
    }
  }

  const finalReasoning = this.streamingState.reasoningBuffer || '';
  if (finalReasoning) {
    this.updateThinkingPanel(finalReasoning, false);
  } else {
    this.updateThinkingPanel(null, false);
  }
};

SidePanelUI.prototype.updateStreamReasoning = function updateStreamReasoning(delta: string | null) {
  if (this.streamingState?.completed) return;
  if (!this.streamingState?.eventsEl) return;
  if (delta === null || delta === undefined) return;
  if (!delta.trim() && !this.streamingState.reasoningRawBuffer) return;
  this.ensureStreamingExecutionDetailsVisible?.();

  if (this.streamingState.lastEventType !== 'reasoning') {
    const reasoningEvent = document.createElement('div');
    reasoningEvent.className = 'stream-event stream-event-reasoning';
    reasoningEvent.innerHTML = `
        <div class="stream-reasoning-label">Raciocínio</div>
        <div class="stream-reasoning-content"></div>
      `;
    this.streamingState.eventsEl.appendChild(reasoningEvent);
    this.streamingState.reasoningEventEl = reasoningEvent.querySelector(
      '.stream-reasoning-content',
    ) as HTMLElement | null;
    this.streamingState.reasoningBuffer = '';
    this.streamingState.reasoningRawBuffer = '';
    this.streamingState.reasoningTextNode = null;
    this.streamingState.reasoningFlushedLength = 0;
    this.streamingState.lastEventType = 'reasoning';
  }

  this.streamingState.reasoningRawBuffer = `${this.streamingState.reasoningRawBuffer || ''}${delta}`;
  this.scheduleStreamingReasoningRender();
};

SidePanelUI.prototype.applyPlanUpdate = function applyPlanUpdate(plan: RunPlan) {
  if (!plan) return;
  this.currentPlan = plan;
  this.renderPlanDrawer(plan);
};

SidePanelUI.prototype.ensurePlanBlock = function ensurePlanBlock() {
  if (!this.streamingState?.eventsEl) return null;
  if (this.streamingState.planEl) return this.streamingState.planEl;

  const container = document.createElement('div');
  container.className = 'plan-block';
  container.innerHTML = `
      <div class="plan-header">
        <span class="plan-title">Plano</span>
        <span class="plan-meta"></span>
      </div>
      <ol class="plan-steps"></ol>
    `;

  const firstChild = this.streamingState.eventsEl.firstChild;
  if (firstChild) {
    this.streamingState.eventsEl.insertBefore(container, firstChild);
  } else {
    this.streamingState.eventsEl.appendChild(container);
  }

  this.streamingState.planEl = container;
  this.streamingState.planListEl = container.querySelector('.plan-steps') as HTMLOListElement | null;
  this.streamingState.planMetaEl = container.querySelector('.plan-meta') as HTMLElement | null;
  return container;
};

// Discards any in-flight streaming state without persisting it. Used when the
// user switches sessions mid-stream, so the old run cannot write into the new
// session's DOM/history and the next stream is not blocked by a stale state.
SidePanelUI.prototype.abortActiveStreaming = function abortActiveStreaming() {
  this.cancelPendingMarkdownRender();
  this.clearRunTransientNotices?.();
  if (!this.streamingState && !this.isStreaming) return;
  this.clearStreamingRenderTimers();
  this.stopThinkingTimer?.();
  this.streamingState = null;
  this.isStreaming = false;
  this.pendingToolCount = 0;
  this.activeToolName = null;
  // setComposerBusy é o ponto único: além da classe `running`, ele destrava o botão
  // de envio e esconde o de parar (que ficariam dessincronizados aqui).
  this.setComposerBusy?.(false);
  this.stopRunLiveness?.();
  this.updateActivityState?.();
};

SidePanelUI.prototype.finishStreamingMessage = function finishStreamingMessage() {
  if (!this.streamingState) return null;
  const streamingThinking = this.streamingReasoning;
  const container = this.streamingState.container;

  this.completeStreamingMessage();
  // completeStreamingMessage may defer markdown; renderedContent is always plain text.
  const renderedContent = this.streamingState?.textBuffer || '';
  this.clearStreamingRenderTimers();
  this.streamingState = null;
  this.isStreaming = false;
  this.updateActivityState();

  return { thinking: streamingThinking, container, renderedContent };
};
