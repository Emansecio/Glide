import type { ChatSessionPayload } from './history-storage.js';

type TruncationMeta = {
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
  // Total corrente: medir o array inteiro a cada mensagem era O(n²) (segundos de freeze da UI
  // ao fim de cada run em sessões longas). Só a mensagem alterada é re-medida.
  let total = measureStoredBytes(fitted);
  if (total <= maxBytes) return fitted;

  for (const message of fitted as any[]) {
    const before = measureStoredBytes([message]);
    if (compactToolMessage(message)) {
      total += measureStoredBytes([message]) - before;
      if (total <= maxBytes) return fitted;
    }
  }

  for (const message of fitted as any[]) {
    const overflow = total - maxBytes;
    if (overflow <= 0) break;
    const before = measureStoredBytes([message]);
    truncateMessageText(message, overflow + 256, reason);
    total += measureStoredBytes([message]) - before;
  }

  while (total > maxBytes && fitted.length > 1) {
    const removed = fitted.shift();
    // [a,b,...] -> [b,...]: remove o tamanho de `a` mais a vírgula.
    total -= measureStoredBytes([removed]) - 1;
  }
  if (measureStoredBytes(fitted) > maxBytes && fitted.length === 1) {
    const message = fitted[0] as any;
    while (measureStoredBytes(fitted) > maxBytes && truncateMessageText(message, 512, reason)) {
      // bounded by shrinking content at least 512 chars per iteration
    }
  }
  return fitted;
}

function allocateTranscriptBudgets(
  displayBytes: number,
  contextBytes: number,
  availableBytes: number,
): [number, number] {
  const half = Math.floor(availableBytes / 2);
  let displayBudget = Math.min(displayBytes, half);
  let contextBudget = Math.min(contextBytes, half);
  let remaining = Math.max(0, availableBytes - displayBudget - contextBudget);

  const displayNeed = Math.max(0, displayBytes - displayBudget);
  const contextNeed = Math.max(0, contextBytes - contextBudget);
  if (displayNeed > 0 && contextNeed > 0) {
    const displayShare = Math.min(displayNeed, Math.floor(remaining / 2));
    displayBudget += displayShare;
    remaining -= displayShare;
  }
  const contextShare = Math.min(contextBytes - contextBudget, remaining);
  contextBudget += contextShare;
  remaining -= contextShare;
  displayBudget += Math.min(displayBytes - displayBudget, remaining);
  return [displayBudget, contextBudget];
}

/** Fits display + context history without fixed per-field caps. Recent text is final fallback. */
export function fitSessionToBudget(session: StoredSession, maxBytes: number): StoredSession {
  const budget = Math.max(1024, Math.floor(maxBytes));
  const fitted = clone(session);
  const hasDistinctContext =
    Array.isArray(fitted.contextTranscript) &&
    JSON.stringify(fitted.contextTranscript) !== JSON.stringify(fitted.transcript);
  if (!hasDistinctContext) fitted.contextTranscript = undefined;
  fitted.messageCount = fitted.transcript.length;

  // Full transcripts remain authoritative until serialized session actually exceeds its budget.
  let sessionBytes = measureStoredBytes(fitted);
  if (sessionBytes <= budget) return fitted;

  const messageSets = [fitted.transcript, ...(fitted.contextTranscript ? [fitted.contextTranscript] : [])];
  for (const messages of messageSets) {
    for (const message of messages as any[]) {
      const before = measureStoredBytes([message]);
      if (compactToolMessage(message)) {
        sessionBytes += measureStoredBytes([message]) - before;
        if (sessionBytes <= budget) return fitted;
      }
    }
  }

  if (!fitted.contextTranscript) {
    const shell = { ...fitted, transcript: [] };
    const transcriptBudget = Math.max(128, budget - measureStoredBytes(shell) + 2);
    fitted.transcript = fitMessagesToBudget(fitted.transcript, transcriptBudget, 'session_budget');
  } else {
    const shell = { ...fitted, transcript: [], contextTranscript: [] };
    const available = Math.max(256, budget - measureStoredBytes(shell) + 4);
    const [displayBudget, contextBudget] = allocateTranscriptBudgets(
      measureStoredBytes(fitted.transcript),
      measureStoredBytes(fitted.contextTranscript),
      available,
    );
    fitted.transcript = fitMessagesToBudget(fitted.transcript, displayBudget, 'session_budget');
    fitted.contextTranscript = fitMessagesToBudget(fitted.contextTranscript, contextBudget, 'session_budget');
  }
  fitted.messageCount = fitted.transcript.length;

  // JSON metadata overhead can shift while truncation markers are added; remove only remaining overflow.
  for (let attempt = 0; attempt < 4 && measureStoredBytes(fitted) > budget; attempt += 1) {
    const overflow = measureStoredBytes(fitted) - budget;
    const displayBytes = measureStoredBytes(fitted.transcript);
    const contextBytes = fitted.contextTranscript ? measureStoredBytes(fitted.contextTranscript) : 0;
    if (contextBytes > displayBytes && fitted.contextTranscript) {
      fitted.contextTranscript = fitMessagesToBudget(
        fitted.contextTranscript,
        Math.max(128, contextBytes - overflow - 128),
        'total_budget',
      );
    } else {
      fitted.transcript = fitMessagesToBudget(
        fitted.transcript,
        Math.max(128, displayBytes - overflow - 128),
        'total_budget',
      );
      fitted.messageCount = fitted.transcript.length;
    }
  }
  return fitted;
}
