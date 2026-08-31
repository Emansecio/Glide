import { fitSessionToBudget, measureStoredBytes } from './history-budget.js';

export const LEGACY_CHAT_SESSIONS_KEY = 'chatSessions';
export const CHAT_SESSIONS_INDEX_KEY = 'chatSessionsIndex';
export const CHAT_SESSION_KEY_PREFIX = 'chatSession:';

export const HISTORY_SCHEMA_VERSION = 1;
export const HISTORY_MAX_SESSIONS = 50;
export const HISTORY_STORAGE_SHRINK_RATIO = 0.7;

export interface ChatSessionIndexEntry {
  id: string;
  startedAt: number;
  updatedAt: number;
  title: string;
  messageCount: number;
  /** Serialized payload size — used for total-byte pruning, not shown in UI. */
  storageBytes: number;
}

export interface ChatSessionPayload {
  schemaVersion: number;
  id: string;
  startedAt: number;
  updatedAt: number;
  title: string;
  messageCount: number;
  transcript: unknown[];
  contextTranscript?: unknown[];
}

export function chatSessionStorageKey(sessionId: string): string {
  return `${CHAT_SESSION_KEY_PREFIX}${sessionId}`;
}

export function measureHistoryStorageBytes(value: unknown, textEncoder: TextEncoder): number {
  try {
    return textEncoder.encode(JSON.stringify(value)).length;
  } catch {
    return textEncoder.encode(String(value)).length;
  }
}

export function buildHistoryIndexEntry(session: ChatSessionPayload, textEncoder: TextEncoder): ChatSessionIndexEntry {
  const compacted = compactSessionPayload(session);
  return {
    id: session.id,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    title: session.title,
    messageCount: session.messageCount,
    storageBytes: measureHistoryStorageBytes(compacted, textEncoder),
  };
}

export function resolveContextTranscript(
  session: Pick<ChatSessionPayload, 'transcript' | 'contextTranscript'>,
): unknown[] {
  if (Array.isArray(session.contextTranscript) && session.contextTranscript.length > 0) {
    return session.contextTranscript;
  }
  return Array.isArray(session.transcript) ? session.transcript : [];
}

export function transcriptsEqual(left: unknown[] | undefined, right: unknown[] | undefined): boolean {
  try {
    return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
  } catch {
    return false;
  }
}

/** Omit contextTranscript when it matches transcript to save storage. */
export function compactSessionPayload(session: ChatSessionPayload): ChatSessionPayload {
  const transcript = Array.isArray(session.transcript) ? session.transcript : [];
  const contextTranscript = Array.isArray(session.contextTranscript) ? session.contextTranscript : undefined;
  if (!contextTranscript || transcriptsEqual(transcript, contextTranscript)) {
    const { contextTranscript: _omit, ...rest } = session;
    return { ...rest, transcript };
  }
  return { ...session, transcript, contextTranscript };
}

export function expandSessionPayload(stored: ChatSessionPayload): ChatSessionPayload {
  const transcript = Array.isArray(stored.transcript) ? stored.transcript : [];
  const contextTranscript = resolveContextTranscript(stored);
  if (transcriptsEqual(transcript, contextTranscript)) {
    const { contextTranscript: _omit, ...rest } = stored;
    return { ...rest, transcript };
  }
  return { ...stored, transcript, contextTranscript };
}

export interface LegacyMigrationSplit {
  index: ChatSessionIndexEntry[];
  sessionEntries: Record<string, ChatSessionPayload>;
  legacySessionIds: string[];
}

export function buildHistoryPersistSignature(entry: {
  id: string;
  messageCount: number;
  transcript: unknown[];
  contextTranscript?: unknown[];
}): string {
  const transcript = Array.isArray(entry.transcript) ? entry.transcript : [];
  const contextTranscript = Array.isArray(entry.contextTranscript) ? entry.contextTranscript : transcript;
  const lastDisplayId =
    transcript.length > 0 && (transcript[transcript.length - 1] as { id?: unknown })?.id != null
      ? String((transcript[transcript.length - 1] as { id?: unknown }).id)
      : '';
  const contextCount = contextTranscript.length;
  const lastContextId =
    contextCount > 0 && (contextTranscript[contextCount - 1] as { id?: unknown })?.id != null
      ? String((contextTranscript[contextCount - 1] as { id?: unknown }).id)
      : '';
  return `${entry.id}:${entry.messageCount}:${lastDisplayId}:${contextCount}:${lastContextId}`;
}

export function isHistoryLoadTokenStale(requestToken: number, currentToken: number): boolean {
  return requestToken !== currentToken;
}

export function shouldWriteThinkingTimerLabel(retryStatusActive: boolean): boolean {
  return !retryStatusActive;
}

/** Split a legacy chatSessions blob into per-session keys + index (pure). */
export function splitLegacyChatSessions(
  legacySessions: unknown[],
  textEncoder: TextEncoder,
  maxSessions = HISTORY_MAX_SESSIONS,
  maxTotalBytes = 4 * 1024 * 1024,
): LegacyMigrationSplit {
  const source = Array.isArray(legacySessions) ? legacySessions : [];
  const sorted = source
    .filter((raw) => raw && typeof raw === 'object')
    .sort(
      (left, right) =>
        Number((right as ChatSessionPayload).updatedAt || 0) - Number((left as ChatSessionPayload).updatedAt || 0),
    );
  const sessionEntries: Record<string, ChatSessionPayload> = {};
  const index: ChatSessionIndexEntry[] = [];
  const legacySessionIds: string[] = [];
  let totalBytes = 0;

  for (const raw of sorted) {
    if (index.length >= maxSessions) break;
    if (!raw || typeof raw !== 'object') continue;

    const session = raw as ChatSessionPayload;
    const id = String(session.id || '').trim();
    if (!id) continue;

    legacySessionIds.push(id);
    const payload: ChatSessionPayload = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      id,
      startedAt: Number(session.startedAt || Date.now()),
      updatedAt: Number(session.updatedAt || Date.now()),
      title: String(session.title || 'Sessão'),
      messageCount: Number(session.messageCount || 0),
      transcript: Array.isArray(session.transcript) ? session.transcript : [],
      contextTranscript: Array.isArray(session.contextTranscript) ? session.contextTranscript : undefined,
    };
    const compacted = compactSessionPayload(payload);
    const bytes = measureHistoryStorageBytes(compacted, textEncoder);
    if (index.length > 0 && totalBytes + bytes > maxTotalBytes) {
      continue;
    }

    sessionEntries[chatSessionStorageKey(id)] = compacted;
    index.push({
      id,
      startedAt: compacted.startedAt,
      updatedAt: compacted.updatedAt,
      title: compacted.title,
      messageCount: compacted.messageCount,
      storageBytes: bytes,
    });
    totalBytes += bytes;
  }

  index.sort((left, right) => (left.updatedAt || 0) - (right.updatedAt || 0));

  return { index, sessionEntries, legacySessionIds };
}

export function buildLegacyMigrationStorageUpdates(
  legacySessions: unknown[],
  textEncoder: TextEncoder,
): Record<string, unknown> {
  const { index, sessionEntries } = splitLegacyChatSessions(legacySessions, textEncoder);
  return {
    [CHAT_SESSIONS_INDEX_KEY]: index,
    ...sessionEntries,
  };
}

export function mergeHistoryIndexEntry(
  index: ChatSessionIndexEntry[],
  entry: ChatSessionIndexEntry,
): ChatSessionIndexEntry[] {
  const filtered = index.filter((item) => item.id !== entry.id);
  filtered.push(entry);
  return filtered;
}

export function pruneHistoryIndex(
  index: ChatSessionIndexEntry[],
  maxSessions = HISTORY_MAX_SESSIONS,
  maxTotalBytes = 4 * 1024 * 1024,
  protectSessionId?: string,
): { index: ChatSessionIndexEntry[]; removedIds: string[] } {
  const source = Array.isArray(index) ? index : [];
  const byNewest = [...source].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  const kept: ChatSessionIndexEntry[] = [];
  let totalBytes = 0;

  for (const entry of byNewest) {
    if (kept.length >= maxSessions) break;
    const bytes = Number(entry.storageBytes || 0);
    if (kept.length > 0 && totalBytes + bytes > maxTotalBytes) continue;
    kept.push(entry);
    totalBytes += bytes;
  }

  if (protectSessionId) {
    const protectedEntry = source.find((entry) => entry.id === protectSessionId);
    if (protectedEntry && !kept.some((entry) => entry.id === protectSessionId)) {
      kept.sort((left, right) => (left.updatedAt || 0) - (right.updatedAt || 0));
      while (kept.length >= maxSessions) {
        const evictIndex = kept.findIndex((entry) => entry.id !== protectSessionId);
        if (evictIndex < 0) break;
        kept.splice(evictIndex, 1);
      }
      kept.push(protectedEntry);
    }
  }

  kept.sort((left, right) => (left.updatedAt || 0) - (right.updatedAt || 0));
  const keptIds = new Set(kept.map((entry) => entry.id));
  const removedIds = source
    .filter((entry) => !keptIds.has(entry.id))
    .map((entry) => entry.id)
    .filter((id) => id !== protectSessionId);

  return { index: kept, removedIds };
}

export function shrinkSessionPayloadForQuota(
  payload: ChatSessionPayload,
  ratio = HISTORY_STORAGE_SHRINK_RATIO,
): ChatSessionPayload {
  const currentBytes = measureStoredBytes(payload);
  const targetBytes = Math.max(1024, Math.floor(currentBytes * ratio));
  return compactSessionPayload(fitSessionToBudget(payload, targetBytes));
}
