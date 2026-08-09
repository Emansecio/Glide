import { RUNTIME_MESSAGE_SCHEMA_VERSION } from '../types/runtime-messages.js';
import type { ToolEvidenceConfidence, ToolFailureClass, ToolRecoveryStage } from '../types/runtime-messages.js';

const BATCH_WINDOW_MS = 16;
export const MAX_RUNTIME_DELTA_CHARS = 16_000;

export type RuntimeBatchMeta = {
  runId: string;
  turnId: string;
  sessionId: string;
};

type DeltaChannel = 'text' | 'reasoning';

type PendingQueueItem =
  | {
      kind: 'delta';
      meta: RuntimeBatchMeta;
      channel: DeltaChannel;
      content: string;
    }
  | {
      kind: 'tool';
      meta: RuntimeBatchMeta;
      event: ToolEventPayload;
    };

export type RuntimeDeltaPayload = {
  schemaVersion: typeof RUNTIME_MESSAGE_SCHEMA_VERSION;
  type: 'assistant_stream_delta';
  runId: string;
  turnId: string;
  sessionId: string;
  timestamp: number;
  content: string;
  channel: DeltaChannel;
  seq?: number;
};

export type ToolEventPayload =
  | {
      type: 'tool_execution_start';
      tool: string;
      id?: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_execution_result';
      tool: string;
      id?: string;
      args?: Record<string, unknown>;
      result: unknown;
      recoveryStage?: ToolRecoveryStage;
      evidenceConfidence?: ToolEvidenceConfidence;
      failureClass?: ToolFailureClass;
    };

export type ToolEventsBatchPayload = {
  schemaVersion: typeof RUNTIME_MESSAGE_SCHEMA_VERSION;
  type: 'tool_events_batch';
  runId: string;
  turnId: string;
  sessionId: string;
  timestamp: number;
  events: ToolEventPayload[];
  seq?: number;
};

const bufferKey = (runId: string, channel: DeltaChannel) => `${runId}:${channel}`;

export const isStreamDeltaPayload = (
  payload: Record<string, unknown>,
): payload is { type: 'assistant_stream_delta'; content: string; channel?: DeltaChannel } =>
  payload.type === 'assistant_stream_delta' && typeof payload.content === 'string';

export const isToolEventPayload = (payload: Record<string, unknown>): payload is ToolEventPayload =>
  payload.type === 'tool_execution_start' || payload.type === 'tool_execution_result';

export const buildStreamDeltaPayload = (
  meta: RuntimeBatchMeta,
  content: string,
  channel: DeltaChannel = 'text',
  seq?: number,
): RuntimeDeltaPayload => ({
  schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
  type: 'assistant_stream_delta',
  runId: meta.runId,
  turnId: meta.turnId,
  sessionId: meta.sessionId,
  timestamp: Date.now(),
  content,
  channel,
  ...(typeof seq === 'number' ? { seq } : {}),
});

export const buildToolEventsBatchPayload = (
  meta: RuntimeBatchMeta,
  events: ToolEventPayload[],
  seq?: number,
): ToolEventsBatchPayload => ({
  schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
  type: 'tool_events_batch',
  runId: meta.runId,
  turnId: meta.turnId,
  sessionId: meta.sessionId,
  timestamp: Date.now(),
  events,
  ...(typeof seq === 'number' ? { seq } : {}),
});

export class RuntimeBatcher {
  /** Legacy delta buffers — kept for flushOne compatibility during coalescing. */
  private buffers = new Map<
    string,
    { meta: RuntimeBatchMeta; channel: DeltaChannel; content: string; timer: ReturnType<typeof setTimeout> | null }
  >();
  private pendingQueues = new Map<string, PendingQueueItem[]>();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private nextSeq = new Map<string, number>();

  constructor(
    private readonly onFlush: (payload: RuntimeDeltaPayload) => void,
    private readonly onFlushToolBatch: (payload: ToolEventsBatchPayload) => void = () => {},
  ) {}

  private allocateSeq(runId: string): number {
    const next = (this.nextSeq.get(runId) ?? 0) + 1;
    this.nextSeq.set(runId, next);
    return next;
  }

  private getQueue(runId: string): PendingQueueItem[] {
    let queue = this.pendingQueues.get(runId);
    if (!queue) {
      queue = [];
      this.pendingQueues.set(runId, queue);
    }
    return queue;
  }

  private scheduleFlush(runId: string) {
    if (this.flushTimers.has(runId)) return;
    this.flushTimers.set(
      runId,
      setTimeout(() => {
        this.flushTimers.delete(runId);
        this.flushOrdered(runId);
      }, BATCH_WINDOW_MS),
    );
  }

  enqueue(meta: RuntimeBatchMeta, content: string, channel: DeltaChannel = 'text') {
    if (!content) return;
    const queue = this.getQueue(meta.runId);
    let remaining = content;
    while (remaining) {
      const chunk = remaining.slice(0, MAX_RUNTIME_DELTA_CHARS);
      remaining = remaining.slice(chunk.length);
      queue.push({ kind: 'delta', meta, channel, content: chunk });
      if (chunk.length >= MAX_RUNTIME_DELTA_CHARS) {
        this.flushOrdered(meta.runId);
      }
    }
    this.scheduleFlush(meta.runId);
  }

  enqueueToolEvent(meta: RuntimeBatchMeta, event: ToolEventPayload) {
    this.getQueue(meta.runId).push({ kind: 'tool', meta, event });
    this.scheduleFlush(meta.runId);
  }

  flush(runId: string, _channel?: DeltaChannel) {
    if (this.flushTimers.has(runId)) {
      clearTimeout(this.flushTimers.get(runId)!);
      this.flushTimers.delete(runId);
    }
    this.flushOrdered(runId);
  }

  flushAll() {
    for (const runId of [...this.pendingQueues.keys()]) {
      this.flush(runId);
    }
    for (const entry of [...this.buffers.values()]) {
      this.flushOne(entry.meta.runId, entry.channel);
    }
  }

  drop(runId: string) {
    if (this.flushTimers.has(runId)) {
      clearTimeout(this.flushTimers.get(runId)!);
      this.flushTimers.delete(runId);
    }
    this.pendingQueues.delete(runId);
    this.nextSeq.delete(runId);
    for (const channel of ['text', 'reasoning'] as const) {
      const key = bufferKey(runId, channel);
      const entry = this.buffers.get(key);
      if (entry?.timer) clearTimeout(entry.timer);
      this.buffers.delete(key);
    }
  }

  private flushOrdered(runId: string) {
    const queue = this.pendingQueues.get(runId);
    if (!queue || queue.length === 0) return;

    let toolBatch: ToolEventPayload[] = [];
    let toolMeta: RuntimeBatchMeta | null = null;
    let pendingDelta: { meta: RuntimeBatchMeta; channel: DeltaChannel; content: string } | null = null;

    const emitDelta = () => {
      if (!pendingDelta?.content) return;
      this.onFlush(
        buildStreamDeltaPayload(pendingDelta.meta, pendingDelta.content, pendingDelta.channel, this.allocateSeq(runId)),
      );
      pendingDelta = null;
    };

    const appendDelta = (meta: RuntimeBatchMeta, channel: DeltaChannel, content: string) => {
      if (
        pendingDelta &&
        (pendingDelta.channel !== channel ||
          pendingDelta.meta.runId !== meta.runId ||
          pendingDelta.content.length + content.length > MAX_RUNTIME_DELTA_CHARS)
      ) {
        emitDelta();
      }
      if (!pendingDelta) {
        pendingDelta = { meta, channel, content: '' };
      }
      pendingDelta.content += content;
      if (pendingDelta.content.length >= MAX_RUNTIME_DELTA_CHARS) {
        emitDelta();
      }
    };

    const flushToolBatch = () => {
      if (toolBatch.length === 0 || !toolMeta) return;
      emitDelta();
      this.onFlushToolBatch(buildToolEventsBatchPayload(toolMeta, toolBatch, this.allocateSeq(runId)));
      toolBatch = [];
      toolMeta = null;
    };

    for (const item of queue) {
      if (item.kind === 'delta') {
        flushToolBatch();
        appendDelta(item.meta, item.channel, item.content);
        continue;
      }
      if (!toolMeta) toolMeta = item.meta;
      toolBatch.push(item.event);
    }
    flushToolBatch();
    emitDelta();
    queue.length = 0;
  }

  private flushOne(runId: string, channel: DeltaChannel) {
    const key = bufferKey(runId, channel);
    const entry = this.buffers.get(key);
    if (!entry || !entry.content) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const payload = buildStreamDeltaPayload(entry.meta, entry.content, entry.channel, this.allocateSeq(runId));
    entry.content = '';
    this.buffers.delete(key);
    this.onFlush(payload);
  }
}
