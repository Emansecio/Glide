import { cloneConversationHistory, normalizeConversationHistory } from '../ai/message-schema.js';
import type { Message } from '../ai/message-schema.js';

/** Max in-memory sessions retained by the service worker context store. */
export const MAX_SESSION_CONTEXT_STORE_SIZE = 20;

export type UserMessageContextAction = 'proceed' | 'adopt' | 'history_needed';

/**
 * Decide how the SW should hydrate conversation context for an incoming user_message.
 * Pure helper — unit-tested without Chrome APIs.
 */
export function resolveUserMessageContextAction(
  hasStoreEntry: boolean,
  hasProvidedHistory: boolean,
): UserMessageContextAction {
  if (hasProvidedHistory) return 'adopt';
  if (hasStoreEntry) return 'proceed';
  return 'history_needed';
}

function touchAccessOrder(order: string[], sessionId: string): string[] {
  const next = order.filter((id) => id !== sessionId);
  next.push(sessionId);
  return next;
}

function evictOldestSessions(
  sessions: Map<string, Message[]>,
  order: string[],
  maxSessions: number,
): { sessions: Map<string, Message[]>; order: string[] } {
  const nextSessions = new Map(sessions);
  let nextOrder = [...order];
  while (nextSessions.size > maxSessions && nextOrder.length > 0) {
    const oldest = nextOrder.shift();
    if (oldest) nextSessions.delete(oldest);
  }
  nextOrder = nextOrder.filter((id) => nextSessions.has(id));
  return { sessions: nextSessions, order: nextOrder };
}

export class SessionContextStore {
  private sessions = new Map<string, Message[]>();
  private accessOrder: string[] = [];

  has(sessionId: string): boolean {
    const id = String(sessionId || '').trim();
    return id ? this.sessions.has(id) : false;
  }

  get(sessionId: string): Message[] {
    const id = String(sessionId || '').trim();
    if (!id || !this.sessions.has(id)) return [];
    this.accessOrder = touchAccessOrder(this.accessOrder, id);
    return cloneConversationHistory(this.sessions.get(id) || []);
  }

  set(sessionId: string, history: Message[], maxSessions = MAX_SESSION_CONTEXT_STORE_SIZE): void {
    const id = String(sessionId || '').trim();
    if (!id) return;
    const normalized = normalizeConversationHistory(history);
    this.sessions.set(id, cloneConversationHistory(normalized));
    this.accessOrder = touchAccessOrder(this.accessOrder, id);
    const evicted = evictOldestSessions(this.sessions, this.accessOrder, maxSessions);
    this.sessions = evicted.sessions;
    this.accessOrder = evicted.order;
  }

  adopt(sessionId: string, history: Message[], maxSessions = MAX_SESSION_CONTEXT_STORE_SIZE): void {
    this.set(sessionId, history, maxSessions);
  }

  append(sessionId: string, messages: Message[], maxSessions = MAX_SESSION_CONTEXT_STORE_SIZE): void {
    const id = String(sessionId || '').trim();
    if (!id || !Array.isArray(messages) || messages.length === 0) return;
    const existing = this.sessions.get(id) || [];
    const normalized = normalizeConversationHistory([...existing, ...messages]);
    this.set(id, normalized, maxSessions);
  }

  delete(sessionId: string): void {
    const id = String(sessionId || '').trim();
    if (!id) return;
    this.sessions.delete(id);
    this.accessOrder = this.accessOrder.filter((entry) => entry !== id);
  }

  /** LRU touch without mutating stored messages — used on session_active. */
  touch(sessionId: string): void {
    const id = String(sessionId || '').trim();
    if (!id || !this.sessions.has(id)) return;
    this.accessOrder = touchAccessOrder(this.accessOrder, id);
  }

  /** Test-only introspection. */
  size(): number {
    return this.sessions.size;
  }

  /** Test-only introspection — oldest session id in LRU order. */
  oldestSessionId(): string | undefined {
    return this.accessOrder[0];
  }
}

/** Module singleton — authoritative run context lives in the service worker. */
export const sessionContextStore = new SessionContextStore();
