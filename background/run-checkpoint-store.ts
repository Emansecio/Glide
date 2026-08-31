import type { Message } from '../ai/message-schema.js';
import { cloneConversationHistory, normalizeConversationHistory } from '../ai/message-schema.js';
import type { SessionStorageArea } from './storage-access.js';
import { getSessionStorageArea } from './storage-access.js';
import type { RunCheckpoint, RunPhase } from './run-types.js';

export const ACTIVE_RUN_CHECKPOINT_KEY = 'glideActiveRunCheckpointV1';
export const RUN_RECOVERY_CONTEXT_KEY = 'glideRunRecoveryContextV1';
export const DEFAULT_MAX_CHECKPOINT_BYTES = 32 * 1024;
export const MAX_RECOVERY_CONTEXT_BYTES = 128 * 1024;

export type RunRecoveryContext = {
  version: 1;
  runId: string;
  sessionId: string;
  contextRevision: number;
  messages: Message[];
};

const TERMINAL_PHASES = new Set<RunPhase>(['awaiting_user', 'completed', 'failed', 'stopped', 'ambiguous']);
const PHASES = new Set<RunPhase>([
  'starting',
  'model',
  'action_prepared',
  'action_in_flight',
  'committing',
  'awaiting_user',
  'completed',
  'failed',
  'stopped',
  'ambiguous',
]);

export interface RunCheckpointStore {
  write(state: RunCheckpoint): Promise<void>;
  readActive(): Promise<RunCheckpoint | null>;
  clear(runId: string): Promise<void>;
  isResumeEnabled(): boolean;
}

const isCheckpoint = (value: unknown): value is RunCheckpoint => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const request = item.request as Record<string, unknown> | undefined;
  return (
    item.version === 1 &&
    typeof item.runId === 'string' &&
    typeof item.sessionId === 'string' &&
    typeof item.turnId === 'string' &&
    PHASES.has(item.phase as RunPhase) &&
    Number.isInteger(item.contextRevision) &&
    Number(item.contextRevision) >= 0 &&
    Array.isArray(item.selectedTabIds) &&
    item.selectedTabIds.every((id) => Number.isInteger(id)) &&
    Boolean(request) &&
    typeof request?.message === 'string' &&
    (request.panelTabId === undefined || Number.isInteger(request.panelTabId)) &&
    typeof item.startedAt === 'number' &&
    typeof item.updatedAt === 'number'
  );
};

const serializeBounded = (state: RunCheckpoint, maxBytes: number): RunCheckpoint => {
  const payload: RunCheckpoint = {
    version: 1,
    runId: state.runId,
    sessionId: state.sessionId,
    turnId: state.turnId,
    ...(state.resumedFromRunId ? { resumedFromRunId: state.resumedFromRunId } : {}),
    phase: state.phase,
    contextRevision: state.contextRevision,
    selectedTabIds: state.selectedTabIds.filter(Number.isInteger),
    request: {
      message: String(state.request.message || ''),
      ...(Number.isInteger(state.request.panelTabId) ? { panelTabId: state.request.panelTabId } : {}),
    },
    ...(state.terminalReason ? { terminalReason: state.terminalReason } : {}),
    ...(state.lastCommittedActionId ? { lastCommittedActionId: state.lastCommittedActionId } : {}),
    ...(state.inFlightAction ? { inFlightAction: { ...state.inFlightAction } } : {}),
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maxBytes) {
    throw new Error(`Checkpoint exceeds ${maxBytes} byte limit.`);
  }
  return payload;
};

export class RunCheckpointSessionStore implements RunCheckpointStore {
  private resumeEnabled = true;

  constructor(
    private storage: SessionStorageArea = getSessionStorageArea(),
    private options: { maxBytes?: number } = {},
  ) {}

  isResumeEnabled(): boolean {
    return this.resumeEnabled;
  }

  async write(state: RunCheckpoint): Promise<void> {
    if (!this.resumeEnabled) return;
    try {
      const payload = serializeBounded(state, this.options.maxBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES);
      await this.storage.set({ [ACTIVE_RUN_CHECKPOINT_KEY]: payload });
    } catch {
      this.resumeEnabled = false;
    }
  }

  async readActive(): Promise<RunCheckpoint | null> {
    try {
      const stored = await this.storage.get(ACTIVE_RUN_CHECKPOINT_KEY);
      const value = stored?.[ACTIVE_RUN_CHECKPOINT_KEY];
      if (!isCheckpoint(value)) {
        if (value !== undefined) await this.storage.remove(ACTIVE_RUN_CHECKPOINT_KEY);
        return null;
      }
      if (TERMINAL_PHASES.has(value.phase)) {
        await this.storage.remove(ACTIVE_RUN_CHECKPOINT_KEY);
        return null;
      }
      return serializeBounded(value, this.options.maxBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES);
    } catch {
      this.resumeEnabled = false;
      return null;
    }
  }

  async writeRecoveryContext(snapshot: RunRecoveryContext): Promise<boolean> {
    try {
      const messages = normalizeConversationHistory(snapshot.messages);
      const serialized = JSON.stringify(messages);
      if (
        new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_CONTEXT_BYTES ||
        /data:image|;base64,/i.test(serialized) ||
        messages.some((message) => message.role === 'tool')
      ) {
        return false;
      }
      await this.storage.set({
        [RUN_RECOVERY_CONTEXT_KEY]: {
          version: 1,
          runId: snapshot.runId,
          sessionId: snapshot.sessionId,
          contextRevision: snapshot.contextRevision,
          messages,
        },
      });
      return true;
    } catch {
      this.resumeEnabled = false;
      return false;
    }
  }

  async readRecoveryContext(runId: string): Promise<RunRecoveryContext | null> {
    try {
      const stored = await this.storage.get(RUN_RECOVERY_CONTEXT_KEY);
      const value = stored?.[RUN_RECOVERY_CONTEXT_KEY];
      if (!value || typeof value !== 'object') return null;
      const snapshot = value as RunRecoveryContext;
      if (
        snapshot.version !== 1 ||
        snapshot.runId !== runId ||
        typeof snapshot.sessionId !== 'string' ||
        !Number.isInteger(snapshot.contextRevision) ||
        !Array.isArray(snapshot.messages)
      ) {
        return null;
      }
      return { ...snapshot, messages: cloneConversationHistory(snapshot.messages) };
    } catch {
      return null;
    }
  }

  async clear(runId: string): Promise<void> {
    try {
      const stored = await this.storage.get([ACTIVE_RUN_CHECKPOINT_KEY, RUN_RECOVERY_CONTEXT_KEY]);
      const checkpoint = stored?.[ACTIVE_RUN_CHECKPOINT_KEY];
      const recoveryContext = stored?.[RUN_RECOVERY_CONTEXT_KEY];
      const removals: string[] = [];
      if (!checkpoint || (typeof checkpoint === 'object' && (checkpoint as { runId?: string }).runId === runId)) {
        removals.push(ACTIVE_RUN_CHECKPOINT_KEY);
      }
      if (
        !recoveryContext ||
        (typeof recoveryContext === 'object' && (recoveryContext as { runId?: string }).runId === runId)
      ) {
        removals.push(RUN_RECOVERY_CONTEXT_KEY);
      }
      if (removals.length) await this.storage.remove(removals);
    } catch {
      this.resumeEnabled = false;
    }
  }
}
