import { compactValue } from './compact-value.js';
import type { ContentPart, Message, MessageContent } from './message-schema.js';
import { isImagePart, isTextPart } from './message-utils.js';

export type PersistContentLimits = {
  maxCharsPerTextField?: number;
  maxImageDataChars?: number;
  maxStructuredPartBytes?: number;
};

const DEFAULT_LIMITS: Required<PersistContentLimits> = {
  maxCharsPerTextField: 4000,
  maxImageDataChars: 256,
  maxStructuredPartBytes: 12_000,
};

function trimText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function redactImageData(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `<redacted:${value.length} chars>`;
}

function isToolResultPart(part: unknown): part is Record<string, unknown> {
  if (!part || typeof part !== 'object') return false;
  const record = part as Record<string, unknown>;
  return record.type === 'tool-result' || Boolean(record.toolCallId || record.tool_use_id);
}

function measurePartBytes(part: unknown): number {
  try {
    return JSON.stringify(part).length;
  } catch {
    return String(part ?? '').length;
  }
}

function normalizeImagePartForPersist(
  part: Record<string, unknown>,
  limits: Required<PersistContentLimits>,
): ContentPart {
  const next: Record<string, unknown> = { ...part };
  if (typeof next.image === 'string') {
    next.image = redactImageData(next.image, limits.maxImageDataChars);
  }
  const imageUrl = next.image_url as { url?: string } | undefined;
  if (imageUrl?.url) {
    next.image_url = { url: redactImageData(String(imageUrl.url), limits.maxImageDataChars) };
  }
  const source = next.source as { type?: string; media_type?: string; data?: string } | undefined;
  if (source?.data) {
    next.source = {
      ...source,
      data: redactImageData(String(source.data), limits.maxImageDataChars),
    };
  }
  return next as ContentPart;
}

function normalizeToolResultPartForPersist(
  part: Record<string, unknown>,
  limits: Required<PersistContentLimits>,
): ContentPart {
  const next: Record<string, unknown> = { ...part };
  const output = next.output;
  if (typeof output === 'string') {
    next.output = trimText(output, limits.maxCharsPerTextField);
  } else if (output && typeof output === 'object') {
    next.output = compactValue(output, 'history');
  }
  if (typeof next.content === 'string') {
    next.content = trimText(next.content, limits.maxCharsPerTextField);
  } else if (next.content && typeof next.content === 'object') {
    next.content = compactValue(next.content, 'history');
  }
  return next as ContentPart;
}

/**
 * Preserve structured multimodal/tool content for context replay.
 * Callers outside ai/** (panel history sanitizer) should use this instead of
 * JSON.stringify + truncate, which destroys arrays and breaks tool pairing.
 */
export function normalizePersistedContent(
  content: MessageContent | null | undefined,
  limits: PersistContentLimits = {},
): MessageContent {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return trimText(content, resolved.maxCharsPerTextField);

  if (Array.isArray(content)) {
    const parts: ContentPart[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(trimText(part, resolved.maxCharsPerTextField));
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      if (isTextPart(part)) {
        parts.push({ ...record, text: trimText(part.text, resolved.maxCharsPerTextField) });
        continue;
      }
      if (isImagePart(part)) {
        parts.push(normalizeImagePartForPersist(record, resolved));
        continue;
      }
      if (isToolResultPart(part)) {
        parts.push(normalizeToolResultPartForPersist(record, resolved));
        continue;
      }
      if (measurePartBytes(part) > resolved.maxStructuredPartBytes) {
        parts.push(compactValue(part, 'history') as ContentPart);
      } else {
        parts.push(structuredCloneSafe(part) as ContentPart);
      }
    }
    return parts;
  }

  if (typeof content === 'object') {
    if (measurePartBytes(content) > resolved.maxStructuredPartBytes) {
      return compactValue(content, 'history') as Record<string, unknown>;
    }
    return structuredCloneSafe(content) as Record<string, unknown>;
  }

  return trimText(String(content), resolved.maxCharsPerTextField);
}

function structuredCloneSafe<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value;
    }
  }
}

export function sanitizeMessageForPersistence(
  message: Partial<Message> | null | undefined,
  limits: PersistContentLimits = {},
): Message | null {
  if (!message || typeof message !== 'object') return null;
  const role = String(message.role || '');
  if (!role) return null;

  const resolved = { ...DEFAULT_LIMITS, ...limits };
  const sanitized: Message = {
    role: role as Message['role'],
    content: normalizePersistedContent(message.content, resolved),
  };

  if (message.id) sanitized.id = String(message.id);
  if (message.createdAt) sanitized.createdAt = String(message.createdAt);
  if (typeof message.thinking === 'string' && message.thinking.trim()) {
    sanitized.thinking = trimText(message.thinking, Math.floor(resolved.maxCharsPerTextField / 2));
  }

  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    sanitized.toolCalls = message.toolCalls.slice(0, 10).map((call) => {
      let args = call?.args && typeof call.args === 'object' ? structuredCloneSafe(call.args) : {};
      let serialized = '{}';
      try {
        serialized = JSON.stringify(args);
      } catch {
        args = {};
      }
      if (serialized.length > resolved.maxCharsPerTextField) {
        args = { _truncated: true, preview: serialized.slice(0, 500) };
      }
      return {
        id: trimText(String(call?.id || ''), 120),
        name: trimText(String(call?.name || ''), 120),
        args: args as Record<string, unknown>,
      };
    });
  }

  if (message.toolCallId) sanitized.toolCallId = trimText(String(message.toolCallId), 120);
  if (message.toolName) sanitized.toolName = trimText(String(message.toolName), 120);
  if (message.name) sanitized.name = trimText(String(message.name), 120);
  if (message.meta && typeof message.meta === 'object') {
    sanitized.meta = {
      ...(message.meta.kind ? { kind: message.meta.kind } : {}),
      ...(message.meta.source ? { source: trimText(String(message.meta.source), 120) } : {}),
      ...(message.meta.summaryOfCount != null ? { summaryOfCount: message.meta.summaryOfCount } : {}),
    };
  }
  if (message.usage) {
    sanitized.usage = message.usage;
  }

  return sanitized;
}
