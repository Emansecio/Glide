import type { RunPlan } from './plan.js';

export const RUNTIME_MESSAGE_SCHEMA_VERSION = 2 as const;

export type RuntimeMessageBase = {
  schemaVersion: typeof RUNTIME_MESSAGE_SCHEMA_VERSION;
  runId: string;
  sessionId: string;
  turnId?: string;
  timestamp: number;
};

export const runStatusPhases = ['planning', 'executing', 'finalizing', 'completed', 'stopped', 'failed'] as const;

export type RunPhase = (typeof runStatusPhases)[number];

export type RetryCounts = {
  api: number;
  tool: number;
  finalize: number;
};

export const toolFailureClasses = ['selector', 'timing', 'permission', 'navigation', 'unknown'] as const;
export type ToolFailureClass = (typeof toolFailureClasses)[number];

export const toolRecoveryStages = ['none', 'structure', 'retry', 'screenshot', 'vision'] as const;
export type ToolRecoveryStage = (typeof toolRecoveryStages)[number];

export const toolEvidenceConfidence = ['low', 'medium', 'high'] as const;
export type ToolEvidenceConfidence = (typeof toolEvidenceConfidence)[number];

export type UserRunStart = RuntimeMessageBase & {
  type: 'user_run_start';
  message: string;
};

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

export type PlanUpdate = RuntimeMessageBase & {
  type: 'plan_update';
  plan: RunPlan;
};

export type ManualPlanUpdate = RuntimeMessageBase & {
  type: 'manual_plan_update';
  steps: Array<{
    title: string;
    status?: 'pending' | 'running' | 'done' | 'blocked';
    notes?: string;
  }>;
};

export type RunStatus = RuntimeMessageBase & {
  type: 'run_status';
  phase: RunPhase;
  attempts: RetryCounts;
  maxRetries: RetryCounts;
  lastError?: string;
  note?: string;
};

export type AssistantResponse = RuntimeMessageBase & {
  type: 'assistant_response';
  content: string;
  thinking?: string | null;
  model?: string;
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
};

export type RunWarning = RuntimeMessageBase & {
  type: 'run_warning';
  message: string;
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

export type SubagentStart = RuntimeMessageBase & {
  type: 'subagent_start';
  id: string;
  name: string;
  tasks?: string[];
  parentRunId?: string;
};

export type SubagentComplete = RuntimeMessageBase & {
  type: 'subagent_complete';
  id: string;
  success: boolean;
  summary?: string;
  parentRunId?: string;
};

export type RuntimeMessage =
  | UserRunStart
  | AssistantStreamStart
  | AssistantStreamDelta
  | AssistantStreamStop
  | ToolExecutionStart
  | ToolExecutionResult
  | PlanUpdate
  | ManualPlanUpdate
  | RunStatus
  | AssistantResponse
  | AssistantFinal
  | RunQualityGate
  | RunError
  | RunWarning
  | ContextCompacted
  | SubagentStart
  | SubagentComplete;

export const runtimeMessageTypes = [
  'user_run_start',
  'assistant_stream_start',
  'assistant_stream_delta',
  'assistant_stream_stop',
  'tool_execution_start',
  'tool_execution_result',
  'plan_update',
  'manual_plan_update',
  'run_status',
  'assistant_response',
  'assistant_final',
  'run_quality_gate',
  'run_error',
  'run_warning',
  'context_compacted',
  'subagent_start',
  'subagent_complete',
] as const;

export type RuntimeMessageType = (typeof runtimeMessageTypes)[number];

type RuntimeMessageValidationResult =
  | { ok: true; message: RuntimeMessage }
  | { ok: false; reason: string };

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

const isRetryCounts = (value: unknown): value is RetryCounts => {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.api) && isFiniteNumber(value.tool) && isFiniteNumber(value.finalize);
};

const isRunPlanLike = (value: unknown): value is RunPlan => {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.steps)) return false;
  if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt)) return false;
  return value.steps.every((step) => {
    if (!isRecord(step)) return false;
    return isNonEmptyString(step.id) && isNonEmptyString(step.title) && isString(step.status);
  });
};

const isManualPlanStepArray = (value: unknown) => {
  if (!Array.isArray(value)) return false;
  return value.every((step) => {
    if (!isRecord(step)) return false;
    if (!isNonEmptyString(step.title)) return false;
    if (step.status !== undefined && typeof step.status !== 'string') return false;
    if (step.notes !== undefined && typeof step.notes !== 'string') return false;
    return true;
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

const validateRuntimeMessageShape = (message: GenericRecord): RuntimeMessageValidationResult => {
  const type = message.type;
  if (!isString(type)) return { ok: false, reason: 'Missing or invalid runtime message type.' };

  switch (type as RuntimeMessageType) {
    case 'user_run_start':
      return isString(message.message)
        ? { ok: true, message: message as RuntimeMessage }
        : { ok: false, reason: 'user_run_start.message must be a string.' };
    case 'assistant_stream_start':
    case 'assistant_stream_stop':
      return { ok: true, message: message as RuntimeMessage };
    case 'assistant_stream_delta':
      if (!isString(message.content)) {
        return { ok: false, reason: 'assistant_stream_delta.content must be a string.' };
      }
      if (
        message.channel !== undefined &&
        message.channel !== 'text' &&
        message.channel !== 'reasoning'
      ) {
        return { ok: false, reason: 'assistant_stream_delta.channel must be text or reasoning.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    case 'tool_execution_start':
      if (!isNonEmptyString(message.tool)) return { ok: false, reason: 'tool_execution_start.tool is required.' };
      if (!isRecord(message.args)) return { ok: false, reason: 'tool_execution_start.args must be an object.' };
      if (message.id !== undefined && !isString(message.id)) return { ok: false, reason: 'tool_execution_start.id must be a string.' };
      return { ok: true, message: message as RuntimeMessage };
    case 'tool_execution_result':
      if (!isNonEmptyString(message.tool)) return { ok: false, reason: 'tool_execution_result.tool is required.' };
      if (!hasOwn(message, 'result')) return { ok: false, reason: 'tool_execution_result.result is required.' };
      if (message.id !== undefined && !isString(message.id)) return { ok: false, reason: 'tool_execution_result.id must be a string.' };
      if (message.args !== undefined && !isRecord(message.args)) return { ok: false, reason: 'tool_execution_result.args must be an object.' };
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
    case 'plan_update':
      return isRunPlanLike(message.plan)
        ? { ok: true, message: message as RuntimeMessage }
        : { ok: false, reason: 'plan_update.plan is invalid.' };
    case 'manual_plan_update':
      return isManualPlanStepArray(message.steps)
        ? { ok: true, message: message as RuntimeMessage }
        : { ok: false, reason: 'manual_plan_update.steps is invalid.' };
    case 'run_status':
      if (!runStatusPhases.includes(message.phase as RunPhase)) {
        return { ok: false, reason: 'run_status.phase is invalid.' };
      }
      if (!isRetryCounts(message.attempts) || !isRetryCounts(message.maxRetries)) {
        return { ok: false, reason: 'run_status retry counts are invalid.' };
      }
      if (message.lastError !== undefined && !isString(message.lastError)) {
        return { ok: false, reason: 'run_status.lastError must be a string.' };
      }
      if (message.note !== undefined && !isString(message.note)) {
        return { ok: false, reason: 'run_status.note must be a string.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    case 'assistant_response':
      if (!isString(message.content)) return { ok: false, reason: 'assistant_response.content must be a string.' };
      if (!isOptionalString(message.thinking)) return { ok: false, reason: 'assistant_response.thinking must be string|null.' };
      if (message.model !== undefined && !isString(message.model)) return { ok: false, reason: 'assistant_response.model must be a string.' };
      return { ok: true, message: message as RuntimeMessage };
    case 'assistant_final':
      if (!isString(message.content)) return { ok: false, reason: 'assistant_final.content must be a string.' };
      if (!isOptionalString(message.thinking)) return { ok: false, reason: 'assistant_final.thinking must be string|null.' };
      if (message.model !== undefined && !isString(message.model)) return { ok: false, reason: 'assistant_final.model must be a string.' };
      if (message.usage !== undefined && !isUsageLike(message.usage)) return { ok: false, reason: 'assistant_final.usage is invalid.' };
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
      if (
        message.state !== 'passed' &&
        message.state !== 'blocked' &&
        message.state !== 'forced_retry'
      ) {
        return { ok: false, reason: 'run_quality_gate.state is invalid.' };
      }
      if (!isString(message.reason)) return { ok: false, reason: 'run_quality_gate.reason must be a string.' };
      if (message.details !== undefined && !isRecord(message.details)) {
        return { ok: false, reason: 'run_quality_gate.details must be an object.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    case 'run_error':
    case 'run_warning':
      return isString(message.message)
        ? { ok: true, message: message as RuntimeMessage }
        : { ok: false, reason: `${type}.message must be a string.` };
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
    case 'subagent_start':
      if (!isNonEmptyString(message.id) || !isNonEmptyString(message.name)) {
        return { ok: false, reason: 'subagent_start.id and subagent_start.name are required.' };
      }
      if (
        message.tasks !== undefined &&
        (!Array.isArray(message.tasks) || !message.tasks.every((task) => isString(task)))
      ) {
        return { ok: false, reason: 'subagent_start.tasks must be string[].' };
      }
      if (message.parentRunId !== undefined && !isString(message.parentRunId)) {
        return { ok: false, reason: 'subagent_start.parentRunId must be a string.' };
      }
      return { ok: true, message: message as RuntimeMessage };
    case 'subagent_complete':
      if (!isNonEmptyString(message.id) || typeof message.success !== 'boolean') {
        return { ok: false, reason: 'subagent_complete.id and subagent_complete.success are required.' };
      }
      if (message.summary !== undefined && !isString(message.summary)) {
        return { ok: false, reason: 'subagent_complete.summary must be a string.' };
      }
      if (message.parentRunId !== undefined && !isString(message.parentRunId)) {
        return { ok: false, reason: 'subagent_complete.parentRunId must be a string.' };
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
