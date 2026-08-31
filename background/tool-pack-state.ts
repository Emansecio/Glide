import type { ToolPackName } from '../ai/tool-packs.js';
import { describeToolPackState, filterToolDefinitionsForPacks, selectToolPacks } from '../ai/tool-packs.js';
import type { ToolDefinition } from '../tools/tool-schema.js';

type ToolPackMessage = {
  role?: string;
  toolCallId?: string;
  toolCalls?: Array<{ id?: string; name?: string }>;
  content?: unknown;
};

const resultIdsFromContent = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const id = (part as { toolCallId?: unknown }).toolCallId;
    return typeof id === 'string' && id ? [id] : [];
  });
};

export function collectOutstandingToolNames(messages: ToolPackMessage[]): string[] {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls || []) {
        if (call.id && call.name) pending.set(call.id, call.name);
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const resultIds = [message.toolCallId, ...resultIdsFromContent(message.content)];
    for (const id of resultIds) {
      if (id) pending.delete(id);
    }
  }
  return [...new Set(pending.values())].sort();
}

export function collectRecentToolNames(messages: ToolPackMessage[], windowSize = 12): string[] {
  const recent = messages
    .slice(-windowSize)
    .flatMap((message) =>
      message.role === 'assistant'
        ? (message.toolCalls || []).flatMap((call) => (typeof call.name === 'string' && call.name ? [call.name] : []))
        : [],
    );
  return [...new Set(recent)].sort();
}

export type BrowserToolPassState = {
  packs: ToolPackName[];
  definitions: ToolDefinition[];
  prompt: string;
  outstandingToolNames: string[];
};

export function resolveBrowserToolPassState(
  definitions: ToolDefinition[],
  input: { taskText: string; activeFailure: boolean; messages: ToolPackMessage[] },
): BrowserToolPassState {
  const outstandingToolNames = collectOutstandingToolNames(input.messages);
  const recentToolNames = collectRecentToolNames(input.messages);
  const packs = selectToolPacks({
    text: input.taskText,
    activeFailure: input.activeFailure,
    outstandingToolNames,
    recentToolNames,
  });
  return {
    packs,
    definitions: filterToolDefinitionsForPacks(definitions, packs),
    prompt: describeToolPackState(packs),
    outstandingToolNames,
  };
}
