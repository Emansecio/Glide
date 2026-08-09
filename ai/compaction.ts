import { compactValue } from './compact-value.js';
import type { Message, Usage } from './message-schema.js';
import { normalizeUsage } from './message-schema.js';
import { estimateTokensFromContent, isTextPart } from './message-utils.js';

export type CompactionSettings = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
};

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  // Larger reserve lowers the absolute compaction boundary (contextLimit -
  // reserveTokens), so history is summarized ~140k instead of ~184k on a 200k
  // window — cutting the worst-case per-request input cost.
  reserveTokens: 60000,
  keepRecentTokens: 20000,
};

export const COMPACTION_ENTER_PERCENT = 0.7;
export const COMPACTION_RELEASE_PERCENT = 0.55;

const COMPACTION_LATCH_MAX_SESSIONS = 256;
const COMPACTION_LATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CompactionLatchEntry = {
  active: boolean;
  lastAccess: number;
};

const compactionLatchBySession = new Map<string, CompactionLatchEntry>();

function pruneCompactionLatches(now = Date.now()) {
  for (const [sessionId, entry] of compactionLatchBySession) {
    if (now - entry.lastAccess > COMPACTION_LATCH_TTL_MS) {
      compactionLatchBySession.delete(sessionId);
    }
  }
  while (compactionLatchBySession.size >= COMPACTION_LATCH_MAX_SESSIONS) {
    let oldestId = '';
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [sessionId, entry] of compactionLatchBySession) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestId = sessionId;
      }
    }
    if (!oldestId) break;
    compactionLatchBySession.delete(oldestId);
  }
}

function touchCompactionLatch(sessionId: string): CompactionLatchEntry {
  const now = Date.now();
  pruneCompactionLatches(now);
  const key = String(sessionId || 'default');
  const existing = compactionLatchBySession.get(key);
  if (existing) {
    existing.lastAccess = now;
    return existing;
  }
  const created: CompactionLatchEntry = { active: false, lastAccess: now };
  compactionLatchBySession.set(key, created);
  return created;
}

export function resetCompactionHysteresis(sessionId?: string) {
  if (sessionId) {
    compactionLatchBySession.delete(sessionId);
    return;
  }
  compactionLatchBySession.clear();
}

/** Test-only introspection of hysteresis bookkeeping size. */
export const getCompactionLatchSizeForTests = () => compactionLatchBySession.size;

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.inputTokens + usage.outputTokens;
}

function getAssistantUsage(message: Message): Usage | undefined {
  if (message.role !== 'assistant') return undefined;
  if (!message.usage) return undefined;
  const normalized = normalizeUsage(message.usage);
  if (normalized.totalTokens <= 0 && normalized.inputTokens + normalized.outputTokens <= 0) return undefined;
  return normalized;
}

function getLastAssistantUsageInfo(messages: Message[]): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) return { usage, index: i };
  }
  return undefined;
}

export function estimateContextTokens(messages: Message[]): {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
} {
  // A fresh per-call memo avoids both cross-call `idx_N` key collisions
  // (stale counts for id-less messages) and unbounded module-global growth.
  const memo = new Map<string, number>();
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) {
    let estimated = 0;
    for (let i = 0; i < messages.length; i += 1) {
      estimated += estimateMessageTokens(messages[i], i, memo);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i += 1) {
    trailingTokens += estimateMessageTokens(messages[i], i, memo);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

export function shouldCompact({
  contextTokens,
  contextLimit,
  settings = DEFAULT_COMPACTION_SETTINGS,
  sessionId = 'default',
}: {
  contextTokens: number;
  contextLimit: number;
  settings?: CompactionSettings;
  sessionId?: string;
}): { shouldCompact: boolean; approxTokens: number; percent: number } {
  if (!settings.enabled) {
    return { shouldCompact: false, approxTokens: contextTokens, percent: 0 };
  }

  const latchKey = String(sessionId || 'default');
  const latchEntry = touchCompactionLatch(latchKey);
  let compactionLatchActive = latchEntry.active;
  const percent = contextLimit > 0 ? contextTokens / contextLimit : 0;
  if (percent < COMPACTION_RELEASE_PERCENT) {
    compactionLatchActive = false;
  }
  if (percent >= COMPACTION_ENTER_PERCENT) {
    compactionLatchActive = true;
  }
  latchEntry.active = compactionLatchActive;

  const overReserve = contextTokens > contextLimit - settings.reserveTokens;
  const shouldRun = compactionLatchActive && overReserve;

  return {
    shouldCompact: shouldRun,
    approxTokens: contextTokens,
    percent,
  };
}

function messageMemoKey(message: Message, index: number): string {
  return message.id || `idx_${index}`;
}

function estimateMessageTokens(message: Message, index: number, memo: Map<string, number>): number {
  const key = messageMemoKey(message, index);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  // estimateTokensFromContent já aplica o custo fixo por imagem (IMAGE_TOKEN_ESTIMATE);
  // não somamos +1200 aqui de novo para não contar imagens em dobro.
  let tokens = estimateTokensFromContent(message.content);
  if (message.thinking) {
    tokens += Math.ceil(message.thinking.length / 4);
  }

  if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
    tokens += Math.ceil(JSON.stringify(message.toolCalls).length / 4);
  }

  memo.set(key, tokens);
  return tokens;
}

function isValidCutPoint(message: Message): boolean {
  return message.role !== 'tool';
}

function resolveCutPointAtOrAfter(messages: Message[], startIndex: number, fromIndex: number): number {
  let cutIndex = Math.max(startIndex, fromIndex);
  while (cutIndex < messages.length && !isValidCutPoint(messages[cutIndex])) {
    cutIndex += 1;
  }
  if (cutIndex < messages.length) return cutIndex;

  cutIndex = fromIndex;
  while (cutIndex > startIndex && !isValidCutPoint(messages[cutIndex])) {
    cutIndex -= 1;
  }
  return Math.max(startIndex, cutIndex);
}

export function findCutPoint(messages: Message[], startIndex: number, keepRecentTokens: number): number {
  const memo = new Map<string, number>();
  if (startIndex >= messages.length) return startIndex;

  let accumulatedTokens = 0;
  let cutIndex = startIndex;

  for (let i = messages.length - 1; i >= startIndex; i -= 1) {
    accumulatedTokens += estimateMessageTokens(messages[i], i, memo);
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex = resolveCutPointAtOrAfter(messages, startIndex, i);
      break;
    }
  }

  if (messages[cutIndex]?.role === 'tool' && cutIndex > startIndex) {
    let adjusted = cutIndex - 1;
    while (adjusted > startIndex && messages[adjusted].role === 'tool') {
      adjusted -= 1;
    }
    cutIndex = Math.max(startIndex, adjusted);
  }

  return cutIndex;
}

export function forceCompactionCut(
  messages: Message[],
  compactionStart: number,
  keepRecentTokens: number,
): { cutIndex: number; messagesToSummarize: Message[] } {
  for (let factor = 0.8; factor >= 0.2; factor -= 0.2) {
    const reducedKeep = Math.max(500, Math.floor(keepRecentTokens * factor));
    const cutIndex = findCutPoint(messages, compactionStart, reducedKeep);
    const messagesToSummarize = messages.slice(compactionStart, cutIndex);
    if (messagesToSummarize.length > 0) {
      return { cutIndex, messagesToSummarize };
    }
  }

  let cutIndex = compactionStart + 1;
  while (cutIndex < messages.length && messages[cutIndex]?.role === 'tool') {
    cutIndex += 1;
  }
  if (cutIndex >= messages.length) {
    cutIndex = Math.max(compactionStart + 1, messages.length - 1);
  }
  // O reset acima pode reposicionar cutIndex sobre um tool-result; nesse caso o
  // trecho preservado (messages.slice(cutIndex)) começaria com um tool_result sem
  // o assistant(tool_use) correspondente → 400 "tool_result without tool_use" na
  // Anthropic. Recua até o assistant que originou os tool-results.
  while (cutIndex > compactionStart + 1 && messages[cutIndex]?.role === 'tool') {
    cutIndex -= 1;
  }
  return {
    cutIndex,
    messagesToSummarize: messages.slice(compactionStart, cutIndex),
  };
}

function formatToolCallArgs(args: Record<string, unknown> | undefined): string {
  const compacted = compactValue(args || {}, 'history', 'args');
  try {
    return JSON.stringify(compacted);
  } catch {
    return '{}';
  }
}

export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const contentText = normalizeContentText(msg.content);
    if (msg.role === 'user') {
      if (contentText) parts.push(`[User]: ${contentText}`);
    } else if (msg.role === 'assistant') {
      if (msg.thinking) parts.push(`[Assistant thinking]: ${msg.thinking}`);
      if (contentText) parts.push(`[Assistant]: ${contentText}`);
      if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        const toolCalls = msg.toolCalls.map((call) => `${call.name}(${formatToolCallArgs(call.args)})`).join('; ');
        parts.push(`[Assistant tool calls]: ${toolCalls}`);
      }
    } else if (msg.role === 'tool') {
      if (contentText) parts.push(`[Tool result]: ${contentText}`);
    } else if (msg.role === 'system') {
      if (contentText) parts.push(`[System]: ${contentText}`);
    }
  }

  return parts.join('\n\n');
}

export function buildTruncateOnlySummary(messages: Message[], maxChars = 6000): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '## Goal\n(none)\n\n## Progress\n### Done\n- (none)\n\n## Next Steps\n1. Continue from recent context.';
  }

  const serialized = serializeConversation(messages);
  const trimmed =
    serialized.length > maxChars
      ? `${serialized.slice(0, maxChars)}\n\n[Truncated ${messages.length} earlier messages for context recovery.]`
      : serialized;

  return `## Goal\nContinue the active task from the preserved recent context.\n\n## Progress\n### Done\n- Earlier context was truncated automatically (${messages.length} messages).\n\n## Critical Context\n${trimmed}`;
}

function normalizeContentText(content: Message['content']): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isTextPart(part)) return part.text;
        if (part && typeof part === 'object') {
          if (typeof (part as { content?: string }).content === 'string') return (part as { content: string }).content;
          try {
            return JSON.stringify(compactValue(part, 'history'));
          } catch {
            return '';
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(compactValue(content, 'history'));
  } catch {
    return String(content ?? '');
  }
}

export function buildCompactionSummaryMessage(summary: string, trimmedCount: number): Message {
  return {
    role: 'system',
    content: summary.trim(),
    meta: {
      kind: 'summary',
      summaryOfCount: trimmedCount,
      source: 'auto',
    },
  };
}

export function applyCompaction({
  summaryMessage,
  preserved,
  trimmedCount,
}: {
  summaryMessage: Message;
  preserved: Message[];
  trimmedCount: number;
}): {
  compacted: Message[];
  summaryMessage: Message;
  trimmedCount: number;
  preservedCount: number;
} {
  return {
    compacted: [summaryMessage, ...preserved],
    summaryMessage,
    trimmedCount,
    preservedCount: preserved.length,
  };
}
