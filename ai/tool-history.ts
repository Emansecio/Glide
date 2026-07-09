import type { Message } from './message-schema.js';

export type PersistedToolResultPart = {
  type: 'tool-result';
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
};

// Builds the messages persisted for a turn that used tools. The persisted
// history is replayed verbatim on the next turn, so it MUST keep every
// tool-result paired with a preceding tool-call — otherwise the Anthropic API
// rejects the follow-up request with "tool_result without tool_use".
export function buildToolTurnMessages(
  finalText: string,
  reasoningText: string | null,
  toolResultContent: PersistedToolResultPart[] = [],
  toolCalls: Array<Record<string, unknown>> = [],
): Message[] {
  const results = Array.isArray(toolResultContent) ? toolResultContent.filter((part) => part?.toolCallId) : [];
  if (results.length === 0) {
    return [{ role: 'assistant', content: finalText, thinking: reasoningText || null }];
  }

  // Recover the original arguments per tool-call id so the reconstructed
  // tool-call matches what the model actually issued.
  const argsById = new Map<string, Record<string, unknown>>();
  for (const call of toolCalls) {
    const id = String((call.toolCallId ?? call.id ?? '') as string);
    if (!id) continue;
    const input = (call.input ?? call.args ?? {}) as unknown;
    argsById.set(id, input && typeof input === 'object' ? (input as Record<string, unknown>) : {});
  }

  const pairedToolCalls = results.map((part) => ({
    id: String(part.toolCallId),
    name: String(part.toolName || ''),
    args: argsById.get(String(part.toolCallId)) || {},
  }));

  // Three messages keep the pairing valid AND the final answer intact:
  //   assistant(tool-calls) → tool(tool-results) → assistant(final text)
  return [
    { role: 'assistant', content: '', thinking: reasoningText || null, toolCalls: pairedToolCalls },
    { role: 'tool', content: toolResultContent as unknown as Message['content'] },
    { role: 'assistant', content: finalText },
  ];
}
