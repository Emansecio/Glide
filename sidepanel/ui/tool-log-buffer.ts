export const MAX_TOOL_LOG_BUFFER = 500;

export type ToolLogBufferEntry = {
  entryId: string;
  toolName: string;
  args: unknown;
  /** `undefined` = still running; `null` is a valid tool result payload. */
  result: unknown | undefined;
  startedAt: number;
};

export function appendCappedToolLogBuffer(
  buffer: ToolLogBufferEntry[],
  entry: ToolLogBufferEntry,
  max = MAX_TOOL_LOG_BUFFER,
): ToolLogBufferEntry[] {
  const next = [...buffer, entry];
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

export function updateToolLogBufferResult(
  buffer: ToolLogBufferEntry[],
  entryId: string,
  result: unknown,
): ToolLogBufferEntry[] {
  const index = buffer.findIndex((item) => item.entryId === entryId);
  if (index === -1) return buffer;
  const next = buffer.slice();
  next[index] = { ...next[index], result };
  return next;
}
