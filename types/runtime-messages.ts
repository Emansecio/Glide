import type { RunPlan } from './plan.js';

export const RUNTIME_MESSAGE_SCHEMA_VERSION = 2 as const;

export type RuntimeMessageBase = {
  schemaVersion: typeof RUNTIME_MESSAGE_SCHEMA_VERSION;
  runId: string;
  sessionId: string;
  turnId?: string;
  timestamp: number;
};

export const toolFailureClasses = ['selector', 'timing', 'permission', 'navigation', 'unknown'] as const;
export type ToolFailureClass = (typeof toolFailureClasses)[number];

export const toolRecoveryStages = ['none', 'structure', 'retry', 'screenshot', 'vision'] as const;
export type ToolRecoveryStage = (typeof toolRecoveryStages)[number];

export const toolEvidenceConfidence = ['low', 'medium', 'high'] as const;
export type ToolEvidenceConfidence = (typeof toolEvidenceConfidence)[number];

export type AssistantStreamStart = RuntimeMessageBase & {
  type: 'assistant_stream_start';
};

export type AssistantStreamDelta = RuntimeMessageBase & {
  type: 'assistant_stream_delta';
  content: string;
  channel?: 'text' | 'reasoning';
};

export type AssistantStreamStop = RuntimeMessageBase & {
  type: 'assistant_stream_stop';
};

export type ToolExecutionStart = RuntimeMessageBase & {
  type: 'tool_execution_start';
  tool: string;
  id?: string;
  args: Record<string, unknown>;
};

export type ToolExecutionResult = RuntimeMessageBase & {
  type: 'tool_execution_result';
  tool: string;
  id?: string;
  args?: Record<string, unknown>;
  result: unknown;
  recoveryStage?: ToolRecoveryStage;
  evidenceConfidence?: ToolEvidenceConfidence;
  failureClass?: ToolFailureClass;
};

/** Nested tool event — inherits runId/sessionId/turnId from the batch envelope. */
export type ToolBatchEvent =
  | Pick<ToolExecutionStart, 'type' | 'tool' | 'id' | 'args'>
  | Pick<
      ToolExecutionResult,
      'type' | 'tool' | 'id' | 'args' | 'result' | 'recoveryStage' | 'evidenceConfidence' | 'failureClass'
    >;

export type ToolEventsBatch = RuntimeMessageBase & {
  type: 'tool_events_batch';
  events: ToolBatchEvent[];
};

export type PlanUpdate = RuntimeMessageBase & {
  type: 'plan_update';
  plan: RunPlan;
};

export type AssistantFinal = RuntimeMessageBase & {
  type: 'assistant_final';
  content: string;
  thinking?: string | null;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  contextUsage?: {
    approxTokens?: number;
    contextLimit?: number;
    percent?: number;
  };
  responseMessages?: Array<Record<string, unknown>>;
  qualityReport?: Record<string, unknown> | null;
};

export type RunQualityGate = RuntimeMessageBase & {
  type: 'run_quality_gate';
  state: 'passed' | 'blocked' | 'forced_retry';
  reason: string;
  details?: Record<string, unknown>;
};

export type RunError = RuntimeMessageBase & {
  type: 'run_error';
  message: string;
  /** `action: 'open_settings'` faz o painel oferecer um atalho para as Configurações. */
  details?: Record<string, unknown>;
};

export type RunWarning = RuntimeMessageBase & {
  type: 'run_warning';
  message: string;
  details?: Record<string, unknown>;
};

/** Parada deliberada pedida pelo usuário — não é erro, e a UI não deve alarmar. */
export type RunStopped = RuntimeMessageBase & {
  type: 'run_stopped';
  message: string;
  details?: Record<string, unknown>;
};

export type ContextCompacted = RuntimeMessageBase & {
  type: 'context_compacted';
  summary: string;
  trimmedCount: number;
  preservedCount: number;
  newSessionId: string;
  contextMessages: Array<Record<string, unknown>>;
  contextUsage?: {
    approxTokens?: number;
    contextLimit?: number;
    percent?: number;
  };
};

export type VisionContextReady = RuntimeMessageBase & {
  type: 'vision_context_ready';
  tool: string;
  id?: string;
  description: string;
  source?: 'recovery' | 'screenshot';
};

export type RuntimeMessage =
  | AssistantStreamStart
  | AssistantStreamDelta
  | AssistantStreamStop
  | ToolExecutionStart
  | ToolExecutionResult
  | ToolEventsBatch
  | PlanUpdate
  | AssistantFinal
  | RunQualityGate
  | RunError
  | RunWarning
  | RunStopped
  | ContextCompacted
  | VisionContextReady;

export const runtimeMessageTypes = [
  'assistant_stream_start',
  'assistant_stream_delta',
  'assistant_stream_stop',
  'tool_execution_start',
  'tool_execution_result',
  'tool_events_batch',
  'plan_update',
  'assistant_final',
  'run_quality_gate',
  'run_error',
  'run_warning',
  'run_stopped',
  'context_compacted',
  'vision_context_ready',
] as const;

export type RuntimeMessageType = (typeof runtimeMessageTypes)[number];

type RuntimeMessageValidationResult = { ok: true; message: RuntimeMessage } | { ok: false; reason: string };

type GenericRecord = Record<string, unknown>;

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is GenericRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown) => typeof value === 'string';
const isNonEmptyString = (value: unknown) => typeof value === 'string' && value.length > 0;
const isFiniteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const isOptionalString = (value: unknown) => value == null || typeof value === 'string';
const isOptionalRecord = (value: unknown) => value == null || isRecord(value);
const isOptionalArray = (value: unknown) => value == null || Array.isArray(value);

const isRunPlanLike = (value: unknown): value is RunPlan => {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.steps)) return false;
  if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt)) return false;
  return value.steps.every((step) => {
    if (!isRecord(step)) return false;
    return isNonEmptyString(step.id) && isNonEmptyString(step.title) && isString(step.status);
  });
};

const isUsageLike = (value: unknown) => {
  if (!isRecord(value)) return false;
  const keys = ['inputTokens', 'outputTokens', 'totalTokens'] as const;
  return keys.every((key) => value[key] === undefined || isFiniteNumber(value[key]));
};

const isContextUsageLike = (value: unknown) => {
  if (!isRecord(value)) return false;
  const keys = ['approxTokens', 'contextLimit', 'percent'] as const;
  return keys.every((key) => value[key] === undefined || isFiniteNumber(value[key]));
};

const validateToolBatchEvent = (
  event: unknown,
): RuntimeMessageValidationResult | { ok: true; event: ToolBatchEvent } => {
  if (!isRecord(event)) return { ok: false, reason: 'tool_events_batch event must be an object.' };
  const type = event.type;
  if (type === 'tool_execution_start') {
    if (!isNonEmptyString(event.tool)) return { ok: false, reason: 'tool_execution_start.tool is required.' };
    if (!isRecord(event.args)) return { ok: false, reason: 'tool_execution_start.args must be an object.' };
    if (event.id !== undefined && !isString(event.id))
      return { ok: false, reason: 'tool_execution_start.id must be a string.' };
    return { ok: true, event: event as ToolBatchEvent };
  }
  if (type === 'tool_execution_result') {
    if (!isNonEmptyString(event.tool)) return { ok: false, reason: 'tool_execution_result.tool is required.' };
    if (!hasOwn(event, 'result')) return { ok: false, reason: 'tool_execution_result.result is required.' };
    if (event.id !== undefined && !isString(event.id))
      return { ok: false, reason: 'tool_execution_result.id must be a string.' };
    if (event.args !== undefined && !isRecord(event.args))
      return { ok: false, reason: 'tool_execution_result.args must be an object.' };
    if (event.recoveryStage !== undefined && !toolRecoveryStages.includes(event.recoveryStage as ToolRecoveryStage)) {
      return { ok: false, reason: 'tool_execution_result.recoveryStage is invalid.' };
    }
    if (
      event.evidenceConfidence !== undefined &&
      !toolEvidenceConfidence.includes(event.evidenceConfidence as ToolEvidenceConfidence)
    ) {
      return { ok: false, reason: 'tool_execution_result.evidenceConfidence is invalid.' };
    }
    if (event.failureClass !== undefined && !toolFailureClasses.includes(event.failureClass as ToolFailureClass)) {
      return { ok: false, reason: 'tool_execution_result.failureClass is invalid.' };
    }
    return { ok: true, event: event as ToolBatchEvent };
  }
  return { ok: false, reason: 'tool_events_batch event type is invalid.' };
};

const validateToolEventsBatch = (message: GenericRecord): RuntimeMessageValidationResult => {
  if (!Array.isArray(message.events) || message.events.length === 0) {
    return { ok: false, reason: 'tool_events_batch.events must be a non-empty array.' };
  }
  for (const event of message.events) {
    const result = validateToolBatchEvent(event);
    if (!result.ok) return result;
  }
  return { ok: true, message: message as RuntimeMessage };
};

/** Validate each batch event individually; drop invalid entries instead of rejecting the batch. */
export function salvageToolEventsBatchEvents(events: unknown[]): ToolBatchEvent[] {
  if (!Array.isArray(events)) return [];
  const valid: ToolBatchEvent[] = [];
  for (const event of events) {
    const result = validateToolBatchEvent(event);
    if (result.ok && 'event' in result) valid.push(result.event);
  }
  return valid;
}

const validateRuntimeMessageShape = (message: GenericRecord): RuntimeMessageValidationResult => {
  const type = message.type;
  if (!isString(type)) return { ok: false, reason: 'Missing or invalid runtime message type.' };

  switch (type as RuntimeMessageType) {
    case 'assistant_stream_start':
    case 'assistant_stream_stop':
      return { ok: true, message: message as RuntimeMessage };
    case 'assistant_stream_delta':
      if (!isString(message.content)) {
        return { ok: false, reason: 'assistant_stream_delta.content must be a string.' };
      }
      if (message.channel !== undefined && message.channel !== 'text' && message.channel !== 'reasoning') {
        return { ok: false, reason: 'assistant_stream_delta.channel must be text or reasoning.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    case 'tool_execution_start':
      if (!isNonEmptyString(message.tool)) return { ok: false, reason: 'tool_execution_start.tool is required.' };
      if (!isRecord(message.args)) return { ok: false, reason: 'tool_execution_start.args must be an object.' };
      if (message.id !== undefined && !isString(message.id))
        return { ok: false, reason: 'tool_execution_start.id must be a string.' };
      return { ok: true, message: message as RuntimeMessage };
    case 'tool_execution_result':
      if (!isNonEmptyString(message.tool)) return { ok: false, reason: 'tool_execution_result.tool is required.' };
      if (!hasOwn(message, 'result')) return { ok: false, reason: 'tool_execution_result.result is required.' };
      if (message.id !== undefined && !isString(message.id))
        return { ok: false, reason: 'tool_execution_result.id must be a string.' };
      if (message.args !== undefined && !isRecord(message.args))
        return { ok: false, reason: 'tool_execution_result.args must be an object.' };
      if (
        message.recoveryStage !== undefined &&
        !toolRecoveryStages.includes(message.recoveryStage as ToolRecoveryStage)
      ) {
        return { ok: false, reason: 'tool_execution_result.recoveryStage is invalid.' };
      }
      if (
        message.evidenceConfidence !== undefined &&
        !toolEvidenceConfidence.includes(message.evidenceConfidence as ToolEvidenceConfidence)
      ) {
        return { ok: false, reason: 'tool_execution_result.evidenceConfidence is invalid.' };
      }
      if (
        message.failureClass !== undefined &&
        !toolFailureClasses.includes(message.failureClass as ToolFailureClass)
      ) {
        return { ok: false, reason: 'tool_execution_result.failureClass is invalid.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    case 'tool_events_batch':
      return validateToolEventsBatch(message);
    case 'plan_update':
      return isRunPlanLike(message.plan)
        ? { ok: true, message: message as RuntimeMessage }
        : { ok: false, reason: 'plan_update.plan is invalid.' };
    case 'assistant_final':
      if (!isString(message.content)) return { ok: false, reason: 'assistant_final.content must be a string.' };
      if (!isOptionalString(message.thinking))
        return { ok: false, reason: 'assistant_final.thinking must be string|null.' };
      if (message.model !== undefined && !isString(message.model))
        return { ok: false, reason: 'assistant_final.model must be a string.' };
      if (message.usage !== undefined && !isUsageLike(message.usage))
        return { ok: false, reason: 'assistant_final.usage is invalid.' };
      if (message.contextUsage !== undefined && !isContextUsageLike(message.contextUsage)) {
        return { ok: false, reason: 'assistant_final.contextUsage is invalid.' };
      }
      if (!isOptionalArray(message.responseMessages)) {
        return { ok: false, reason: 'assistant_final.responseMessages must be an array.' };
      }
      if (!isOptionalRecord(message.qualityReport)) {
        return { ok: false, reason: 'assistant_final.qualityReport must be object|null.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    case 'run_quality_gate':
      if (message.state !== 'passed' && message.state !== 'blocked' && message.state !== 'forced_retry') {
        return { ok: false, reason: 'run_quality_gate.state is invalid.' };
      }
      if (!isString(message.reason)) return { ok: false, reason: 'run_quality_gate.reason must be a string.' };
      if (message.details !== undefined && !isRecord(message.details)) {
        return { ok: false, reason: 'run_quality_gate.details must be an object.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    case 'run_error':
    case 'run_warning':
    case 'run_stopped':
      if (!isString(message.message)) return { ok: false, reason: `${type}.message must be a string.` };
      if (!isOptionalRecord(message.details)) return { ok: false, reason: `${type}.details must be an object.` };
      return { ok: true, message: message as RuntimeMessage };
    case 'context_compacted':
      if (!isString(message.summary)) return { ok: false, reason: 'context_compacted.summary must be a string.' };
      if (!isFiniteNumber(message.trimmedCount) || !isFiniteNumber(message.preservedCount)) {
        return { ok: false, reason: 'context_compacted counts are invalid.' };
      }
      if (!isNonEmptyString(message.newSessionId)) {
        return { ok: false, reason: 'context_compacted.newSessionId is required.' };
      }
      if (!Array.isArray(message.contextMessages)) {
        return { ok: false, reason: 'context_compacted.contextMessages must be an array.' };
      }
      if (message.contextUsage !== undefined && !isContextUsageLike(message.contextUsage)) {
        return { ok: false, reason: 'context_compacted.contextUsage is invalid.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    case 'vision_context_ready':
      if (!isNonEmptyString(message.tool) || !isNonEmptyString(message.description)) {
        return { ok: false, reason: 'vision_context_ready.tool and vision_context_ready.description are required.' };
      }
      if (message.id !== undefined && !isString(message.id)) {
        return { ok: false, reason: 'vision_context_ready.id must be a string.' };
      }
      if (message.source !== undefined && message.source !== 'recovery' && message.source !== 'screenshot') {
        return { ok: false, reason: 'vision_context_ready.source must be recovery or screenshot.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    default:
      return { ok: false, reason: `Unknown runtime message type: ${String(type)}` };
  }
};

export function validateRuntimeMessage(value: unknown): RuntimeMessageValidationResult {
  if (!isRecord(value)) return { ok: false, reason: 'Runtime message must be an object.' };
  const message = value;
  if (message.schemaVersion !== RUNTIME_MESSAGE_SCHEMA_VERSION) {
    return { ok: false, reason: 'Invalid runtime message schemaVersion.' };
  }
  if (!isString(message.type)) return { ok: false, reason: 'Missing runtime message type.' };
  if (!runtimeMessageTypes.includes(message.type as RuntimeMessageType)) {
    return { ok: false, reason: 'Unknown runtime message type.' };
  }
  if (!isNonEmptyString(message.runId)) return { ok: false, reason: 'Missing runtime message runId.' };
  if (!isNonEmptyString(message.sessionId)) return { ok: false, reason: 'Missing runtime message sessionId.' };
  if (!isFiniteNumber(message.timestamp)) return { ok: false, reason: 'Missing runtime message timestamp.' };
  if (message.turnId !== undefined && !isString(message.turnId)) {
    return { ok: false, reason: 'turnId must be a string if provided.' };
  }
  return validateRuntimeMessageShape(message);
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return validateRuntimeMessage(value).ok;
}

/** Panel → service worker: start or continue a chat turn. */
export type UserMessagePanel = {
  type: 'user_message';
  message: string;
  sessionId: string;
  /** Full model context — optional when the SW already holds this session (warm path). */
  conversationHistory?: Array<Record<string, unknown>>;
  selectedTabs?: unknown[];
  panelTabId?: number;
};

type UserMessagePanelValidationResult = { ok: true; message: UserMessagePanel } | { ok: false; reason: string };

const isConversationHistoryLike = (value: unknown) => {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => isRecord(entry));
};

export function validateUserMessagePanel(value: unknown): UserMessagePanelValidationResult {
  if (!isRecord(value)) return { ok: false, reason: 'user_message must be an object.' };
  if (value.type !== 'user_message') return { ok: false, reason: 'Expected user_message type.' };
  if (!isString(value.message)) return { ok: false, reason: 'user_message.message must be a string.' };
  if (!isNonEmptyString(value.sessionId)) return { ok: false, reason: 'user_message.sessionId is required.' };
  if (!isConversationHistoryLike(value.conversationHistory)) {
    return { ok: false, reason: 'user_message.conversationHistory must be an array when provided.' };
  }
  if (value.selectedTabs !== undefined && !Array.isArray(value.selectedTabs)) {
    return { ok: false, reason: 'user_message.selectedTabs must be an array when provided.' };
  }
  if (value.panelTabId !== undefined && !isFiniteNumber(value.panelTabId)) {
    return { ok: false, reason: 'user_message.panelTabId must be a number when provided.' };
  }
  return { ok: true, message: value as UserMessagePanel };
}

export function isUserMessagePanel(value: unknown): value is UserMessagePanel {
  return validateUserMessagePanel(value).ok;
}
