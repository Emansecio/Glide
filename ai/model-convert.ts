import type { AssistantContent, JSONValue, ModelMessage, ToolContent, ToolResultPart, UserContent } from 'ai';
import type { Message, MessageContent, ToolCall } from './message-schema.js';
import { isTextPart } from './message-utils.js';

export type ModelMessageOptions = {
  systemMessageMode?: 'system' | 'user' | 'drop';
};

export function toModelMessages(history: Message[] = [], options: ModelMessageOptions = {}): ModelMessage[] {
  const normalized = Array.isArray(history) ? history : [];
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

function normalizeToolContent(message: Message): ToolContent {
  const content = message.content;
  if (Array.isArray(content)) {
    const parts = content.filter((part) => part && typeof part === 'object' && 'type' in part) as ToolResultPart[];
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
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return { type: 'text', text: part } as const;
        }
        if (part && typeof part === 'object') {
          if (isTextPart(part)) {
            return { type: 'text', text: part.text } as const;
          }
          if ('image' in part && part.image) {
            return { type: 'image', image: part.image } as const;
          }
          if ('image_url' in part && part.image_url?.url) {
            return { type: 'image', image: part.image_url.url } as const;
          }
        }
        return { type: 'text', text: '' } as const;
      })
      .filter(Boolean);
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
