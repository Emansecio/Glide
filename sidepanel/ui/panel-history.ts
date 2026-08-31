import { cloneConversationHistory, normalizeConversationHistory } from '../../ai/message-schema.js';
import { dedupeThinking, extractThinking } from '../../ai/message-utils.js';
import { sanitizeMessageForPersistence } from '../../ai/persist-serialization.js';
import { resolveHistoryPersistenceMode } from '../../ai/persist-tool-args.js';
import {
  CHAT_SESSIONS_INDEX_KEY,
  type ChatSessionIndexEntry,
  type ChatSessionPayload,
  LEGACY_CHAT_SESSIONS_KEY,
  buildHistoryIndexEntry,
  buildLegacyMigrationStorageUpdates,
  chatSessionStorageKey,
  compactSessionPayload,
  buildHistoryPersistSignature as computeHistoryPersistSignature,
  expandSessionPayload,
  isHistoryLoadTokenStale,
  mergeHistoryIndexEntry,
  pruneHistoryIndex,
  resolveContextTranscript,
  shrinkSessionPayloadForQuota,
  transcriptsEqual,
} from './history-storage.js';
import { fitSessionToBudget } from './history-budget.js';
import { isHistoryListLoadTokenStale, isHistoryPersistBarrierStale, isRenderGenerationStale } from './panel-guards.js';
import { SidePanelUI } from './panel-ui.js';

const HISTORY_PERSIST_DEBOUNCE_MS = 350;
const HISTORY_SCHEMA_VERSION = 1;
const HISTORY_MAX_MESSAGES_PER_SESSION = 200;
const HISTORY_MAX_SESSION_BYTES = 200 * 1024;
const HISTORY_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const HISTORY_STORAGE_RETRY_MAX = 2;
const historyTextEncoder = new TextEncoder();

SidePanelUI.prototype.isHistoryPanelVisible = function isHistoryPanelVisible() {
  const panel = this.elements.historyPanel as HTMLElement | null;
  return Boolean(panel && !panel.classList.contains('hidden'));
};

SidePanelUI.prototype.measureHistoryBytes = function measureHistoryBytes(value: unknown) {
  try {
    return historyTextEncoder.encode(JSON.stringify(value)).length;
  } catch {
    return historyTextEncoder.encode(String(value)).length;
  }
};

SidePanelUI.prototype.truncateHistoryField = function truncateHistoryField(
  value: unknown,
  limit = HISTORY_MAX_SESSION_BYTES,
) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
};

SidePanelUI.prototype.sanitizeHistoryMessage = function sanitizeHistoryMessage(message: any) {
  const mode = resolveHistoryPersistenceMode(this.historyPersistence);
  return sanitizeMessageForPersistence(
    message,
    {
      maxCharsPerTextField: HISTORY_MAX_SESSION_BYTES,
    },
    mode,
  );
};

SidePanelUI.prototype.buildHistoryTranscript = function buildHistoryTranscript(history: any[]) {
  const source = Array.isArray(history) ? history.slice(-HISTORY_MAX_MESSAGES_PER_SESSION) : [];
  const sanitized = source
    .map((message: any) => this.sanitizeHistoryMessage(message))
    .filter((message: any) => Boolean(message));

  const chronological = sanitized;
  // O corte por bytes (do fim para o começo) pode ter removido o assistant(tool_use)
  // e deixado seus tool-results no início do transcript. Um transcript que começa
  // com tool-result quebra a alternância user/assistant e dá 400 na Anthropic ao
  // continuar a sessão restaurada — então descartamos órfãos iniciais.
  let start = 0;
  while (start < chronological.length && chronological[start]?.role === 'tool') {
    start += 1;
  }
  return start > 0 ? chronological.slice(start) : chronological;
};

SidePanelUI.prototype.buildHistoryPersistSignature = function buildHistoryPersistSignature(entry: any) {
  return computeHistoryPersistSignature(entry);
};

SidePanelUI.prototype.bindHistoryStorageSync = function bindHistoryStorageSync() {
  if (this._historyStorageChangeListener) return;
  this._historyStorageChangeListener = (changes, areaName) => {
    if (areaName !== 'local') return;
    if (!(CHAT_SESSIONS_INDEX_KEY in changes)) return;
    if (this._historyIndexWriteInFlight) return;
    this._cachedChatSessionsIndex = undefined;
    this.historyListDirty = true;
  };
  chrome.storage.onChanged.addListener(this._historyStorageChangeListener);
};

SidePanelUI.prototype.flushPendingHistoryPersist = async function flushPendingHistoryPersist() {
  if (this.historyPersistDebounceTimerId) {
    window.clearTimeout(this.historyPersistDebounceTimerId);
    this.historyPersistDebounceTimerId = null;
  }
  await this.persistHistoryNow();
};

SidePanelUI.prototype.readHistoryIndex = async function readHistoryIndex(): Promise<ChatSessionIndexEntry[]> {
  const stored = await chrome.storage.local.get([CHAT_SESSIONS_INDEX_KEY]);
  const index = stored[CHAT_SESSIONS_INDEX_KEY];
  return Array.isArray(index) ? index : [];
};

SidePanelUI.prototype.readSessionPayload = async function readSessionPayload(
  sessionId: string,
): Promise<ChatSessionPayload | null> {
  const key = chatSessionStorageKey(sessionId);
  const stored = await chrome.storage.local.get([key]);
  const payload = stored[key];
  if (!payload || typeof payload !== 'object') return null;
  return expandSessionPayload(payload as ChatSessionPayload);
};

SidePanelUI.prototype.ensureHistoryStorageMigrated = async function ensureHistoryStorageMigrated() {
  if (this._historyStorageMigrated) return;

  await this.historyWriteQueue.run(async () => {
    if (this._historyStorageMigrated) return;

    const stored = await chrome.storage.local.get([LEGACY_CHAT_SESSIONS_KEY, CHAT_SESSIONS_INDEX_KEY]);
    const legacySessions = stored[LEGACY_CHAT_SESSIONS_KEY];
    if (!Array.isArray(legacySessions) || legacySessions.length === 0) {
      this._historyStorageMigrated = true;
      return;
    }

    const existingIndex = Array.isArray(stored[CHAT_SESSIONS_INDEX_KEY])
      ? (stored[CHAT_SESSIONS_INDEX_KEY] as ChatSessionIndexEntry[])
      : [];
    const existingIds = new Set(existingIndex.map((entry) => entry.id));
    const pendingLegacy = legacySessions.filter((session: any) => {
      const id = String(session?.id || '').trim();
      return id && !existingIds.has(id);
    });

    if (pendingLegacy.length === 0) {
      await chrome.storage.local.remove(LEGACY_CHAT_SESSIONS_KEY);
      this._cachedChatSessionsIndex = existingIndex;
      this._historyStorageMigrated = true;
      return;
    }

    const migrationUpdates = buildLegacyMigrationStorageUpdates(pendingLegacy, historyTextEncoder);
    const mergedIndex = [...existingIndex];
    const migrationIndex = migrationUpdates[CHAT_SESSIONS_INDEX_KEY] as ChatSessionIndexEntry[];
    for (const entry of migrationIndex) {
      const without = mergedIndex.filter((item) => item.id !== entry.id);
      without.push(entry);
      mergedIndex.splice(0, mergedIndex.length, ...without);
    }

    migrationUpdates[CHAT_SESSIONS_INDEX_KEY] = mergedIndex;
    await chrome.storage.local.set(migrationUpdates);
    await chrome.storage.local.remove(LEGACY_CHAT_SESSIONS_KEY);

    this._cachedChatSessionsIndex = mergedIndex;
    this._historyStorageMigrated = true;
  });
};

SidePanelUI.prototype.saveSessionPayloadWithRetry = async function saveSessionPayloadWithRetry(
  payload: ChatSessionPayload,
) {
  let lastError: unknown = null;
  let current = compactSessionPayload(payload);

  for (let attempt = 0; attempt <= HISTORY_STORAGE_RETRY_MAX; attempt += 1) {
    try {
      await chrome.storage.local.set({ [chatSessionStorageKey(current.id)]: current });
      return current;
    } catch (error) {
      lastError = error;
      const message = String((error as Error)?.message || error || '').toLowerCase();
      const isQuotaError = message.includes('quota');
      const transcript = Array.isArray(current.transcript) ? current.transcript : [];
      if (!isQuotaError || transcript.length <= 1 || attempt >= HISTORY_STORAGE_RETRY_MAX) {
        break;
      }
      current = shrinkSessionPayloadForQuota(current);
    }
  }

  throw lastError || new Error('Falha ao salvar historico');
};

SidePanelUI.prototype.removeHistorySessionKeys = async function removeHistorySessionKeys(sessionIds: string[]) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return;
  const keys = sessionIds.map((sessionId) => chatSessionStorageKey(sessionId));
  await chrome.storage.local.remove(keys);
};

SidePanelUI.prototype.persistHistoryNow = async function persistHistoryNow() {
  const persistBarrier = this.historyDeletionBarrier;
  if (this.privateSession || resolveHistoryPersistenceMode(this.historyPersistence) === 'off') return;
  // Only persist if there's actual content
  if (!this.displayHistory || this.displayHistory.length === 0) return;

  const transcript = this.buildHistoryTranscript(this.displayHistory);
  if (!transcript.length) return;
  const contextSource =
    Array.isArray(this.contextHistory) && this.contextHistory.length > 0 ? this.contextHistory : this.displayHistory;
  const contextTranscriptBuilt = this.buildHistoryTranscript(contextSource);
  const contextSameAsDisplay = transcriptsEqual(transcript, contextTranscriptBuilt);
  const contextTranscript = contextSameAsDisplay ? transcript : contextTranscriptBuilt;

  const entry = fitSessionToBudget(
    {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      id: this.sessionId,
      startedAt: this.sessionStartedAt,
      updatedAt: Date.now(),
      title: this.truncateHistoryField(this.firstUserMessage || 'Sessão', 180),
      messageCount: transcript.length,
      transcript,
      contextTranscript: contextSameAsDisplay ? undefined : contextTranscript,
    },
    HISTORY_MAX_SESSION_BYTES,
  );

  const signature = this.buildHistoryPersistSignature({
    id: entry.id,
    messageCount: entry.messageCount,
    transcript: entry.transcript,
    contextTranscript: contextTranscript,
  });
  if (signature === this.lastPersistedHistorySignature) {
    return;
  }

  try {
    await this.historyWriteQueue.run(async () => {
      if (isHistoryPersistBarrierStale(persistBarrier, this.historyDeletionBarrier)) return;
      if (signature === this.lastPersistedHistorySignature) return;
      await this.ensureHistoryStorageMigrated();

      const savedPayload = await this.saveSessionPayloadWithRetry(entry);
      const indexEntry = buildHistoryIndexEntry(savedPayload, historyTextEncoder);
      const existingIndex = this._cachedChatSessionsIndex ?? (await this.readHistoryIndex());
      const merged = mergeHistoryIndexEntry(existingIndex, indexEntry);
      const { index: trimmed, removedIds } = pruneHistoryIndex(
        merged,
        undefined,
        HISTORY_MAX_TOTAL_BYTES,
        this.sessionId,
      );

      this._historyIndexWriteInFlight = true;
      try {
        await chrome.storage.local.set({ [CHAT_SESSIONS_INDEX_KEY]: trimmed });
      } finally {
        this._historyIndexWriteInFlight = false;
      }
      if (removedIds.length > 0) {
        await this.removeHistorySessionKeys(removedIds);
      }

      this._cachedChatSessionsIndex = trimmed;
      this.lastPersistedHistorySignature = signature;
      this.historyListDirty = true;
      if (this.isHistoryPanelVisible()) {
        void this.loadHistoryList();
      }
    });
  } catch (e) {
    console.error('Falha ao salvar historico:', e);
    this.showErrorBanner?.('Falha ao salvar historico.');
  }
};

SidePanelUI.prototype.persistHistory = async function persistHistory({
  immediate = false,
}: { immediate?: boolean } = {}) {
  const persistBarrier = this.historyDeletionBarrier;
  const runPersist = async () => {
    this.historyPersistDebounceTimerId = null;
    if (isHistoryPersistBarrierStale(persistBarrier, this.historyDeletionBarrier)) return;
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

SidePanelUI.prototype.loadHistoryList = async function loadHistoryList() {
  if (!this.elements.historyItems) return;
  const loadToken = ++this.historyListLoadToken;

  try {
    await this.ensureHistoryStorageMigrated();
    if (isHistoryListLoadTokenStale(loadToken, this.historyListLoadToken)) return;
    const chatSessionsIndex = this._cachedChatSessionsIndex || (await this.readHistoryIndex());
    if (isHistoryListLoadTokenStale(loadToken, this.historyListLoadToken)) return;
    this._cachedChatSessionsIndex = chatSessionsIndex;
    this.elements.historyItems.innerHTML = '';

    if (!chatSessionsIndex.length) {
      if (isHistoryListLoadTokenStale(loadToken, this.historyListLoadToken)) return;
      this.elements.historyItems.innerHTML = '<div class="history-empty">Nenhuma conversa salva ainda.</div>';
      this.historyListDirty = false;
      return;
    }

    const fragment = document.createDocumentFragment();
    chatSessionsIndex.forEach((session: ChatSessionIndexEntry) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const date = new Date(session.updatedAt || session.startedAt || Date.now());
      const msgCount = session.messageCount || 0;
      const timeAgo = this.formatTimeAgo(date);
      const safeSessionId = this.escapeAttribute(String(session.id || ''));

      item.innerHTML = `
        <button type="button" class="history-item-main">
          <div class="history-title">${this.escapeHtml(session.title || 'Sessão sem título')}</div>
          <div class="history-meta">
            <span>${timeAgo}</span>
            <span class="history-meta-dot">-</span>
            <span>${msgCount} mensagens</span>
          </div>
        </button>
        <button class="history-delete"
                title="Excluir"
                aria-label="Excluir sessão: ${this.escapeAttribute(session.title || 'Sessão sem título')}"
                data-session-id="${safeSessionId}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;

      // Click to load session
      item.querySelector('.history-item-main')?.addEventListener('click', () => {
        void this.loadSessionById(session.id);
      });

      // Delete button
      item.querySelector('.history-delete')?.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        this.deleteSession(session.id);
      });

      fragment.appendChild(item);
    });
    if (isHistoryListLoadTokenStale(loadToken, this.historyListLoadToken)) return;
    this.elements.historyItems.appendChild(fragment);
    this.historyListDirty = false;
  } catch (e) {
    if (isHistoryListLoadTokenStale(loadToken, this.historyListLoadToken)) return;
    console.error('Falha ao carregar historico:', e);
    this.showErrorBanner?.('Falha ao carregar historico.');
    this.elements.historyItems.innerHTML = '<div class="history-empty">Falha ao carregar historico.</div>';
  }
};

SidePanelUI.prototype.loadSessionById = async function loadSessionById(sessionId: string) {
  const loadToken = ++this._historyLoadToken;
  try {
    await this.flushPendingHistoryPersist();
    if (isHistoryLoadTokenStale(loadToken, this._historyLoadToken)) return;

    const payload = await this.readSessionPayload(sessionId);
    if (isHistoryLoadTokenStale(loadToken, this._historyLoadToken)) return;
    if (!payload) {
      this.showErrorBanner?.('Sessão não encontrada.');
      return;
    }
    await this.loadSession(payload);
  } catch (e) {
    if (isHistoryLoadTokenStale(loadToken, this._historyLoadToken)) return;
    console.error('Falha ao carregar sessão:', e);
    this.showErrorBanner?.('Falha ao carregar sessão.');
  }
};

SidePanelUI.prototype.loadSession = async function loadSession(session: ChatSessionPayload) {
  await this.waitForRunStopAck?.();
  this.bumpRenderSessionGeneration?.();
  this.abortActiveStreaming?.();
  this.switchView('chat');
  if (Array.isArray(session.transcript)) {
    this.recordScrollPosition();
    const displayNormalized = normalizeConversationHistory((session.transcript || []) as any[]);
    const contextSource = resolveContextTranscript(session);
    const contextNormalized = normalizeConversationHistory((contextSource || []) as any[]);
    // Cópias independentes: no fluxo normal cada turno faz push nos DOIS arrays;
    // se eles compartilharem a referência, cada mensagem entra 2× e o modelo
    // recebe contexto duplicado.
    this.displayHistory = cloneConversationHistory(displayNormalized);
    this.contextHistory = cloneConversationHistory(contextNormalized);
    // Revisions live in service-worker lineage memory; persisted legacy sessions restart at zero.
    this.contextRevision = 0;
    this.invalidateContextUsageCache?.();
    this.sessionId = session.id || `session-${Date.now()}`;
    this.sessionStartedAt = Number(session.startedAt || Date.now());
    this.activeRunId = null;
    this.completedRunIds = new Set();
    this.acceptedSessionIds = new Set([this.sessionId]);
    this.noteAcceptedSessionId?.(this.sessionId);
    this.swContextSyncedSessions.delete(this.sessionId);
    this.pendingSessionId = null;
    this.firstUserMessage = session.title || '';
    void chrome.runtime.sendMessage({ type: 'session_active', sessionId: this.sessionId });
    this.renderConversationHistory();
    this.scheduleContextUsageRecompute?.({ force: true });
  }
  this.closeSidebar();
};

SidePanelUI.prototype.deleteSession = async function deleteSession(sessionId: string) {
  const deletingCurrent = sessionId === this.sessionId;
  this.bumpHistoryDeletionBarrier?.();
  if (deletingCurrent) {
    this.lastPersistedHistorySignature = undefined;
  }
  try {
    await this.historyWriteQueue.run(async () => {
      await this.ensureHistoryStorageMigrated();
      const chatSessionsIndex = await this.readHistoryIndex();
      const filtered = chatSessionsIndex.filter((entry) => entry.id !== sessionId);
      this._historyIndexWriteInFlight = true;
      try {
        await chrome.storage.local.set({ [CHAT_SESSIONS_INDEX_KEY]: filtered });
      } finally {
        this._historyIndexWriteInFlight = false;
      }
      await this.removeHistorySessionKeys([sessionId]);
      await chrome.runtime.sendMessage({ type: 'session_deleted', sessionId });
      this.swContextSyncedSessions?.delete(sessionId);
      this._cachedChatSessionsIndex = filtered;
      this.historyListDirty = true;
      if (this.isHistoryPanelVisible()) {
        void this.loadHistoryList();
      }
    });
  } catch (e) {
    console.error('Falha ao excluir sessão:', e);
    this.showErrorBanner?.('Falha ao excluir sessão.');
  }
};

SidePanelUI.prototype.clearAllHistory = async function clearAllHistory() {
  if (!confirm('Limpar todo o histórico de conversa? Esta ação não pode ser desfeita.')) return;

  this.bumpHistoryDeletionBarrier?.();
  this.lastPersistedHistorySignature = undefined;
  try {
    await this.historyWriteQueue.run(async () => {
      await this.ensureHistoryStorageMigrated();
      const chatSessionsIndex = await this.readHistoryIndex();
      const sessionIds = chatSessionsIndex.map((entry) => entry.id);
      await this.removeHistorySessionKeys(sessionIds);
      await chrome.storage.local.set({ [CHAT_SESSIONS_INDEX_KEY]: [] });
      await chrome.storage.local.remove(LEGACY_CHAT_SESSIONS_KEY);
      this._cachedChatSessionsIndex = [];
      this.lastPersistedHistorySignature = undefined;
      this.historyListDirty = true;
      if (this.isHistoryPanelVisible()) {
        void this.loadHistoryList();
      }
    });
  } catch (e) {
    console.error('Falha ao limpar historico:', e);
    this.showErrorBanner?.('Falha ao limpar historico.');
  }
};

SidePanelUI.prototype.formatTimeAgo = function formatTimeAgo(date: Date): string {
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

SidePanelUI.prototype.bindThinkingToggle = function bindThinkingToggle(thinkingHeader: Element) {
  thinkingHeader.addEventListener('click', () => {
    const block = thinkingHeader.closest('.thinking-block');
    if (!block || block.classList.contains('thinking-hidden')) return;
    block.classList.toggle('collapsed');
    const expanded = !block.classList.contains('collapsed');
    thinkingHeader.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });
};

// Render markdown cache keyed by content string to avoid re-compiling identical text.
let _renderMdCache: Map<string, string> | null = null;
const RENDER_MD_CACHE_MAX = 50;

SidePanelUI.prototype.renderConversationHistory = function renderConversationHistory() {
  this.cancelPendingMarkdownRender?.();
  this.cancelDeferredConversationRender?.();
  const renderGeneration = this.renderSessionGeneration;
  this.elements.chatMessages.innerHTML = '';
  this.toolCallViews.clear();
  this.runningToolViewIds.clear();
  this.lastChatTurn = null;
  this.resetActivityPanel();

  // Lazily seed the markdown cache on first rebuild
  if (!_renderMdCache) {
    _renderMdCache = new Map();
  }

  const fragment = document.createDocumentFragment();
  let precedingUserText = '';
  let currentTurn: HTMLElement | null = null;
  this.displayHistory.forEach((msg: any) => {
    if (msg.role === 'system' || msg.meta?.kind === 'summary') {
      // Mesmo fragment que o resto — evita flash/ordem errada vs rAF append.
      this.displaySummaryMessage(msg, { parent: fragment });
      return;
    }
    if (msg.role === 'user') {
      // Após compaction/restauração, msg.content pode ser array de parts
      // (multimodal). `escapeHtml(String(array))` renderizava "[object Object]".
      const userText = Array.isArray(msg.content)
        ? msg.content
            .map((part: any) => {
              if (typeof part === 'string') return part;
              if (part && typeof part === 'object') {
                if (typeof part.text === 'string') return part.text;
                if (part.type === 'image' || part.type === 'image_url' || part.image || part.image_url) {
                  return '🖼️ [imagem]';
                }
              }
              return '';
            })
            .filter(Boolean)
            .join('\n')
        : typeof msg.content === 'string'
          ? msg.content
          : String(msg.content ?? '');
      const turn = document.createElement('div');
      turn.className = 'chat-turn';
      const messageDiv = document.createElement('div');
      messageDiv.className = 'message user';
      messageDiv.innerHTML = `
          <div class="message-content">${this.escapeHtml(userText)}</div>
        `;
      turn.appendChild(messageDiv);
      fragment.appendChild(turn);
      currentTurn = turn;
      precedingUserText = userText;
    } else if (msg.role === 'assistant') {
      const rawContent = typeof msg.content === 'string' ? msg.content : this.safeJsonStringify(msg.content);
      const parsed = extractThinking(rawContent, msg.thinking || null);
      const messageDiv = document.createElement('div');
      const isPartial = msg.meta?.partial === true;
      const isTruncated = Boolean(msg.meta?.truncation);
      const historyMeta = [isPartial ? 'Interrompida' : '', isTruncated ? 'Conteúdo truncado' : '']
        .filter(Boolean)
        .join(' · ');
      messageDiv.className = `message assistant${isPartial ? ' partial' : ''}${isTruncated ? ' truncated' : ''}`;
      const htmlParts: string[] = [
        `<div class="message-header assistant-header">${this.buildAssistantHeaderHtml(historyMeta || null)}</div>`,
      ];
      if (parsed.thinking) {
        const cleanedThinking = dedupeThinking(parsed.thinking);
        htmlParts.push(`
            <div class="thinking-block collapsed">
              <button class="thinking-header" type="button" aria-expanded="false">
                <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
                Raciocinio
              </button>
              <div class="thinking-content">${this.escapeHtml(cleanedThinking)}</div>
            </div>
          `);
      }
      if (parsed.content && parsed.content.trim() !== '') {
        // Memoized renderMarkdown: avoid re-running heavy regex on identical content
        let rendered = _renderMdCache!.get(parsed.content);
        if (rendered === undefined) {
          rendered = this.renderMarkdown(parsed.content);
          if (_renderMdCache!.size >= RENDER_MD_CACHE_MAX) {
            const firstKey = _renderMdCache!.keys().next().value;
            if (firstKey) _renderMdCache!.delete(firstKey);
          }
          _renderMdCache!.set(parsed.content, rendered!);
        }
        htmlParts.push(`<div class="message-content markdown-body">${rendered}</div>`);
      }
      messageDiv.innerHTML = htmlParts.join('');

      const thinkingHeader = messageDiv.querySelector('.thinking-header');
      if (thinkingHeader) {
        this.bindThinkingToggle(thinkingHeader);
      }
      this.bindAssistantActions(
        messageDiv.querySelector('.assistant-header') as HTMLElement | null,
        parsed.content,
        precedingUserText,
      );

      if (currentTurn) currentTurn.appendChild(messageDiv);
      else fragment.appendChild(messageDiv);
    }
  });

  // Defer DOM append to next animation frame so layout recalc does not block
  // the main thread — important after compaction rebuilds with many messages.
  this.renderConversationRafId = requestAnimationFrame(() => {
    this.renderConversationRafId = 0;
    if (isRenderGenerationStale(renderGeneration, this.renderSessionGeneration)) return;
    this.elements.chatMessages.appendChild(fragment);
    this.restoreScrollPosition();
    this.updateChatEmptyState();
  });
};
