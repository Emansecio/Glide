import type { RuntimeMessage } from '../../types/runtime-messages.js';

export type StreamRuntimeMessage = Extract<
  RuntimeMessage,
  { type: 'assistant_stream_start' | 'assistant_stream_delta' | 'assistant_stream_stop' }
>;

export const MAX_PENDING_STREAM_MESSAGES = 256;

const canCoalesce = (
  previous: StreamRuntimeMessage | undefined,
  next: StreamRuntimeMessage,
): previous is Extract<StreamRuntimeMessage, { type: 'assistant_stream_delta' }> =>
  previous?.type === 'assistant_stream_delta' &&
  next.type === 'assistant_stream_delta' &&
  previous.runId === next.runId &&
  previous.sessionId === next.sessionId &&
  previous.turnId === next.turnId &&
  previous.channel === next.channel;

export function enqueueStreamMessage(queue: StreamRuntimeMessage[], message: StreamRuntimeMessage): boolean {
  const previous = queue[queue.length - 1];
  if (canCoalesce(previous, message) && message.type === 'assistant_stream_delta') {
    previous.content += message.content;
  } else {
    queue.push(message);
  }
  return queue.length >= MAX_PENDING_STREAM_MESSAGES;
}
