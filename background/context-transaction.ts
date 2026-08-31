import { type Message, cloneConversationHistory, normalizeConversationHistory } from '../ai/message-schema.js';
import { MAX_SESSION_CONTEXT_STORE_SIZE } from './session-context-store.js';

export type ContextUsage = {
  approxTokens?: number;
  contextLimit?: number;
  percent?: number;
};

export type ContextCommit = {
  sessionId: string;
  previousSessionId?: string;
  revision: number;
  runId: string;
  turnId: string;
  messages: Message[];
  compacted: boolean;
  contextUsage: ContextUsage;
};

export type ContextCommitInput = Omit<ContextCommit, 'revision'> & { sourceRevision: number };

export function shouldDiscardCompactionAttempt(input: {
  abortSignal?: AbortSignal;
  timedOut: boolean;
  errorIsAbort: boolean;
}): boolean {
  return input.abortSignal?.aborted === true || (input.errorIsAbort && !input.timedOut);
}

export function canApplyCompactionResult(input: {
  abortSignal?: AbortSignal;
  runOwned: boolean;
  tombstoned: boolean;
  generationMatches: boolean;
  sourceRevision: number;
  currentRevision: number;
}): boolean {
  return (
    input.abortSignal?.aborted !== true &&
    input.runOwned &&
    !input.tombstoned &&
    input.generationMatches &&
    input.sourceRevision === input.currentRevision
  );
}

type SessionSnapshot = { revision: number; messages: Message[] };
type TerminalCommitRecord = { fingerprint: string; revision: number; commit?: ContextCommit };

export type ContextLineageAdoption = {
  accepted: boolean;
  state: 'cold_adopted' | 'warm_confirmed' | 'revision_mismatch';
  revision: number;
};

export type ContextTransactionRetentionOptions = {
  maxSessions?: number;
  maxTerminalDigests?: number;
  maxTerminalPayloads?: number;
};

export const MAX_CONTEXT_TRANSACTION_TERMINAL_DIGESTS = 100;
export const MAX_CONTEXT_TRANSACTION_TERMINAL_PAYLOADS = 8;

const cloneCommit = (commit: ContextCommit): ContextCommit => ({
  ...commit,
  messages: cloneConversationHistory(commit.messages),
  contextUsage: { ...commit.contextUsage },
});

const digestText = (text: string): string => {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${text.length}:${(left >>> 0).toString(16)}:${(right >>> 0).toString(16)}`;
};

// Full history is serialized only transiently. Retained idempotency state is fixed-size digest metadata.
const commitFingerprint = (input: ContextCommitInput): string => digestText(JSON.stringify(input));

const positiveLimit = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;

export class ContextTransactionStore {
  private sessions = new Map<string, SessionSnapshot>();
  private sessionAccessOrder: string[] = [];
  private terminalCommits = new Map<string, TerminalCommitRecord>();
  private readonly maxSessions: number;
  private readonly maxTerminalDigests: number;
  private readonly maxTerminalPayloads: number;

  constructor(options: ContextTransactionRetentionOptions = {}) {
    this.maxSessions = positiveLimit(options.maxSessions, MAX_SESSION_CONTEXT_STORE_SIZE);
    this.maxTerminalDigests = positiveLimit(options.maxTerminalDigests, MAX_CONTEXT_TRANSACTION_TERMINAL_DIGESTS);
    this.maxTerminalPayloads = Math.min(
      this.maxTerminalDigests,
      positiveLimit(options.maxTerminalPayloads, MAX_CONTEXT_TRANSACTION_TERMINAL_PAYLOADS),
    );
  }

  private touchSession(sessionId: string): void {
    this.sessionAccessOrder = this.sessionAccessOrder.filter((id) => id !== sessionId);
    this.sessionAccessOrder.push(sessionId);
  }

  private setSession(sessionId: string, snapshot: SessionSnapshot): void {
    this.sessions.set(sessionId, snapshot);
    this.touchSession(sessionId);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessionAccessOrder.shift();
      if (oldest) this.sessions.delete(oldest);
      else break;
    }
  }

  private retainTerminal(terminalKey: string, record: TerminalCommitRecord): void {
    this.terminalCommits.delete(terminalKey);
    this.terminalCommits.set(terminalKey, record);
    while (this.terminalCommits.size > this.maxTerminalDigests) {
      const oldest = this.terminalCommits.keys().next().value;
      if (typeof oldest === 'string') this.terminalCommits.delete(oldest);
      else break;
    }
    let payloadsToRelease =
      [...this.terminalCommits.values()].filter((item) => item.commit).length - this.maxTerminalPayloads;
    if (payloadsToRelease <= 0) return;
    for (const retained of this.terminalCommits.values()) {
      if (!retained.commit) continue;
      retained.commit = undefined;
      payloadsToRelease -= 1;
      if (payloadsToRelease === 0) break;
    }
  }

  hydrate(sessionId: string, revision: number, messages: Message[]): void {
    const id = String(sessionId || '').trim();
    if (!id || !Number.isInteger(revision) || revision < 0) return;
    const current = this.sessions.get(id);
    if (current && current.revision > revision) return;
    this.setSession(id, {
      revision,
      messages: cloneConversationHistory(normalizeConversationHistory(messages)),
    });
  }

  /** Adopts panel-owned history only when its explicit revision matches this lineage. */
  adoptLineage(sessionId: string, revision: number, messages: Message[]): ContextLineageAdoption {
    const id = String(sessionId || '').trim();
    const current = this.sessions.get(id);
    const currentRevision = current?.revision ?? 0;
    if (!id || !Number.isInteger(revision) || revision < 0 || (current && currentRevision !== revision)) {
      return { accepted: false, state: 'revision_mismatch', revision: currentRevision };
    }

    const state = current ? 'warm_confirmed' : 'cold_adopted';
    this.setSession(id, {
      revision,
      messages: cloneConversationHistory(normalizeConversationHistory(messages)),
    });
    return { accepted: true, state, revision };
  }

  read(sessionId: string): SessionSnapshot {
    const id = String(sessionId || '').trim();
    const snapshot = this.sessions.get(id);
    if (snapshot) this.touchSession(id);
    return snapshot
      ? { revision: snapshot.revision, messages: cloneConversationHistory(snapshot.messages) }
      : { revision: 0, messages: [] };
  }

  commit(input: ContextCommitInput): ContextCommit {
    const sessionId = String(input.sessionId || '').trim();
    const runId = String(input.runId || '').trim();
    const turnId = String(input.turnId || '').trim();
    if (!sessionId || !runId || !turnId) throw new Error('Context commit requires sessionId, runId, and turnId.');
    if (!Number.isInteger(input.sourceRevision) || input.sourceRevision < 0) {
      throw new Error('Context commit sourceRevision must be a non-negative integer.');
    }
    const normalizedInput = { ...input, sessionId, runId, turnId };
    const terminalKey = `${runId}\0${turnId}`;
    const fingerprint = commitFingerprint(normalizedInput);
    const prior = this.terminalCommits.get(terminalKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error(`Context already committed for run ${runId}, turn ${turnId}.`);
      }
      const retainedSession = this.sessions.get(sessionId);
      const duplicateMessages =
        retainedSession?.revision === prior.revision
          ? retainedSession.messages
          : normalizeConversationHistory(normalizedInput.messages);
      const duplicate = prior.commit ?? this.buildCommit(normalizedInput, prior.revision, duplicateMessages);
      this.retainTerminal(terminalKey, { ...prior, ...(prior.commit ? { commit: prior.commit } : {}) });
      return cloneCommit(duplicate);
    }

    const sourceSessionId = String(input.previousSessionId || sessionId).trim();
    const source = this.read(sourceSessionId);
    if (source.revision !== input.sourceRevision) {
      throw new Error(`Stale source revision: expected ${source.revision}, received ${input.sourceRevision}.`);
    }
    const messages = normalizeConversationHistory(input.messages);
    const commit = this.buildCommit(normalizedInput, source.revision + 1, messages);
    this.setSession(sessionId, { revision: commit.revision, messages: cloneConversationHistory(messages) });
    this.retainTerminal(terminalKey, { fingerprint, revision: commit.revision, commit: cloneCommit(commit) });
    return cloneCommit(commit);
  }

  private buildCommit(input: ContextCommitInput, revision: number, messages: Message[]): ContextCommit {
    return {
      sessionId: input.sessionId,
      ...(input.previousSessionId ? { previousSessionId: input.previousSessionId } : {}),
      revision,
      runId: input.runId,
      turnId: input.turnId,
      messages: cloneConversationHistory(messages),
      compacted: input.compacted,
      contextUsage: { ...input.contextUsage },
    };
  }

  releaseTerminalCommitPayload(runId: string, turnId: string): void {
    const record = this.terminalCommits.get(`${String(runId || '').trim()}\0${String(turnId || '').trim()}`);
    if (record) record.commit = undefined;
  }

  /** Test-only bounded-retention introspection. */
  retentionCardinality(): { sessions: number; terminalDigests: number; terminalPayloads: number } {
    return {
      sessions: this.sessions.size,
      terminalDigests: this.terminalCommits.size,
      terminalPayloads: [...this.terminalCommits.values()].filter((record) => record.commit).length,
    };
  }
}

export const contextTransactionStore = new ContextTransactionStore();
