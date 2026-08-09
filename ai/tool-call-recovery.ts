export type RecoveredToolCall = {
  name: string;
  args: Record<string, unknown>;
  raw: string;
};

type JsonParseResult = { ok: true; value: unknown } | { ok: false };

function normalizeAllowedToolNames(allowedToolNames?: Iterable<string>) {
  const names = new Set<string>();
  if (!allowedToolNames) return names;
  for (const name of allowedToolNames) {
    const normalized = String(name || '').trim();
    if (normalized) names.add(normalized);
  }
  return names;
}

function isAllowedTool(name: string, allowedToolNames: Set<string>) {
  return Boolean(name) && (allowedToolNames.size === 0 || allowedToolNames.has(name));
}

function parseJson(value: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

/**
 * Parse function-style kwargs: url="https://x.com", selector='#a', count=3, flag=true
 * Also accepts a single bare string/number as { value }.
 */
function parseKwargsOrBare(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  const asJson = parseJson(text);
  if (asJson.ok) return coerceArgs(asJson.value);

  const kwargs: Record<string, unknown> = {};
  // key=value pairs separated by commas (values may be quoted).
  const pairRe = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^,]+))/g;
  let match: RegExpExecArray | null;
  let matchedAny = false;
  while ((match = pairRe.exec(text))) {
    matchedAny = true;
    const key = match[1];
    const rawVal = match[2] ?? match[3] ?? String(match[4] || '').trim();
    const unescaped = rawVal.replace(/\\(["'\\])/g, '$1');
    if (unescaped === 'true') kwargs[key] = true;
    else if (unescaped === 'false') kwargs[key] = false;
    else if (unescaped === 'null') kwargs[key] = null;
    else if (/^-?\d+(\.\d+)?$/.test(unescaped)) kwargs[key] = Number(unescaped);
    else kwargs[key] = unescaped;
  }
  if (matchedAny) return kwargs;

  // Bare string argument: navigate("https://…")
  const bareQuoted = text.match(/^["']([\s\S]*)["']$/);
  if (bareQuoted) return { value: bareQuoted[1] };
  return { value: text };
}

function coerceArgs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    if (parsed.ok) return coerceArgs(parsed.value);
    return parseKwargsOrBare(value);
  }
  if (Array.isArray(value)) return { value };
  if (typeof value === 'object') return value as Record<string, unknown>;
  return { value };
}

function stringField(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickToolName(source: Record<string, unknown>) {
  const direct = stringField(source, ['name', 'tool', 'toolName', 'function_name']);
  if (direct) return direct;
  const fn = source.function || source.func || source.tool;
  if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
    return stringField(fn as Record<string, unknown>, ['name']);
  }
  return '';
}

function pickExplicitArgs(source: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(source, 'args')) return source.args;
  if (Object.prototype.hasOwnProperty.call(source, 'arguments')) return source.arguments;
  if (Object.prototype.hasOwnProperty.call(source, 'input')) return source.input;
  if (Object.prototype.hasOwnProperty.call(source, 'parameters')) return source.parameters;
  const fn = source.function || source.func || source.tool;
  if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
    const fnRecord = fn as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(fnRecord, 'arguments')) return fnRecord.arguments;
    if (Object.prototype.hasOwnProperty.call(fnRecord, 'args')) return fnRecord.args;
    if (Object.prototype.hasOwnProperty.call(fnRecord, 'input')) return fnRecord.input;
    if (Object.prototype.hasOwnProperty.call(fnRecord, 'parameters')) return fnRecord.parameters;
  }
  return undefined;
}

function pickInlineArgs(source: Record<string, unknown>) {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (['name', 'tool', 'toolName', 'function_name', 'type', 'id', 'function', 'func'].includes(key)) continue;
    args[key] = value;
  }
  return args;
}

function normalizeToolCall(source: Record<string, unknown>, raw: string, allowedToolNames: Set<string>) {
  const name = pickToolName(source);
  if (!isAllowedTool(name, allowedToolNames)) return null;
  const explicitArgs = pickExplicitArgs(source);
  const args = explicitArgs === undefined ? pickInlineArgs(source) : coerceArgs(explicitArgs);
  return { name, args, raw } satisfies RecoveredToolCall;
}

function collectToolCalls(value: unknown, raw: string, allowedToolNames: Set<string>, output: RecoveredToolCall[]) {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) collectToolCalls(item, raw, allowedToolNames, output);
    return;
  }

  const source = value as Record<string, unknown>;
  const toolCalls = source.tool_calls || source.toolCalls || source.calls;
  if (Array.isArray(toolCalls)) {
    for (const item of toolCalls) collectToolCalls(item, raw, allowedToolNames, output);
  }

  const single = source.tool_call || source.toolCall || source.call;
  if (single && typeof single === 'object') {
    collectToolCalls(single, raw, allowedToolNames, output);
  }

  const call = normalizeToolCall(source, raw, allowedToolNames);
  if (call) output.push(call);

  if (allowedToolNames.size > 0) {
    const keys = Object.keys(source);
    if (keys.length === 1 && allowedToolNames.has(keys[0])) {
      output.push({ name: keys[0], args: coerceArgs(source[keys[0]]), raw });
    }
  }
}

function markdownFenceContent(text: string) {
  const match = text.trim().match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : '';
}

function collectJsonCandidates(text: string) {
  const candidates: Array<{ raw: string; json: string }> = [];
  const trimmed = text.trim();
  const fenced = markdownFenceContent(trimmed);
  if (fenced) candidates.push({ raw: trimmed, json: fenced });
  candidates.push({ raw: trimmed, json: trimmed });

  const fenceRegex = /```(?:json|javascript|js)?\s*([\s\S]*?)\s*```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(text))) {
    candidates.push({ raw: fenceMatch[0], json: String(fenceMatch[1] || '').trim() });
  }

  for (const raw of scanJsonSubstrings(text)) {
    candidates.push({ raw, json: raw });
  }

  return candidates;
}

const JSON_SCAN_MAX_CANDIDATES = 20;
const JSON_SCAN_MAX_BYTES = 512_000;

function scanJsonSubstrings(text: string) {
  const found: string[] = [];
  const limit = Math.min(text.length, JSON_SCAN_MAX_BYTES);
  let start = 0;

  while (start < limit && found.length < JSON_SCAN_MAX_CANDIDATES) {
    const first = text[start];
    if (first !== '{' && first !== '[') {
      start += 1;
      continue;
    }

    const stack: string[] = [first];
    let inString = false;
    let escaped = false;
    let matchedEnd = -1;

    for (let index = start + 1; index < limit; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }
      if (char !== '}' && char !== ']') continue;
      const last = stack[stack.length - 1];
      if ((char === '}' && last !== '{') || (char === ']' && last !== '[')) break;
      stack.pop();
      if (stack.length === 0) {
        matchedEnd = index;
        break;
      }
    }

    if (matchedEnd >= 0) {
      const candidate = text.slice(start, matchedEnd + 1);
      if (parseJson(candidate).ok) {
        found.push(candidate);
        start = matchedEnd + 1;
        continue;
      }
    }

    start += 1;
  }

  return found;
}

function extractFunctionStyleCalls(text: string, allowedToolNames: Set<string>) {
  const calls: RecoveredToolCall[] = [];
  const lines = text
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][\w-]*)\s*\(([\s\S]*)\)\s*;?$/);
    if (!match) continue;
    const name = match[1];
    if (!isAllowedTool(name, allowedToolNames)) continue;
    const rawArgs = match[2].trim();
    const args = rawArgs ? coerceArgs(rawArgs) : {};
    calls.push({ name, args, raw: line });
  }

  return calls;
}

function dedupeCalls(calls: RecoveredToolCall[]) {
  const seen = new Set<string>();
  const unique: RecoveredToolCall[] = [];
  for (const call of calls) {
    const key = `${call.name}:${JSON.stringify(call.args)}:${call.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(call);
  }
  return unique;
}

export function extractRecoverableToolCalls(text: string, allowedToolNames?: Iterable<string>): RecoveredToolCall[] {
  if (!text || typeof text !== 'string') return [];
  const allowed = normalizeAllowedToolNames(allowedToolNames);
  const calls: RecoveredToolCall[] = [];

  for (const candidate of collectJsonCandidates(text)) {
    const parsed = parseJson(candidate.json);
    if (!parsed.ok) continue;
    collectToolCalls(parsed.value, candidate.raw, allowed, calls);
  }

  calls.push(...extractFunctionStyleCalls(text, allowed));
  return dedupeCalls(calls);
}

export function stripRecoverableToolCalls(text: string, allowedToolNames?: Iterable<string>): string {
  if (!text || typeof text !== 'string') return text;
  const calls = extractRecoverableToolCalls(text, allowedToolNames);
  if (calls.length === 0) return text.trim();
  let cleaned = text;
  for (const call of calls) {
    cleaned = cleaned.replace(call.raw, '');
  }
  // Drop leftover parallel-call wrapper tokens some models emit around JSON tool calls (e.g. ".parallel { ... }").
  cleaned = cleaned.replace(/\.parallel\b/gi, '');
  return cleaned.trim();
}
