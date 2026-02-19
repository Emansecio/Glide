import { normalizeConversationHistory } from '../../ai/message-schema.js';
import { dedupeThinking, extractThinking } from '../../ai/message-utils.js';
import { SidePanelUI } from './panel-ui.js';

const HISTORY_PERSIST_DEBOUNCE_MS = 350;
const HISTORY_MAX_SESSIONS = 50;
const HISTORY_MAX_MESSAGES_PER_SESSION = 200;
const HISTORY_MAX_CHARS_PER_FIELD = 4000;
const HISTORY_MAX_SESSION_BYTES = 200 * 1024;
const HISTORY_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const HISTORY_STORAGE_RETRY_MAX = 2;
const historyTextEncoder = new TextEncoder();

(SidePanelUI.prototype as any).isHistoryPanelVisible = function isHistoryPanelVisible() {
  const panel = this.elements.historyPanel as HTMLElement | null;
  return Boolean(panel && !panel.classList.contains('hidden'));
};

(SidePanelUI.prototype as any).measureHistoryBytes = function measureHistoryBytes(value: unknown) {
  try {
    return historyTextEncoder.encode(JSON.stringify(value)).length;
  } catch {
    return historyTextEncoder.encode(String(value)).length;
  }
};

(SidePanelUI.prototype as any).truncateHistoryField = function truncateHistoryField(value: unknown, limit = HISTORY_MAX_CHARS_PER_FIELD) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
};

(SidePanelUI.prototype as any).sanitizeHistoryMessage = function sanitizeHistoryMessage(message: any) {
  if (!message || typeof message !== 'object') return null;
  const role = String(message.role || '');
  if (!role) return null;

  const contentRaw = typeof message.content === 'string' ? message.content : this.safeJsonStringify(message.content);
  const content = this.truncateHistoryField(contentRaw, HISTORY_MAX_CHARS_PER_FIELD);
  const thinking = message.thinking
    ? this.truncateHistoryField(message.thinking, Math.floor(HISTORY_MAX_CHARS_PER_FIELD / 2))
    : undefined;

  const sanitized: Record<string, any> = {
    id: message.id || undefined,
    createdAt: message.createdAt || undefined,
    role,
    content,
  };

  if (thinking) {
    sanitized.thinking = thinking;
  }

  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    sanitized.toolCalls = message.toolCalls.slice(0, 10).map((call: any) => ({
      id: this.truncateHistoryField(call?.id || '', 120),
      name: this.truncateHistoryField(call?.name || '', 120),
      args: this.truncateHistoryField(this.safeJsonStringify(call?.args || {}), HISTORY_MAX_CHARS_PER_FIELD),
    }));
  }

  if (message.toolCallId) {
    sanitized.toolCallId = this.truncateHistoryField(message.toolCallId, 120);
  }
  if (message.toolName) {
    sanitized.toolName = this.truncateHistoryField(message.toolName, 120);
  }
  if (message.name) {
    sanitized.name = this.truncateHistoryField(message.name, 120);
  }

  if (message.meta && typeof message.meta === 'object') {
    sanitized.meta = {
      kind: this.truncateHistoryField(message.meta.kind || '', 40),
      source: this.truncateHistoryField(message.meta.source || '', 120),
    };
  }

  if (message.usage && typeof message.usage === 'object') {
    sanitized.usage = {
      inputTokens: Number(message.usage.inputTokens || 0),
      outputTokens: Number(message.usage.outputTokens || 0),
      totalTokens: Number(message.usage.totalTokens || 0),
    };
  }

  return sanitized;
};

(SidePanelUI.prototype as any).buildHistoryTranscript = function buildHistoryTranscript(history: any[]) {
  const source = Array.isArray(history) ? history.slice(-HISTORY_MAX_MESSAGES_PER_SESSION) : [];
  const sanitized = source
    .map((message: any) => this.sanitizeHistoryMessage(message))
    .filter((message: any) => Boolean(message));

  const compacted: any[] = [];
  let totalBytes = 0;
  for (let i = sanitized.length - 1; i >= 0; i -= 1) {
    const item = sanitized[i];
    const size = this.measureHistoryBytes(item);
    if (compacted.length > 0 && totalBytes + size > HISTORY_MAX_SESSION_BYTES) break;
    compacted.unshift(item);
    totalBytes += size;
  }
  return compacted;
};

(SidePanelUI.prototype as any).pruneHistorySessions = function pruneHistorySessions(sessions: any[]) {
  const source = Array.isArray(sessions) ? sessions : [];
  const pruned: any[] = [];
  let totalBytes = 0;

  for (const session of source) {
    if (pruned.length >= HISTORY_MAX_SESSIONS) break;
    if (!session || typeof session !== 'object') continue;

    const normalized = {
      id: this.truncateHistoryField(session.id || '', 160),
      startedAt: Number(session.startedAt || Date.now()),
      updatedAt: Number(session.updatedAt || Date.now()),
      title: this.truncateHistoryField(session.title || 'Sessao', 180),
      messageCount: Number(session.messageCount || 0),
      transcript: this.buildHistoryTranscript(session.transcript || []),
    };

    const bytes = this.measureHistoryBytes(normalized);
    if (pruned.length > 0 && totalBytes + bytes > HISTORY_MAX_TOTAL_BYTES) {
      continue;
    }

    pruned.push(normalized);
    totalBytes += bytes;
  }

  return pruned;
};

(SidePanelUI.prototype as any).buildHistoryPersistSignature = function buildHistoryPersistSignature(entry: any) {
  const signaturePayload = {
    id: entry.id,
    title: entry.title,
    messageCount: entry.messageCount,
    transcript: entry.transcript,
  };
  return this.safeJsonStringify(signaturePayload);
};

(SidePanelUI.prototype as any).saveHistorySessionsWithRetry = async function saveHistorySessionsWithRetry(sessions: any[]) {
  let lastError: unknown = null;
  let current = Array.isArray(sessions) ? sessions.slice() : [];

  for (let attempt = 0; attempt <= HISTORY_STORAGE_RETRY_MAX; attempt += 1) {
    try {
      await chrome.storage.local.set({ chatSessions: current });
      return current;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '').toLowerCase();
      const isQuotaError = message.includes('quota');
      if (!isQuotaError || current.length <= 1 || attempt >= HISTORY_STORAGE_RETRY_MAX) {
        break;
      }
      const nextLength = Math.max(1, Math.floor(current.length * 0.7));
      current = current.slice(0, nextLength);
    }
  }

  throw lastError || new Error('Falha ao salvar historico');
};

(SidePanelUI.prototype as any).persistHistoryNow = async function persistHistoryNow() {
  // Default to saving history unless explicitly disabled
  const saveEnabled = this.elements.saveHistory?.value !== 'false';
  if (!saveEnabled) return;
  
  // Only persist if there's actual content
  if (!this.displayHistory || this.displayHistory.length === 0) return;

  const transcript = this.buildHistoryTranscript(this.displayHistory);
  if (!transcript.length) return;
  
  const entry = {
    id: this.sessionId,
    startedAt: this.sessionStartedAt,
    updatedAt: Date.now(),
    title: this.truncateHistoryField(this.firstUserMessage || 'Sessao', 180),
    messageCount: this.displayHistory.length,
    transcript,
  };

  const signature = this.buildHistoryPersistSignature(entry);
  if (signature === this.lastPersistedHistorySignature) {
    return;
  }
  
  try {
    const existing = await chrome.storage.local.get(['chatSessions']);
    const sessions = existing.chatSessions || [];
    const filtered = sessions.filter((s: any) => s.id !== entry.id);
    filtered.unshift(entry);
    const trimmed = this.pruneHistorySessions(filtered);
    await this.saveHistorySessionsWithRetry(trimmed);
    this.lastPersistedHistorySignature = signature;
    this.historyListDirty = true;
    if (this.isHistoryPanelVisible()) {
      void this.loadHistoryList();
    }
  } catch (e) {
    console.error('Falha ao salvar historico:', e);
  }
};

(SidePanelUI.prototype as any).persistHistory = async function persistHistory(
  { immediate = false }: { immediate?: boolean } = {},
) {
  const runPersist = async () => {
    this.historyPersistDebounceTimerId = null;
    await this.persistHistoryNow();
  };

  if (immediate) {
    if (this.historyPersistDebounceTimerId) {
      window.clearTimeout(this.historyPersistDebounceTimerId);
      this.historyPersistDebounceTimerId = null;
    }
    await runPersist();
    return;
  }

  if (this.historyPersistDebounceTimerId) {
    window.clearTimeout(this.historyPersistDebounceTimerId);
  }
  this.historyPersistDebounceTimerId = window.setTimeout(() => {
    void runPersist();
  }, HISTORY_PERSIST_DEBOUNCE_MS);
};

(SidePanelUI.prototype as any).loadHistoryList = async function loadHistoryList() {
  if (!this.elements.historyItems) return;

  const saveEnabled = this.elements.saveHistory?.value !== 'false';
  if (!saveEnabled) {
    this.elements.historyItems.innerHTML =
      '<div class="history-empty">Historico desativado. Ative "Salvar Historico" nas Configuracoes para ver conversas anteriores.</div>';
    return;
  }
  
  try {
    const { chatSessions = [] } = await chrome.storage.local.get(['chatSessions']);
    this.elements.historyItems.innerHTML = '';
    
    if (!chatSessions.length) {
      this.elements.historyItems.innerHTML = '<div class="history-empty">Nenhuma conversa salva ainda.</div>';
      this.historyListDirty = false;
      return;
    }
    
    chatSessions.forEach((session: any) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const date = new Date(session.updatedAt || session.startedAt || Date.now());
      const msgCount = session.messageCount || session.transcript?.length || 0;
      const timeAgo = this.formatTimeAgo(date);
      
      item.innerHTML = `
        <div class="history-item-main">
          <div class="history-title">${this.escapeHtml(session.title || 'Sessao sem titulo')}</div>
          <div class="history-meta">
            <span>${timeAgo}</span>
            <span class="history-meta-dot">-</span>
            <span>${msgCount} mensagens</span>
          </div>
        </div>
        <button class="history-delete" title="Excluir" data-session-id="${session.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;
      
      // Click to load session
      item.querySelector('.history-item-main')?.addEventListener('click', () => {
        this.loadSession(session);
      });
      
      // Delete button
      item.querySelector('.history-delete')?.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        this.deleteSession(session.id);
      });
      
      this.elements.historyItems.appendChild(item);
    });
    this.historyListDirty = false;
  } catch (e) {
    console.error('Falha ao carregar historico:', e);
    this.elements.historyItems.innerHTML = '<div class="history-empty">Falha ao carregar historico.</div>';
  }
};

(SidePanelUI.prototype as any).loadSession = function loadSession(session: any) {
  this.switchView('chat');
  if (Array.isArray(session.transcript)) {
    this.recordScrollPosition();
    const normalized = normalizeConversationHistory(session.transcript || []);
    this.displayHistory = normalized;
    this.contextHistory = normalized;
    this.invalidateContextUsageCache?.();
    this.sessionId = session.id || `session-${Date.now()}`;
    this.firstUserMessage = session.title || '';
    this.renderConversationHistory();
    this.scheduleContextUsageRecompute?.({ force: true });
  }
};

(SidePanelUI.prototype as any).deleteSession = async function deleteSession(sessionId: string) {
  try {
    const { chatSessions = [] } = await chrome.storage.local.get(['chatSessions']);
    const filtered = chatSessions.filter((s: any) => s.id !== sessionId);
    await chrome.storage.local.set({ chatSessions: filtered });
    this.historyListDirty = true;
    if (this.isHistoryPanelVisible()) {
      void this.loadHistoryList();
    }
  } catch (e) {
    console.error('Falha ao excluir sessao:', e);
  }
};

(SidePanelUI.prototype as any).clearAllHistory = async function clearAllHistory() {
  if (!confirm('Limpar todo o historico de conversa? Esta acao nao pode ser desfeita.')) return;
  
  try {
    await chrome.storage.local.set({ chatSessions: [] });
    this.historyListDirty = true;
    if (this.isHistoryPanelVisible()) {
      void this.loadHistoryList();
    }
  } catch (e) {
    console.error('Falha ao limpar historico:', e);
  }
};

(SidePanelUI.prototype as any).formatTimeAgo = function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Agora';
  if (minutes < 60) return `${minutes} min atras`;
  if (hours < 24) return `${hours} h atras`;
  if (days < 7) return `${days} d atras`;
  return date.toLocaleDateString();
};

(SidePanelUI.prototype as any).renderConversationHistory = function renderConversationHistory() {
  this.elements.chatMessages.innerHTML = '';
  this.toolCallViews.clear();
  this.lastChatTurn = null;
  this.resetActivityPanel();

  this.displayHistory.forEach((msg: any) => {
    if (msg.role === 'system' || msg.meta?.kind === 'summary') {
      this.displaySummaryMessage(msg);
      return;
    }
    if (msg.role === 'user') {
      const messageDiv = document.createElement('div');
      messageDiv.className = 'message user';
      messageDiv.innerHTML = `
          <div class="message-header">Voce</div>
          <div class="message-content">${this.escapeHtml(msg.content || '')}</div>
        `;
      this.elements.chatMessages.appendChild(messageDiv);
    } else if (msg.role === 'assistant') {
      const rawContent = typeof msg.content === 'string' ? msg.content : this.safeJsonStringify(msg.content);
      const parsed = extractThinking(rawContent, msg.thinking || null);
      const messageDiv = document.createElement('div');
      messageDiv.className = 'message assistant';
      let html = `<div class="message-header">Assistente</div>`;
      const showThinking = this.elements.showThinking.value === 'true';
      if (parsed.thinking && showThinking) {
        const cleanedThinking = dedupeThinking(parsed.thinking);
        html += `
            <div class="thinking-block collapsed">
              <button class="thinking-header" type="button" aria-expanded="false">
                <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
                Raciocinio
              </button>
              <div class="thinking-content">${this.escapeHtml(cleanedThinking)}</div>
            </div>
          `;
      }
      if (parsed.content && parsed.content.trim() !== '') {
        html += `<div class="message-content markdown-body">${this.renderMarkdown(parsed.content)}</div>`;
      }
      messageDiv.innerHTML = html;

      const thinkingHeader = messageDiv.querySelector('.thinking-header');
      if (thinkingHeader) {
        thinkingHeader.addEventListener('click', () => {
          const block = thinkingHeader.closest('.thinking-block');
          if (!block || block.classList.contains('thinking-hidden')) return;
          block.classList.toggle('collapsed');
          const expanded = !block.classList.contains('collapsed');
          thinkingHeader.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        });
      }

      this.elements.chatMessages.appendChild(messageDiv);
    }
  });
  this.restoreScrollPosition();
  this.updateChatEmptyState();
};
