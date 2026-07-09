import { RUNTIME_MESSAGE_SCHEMA_VERSION } from '../types/runtime-messages.js';

const BATCH_WINDOW_MS = 16;

export type RuntimeBatchMeta = {
  runId: string;
  turnId: string;
  sessionId: string;
};

type DeltaChannel = 'text' | 'reasoning';

type BufferEntry = {
  meta: RuntimeBatchMeta;
  channel: DeltaChannel;
  content: string;
  timer: ReturnType<typeof setTimeout> | null;
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
};

const bufferKey = (runId: string, channel: DeltaChannel) => `${runId}:${channel}`;

export const isStreamDeltaPayload = (
  payload: Record<string, unknown>,
): payload is { type: 'assistant_stream_delta'; content: string; channel?: DeltaChannel } =>
  payload.type === 'assistant_stream_delta' && typeof payload.content === 'string';

export const buildStreamDeltaPayload = (
  meta: RuntimeBatchMeta,
  content: string,
  channel: DeltaChannel = 'text',
): RuntimeDeltaPayload => ({
  schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
  type: 'assistant_stream_delta',
  runId: meta.runId,
  turnId: meta.turnId,
  sessionId: meta.sessionId,
  timestamp: Date.now(),
  content,
  channel,
});

export class RuntimeBatcher {
  private buffers = new Map<string, BufferEntry>();

  constructor(private readonly onFlush: (payload: RuntimeDeltaPayload) => void) {}

  enqueue(meta: RuntimeBatchMeta, content: string, channel: DeltaChannel = 'text') {
    if (!content) return;
    const key = bufferKey(meta.runId, channel);
    const existing = this.buffers.get(key);
    if (existing) {
      existing.content += content;
      return;
    }

    const entry: BufferEntry = {
      meta,
      channel,
      content,
      timer: setTimeout(() => this.flush(meta.runId, channel), BATCH_WINDOW_MS),
    };
    this.buffers.set(key, entry);
  }

  flush(runId: string, channel?: DeltaChannel) {
    if (channel) {
      this.flushOne(runId, channel);
      return;
    }
    this.flushOne(runId, 'text');
    this.flushOne(runId, 'reasoning');
  }

  flushAll() {
    for (const key of [...this.buffers.keys()]) {
      const [runId, channel] = key.split(':') as [string, DeltaChannel];
      this.flushOne(runId, channel);
    }
  }

  private flushOne(runId: string, channel: DeltaChannel) {
    const key = bufferKey(runId, channel);
    const entry = this.buffers.get(key);
    if (!entry || !entry.content) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const payload = buildStreamDeltaPayload(entry.meta, entry.content, entry.channel);
    entry.content = '';
    this.buffers.delete(key);
    this.onFlush(payload);
  }
}
