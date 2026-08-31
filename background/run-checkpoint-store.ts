import type { SessionStorageArea } from './storage-access.js';
import { getSessionStorageArea } from './storage-access.js';
import type { RunCheckpoint, RunPhase } from './run-types.js';

export const ACTIVE_RUN_CHECKPOINT_KEY = 'glideActiveRunCheckpointV1';
export const DEFAULT_MAX_CHECKPOINT_BYTES = 32 * 1024;

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

  async clear(runId: string): Promise<void> {
    try {
      const stored = await this.storage.get(ACTIVE_RUN_CHECKPOINT_KEY);
      const value = stored?.[ACTIVE_RUN_CHECKPOINT_KEY];
      if (!value || (typeof value === 'object' && (value as { runId?: string }).runId === runId)) {
        await this.storage.remove(ACTIVE_RUN_CHECKPOINT_KEY);
      }
    } catch {
      this.resumeEnabled = false;
    }
  }
}
