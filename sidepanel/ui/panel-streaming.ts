import type { RunPlan } from '../../types/plan.js';
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

(SidePanelUI.prototype as any).handleAssistantStream = function handleAssistantStream(event: any) {
  if (event.status === 'start') {
    this.isStreaming = true;
    this.clearErrorBanner();
    this.startStreamingMessage();
    this.startThinkingTimer();
  } else if (event.status === 'delta') {
    this.isStreaming = true;
    this.updateStreamingMessage(event.content || '');
  } else if (event.status === 'stop') {
    this.isStreaming = false;
    this.completeStreamingMessage();
    this.stopThinkingTimer();
  }
  this.updateActivityState();
};

(SidePanelUI.prototype as any).clearStreamingRenderTimers = function clearStreamingRenderTimers() {
  if (this.streamTextRenderTimerId) {
    window.clearTimeout(this.streamTextRenderTimerId);
    this.streamTextRenderTimerId = null;
  }
  if (this.streamReasoningRenderTimerId) {
    window.clearTimeout(this.streamReasoningRenderTimerId);
    this.streamReasoningRenderTimerId = null;
  }
};

(SidePanelUI.prototype as any).scheduleStreamingTextRender = function scheduleStreamingTextRender() {
  if (this.streamTextRenderTimerId) return;
  this.streamTextRenderTimerId = window.setTimeout(() => {
    this.streamTextRenderTimerId = null;
    this.flushStreamingTextRender();
  }, STREAM_TEXT_RENDER_INTERVAL_MS);
};

(SidePanelUI.prototype as any).flushStreamingTextRender = function flushStreamingTextRender() {
  if (!this.streamingState?.textEventEl) return;
  const pending = this.streamingState.textPendingBuffer || '';
  if (!pending) return;
  this.streamingState.textEventEl.textContent = `${this.streamingState.textEventEl.textContent || ''}${pending}`;
  this.streamingState.textPendingBuffer = '';
  if (this.shouldAutoScroll() && this.isNearBottom) {
    this.scrollToBottom();
  }
};

(SidePanelUI.prototype as any).scheduleStreamingReasoningRender = function scheduleStreamingReasoningRender() {
  if (this.streamReasoningRenderTimerId) return;
  this.streamReasoningRenderTimerId = window.setTimeout(() => {
    this.streamReasoningRenderTimerId = null;
    this.flushStreamingReasoningRender();
  }, STREAM_REASONING_RENDER_INTERVAL_MS);
};

(SidePanelUI.prototype as any).flushStreamingReasoningRender = function flushStreamingReasoningRender() {
  if (!this.streamingState?.reasoningEventEl) return;
  const raw = this.streamingState.reasoningRawBuffer || '';
  if (!raw.trim()) return;

  this.streamingState.reasoningBuffer = raw;
  this.streamingState.reasoningEventEl.textContent = raw;

  const panel = this.elements.thinkingPanel as HTMLElement | null;
  if (panel) {
    this.latestThinking = raw;
    panel.textContent = raw;
    panel.classList.remove('empty');
    panel.classList.add('streaming');
  }
  if (this.shouldAutoScroll() && this.isNearBottom) {
    this.scrollToBottom();
  }
};

(SidePanelUI.prototype as any).startThinkingTimer = function startThinkingTimer() {
  if (this.thinkingTimerId) {
    window.clearInterval(this.thinkingTimerId);
  }
  this.thinkingStartedAt = Date.now();
  const updateTimer = () => {
    const elapsed = formatElapsed(Date.now() - (this.thinkingStartedAt || Date.now()));
    this.updateStatus(`Thinking ${elapsed}`, 'active');
  };
  updateTimer();
  this.thinkingTimerId = window.setInterval(updateTimer, 1000);
};

(SidePanelUI.prototype as any).stopThinkingTimer = function stopThinkingTimer() {
  if (this.thinkingTimerId) {
    window.clearInterval(this.thinkingTimerId);
    this.thinkingTimerId = null;
  }
  this.thinkingStartedAt = null;
  this.clearStreamingRenderTimers();
};

(SidePanelUI.prototype as any).startStreamingMessage = function startStreamingMessage() {
  if (this.streamingState) return;
  this.clearStreamingRenderTimers();
  const container = document.createElement('div');
  container.className = 'message assistant streaming';
  container.innerHTML = `
      <div class="message-content streaming-content markdown-body">
        <div class="typing-indicator"><span></span><span></span><span></span></div>
        <div class="execution-human-summary hidden"></div>
        <details class="execution-details hidden">
          <summary class="execution-details-summary">
            <span class="execution-details-title">Ver detalhes tecnicos da execucao</span>
            <span class="execution-details-meta">Em execucao</span>
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

(SidePanelUI.prototype as any).updateStreamingMessage = function updateStreamingMessage(content: string) {
  if (!this.streamingState) {
    this.startStreamingMessage();
  }
  if (!this.streamingState?.textEventEl) return;

  this.streamingState.textBuffer = `${this.streamingState.textBuffer || ''}${content || ''}`;
  this.streamingState.textPendingBuffer = `${this.streamingState.textPendingBuffer || ''}${content || ''}`;
  this.scheduleStreamingTextRender();
};

(SidePanelUI.prototype as any).completeStreamingMessage = function completeStreamingMessage() {
  if (!this.streamingState?.container) return;

  this.flushStreamingTextRender();
  this.flushStreamingReasoningRender();
  this.clearStreamingRenderTimers();

  const indicator = this.streamingState.container.querySelector('.typing-indicator');
  if (indicator) indicator.remove();
  this.streamingState.container.classList.remove('streaming');
  if (this.streamingState.textEventEl) {
    this.streamingState.textEventEl.innerHTML = this.renderMarkdown(this.streamingState.textBuffer || '');
  }

  const finalReasoning = this.streamingState.reasoningBuffer || '';
  if (finalReasoning) {
    this.updateThinkingPanel(finalReasoning, false);
  } else {
    this.updateThinkingPanel(null, false);
  }
};

(SidePanelUI.prototype as any).updateStreamReasoning = function updateStreamReasoning(delta: string | null) {
  if (!this.streamingState?.eventsEl) return;
  if (delta === null || delta === undefined) return;
  if (!delta.trim() && !this.streamingState.reasoningRawBuffer) return;
  this.ensureStreamingExecutionDetailsVisible?.();

  if (this.streamingState.lastEventType !== 'reasoning') {
    const reasoningEvent = document.createElement('div');
    reasoningEvent.className = 'stream-event stream-event-reasoning';
    reasoningEvent.innerHTML = `
        <div class="stream-reasoning-label">Reasoning</div>
        <div class="stream-reasoning-content"></div>
      `;
    this.streamingState.eventsEl.appendChild(reasoningEvent);
    this.streamingState.reasoningEventEl = reasoningEvent.querySelector(
      '.stream-reasoning-content',
    ) as HTMLElement | null;
    this.streamingState.reasoningBuffer = '';
    this.streamingState.reasoningRawBuffer = '';
    this.streamingState.lastEventType = 'reasoning';
  }

  this.streamingState.reasoningRawBuffer = `${this.streamingState.reasoningRawBuffer || ''}${delta}`;
  this.scheduleStreamingReasoningRender();
};

(SidePanelUI.prototype as any).applyPlanUpdate = function applyPlanUpdate(plan: RunPlan) {
  if (!plan) return;
  this.currentPlan = plan;
  this.renderPlanDrawer(plan);
};

(SidePanelUI.prototype as any).applyManualPlanUpdate = function applyManualPlanUpdate(
  steps: Array<{ title: string; status?: string; notes?: string }> = [],
) {
  if (!steps || steps.length === 0) return;
  const now = Date.now();
  const normalizedSteps = steps
    .map((step, index) => {
      const status =
        step.status === 'running' || step.status === 'done' || step.status === 'blocked' ? step.status : 'pending';
      return {
        id: `step-${index + 1}`,
        title: step.title,
        status: status as RunPlan['steps'][number]['status'],
        notes: step.notes,
      };
    })
    .filter((step) => step.title);
  if (!normalizedSteps.length) return;
  this.currentPlan = {
    steps: normalizedSteps,
    createdAt: this.currentPlan?.createdAt || now,
    updatedAt: now,
  };
  if (this.currentPlan) {
    this.renderPlanDrawer(this.currentPlan);
  }
};

(SidePanelUI.prototype as any).ensurePlanBlock = function ensurePlanBlock() {
  if (!this.streamingState?.eventsEl) return null;
  if (this.streamingState.planEl) return this.streamingState.planEl;

  const container = document.createElement('div');
  container.className = 'plan-block';
  container.innerHTML = `
      <div class="plan-header">
        <span class="plan-title">Plan</span>
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

(SidePanelUI.prototype as any).finishStreamingMessage = function finishStreamingMessage() {
  if (!this.streamingState) return null;
  const streamingThinking = this.streamingReasoning;
  const container = this.streamingState.container;

  this.completeStreamingMessage();
  this.clearStreamingRenderTimers();
  this.streamingState = null;
  this.isStreaming = false;
  this.updateActivityState();

  return { thinking: streamingThinking, container };
};
