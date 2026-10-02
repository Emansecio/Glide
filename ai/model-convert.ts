import type { AssistantContent, JSONValue, ModelMessage, ToolContent, ToolResultPart, UserContent } from 'ai';
import { normalizeConversationHistory } from './message-schema.js';
import type { Message, MessageContent, ToolCall } from './message-schema.js';
import { isImagePart, isTextPart } from './message-utils.js';

/** Marcador gravado por persist-serialization no lugar de imagens base64 grandes. */
const isRedactedImage = (value: string) => value.trim().startsWith('<redacted:');

const OMITTED_IMAGE_TEXT = '[image omitted from saved history]';

function extractImageFromPart(part: Record<string, unknown>): string | null {
  if (typeof part.image === 'string' && part.image.trim()) return isRedactedImage(part.image) ? null : part.image;
  const imageUrl = part.image_url as { url?: string } | undefined;
  if (imageUrl?.url) return isRedactedImage(String(imageUrl.url)) ? null : String(imageUrl.url);
  const source = part.source as { type?: string; media_type?: string; data?: string } | undefined;
  if (source?.data) {
    const mediaType = source.media_type || 'image/png';
    return `data:${mediaType};base64,${source.data}`;
  }
  return null;
}

function normalizeUserPart(part: unknown) {
  if (typeof part === 'string') {
    return { type: 'text', text: part } as const;
  }
  if (!part || typeof part !== 'object') {
    return { type: 'text', text: '' } as const;
  }
  const record = part as Record<string, unknown>;
  if (isTextPart(part)) {
    return { type: 'text', text: part.text } as const;
  }
  const image = extractImageFromPart(record);
  if (image) {
    return { type: 'image', image } as const;
  }
  if (record.type === 'image' || record.type === 'image_url') {
    // Imagem redigida/ilegível: texto não vazio (provedores rejeitam bloco de texto vazio).
    return { type: 'text', text: OMITTED_IMAGE_TEXT } as const;
  }
  return { type: 'text', text: '' } as const;
}

export type ModelMessageOptions = {
  systemMessageMode?: 'system' | 'user' | 'drop';
};

export function toModelMessages(history: Message[] = [], options: ModelMessageOptions = {}): ModelMessage[] {
  const normalized = filterToolResultPairs(
    normalizeConversationHistory(Array.isArray(history) ? history : [], {
      addIds: false,
      addTimestamps: false,
    }),
  );
  const systemMessageMode = options.systemMessageMode || 'system';
  const modelMessages: ModelMessage[] = [];

  for (const msg of normalized) {
    if (!msg?.role) continue;
    if (msg.role === 'tool') {
      modelMessages.push({ role: 'tool', content: normalizeToolContent(msg) });
      continue;
    }
    if (msg.role === 'assistant') {
      modelMessages.push({ role: 'assistant', content: normalizeAssistantContent(msg) });
      continue;
    }
    if (msg.role === 'system') {
      if (systemMessageMode === 'drop') continue;
      const content = normalizeSystemContent(msg.content);
      modelMessages.push(systemMessageMode === 'user' ? { role: 'user', content } : { role: 'system', content });
      continue;
    }
    modelMessages.push({ role: 'user', content: normalizeUserContent(msg.content) });
  }

  return modelMessages;
}

function filterToolResultPairs(history: Message[]): Message[] {
  const pendingToolCallIds = new Set<string>();
  const filtered: Message[] = [];
  let lastAssistantIndex = -1;

  const finalizeAssistantToolCalls = () => {
    if (lastAssistantIndex < 0) {
      pendingToolCallIds.clear();
      return;
    }
    const prev = filtered[lastAssistantIndex];
    if (prev?.role === 'assistant' && Array.isArray(prev.toolCalls) && prev.toolCalls.length > 0) {
      // IDs ainda em pending = tool_use sem tool_result → strip (evita 400 Anthropic).
      const kept = prev.toolCalls.filter((call) => {
        const id = call?.id != null ? String(call.id) : '';
        return id && !pendingToolCallIds.has(id);
      });
      if (kept.length !== prev.toolCalls.length) {
        filtered[lastAssistantIndex] = {
          ...prev,
          toolCalls: kept.length > 0 ? kept : undefined,
        };
      }
    }
    pendingToolCallIds.clear();
    lastAssistantIndex = -1;
  };

  for (const message of history) {
    if (message.role === 'assistant') {
      finalizeAssistantToolCalls();
      pendingToolCallIds.clear();
      for (const call of message.toolCalls || []) {
        if (call.id) pendingToolCallIds.add(String(call.id));
      }
      filtered.push(message);
      lastAssistantIndex = filtered.length - 1;
      continue;
    }

    if (message.role !== 'tool') {
      finalizeAssistantToolCalls();
      filtered.push(message);
      continue;
    }

    const declaredIds = new Set<string>();
    const messageToolCallId = message.toolCallId || message.tool_call_id;
    if (messageToolCallId) declaredIds.add(String(messageToolCallId));

    const validParts = Array.isArray(message.content)
      ? message.content.filter((part) => {
          if (!part || typeof part !== 'object') return false;
          const record = part as Record<string, unknown>;
          const partToolCallId = record.toolCallId || record.tool_call_id || record.tool_use_id;
          if (!partToolCallId) return false;
          declaredIds.add(String(partToolCallId));
          return pendingToolCallIds.has(String(partToolCallId));
        })
      : [];

    const validIds = [...declaredIds].filter((id) => pendingToolCallIds.has(id));
    if (validIds.length === 0) continue;

    const safeMessage =
      Array.isArray(message.content) && validParts.length > 0 ? { ...message, content: validParts } : message;
    filtered.push(safeMessage);
    for (const id of validIds) pendingToolCallIds.delete(id);
  }

  finalizeAssistantToolCalls();
  return filtered;
}

function normalizeToolContent(message: Message): ToolContent {
  const content = message.content;
  if (Array.isArray(content)) {
    const parts: ToolContent = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      if (record.type === 'tool-result' || record.toolCallId || record.tool_use_id) {
        const output = record.output ?? record.content;
        parts.push({
          type: 'tool-result',
          toolCallId: String(record.toolCallId || record.tool_use_id || message.toolCallId || `tool_${Date.now()}`),
          toolName: String(record.toolName || record.name || message.name || message.toolName || 'tool'),
          output:
            output && typeof output === 'object' && 'type' in (output as object)
              ? (output as ToolResultPart['output'])
              : normalizeToolOutput((output ?? record) as MessageContent),
        });
        continue;
      }
      if (record.type === 'image' || isImagePart(record)) {
        const source = record.source as { data?: string; media_type?: string } | undefined;
        const image = extractImageFromPart(record);
        if (source?.data) {
          parts.push({
            type: 'tool-result',
            toolCallId: String(message.toolCallId || message.tool_call_id || `tool_${Date.now()}`),
            toolName: String(message.name || message.toolName || 'tool'),
            output: {
              type: 'content',
              value: [{ type: 'media', data: source.data, mediaType: source.media_type || 'image/png' }],
            },
          } as ToolResultPart);
        } else if (image) {
          const match = image.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({
              type: 'tool-result',
              toolCallId: String(message.toolCallId || message.tool_call_id || `tool_${Date.now()}`),
              toolName: String(message.name || message.toolName || 'tool'),
              output: {
                type: 'content',
                value: [{ type: 'media', data: match[2], mediaType: match[1] }],
              },
            } as ToolResultPart);
          }
        }
      }
    }
    if (parts.length) return parts;
  }
  const toolCallId = message.toolCallId || message.tool_call_id || `tool_${Date.now()}`;
  return [
    {
      type: 'tool-result',
      toolCallId: String(toolCallId),
      toolName: message.name || message.toolName || 'tool',
      output: normalizeToolOutput(content),
    },
  ];
}

function normalizeToolOutput(content: MessageContent): ToolResultPart['output'] {
  if (typeof content === 'string') {
    return { type: 'text', value: content };
  }
  if (content && typeof content === 'object') {
    return {
      type: 'json',
      value: coerceJsonValue(content),
    };
  }
  return { type: 'text', value: '' };
}

function normalizeUserContent(content: MessageContent): UserContent {
  if (Array.isArray(content)) {
    return content.map((part) => normalizeUserPart(part)).filter(Boolean);
  }
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function normalizeToolCallParts(toolCalls: ToolCall[] | undefined) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  return toolCalls.map((call) => ({
    type: 'tool-call' as const,
    toolCallId: String(call.id || `call_${Date.now()}`),
    toolName: String(call.name || 'tool'),
    input: coerceJsonValue(call.args || {}),
  }));
}

function normalizeAssistantContent(message: Message): AssistantContent {
  const toolCallParts = normalizeToolCallParts(message.toolCalls);
  const textParts: Array<{ type: 'text'; text: string } | { type: 'reasoning'; text: string }> = [];

  if (message.thinking) {
    textParts.push({ type: 'reasoning', text: message.thinking });
  }

  if (typeof message.content === 'string') {
    if (message.content) textParts.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (typeof part === 'string' && part) {
        textParts.push({ type: 'text', text: part });
        continue;
      }
      if (isTextPart(part) && part.text) {
        textParts.push({ type: 'text', text: part.text });
      }
    }
  } else if (message.content && typeof message.content === 'object') {
    textParts.push({ type: 'text', text: JSON.stringify(message.content) });
  }

  if (toolCallParts.length > 0) {
    return [...textParts, ...toolCallParts];
  }
  if (textParts.length === 1 && textParts[0].type === 'text') {
    return textParts[0].text;
  }
  if (textParts.length > 0) {
    return textParts;
  }
  return '';
}

function normalizeSystemContent(content: MessageContent) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isTextPart(part)) return part.text;
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function coerceJsonValue(value: unknown): JSONValue {
  try {
    return structuredClone(value) as JSONValue;
  } catch {
    return String(value ?? '');
  }
}
