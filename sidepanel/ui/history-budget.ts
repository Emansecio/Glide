import type { ChatSessionPayload } from './history-storage.js';

export type TruncationMeta = {
  originalChars: number;
  retainedChars: number;
  reason: 'session_budget' | 'total_budget';
};

export type StoredSession = ChatSessionPayload;

const encoder = new TextEncoder();

export function measureStoredBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).length;
  } catch {
    return encoder.encode(String(value)).length;
  }
}

function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function compactToolMessage(message: any): boolean {
  let changed = false;
  if (message?.role === 'tool' && message.content !== '[Resultado de ferramenta compactado pelo limite da sessão]') {
    message.content = '[Resultado de ferramenta compactado pelo limite da sessão]';
    changed = true;
  }
  if (Array.isArray(message?.toolCalls)) {
    for (const call of message.toolCalls) {
      if (call?.args && JSON.stringify(call.args).length > 256) {
        call.args = { _compacted: true, reason: 'session_budget' };
        changed = true;
      }
    }
  }
  return changed;
}

function truncateMessageText(message: any, maxReduction: number, reason: TruncationMeta['reason']): boolean {
  if (!message || typeof message.content !== 'string' || message.content.length <= 32) return false;
  const originalChars = Number(message.meta?.truncation?.originalChars || message.content.length);
  const retainedChars = Math.max(32, message.content.length - Math.max(1, maxReduction));
  if (retainedChars >= message.content.length) return false;
  message.content = message.content.slice(0, retainedChars);
  message.meta = {
    ...(message.meta || {}),
    truncation: { originalChars, retainedChars, reason },
  };
  return true;
}

function fitMessagesToBudget(messages: unknown[], maxBytes: number, reason: TruncationMeta['reason']): unknown[] {
  const fitted = clone(Array.isArray(messages) ? messages : []);
  if (measureStoredBytes(fitted) <= maxBytes) return fitted;

  for (const message of fitted as any[]) {
    if (compactToolMessage(message) && measureStoredBytes(fitted) <= maxBytes) return fitted;
  }

  for (const message of fitted as any[]) {
    const overflow = measureStoredBytes(fitted) - maxBytes;
    if (overflow <= 0) break;
    truncateMessageText(message, overflow + 256, reason);
  }

  while (measureStoredBytes(fitted) > maxBytes && fitted.length > 1) {
    fitted.shift();
  }
  if (measureStoredBytes(fitted) > maxBytes && fitted.length === 1) {
    const message = fitted[0] as any;
    while (measureStoredBytes(fitted) > maxBytes && truncateMessageText(message, 512, reason)) {
      // bounded by shrinking content at least 512 chars per iteration
    }
  }
  return fitted;
}

/** Fits display + context history without fixed per-field caps. Recent text is final fallback. */
export function fitSessionToBudget(session: StoredSession, maxBytes: number): StoredSession {
  const budget = Math.max(1024, Math.floor(maxBytes));
  const fitted = clone(session);
  const hasDistinctContext =
    Array.isArray(fitted.contextTranscript) &&
    JSON.stringify(fitted.contextTranscript) !== JSON.stringify(fitted.transcript);

  if (hasDistinctContext) {
    const transcriptBudget = Math.max(512, Math.floor((budget - 768) / 2));
    fitted.transcript = fitMessagesToBudget(fitted.transcript, transcriptBudget, 'session_budget');
    fitted.contextTranscript = fitMessagesToBudget(fitted.contextTranscript || [], transcriptBudget, 'session_budget');
  } else {
    fitted.transcript = fitMessagesToBudget(fitted.transcript, budget - 512, 'session_budget');
    fitted.contextTranscript = undefined;
  }
  fitted.messageCount = fitted.transcript.length;

  if (measureStoredBytes(fitted) <= budget) return fitted;
  const remaining = Math.max(512, budget - 512);
  const finalTranscriptBudget = fitted.contextTranscript ? Math.max(512, Math.floor(remaining / 2)) : remaining;
  fitted.transcript = fitMessagesToBudget(fitted.transcript, finalTranscriptBudget, 'total_budget');
  if (fitted.contextTranscript) {
    fitted.contextTranscript = fitMessagesToBudget(fitted.contextTranscript, finalTranscriptBudget, 'total_budget');
  }
  fitted.messageCount = fitted.transcript.length;
  return fitted;
}
