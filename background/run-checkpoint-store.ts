import type { Message } from '../ai/message-schema.js';
import { cloneConversationHistory, normalizeConversationHistory } from '../ai/message-schema.js';
import type { RunCheckpoint, RunPhase } from './run-types.js';
import type { SessionStorageArea } from './storage-access.js';
import { getSessionStorageArea } from './storage-access.js';

export const ACTIVE_RUN_CHECKPOINT_KEY = 'glideActiveRunCheckpointV1';
export const RUN_RECOVERY_CONTEXT_KEY = 'glideRunRecoveryContextV1';
const DEFAULT_MAX_CHECKPOINT_BYTES = 32 * 1024;
const MAX_RECOVERY_CONTEXT_BYTES = 128 * 1024;

type RunRecoveryLossKind = 'sensitive_redaction' | 'binary_redaction' | 'total_byte_limit';

type RunRecoveryLossReason = {
  kind: RunRecoveryLossKind;
  messageIndex?: number;
  path?: string;
  originalBytes?: number;
  maxBytes?: number;
};

export type RunRecoveryLoss = {
  lossy: true;
  reasons: RunRecoveryLossReason[];
  omittedReasonCount?: number;
};

export type RunRecoveryContext = {
  version: 1;
  runId: string;
  sessionId: string;
  contextRevision: number;
  lastCommittedActionId?: string;
  messages: Message[];
  loss?: RunRecoveryLoss;
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

const RECOVERY_SENSITIVE_KEY_RE =
  /apikey|api_key|token|secret|password|authorization|credential|cookie|csrftoken|set-cookie/i;
const RECOVERY_IMAGE_KEY_RE = /^(dataurl|image|screenshot)$/i;

const MAX_RECOVERY_LOSS_REASONS = 32;
const MAX_RECOVERY_LOSS_PATH_CHARS = 240;

type RecoveryLossCollector = { reasons: RunRecoveryLossReason[]; omittedReasonCount: number };

const addRecoveryLoss = (collector: RecoveryLossCollector, reason: RunRecoveryLossReason): void => {
  if (collector.reasons.length >= MAX_RECOVERY_LOSS_REASONS) {
    collector.omittedReasonCount += 1;
    return;
  }
  collector.reasons.push({
    ...reason,
    ...(reason.path ? { path: reason.path.slice(0, MAX_RECOVERY_LOSS_PATH_CHARS) } : {}),
  });
};

const redactRecoveryValue = (
  value: unknown,
  collector: RecoveryLossCollector,
  messageIndex: number,
  path: string,
  key = '',
  parentType = '',
): unknown => {
  if (typeof value === 'string') {
    const sensitive = RECOVERY_SENSITIVE_KEY_RE.test(key);
    const binary =
      RECOVERY_IMAGE_KEY_RE.test(key) ||
      (key === 'data' && /base64/i.test(parentType)) ||
      /^data:[^;]+;base64,/i.test(value) ||
      /;base64,/i.test(value);
    if (sensitive || binary) {
      addRecoveryLoss(collector, {
        kind: sensitive ? 'sensitive_redaction' : 'binary_redaction',
        messageIndex,
        path,
      });
      return `<redacted:${value.length} chars>`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactRecoveryValue(item, collector, messageIndex, `${path}[${index}]`, key, parentType),
    );
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : parentType;
  return Object.fromEntries(
    Object.entries(record).map(([nestedKey, nestedValue]) => [
      nestedKey,
      redactRecoveryValue(
        nestedValue,
        collector,
        messageIndex,
        path ? `${path}.${nestedKey}` : nestedKey,
        nestedKey,
        type,
      ),
    ]),
  );
};

const sanitizeRecoveryMessages = (messages: Message[]): { messages: Message[]; loss?: RunRecoveryLoss } => {
  const normalized = normalizeConversationHistory(messages);
  const collector: RecoveryLossCollector = { reasons: [], omittedReasonCount: 0 };
  const sanitized = normalized.map(
    (message, messageIndex) =>
      redactRecoveryValue(message, collector, messageIndex, `messages[${messageIndex}]`) as Message,
  );
  if (collector.reasons.length === 0 && collector.omittedReasonCount === 0) return { messages: sanitized };
  return {
    messages: sanitized,
    loss: {
      lossy: true,
      reasons: collector.reasons,
      ...(collector.omittedReasonCount > 0 ? { omittedReasonCount: collector.omittedReasonCount } : {}),
    },
  };
};

const serializedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const isRecoveryLoss = (value: unknown): value is RunRecoveryLoss => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const loss = value as RunRecoveryLoss;
  if (loss.lossy !== true || !Array.isArray(loss.reasons) || loss.reasons.length === 0) return false;
  return loss.reasons.every(
    (reason) =>
      reason &&
      typeof reason === 'object' &&
      (reason.kind === 'sensitive_redaction' ||
        reason.kind === 'binary_redaction' ||
        reason.kind === 'total_byte_limit'),
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
      // A mensagem completa vive no recovery context; um prompt grande não pode estourar o limite do
      // checkpoint e desligar a recuperação de todos os runs seguintes deste worker.
      message: String(state.request.message || '').slice(0, 6000),
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
    private options: { maxBytes?: number; maxRecoveryContextBytes?: number } = {},
  ) {}

  isResumeEnabled(): boolean {
    return this.resumeEnabled;
  }

  private async clearActiveRecoveryState(): Promise<void> {
    try {
      await this.storage.remove([ACTIVE_RUN_CHECKPOINT_KEY, RUN_RECOVERY_CONTEXT_KEY]);
    } catch {
      // Storage is unavailable; later persistence attempts retry cleanup.
    }
  }

  private async disableResume(): Promise<void> {
    this.resumeEnabled = false;
    await this.clearActiveRecoveryState();
  }

  async write(state: RunCheckpoint): Promise<void> {
    if (!this.resumeEnabled) {
      await this.clearActiveRecoveryState();
      return;
    }
    try {
      const payload = serializeBounded(state, this.options.maxBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES);
      await this.storage.set({ [ACTIVE_RUN_CHECKPOINT_KEY]: payload });
    } catch {
      await this.disableResume();
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
    if (!this.resumeEnabled) {
      await this.clearActiveRecoveryState();
      return false;
    }
    try {
      const maxBytes = this.options.maxRecoveryContextBytes ?? MAX_RECOVERY_CONTEXT_BYTES;
      const sanitized = sanitizeRecoveryMessages(snapshot.messages);
      let payload: RunRecoveryContext = {
        version: 1,
        runId: snapshot.runId,
        sessionId: snapshot.sessionId,
        contextRevision: snapshot.contextRevision,
        ...(snapshot.lastCommittedActionId ? { lastCommittedActionId: snapshot.lastCommittedActionId } : {}),
        messages: sanitized.messages,
        ...(sanitized.loss ? { loss: sanitized.loss } : {}),
      };
      const originalBytes = serializedBytes(payload);
      if (originalBytes > maxBytes) {
        payload = {
          version: 1,
          runId: snapshot.runId,
          sessionId: snapshot.sessionId,
          contextRevision: snapshot.contextRevision,
          ...(snapshot.lastCommittedActionId ? { lastCommittedActionId: snapshot.lastCommittedActionId } : {}),
          messages: [],
          loss: {
            lossy: true,
            reasons: [{ kind: 'total_byte_limit', originalBytes, maxBytes }],
            ...(sanitized.loss
              ? { omittedReasonCount: sanitized.loss.reasons.length + (sanitized.loss.omittedReasonCount || 0) }
              : {}),
          },
        };
      }
      if (serializedBytes(payload) > maxBytes) {
        await this.disableResume();
        return false;
      }
      await this.storage.set({ [RUN_RECOVERY_CONTEXT_KEY]: payload });
      return true;
    } catch {
      await this.disableResume();
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
        !Array.isArray(snapshot.messages) ||
        (snapshot.loss !== undefined && !isRecoveryLoss(snapshot.loss))
      ) {
        return null;
      }
      return {
        version: 1,
        runId: snapshot.runId,
        sessionId: snapshot.sessionId,
        contextRevision: snapshot.contextRevision,
        ...(typeof snapshot.lastCommittedActionId === 'string'
          ? { lastCommittedActionId: snapshot.lastCommittedActionId }
          : {}),
        messages: cloneConversationHistory(snapshot.messages),
        ...(snapshot.loss ? { loss: snapshot.loss } : {}),
      };
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
