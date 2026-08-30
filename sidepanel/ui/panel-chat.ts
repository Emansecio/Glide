import { createMessage } from '../../ai/message-schema.js';
import type { Message } from '../../ai/message-schema.js';
import { dedupeThinking, extractThinking } from '../../ai/message-utils.js';
import { resolvePanelTabId } from './panel-tab-id.js';
import type { UsagePayload } from './panel-types.js';
import { SidePanelUI } from './panel-ui.js';

SidePanelUI.prototype.sendMessage = async function sendMessage() {
  const userMessage = this.elements.userInput.value.trim();
  const attachments = Array.isArray(this.pendingAttachments) ? [...this.pendingAttachments] : [];
  if (!userMessage && attachments.length === 0) return;
  const runInProgress =
    this.stoppingRun ||
    this.elements.composer?.classList.contains('running') ||
    this.isStreaming ||
    this.pendingToolCount > 0;
  if (runInProgress) {
    this.updateStatus(
      this.stoppingRun
        ? 'Aguarde a interrupção da execução atual antes de enviar outra mensagem.'
        : 'Aguarde a execução atual terminar antes de enviar outra mensagem. Use Parar para interrompê-la.',
      'warning',
    );
    return;
  }

  this._panelPortEnsureConnected?.();

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
    attachments
      .map((a: { kind: string; name: string }) => (a.kind === 'image' ? `[imagem: ${a.name}]` : `[arquivo: ${a.name}]`))
      .join(' ');

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

  this.updateStatus('Processando...', 'active');
  this.setComposerBusy(true);
  this.startRunLiveness();
  // Marca o turno pendente para rollback se o SW rejeitar (concurrent/preflight)
  // depois do ACK, sem ter começado stream/tools.
  this.awaitingRunAcceptance = true;
  this.pendingUserTurn = {
    displayId: displayEntry?.id,
    contextId: contextEntry?.id,
    turnEl: pendingTurn,
    restoreText: userMessage,
    restoreAttachments: attachments,
  };

  try {
    const panelTabId = await resolvePanelTabId();
    const canOmitHistory = this.swContextSyncedSessions.has(this.sessionId) && attachments.length === 0;

    const buildPayload = (includeHistory: boolean) => {
      const payload: Record<string, unknown> = {
        type: 'user_message',
        message: typeof modelContent === 'string' ? modelContent : displayText,
        selectedTabs: [],
        sessionId: this.sessionId,
        panelTabId,
      };
      if (includeHistory) {
        payload.conversationHistory = this.contextHistory;
      }
      return payload;
    };

    let response = await chrome.runtime.sendMessage(buildPayload(!canOmitHistory));

    if (response?.history_needed) {
      response = await chrome.runtime.sendMessage(buildPayload(true));
    }

    if (response?.success && response?.queued) {
      this.swContextSyncedSessions.add(this.sessionId);
    } else if (!response?.success && !response?.queued) {
      throw new Error(response?.error || 'Falha ao enfileirar mensagem no service worker.');
    }
  } catch (error: any) {
    const errorMessage = error?.message || 'Falha ao enviar mensagem ao service worker.';
    this.awaitingRunAcceptance = false;
    this.pendingUserTurn = null;

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
    this.updateStatus(`Erro: ${errorMessage}`, 'error');
    this.stopRunLiveness();
    this.setComposerBusy(false);
    this.showErrorBanner?.(errorMessage);
    this.updateActivityState();
  }
};

/**
 * Pede ao service worker que aborte o run em andamento. O worker responde com
 * `run_stopped`, que destrava a UI — mas já desabilitamos o botão aqui para o
 * clique não ser repetido, e destravamos localmente se o worker não responder
 * (ex.: worker já morto), sem depender do watchdog de liveness.
 */
SidePanelUI.prototype.requestStopRun = async function requestStopRun() {
  const stopBtn = this.elements.stopBtn as HTMLButtonElement | null;
  if (!this.elements.composer?.classList.contains('running') && !this.isStreaming && this.pendingToolCount === 0) {
    return;
  }
  if (stopBtn) stopBtn.disabled = true;
  this.updateStatus('Interrompendo…', 'warning');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'stop_run', runId: this.activeRunId || undefined });
    if (!response?.success && !response?.stopped) {
      // Nenhum run ativo do outro lado: a UI é que estava dessincronizada.
      this.stopRunLiveness();
      this.setComposerBusy(false);
      this.pendingToolCount = 0;
      this.isStreaming = false;
      this.finishStreamingMessage?.();
      this.updateActivityState();
      this.updateStatus('Nenhuma execução ativa', 'default');
      this.finishActiveRun?.();
      this.resolveRunStopAckWaiter?.();
    }
  } catch {
    this.stopRunLiveness();
    this.setComposerBusy(false);
    this.pendingToolCount = 0;
    this.isStreaming = false;
    this.finishStreamingMessage?.();
    this.updateActivityState();
    this.updateStatus('Execução interrompida', 'warning');
    this.finishActiveRun?.();
    this.resolveRunStopAckWaiter?.();
  } finally {
    if (stopBtn) stopBtn.disabled = false;
  }
};

const RUN_STOP_ACK_TIMEOUT_MS = 20000;
const RUN_STOP_ACK_POLL_MS = 250;

SidePanelUI.prototype.waitForRunStopAck = async function waitForRunStopAck(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? RUN_STOP_ACK_TIMEOUT_MS;
  const busy =
    this.elements.composer?.classList.contains('running') ||
    this.isStreaming ||
    this.pendingToolCount > 0 ||
    Boolean(this.activeRunId);
  if (!busy) return;

  this.stoppingRun = true;
  this.setComposerBusy(true);
  this.updateStatus('Interrompendo…', 'warning');

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    this.stoppingRun = false;
    this.resolveRunStopAckWaiter?.();
    this.stopRunLiveness?.();
    this.abortActiveStreaming?.();
    this.pendingToolCount = 0;
    this.isStreaming = false;
    this.activeToolName = null;
    this.finishStreamingMessage?.();
    this.setComposerBusy(false);
    this.updateActivityState();
    this.finishActiveRun?.();
  };

  const ackPromise = new Promise<void>((resolve) => {
    this._runStopAckWaiter = () => resolve();
  });

  void chrome.runtime.sendMessage({ type: 'stop_run', runId: this.activeRunId || undefined }).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raced = await Promise.race([
      ackPromise.then(() => 'ack' as const),
      new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), RUN_STOP_ACK_POLL_MS)),
    ]);
    if (raced === 'ack') {
      finish();
      return;
    }
    try {
      const status = await chrome.runtime.sendMessage({ type: 'run_status_query' });
      if (status && typeof status === 'object' && 'activeRunId' in status && !status.activeRunId) {
        finish();
        return;
      }
    } catch {
      finish();
      return;
    }
  }

  finish();
};

SidePanelUI.prototype.buildAssistantHeaderHtml = function buildAssistantHeaderHtml(meta?: string | null) {
  const metaHtml = meta ? `<span class="message-meta-inline">${this.escapeHtml(meta)}</span>` : '';
  return `
    <span class="assistant-glyph" aria-hidden="true">
      <!-- Mark: esfera com clique. Fonte: icons/glide-mark.svg -->
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path d="M18.88 16.82A8.4 8.4 0 1 1 18.69 6.92" stroke="currentColor" stroke-width="2.9" stroke-linecap="round"/>
        <circle cx="12" cy="12" r="2.9" fill="currentColor"/>
      </svg>
    </span>
    <span class="assistant-name">Glide</span>
    ${metaHtml}
    <div class="assistant-actions">
      <button type="button" class="icon-btn assistant-copy-btn" aria-label="Copiar resposta" title="Copiar resposta">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      </button>
      <button type="button" class="icon-btn assistant-edit-btn" aria-label="Editar e reenviar" title="Editar e reenviar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
      </button>
    </div>
  `;
};

SidePanelUI.prototype.bindAssistantActions = function bindAssistantActions(
  header: HTMLElement | null,
  markdownSource: string,
) {
  if (!header) return;
  header.dataset.markdownSource = markdownSource;
  const copyBtn = header.querySelector('.assistant-copy-btn') as HTMLButtonElement | null;
  const editBtn = header.querySelector('.assistant-edit-btn') as HTMLButtonElement | null;
  if (copyBtn && !copyBtn.dataset.bound) {
    copyBtn.dataset.bound = '1';
    copyBtn.addEventListener('click', () => {
      const source = header.dataset.markdownSource || '';
      if (!source) return;
      void navigator.clipboard.writeText(source).then(
        () => this.showSuccessToast?.('Resposta copiada'),
        () => this.showErrorBanner?.('Não foi possível copiar a resposta.'),
      );
    });
  }
  if (editBtn && !editBtn.dataset.bound) {
    editBtn.dataset.bound = '1';
    editBtn.addEventListener('click', () => {
      const lastUserText = this.getLastUserMessageText?.() || '';
      if (!lastUserText) return;
      this.elements.userInput.value = lastUserText;
      this.elements.userInput.dispatchEvent(new Event('input', { bubbles: true }));
      this.elements.userInput.focus();
    });
  }
  this.syncAssistantActionButtons();
};

SidePanelUI.prototype.getLastUserMessageText = function getLastUserMessageText() {
  for (let i = this.displayHistory.length - 1; i >= 0; i -= 1) {
    const entry = this.displayHistory[i];
    if (entry?.role === 'user') {
      return String(entry.content || '');
    }
  }
  return '';
};

SidePanelUI.prototype.syncAssistantActionButtons = function syncAssistantActionButtons() {
  const idle =
    !this.elements.composer?.classList.contains('running') && !this.isStreaming && this.pendingToolCount === 0;
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.assistant-actions .icon-btn'))) {
    btn.disabled = !idle;
  }
};

SidePanelUI.prototype.displayUserMessage = function displayUserMessage(
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

SidePanelUI.prototype.displaySummaryMessage = function displaySummaryMessage(
  messageOrEntry: Message | string,
  options?: { parent?: ParentNode | null },
) {
  const content = typeof messageOrEntry === 'string' ? messageOrEntry : String(messageOrEntry.content || '');
  const container = document.createElement('div');
  container.className = 'message summary';
  container.innerHTML = `
      <div class="summary-header">Contexto compactado</div>
      <div class="summary-body markdown-body">${this.renderMarkdown(content)}</div>
    `;
  const parent = options?.parent ?? this.elements.chatMessages;
  parent?.appendChild(container);
  if (!options?.parent) {
    this.scrollToBottom();
    this.updateChatEmptyState();
  }
  return container;
};

SidePanelUI.prototype.updateChatEmptyState = function updateChatEmptyState() {
  const emptyState = this.elements.chatEmptyState;
  if (!emptyState) return;
  const hasMessages =
    (this.displayHistory && this.displayHistory.length > 0) ||
    (this.elements.chatMessages && this.elements.chatMessages.children.length > 0);
  emptyState.classList.toggle('hidden', hasMessages);
};

SidePanelUI.prototype.displayAssistantMessage = function displayAssistantMessage(
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
    this.updateStatus('Pronto', 'success');
    this.stopRunLiveness();
    this.setComposerBusy(false);
    this.pendingToolCount = 0;
    this.updateActivityState();
    return false;
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
    this.bindAssistantActions(header, content);

    if (
      content &&
      content.trim() !== '' &&
      streamMainTextEl &&
      (content !== streamResult?.renderedContent || this.hasPendingMarkdownRender(streamMainTextEl))
    ) {
      // Final path wins over idle stream_stop parse — cancel deferred swap first.
      this.cancelPendingMarkdownRender();
      streamMainTextEl.innerHTML = this.renderMarkdown(content);
    }
    this.renderExecutionSemanticSummary?.(executionSummary, streamedContainer);
    this.finalizeExecutionDetails?.(executionSummary, streamedContainer);

    this.scrollToBottom();
    this.updateStatus('Pronto', 'success');
    this.stopRunLiveness();
    this.setComposerBusy(false);
    this.pendingToolCount = 0;
    this.updateActivityState();
    this.persistHistory();
    this.updateChatEmptyState();
    return true;
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

  if (thinking) {
    const cleanedThinking = dedupeThinking(thinking);
    html += `
        <div class="thinking-block collapsed">
          <button class="thinking-header" type="button" aria-expanded="false">
            <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            Raciocínio
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

  const assistantHeader = messageDiv.querySelector('.assistant-header') as HTMLElement | null;
  this.bindAssistantActions(assistantHeader, content);

  if (this.lastChatTurn) {
    this.lastChatTurn.appendChild(messageDiv);
  } else {
    this.elements.chatMessages.appendChild(messageDiv);
  }
  this.scrollToBottom();
  this.updateStatus('Pronto', 'success');
  this.stopRunLiveness();
  this.setComposerBusy(false);
  this.pendingToolCount = 0;
  this.updateActivityState();
  this.persistHistory();
  this.updateChatEmptyState();
  return true;
};

SidePanelUI.prototype.rollbackPendingUserTurn = function rollbackPendingUserTurn() {
  const pending = this.pendingUserTurn;
  this.pendingUserTurn = null;
  this.awaitingRunAcceptance = false;
  if (!pending) return;

  if (pending.displayId) {
    this.displayHistory = this.displayHistory.filter((entry: Message) => entry.id !== pending.displayId);
  }
  if (pending.contextId) {
    this.contextHistory = this.contextHistory.filter((entry: Message) => entry.id !== pending.contextId);
    this.invalidateContextUsageCache?.();
  }
  if (pending.turnEl?.parentElement) {
    pending.turnEl.remove();
    if (this.lastChatTurn === pending.turnEl) this.lastChatTurn = null;
  }
  if (pending.restoreText != null) {
    this.elements.userInput.value = pending.restoreText;
  }
  if (Array.isArray(pending.restoreAttachments)) {
    this.pendingAttachments = pending.restoreAttachments;
    this.renderPendingAttachments?.();
  }
  this.swContextSyncedSessions?.delete(this.sessionId);
  this.updateContextUsage?.();
  this.updateChatEmptyState?.();
};
