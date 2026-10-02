import { createMessage } from '../../ai/message-schema.js';
import type { RunPlan } from '../../types/plan.js';
import { shouldWriteThinkingTimerLabel } from './history-storage.js';
import {
  cancelMarkdownIdleWork,
  digestMarkdownSource,
  findMarkdownCommitBoundary,
  findStreamingTable,
  scheduleMarkdownIdleWork,
  shouldDeferMarkdownRender,
} from './markdown-render-defer.js';
import { SidePanelUI } from './panel-ui.js';

const STREAM_TEXT_RENDER_INTERVAL_MS = 50;
const STREAM_REASONING_RENDER_INTERVAL_MS = 100;
/** Duração do fade de `.stream-chunk` (motion.css); depois disso o trecho vira texto comum. */
const STREAM_CHUNK_FADE_MS = 320;

type StreamingState = NonNullable<SidePanelUI['streamingState']>;

/**
 * Renderiza como markdown o trecho ainda cru do buffer até `end` e deixa o
 * restante como cauda em texto puro.
 */
const commitStreamMarkdown = (ui: SidePanelUI, state: StreamingState, end: number) => {
  const host = state.textEventEl;
  if (!host) return;
  const buffer = state.textBuffer || '';
  let committedEl = state.mdCommittedEl;
  if (!committedEl || committedEl.parentNode !== host) {
    committedEl = document.createElement('div');
    committedEl.className = 'stream-md-committed';
    host.prepend(committedEl);
    state.mdCommittedEl = committedEl;
  }
  committedEl.insertAdjacentHTML('beforeend', ui.renderMarkdown(buffer.slice(state.mdCommittedPos || 0, end)));
  state.mdCommittedPos = end;
  state.textTailEl?.replaceChildren(document.createTextNode(buffer.slice(end)));
  state.mdLiveEl?.remove();
  state.mdLiveEl = null;
  state.mdTailHeld = false;
};

/**
 * Tabela ainda chegando: mostra as linhas completas já como tabela. Só as linhas
 * novas entram no DOM, então o fade (motion.css) toca em cada uma uma única vez.
 */
const renderStreamingTable = (ui: SidePanelUI, state: StreamingState, source: string, lines: number) => {
  const tail = state.textTailEl;
  if (!tail || (state.mdLiveEl && state.mdLiveLines === lines)) return;
  let live = state.mdLiveEl;
  if (!live) {
    live = document.createElement('div');
    live.className = 'stream-md-live';
    tail.before(live);
    state.mdLiveEl = live;
  }
  state.mdLiveLines = lines;
  const next = document.createElement('template');
  next.innerHTML = ui.renderMarkdown(source);
  const table = live.querySelector('table');
  const nextBody = next.content.querySelector('tbody');
  if (!table || !nextBody) {
    live.replaceChildren(next.content);
    return;
  }
  const body = table.querySelector('tbody');
  if (!body) table.appendChild(nextBody);
  else body.append(...Array.from(nextBody.children).slice(body.children.length));
};

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
  this.pendingMarkdownRender = {
    el,
    token,
    buffer,
    sourceDigest: digestMarkdownSource(buffer),
  };

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
    pending.onRendered?.();
    if (stickBottom) {
      this.scrollToBottom();
    }
  };

  this.pendingMarkdownIdleHandle = scheduleMarkdownIdleWork(run);
};

SidePanelUI.prototype.reconcileTerminalMarkdownRender = function reconcileTerminalMarkdownRender(
  el: HTMLElement,
  finalContent: string,
  onRendered?: () => void,
) {
  const pending = this.pendingMarkdownRender;
  const finalDigest = digestMarkdownSource(finalContent);
  if (pending?.el === el && pending.sourceDigest === finalDigest) {
    pending.onRendered = onRendered;
    return;
  }

  this.cancelPendingMarkdownRender();
  if (shouldDeferMarkdownRender(finalContent.length)) {
    this.scheduleDeferredMarkdownRender(el, finalContent);
    if (this.pendingMarkdownRender) this.pendingMarkdownRender.onRendered = onRendered;
    return;
  }
  if (!el.isConnected) return;
  el.innerHTML = this.renderMarkdown(finalContent);
  onRendered?.();
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
  const state = this.streamingState;
  if (!state?.textEventEl) return;
  const pending = state.textPendingBuffer || '';
  if (!pending) return;
  // A cauda em aberto é um nó de texto seguido dos trechos recém-chegados, cada
  // um num span que entra em fade. Só o delta é anexado: reatribuir textContent
  // reprocessa a string acumulada inteira a cada flush (O(n²) na resposta).
  let tail = state.textTailEl;
  if (!tail || tail.parentNode !== state.textEventEl) {
    tail = document.createElement('span');
    tail.className = 'stream-tail';
    tail.appendChild(document.createTextNode(''));
    state.textEventEl.appendChild(tail);
    state.textTailEl = tail;
  }
  // Blocos já fechados (parágrafo, lista, tabela, bloco de código) viram markdown
  // uma única vez; só a cauda em aberto continua como texto cru. O render final
  // do turno ainda reprocessa tudo, então divisões entre blocos se acertam no fim.
  const committed = state.mdCommittedPos || 0;
  const boundary = findMarkdownCommitBoundary(state.textBuffer || '', committed);
  const committedNow = boundary > committed;
  if (committedNow) commitStreamMarkdown(this, state, boundary);
  const open = (state.textBuffer || '').slice(state.mdCommittedPos || 0);
  const table = findStreamingTable(open);
  if (table) {
    // Sintaxe de tabela não aparece crua: a cauda fica vazia e as linhas
    // completas são desenhadas como tabela conforme chegam.
    if (!state.mdTailHeld) tail.replaceChildren(document.createTextNode(''));
    state.mdTailHeld = true;
    if (table.lines >= 2) renderStreamingTable(this, state, table.source, table.lines);
  } else if (state.mdTailHeld) {
    // Parecia tabela e não era: devolve o texto inteiro à cauda.
    state.mdTailHeld = false;
    state.mdLiveEl?.remove();
    state.mdLiveEl = null;
    tail.replaceChildren(document.createTextNode(open));
  } else if (!committedNow) {
    // Trechos cujo fade já terminou voltam para o nó de texto, então a cauda
    // nunca acumula mais que meia dúzia de spans, por maior que seja o bloco.
    const now = performance.now();
    const settled = tail.firstChild as Text;
    for (let chunk = tail.children[0] as HTMLElement | undefined; chunk; chunk = tail.children[0] as HTMLElement) {
      if (now - Number(chunk.dataset.at) < STREAM_CHUNK_FADE_MS) break;
      settled.appendData(chunk.textContent || '');
      chunk.remove();
    }
    const chunk = document.createElement('span');
    chunk.className = 'stream-chunk';
    chunk.dataset.at = String(now);
    chunk.textContent = pending;
    tail.appendChild(chunk);
  }
  state.textPendingBuffer = '';
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
      // Mesmo verbo do título do bloco de execução: a barra dizia "Pensando"
      // enquanto o agente clicava ou já escrevia a resposta.
      const state = this.streamingState;
      const activity = (!state?.completed && state?.executionTitleEl?.textContent) || 'Pensando';
      const label = `${activity.replace(/…$/, '')} ${elapsed}`;
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
  this._tickThinkingTimer = updateTimer;
  this.thinkingTimerId = window.setInterval(updateTimer, 1000);
};

SidePanelUI.prototype.stopThinkingTimer = function stopThinkingTimer() {
  if (this.thinkingTimerId) {
    window.clearInterval(this.thinkingTimerId);
    this.thinkingTimerId = null;
  }
  this._tickThinkingTimer = null;
  this.thinkingStartedAt = null;
  this.clearStreamingRenderTimers();
};

SidePanelUI.prototype.startStreamingMessage = function startStreamingMessage() {
  if (this.streamingState) return;
  this.clearStreamingRenderTimers();
  const container = document.createElement('div');
  container.className = 'message assistant streaming';
  // O cabeçalho já nasce com a bolha: criado só no fim, ele empurrava a resposta
  // inteira ~30px para baixo no último frame. As ações entram com o texto final.
  container.innerHTML = `
      <div class="message-header assistant-header">${this.buildAssistantHeaderHtml()}</div>
      <div class="message-content streaming-content markdown-body">
        <div class="typing-indicator"><span></span><span></span><span></span></div>
        <div class="execution-human-summary hidden"></div>
        <details class="execution-details working hidden">
          <summary class="execution-details-summary">
            <svg class="execution-details-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
            <span class="execution-details-title shimmer">Pensando…</span>
            <span class="execution-details-meta"></span>
          </summary>
          <div class="stream-events"></div>
        </details>
        <div class="stream-main-text stream-event-text"></div>
      </div>
    `;

  const streamParent = this.lastChatTurn?.isConnected ? this.lastChatTurn : this.elements.chatMessages;
  container.querySelector('.assistant-actions')?.remove();
  streamParent.appendChild(container);
  this.streamingState = {
    container,
    eventsEl: container.querySelector('.stream-events') as HTMLElement | null,
    executionTitleEl: container.querySelector('.execution-details-title') as HTMLElement | null,
    lastEventType: undefined,
    textEventEl: container.querySelector('.stream-main-text') as HTMLElement | null,
    reasoningEventEl: null,
    textBuffer: '',
    textPendingBuffer: '',
    _lastMdPos: 0,
    reasoningBuffer: '',
    reasoningRawBuffer: '',
    executionDetailsEl: container.querySelector('.execution-details') as HTMLDetailsElement | null,
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

  if (!this.streamingState.textBuffer && content) this.collapsePlanDrawerForAnswer?.();
  this.streamingState.textBuffer = `${this.streamingState.textBuffer || ''}${content || ''}`;
  this.streamingState.textPendingBuffer = `${this.streamingState.textPendingBuffer || ''}${content || ''}`;
  this.setExecutionActivityLabel('Respondendo…');
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
        // O parse completo espera o navegador ficar ocioso; a cauda vira
        // markdown já, para a resposta não ficar com sintaxe crua até lá.
        commitStreamMarkdown(this, this.streamingState, buf.length);
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
  this.setExecutionActivityLabel('Pensando…');
  this.scheduleStreamingReasoningRender();
};

SidePanelUI.prototype.applyPlanUpdate = function applyPlanUpdate(plan: RunPlan) {
  if (!plan) return;
  const current = this.currentPlan;
  if (current?.planId && plan.planId === current.planId && Number(plan.version || 0) < Number(current.version || 0)) {
    return;
  }
  this.currentPlan = plan;
  this.renderPlanDrawer(plan);
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

SidePanelUI.prototype.finalizePartialStreamingMessage = function finalizePartialStreamingMessage(
  reason: 'stopped' | 'failed' | 'interrupted' | 'ambiguous_action',
) {
  const partial = this.finishStreamingMessage?.();
  const content = String(partial?.renderedContent || '').trim();
  if (!content) return false;

  const entry = createMessage({
    role: 'assistant',
    content,
    meta: { finishReason: reason, partial: true },
  });
  if (!entry) return false;
  this.displayHistory.push(entry);

  const container = partial?.container;
  if (container) {
    container.classList.add('partial');
    let header = container.querySelector('.message-header') as HTMLElement | null;
    if (!header) {
      header = document.createElement('div');
      header.className = 'message-header assistant-header';
      container.prepend(header);
    }
    header.innerHTML = this.buildAssistantHeaderHtml('Interrompida');
    this.bindAssistantActions(header, content, this.getLastUserMessageText?.() || '');
  }
  this.persistHistory?.();
  this.updateChatEmptyState?.();
  return true;
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
