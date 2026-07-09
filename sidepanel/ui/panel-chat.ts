import { createMessage } from '../../ai/message-schema.js';
import type { Message } from '../../ai/message-schema.js';
import { dedupeThinking, extractThinking } from '../../ai/message-utils.js';
import { resolvePanelTabId } from './panel-tab-id.js';
import type { UsagePayload } from './panel-types.js';
import { SidePanelUI } from './panel-ui.js';

(SidePanelUI.prototype as any).sendMessage = async function sendMessage() {
  const userMessage = this.elements.userInput.value.trim();
  const attachments = Array.isArray(this.pendingAttachments) ? [...this.pendingAttachments] : [];
  if (!userMessage && attachments.length === 0) return;
  const runInProgress =
    this.elements.composer?.classList.contains('running') || this.isStreaming || this.pendingToolCount > 0;
  if (runInProgress) {
    this.updateStatus('Aguarde a resposta atual terminar antes de enviar outra mensagem', 'warning');
    return;
  }

  this.elements.userInput.value = '';
  this.elements.userInput.style.height = '';
  this.clearPendingAttachments?.();

  const titleSeed =
    userMessage ||
    (attachments.some((a: { kind: string }) => a.kind === 'image') ? 'Print anexado' : 'Arquivo anexado');
  if (!this.firstUserMessage) {
    this.firstUserMessage = titleSeed;
  }

  this.pendingToolCount = 0;
  this.isStreaming = false;
  this.activeToolName = null;
  this.activeExecutionTurnKey = null;
  this.clearRunIncompleteBanner();
  this.updateActivityState();

  // Model payload: multimodal parts when images present; text files wrapped in <attached_file>.
  const modelContent = this.buildAttachmentModelContent?.(userMessage, attachments) ?? userMessage;
  // Display / history: keep UI clean (no base64 dumps).
  const displayText =
    userMessage ||
    attachments.map((a: { kind: string; name: string }) => (a.kind === 'image' ? `[imagem: ${a.name}]` : `[arquivo: ${a.name}]`)).join(' ');

  this.currentPlan = null;

  this.displayUserMessage(userMessage, attachments);
  const pendingTurn = this.lastChatTurn;

  const displayEntry = createMessage({ role: 'user', content: displayText });
  if (displayEntry) {
    this.displayHistory.push(displayEntry);
  }

  const contextEntry = createMessage({ role: 'user', content: modelContent as Message['content'] });
  if (contextEntry) {
    this.contextHistory.push(contextEntry);
    this.bumpContextUsageWithMessages?.([contextEntry]);
  }
  this.updateContextUsage();

  this.updateStatus('Processing...', 'active');
  this.elements.composer?.classList.add('running');
  this.elements.sendBtn?.setAttribute('disabled', 'true');
  this.elements.sendBtn?.classList.add('loading');

  try {
    const panelTabId = await resolvePanelTabId();
    await chrome.runtime.sendMessage({
      type: 'user_message',
      message: typeof modelContent === 'string' ? modelContent : displayText,
      conversationHistory: this.contextHistory,
      selectedTabs: [],
      sessionId: this.sessionId,
      panelTabId,
    });
  } catch (error: any) {
    const errorMessage = error?.message || 'Failed to send message to the background service.';

    if (displayEntry) {
      this.displayHistory = this.displayHistory.filter((entry: Message) => entry.id !== displayEntry.id);
    }
    if (contextEntry) {
      this.contextHistory = this.contextHistory.filter((entry: Message) => entry.id !== contextEntry.id);
      this.invalidateContextUsageCache?.();
    }

    if (pendingTurn && pendingTurn.parentElement) {
      pendingTurn.remove();
      this.lastChatTurn = null;
    }

    // Restore composer state on failure
    this.elements.userInput.value = userMessage;
    this.pendingAttachments = attachments;
    this.renderPendingAttachments?.();
    this.elements.userInput.focus();
    this.updateContextUsage();
    this.updateChatEmptyState();
    this.stopThinkingTimer?.();
    this.pendingToolCount = 0;
    this.isStreaming = false;
    this.activeToolName = null;
    this.updateStatus(`Error: ${errorMessage}`, 'error');
    this.elements.composer?.classList.remove('running');
    this.elements.sendBtn?.removeAttribute('disabled');
    this.elements.sendBtn?.classList.remove('loading');
    this.showErrorBanner?.(errorMessage);
    this.updateActivityState();
  }
};

(SidePanelUI.prototype as any).buildAssistantHeaderHtml = function buildAssistantHeaderHtml(meta?: string | null) {
  const metaHtml = meta ? `<span class="message-meta-inline">${this.escapeHtml(meta)}</span>` : '';
  return `
    <span class="assistant-glyph">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z"/>
      </svg>
    </span>
    <span class="assistant-name">Glide</span>
    ${metaHtml}
  `;
};

(SidePanelUI.prototype as any).displayUserMessage = function displayUserMessage(
  content: string,
  attachments: Array<{
    id: string;
    kind: 'text' | 'image';
    name: string;
    mime: string;
    sizeLabel: string;
    text?: string;
    dataUrl?: string;
    previewUrl?: string;
  }> = [],
) {
  const turn = document.createElement('div');
  turn.className = 'chat-turn';
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message user';
  if (typeof this.buildAttachmentDisplayHtml === 'function' && attachments.length) {
    messageDiv.innerHTML = this.buildAttachmentDisplayHtml(content, attachments);
  } else {
    messageDiv.innerHTML = `<div class="message-content">${this.escapeHtml(content)}</div>`;
  }
  turn.appendChild(messageDiv);
  this.elements.chatMessages.appendChild(turn);
  this.lastChatTurn = turn;
  this.scrollToBottom({ force: true });
  this.updateChatEmptyState();
};

(SidePanelUI.prototype as any).displaySummaryMessage = function displaySummaryMessage(
  messageOrEntry: Message | string,
) {
  const content = typeof messageOrEntry === 'string' ? messageOrEntry : String(messageOrEntry.content || '');
  const container = document.createElement('div');
  container.className = 'message summary';
  container.innerHTML = `
      <div class="summary-header">Context compacted</div>
      <div class="summary-body">${this.renderMarkdown(content)}</div>
    `;
  this.elements.chatMessages.appendChild(container);
  this.scrollToBottom();
  this.updateChatEmptyState();
};

(SidePanelUI.prototype as any).updateChatEmptyState = function updateChatEmptyState() {
  const emptyState = this.elements.chatEmptyState;
  if (!emptyState) return;
  const hasMessages =
    (this.displayHistory && this.displayHistory.length > 0) ||
    (this.elements.chatMessages && this.elements.chatMessages.children.length > 0);
  emptyState.classList.toggle('hidden', hasMessages);
};

(SidePanelUI.prototype as any).displayAssistantMessage = function displayAssistantMessage(
  content: string,
  thinking: string | null = null,
  usage: UsagePayload | null = null,
  model: string | null = null,
  runtimeMeta: { runId?: string; turnId?: string } | null = null,
) {
  this.stopThinkingTimer?.();
  const streamResult = this.finishStreamingMessage();
  const streamedContainer = streamResult?.container;
  const streamMainTextEl = streamedContainer?.querySelector('.stream-main-text') as HTMLElement | null;
  const streamEventsEl = streamedContainer?.querySelector('.stream-events') as HTMLElement | null;
  const hasStreamEvents = Boolean(streamEventsEl && streamEventsEl.children.length > 0);
  const executionSummary = this.consumeExecutionTurnSummary?.(runtimeMeta?.runId, runtimeMeta?.turnId) || null;
  let normalizedUsage = this.normalizeUsage(usage);
  const modelLabel = model || this.getActiveModelLabel();
  const combinedThinking = [streamResult?.thinking, thinking].filter(Boolean).join('\n\n') || null;

  if ((!content || content.trim() === '') && !combinedThinking && !hasStreamEvents) {
    if (streamedContainer) {
      streamedContainer.remove();
    }
    this.updateStatus('Ready', 'success');
    this.elements.composer?.classList.remove('running');
    this.elements.sendBtn?.removeAttribute('disabled');
    this.elements.sendBtn?.classList.remove('loading');
    this.pendingToolCount = 0;
    this.updateActivityState();
    return;
  }

  const parsed = extractThinking(content, combinedThinking);
  content = parsed.content;
  thinking = parsed.thinking;
  this.updateThinkingPanel(thinking, false);

  if (!normalizedUsage) {
    normalizedUsage = this.estimateUsageFromContent(content);
  }
  if (normalizedUsage) {
    this.updateUsageStats(normalizedUsage);
  }
  const messageMeta = this.buildMessageMeta(normalizedUsage, modelLabel);

  const assistantEntry = createMessage({
    role: 'assistant',
    content,
    thinking,
  });
  if (assistantEntry) {
    this.displayHistory.push(assistantEntry);
  }

  if (streamedContainer) {
    let header = streamedContainer.querySelector('.message-header') as HTMLElement | null;
    if (!header) {
      header = document.createElement('div');
      header.className = 'message-header assistant-header';
      streamedContainer.prepend(header);
    }
    header.innerHTML = this.buildAssistantHeaderHtml(messageMeta);

    if (content && content.trim() !== '' && streamMainTextEl) {
      streamMainTextEl.innerHTML = this.renderMarkdown(content);
    }
    this.renderExecutionSemanticSummary?.(executionSummary, streamedContainer);
    this.finalizeExecutionDetails?.(executionSummary, streamedContainer);

    this.scrollToBottom();
    this.updateStatus('Ready', 'success');
    this.elements.composer?.classList.remove('running');
    this.elements.sendBtn?.removeAttribute('disabled');
    this.elements.sendBtn?.classList.remove('loading');
    this.pendingToolCount = 0;
    this.updateActivityState();
    this.persistHistory();
    this.updateChatEmptyState();
    return;
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant';

  let html = `<div class="message-header assistant-header">${this.buildAssistantHeaderHtml(messageMeta)}</div>`;

  const semanticRows = this.buildExecutionSemanticRows?.(executionSummary) || [];
  if (semanticRows.length > 0) {
    html += `
      <div class="execution-human-summary">
        ${this.buildExecutionChipsHtml(semanticRows)}
      </div>
    `;
  }

  const showThinking = this.elements.showThinking?.value !== 'false';
  if (thinking && showThinking) {
    const cleanedThinking = dedupeThinking(thinking);
    html += `
        <div class="thinking-block collapsed">
          <button class="thinking-header" type="button" aria-expanded="false">
            <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            Thinking
          </button>
          <div class="thinking-content">${this.escapeHtml(cleanedThinking)}</div>
        </div>
      `;
  }

  if (content && content.trim() !== '') {
    const renderedContent = this.renderMarkdown(content);
    html += `<div class="message-content markdown-body">${renderedContent}</div>`;
  }

  messageDiv.innerHTML = html;

  const thinkingHeader = messageDiv.querySelector('.thinking-header');
  if (thinkingHeader) {
    this.bindThinkingToggle(thinkingHeader);
  }

  if (this.lastChatTurn) {
    this.lastChatTurn.appendChild(messageDiv);
  } else {
    this.elements.chatMessages.appendChild(messageDiv);
  }
  this.scrollToBottom();
  this.updateStatus('Ready', 'success');
  this.elements.composer?.classList.remove('running');
  this.elements.sendBtn?.removeAttribute('disabled');
  this.elements.sendBtn?.classList.remove('loading');
  this.pendingToolCount = 0;
  this.updateActivityState();
  this.persistHistory();
  this.updateChatEmptyState();
};
