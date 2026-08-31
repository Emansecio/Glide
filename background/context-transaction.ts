import { type Message, cloneConversationHistory, normalizeConversationHistory } from '../ai/message-schema.js';

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

const cloneCommit = (commit: ContextCommit): ContextCommit => ({
  ...commit,
  messages: cloneConversationHistory(commit.messages),
  contextUsage: { ...commit.contextUsage },
});

const commitFingerprint = (input: ContextCommitInput): string => JSON.stringify(input);

export class ContextTransactionStore {
  private sessions = new Map<string, SessionSnapshot>();
  private terminalCommits = new Map<string, { fingerprint: string; commit: ContextCommit }>();

  read(sessionId: string): SessionSnapshot {
    const snapshot = this.sessions.get(String(sessionId || '').trim());
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
    const terminalKey = `${runId}\0${turnId}`;
    const fingerprint = commitFingerprint({ ...input, sessionId, runId, turnId });
    const prior = this.terminalCommits.get(terminalKey);
    if (prior) {
      if (prior.fingerprint === fingerprint) return cloneCommit(prior.commit);
      throw new Error(`Context already committed for run ${runId}, turn ${turnId}.`);
    }

    const sourceSessionId = String(input.previousSessionId || sessionId).trim();
    const source = this.read(sourceSessionId);
    if (source.revision !== input.sourceRevision) {
      throw new Error(`Stale source revision: expected ${source.revision}, received ${input.sourceRevision}.`);
    }
    const messages = normalizeConversationHistory(input.messages);
    const commit: ContextCommit = {
      sessionId,
      ...(input.previousSessionId ? { previousSessionId: input.previousSessionId } : {}),
      revision: source.revision + 1,
      runId,
      turnId,
      messages: cloneConversationHistory(messages),
      compacted: input.compacted,
      contextUsage: { ...input.contextUsage },
    };
    this.sessions.set(sessionId, { revision: commit.revision, messages: cloneConversationHistory(messages) });
    this.terminalCommits.set(terminalKey, { fingerprint, commit: cloneCommit(commit) });
    return cloneCommit(commit);
  }
}

export const contextTransactionStore = new ContextTransactionStore();
