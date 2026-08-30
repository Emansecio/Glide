import type {
  JSONSchema7,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { extensionFetch } from './sdk-client.js';

export const COMMAND_CODE_GENERATE_PATH = '/alpha/generate';
export const COMMAND_CODE_CLIENT_VERSION = '1.38.0';

type CommandCodeEvent = Record<string, unknown>;

const emptyUsage = (): LanguageModelV3Usage => ({
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});

const toolResultToText = (output: { type: string; value?: unknown; reason?: string }): string => {
  if (output.type === 'text' || output.type === 'error-text') return String(output.value ?? '');
  if (output.type === 'execution-denied') return String(output.reason || 'Tool execution denied.');
  try {
    return JSON.stringify(output.value ?? {});
  } catch {
    return '{}';
  }
};

const wireTextPart = (text: string) => ({ type: 'text', text });

const inferImageMediaType = (image: unknown, fallback?: string): string => {
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  if (typeof image === 'string') {
    const match = image.match(/^data:([^;,]+)/);
    if (match?.[1]) return match[1];
  }
  return 'image/png';
};

const wireUserPart = (part: {
  type: string;
  text?: string;
  image?: unknown;
  mediaType?: string;
  mimeType?: string;
}): Record<string, unknown> | null => {
  if (part.type === 'text' && part.text) return wireTextPart(part.text);
  if (part.type === 'image' && part.image != null) {
    return {
      type: 'image',
      image: part.image,
      mediaType: inferImageMediaType(part.image, part.mediaType || part.mimeType),
    };
  }
  if (part.type === 'file') return wireTextPart('[file attachment omitted]');
  return null;
};

const wireUserContent = (
  content: Array<{ type: string; text?: string; image?: unknown; mediaType?: string; mimeType?: string }>,
) => content.map(wireUserPart).filter((part): part is Record<string, unknown> => Boolean(part));

const convertPrompt = (prompt: LanguageModelV3Prompt): { system: string; messages: unknown[] } => {
  const systemParts: string[] = [];
  const messages: unknown[] = [];

  for (const message of prompt) {
    if (message.role === 'system') {
      if (message.content.trim()) systemParts.push(message.content);
      continue;
    }

    if (message.role === 'user') {
      const content = wireUserContent(message.content);
      if (content.length) messages.push({ role: 'user', content });
      continue;
    }

    if (message.role === 'assistant') {
      const content: unknown[] = [];
      for (const part of message.content) {
        if (part.type === 'text' && part.text) content.push(wireTextPart(part.text));
        if (part.type === 'reasoning' && part.text) content.push({ type: 'reasoning', text: part.text });
        if (part.type === 'tool-call' && !part.providerExecuted) {
          content.push({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
        }
        if (part.type === 'tool-result') {
          content.push({
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: { type: 'text', value: toolResultToText(part.output) },
          });
        }
      }
      if (content.length) messages.push({ role: 'assistant', content });
      continue;
    }

    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: { type: 'text', value: toolResultToText(part.output) },
            },
          ],
        });
      }
    }
  }

  return { system: systemParts.join('\n\n'), messages };
};

/** Exported for unit tests and to keep the wire contract explicit. */
export const convertCommandCodePrompt = convertPrompt;

const buildCommandCodeConfig = () => ({
  workingDir: 'glide-v2',
  date: new Date().toISOString().slice(0, 10),
  environment: 'chrome-extension',
  structure: [],
  isGitRepo: false,
  currentBranch: '',
  mainBranch: '',
  gitStatus: '',
  recentCommits: [],
});

const convertTools = (tools: LanguageModelV3CallOptions['tools']): unknown[] =>
  (tools || [])
    .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === 'function')
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: (tool.inputSchema as JSONSchema7) || { type: 'object', properties: {} },
    }));

export const buildCommandCodeRequestBody = (
  options: LanguageModelV3CallOptions,
  modelId: string,
): Record<string, unknown> => {
  const { system, messages } = convertPrompt(options.prompt);
  return {
    config: buildCommandCodeConfig(),
    memory: '',
    taste: null,
    skills: null,
    permissionMode: 'standard',
    mode: 'agent',
    params: {
      model: modelId,
      messages,
      tools: convertTools(options.tools),
      system: system || undefined,
      max_tokens: options.maxOutputTokens ?? 64000,
      stream: true,
      ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
    },
  };
};

const mapFinishReason = (raw: string | undefined): LanguageModelV3FinishReason => {
  if (raw === 'length' || raw === 'max_tokens' || raw === 'max_output_tokens') return { unified: 'length', raw };
  if (raw === 'tool-calls' || raw === 'tool_calls' || raw === 'function_call') return { unified: 'tool-calls', raw };
  if (raw === 'error' || raw === 'truncated' || raw === 'abort') return { unified: 'error', raw };
  if (raw === 'stop' || raw === 'end_turn' || raw === undefined) return { unified: 'stop', raw };
  return { unified: 'error', raw };
};

const numberOrUndefined = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const mapUsage = (raw: unknown): LanguageModelV3Usage => {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const usage = raw as Record<string, unknown>;
  const cacheDetails = (usage.inputTokenDetails || {}) as Record<string, unknown>;
  const input = numberOrUndefined(usage.inputTokens);
  const output = numberOrUndefined(usage.outputTokens);
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: numberOrUndefined(cacheDetails.cacheReadTokens),
      cacheWrite: numberOrUndefined(cacheDetails.cacheWriteTokens),
    },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
};

const eventErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const object = error as Record<string, unknown>;
    return String(object.message || object.error || JSON.stringify(object));
  }
  return String(error || 'Command Code request failed.');
};

const consumeNdjson = async (
  body: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): Promise<{ finishReason: LanguageModelV3FinishReason; usage: LanguageModelV3Usage }> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let textStarted = false;
  let reasoningStarted = false;
  let sawTerminalEvent = false;
  let finishReason: LanguageModelV3FinishReason = { unified: 'error', raw: 'truncated' };
  let usage = emptyUsage();

  const markTerminal = (reason: LanguageModelV3FinishReason) => {
    sawTerminalEvent = true;
    finishReason = reason;
  };

  const handleEvent = (event: CommandCodeEvent) => {
    const type = String(event.type || '');
    if (type === 'text-delta') {
      const text = String(event.text || '');
      if (!text) return;
      if (!textStarted) {
        controller.enqueue({ type: 'text-start', id: 'text-0' });
        textStarted = true;
      }
      controller.enqueue({ type: 'text-delta', id: 'text-0', delta: text });
      return;
    }
    if (type === 'reasoning-start') {
      if (!reasoningStarted) {
        controller.enqueue({ type: 'reasoning-start', id: 'reasoning-0' });
        reasoningStarted = true;
      }
      return;
    }
    if (type === 'reasoning-delta') {
      const text = String(event.text || '');
      if (!text) return;
      if (!reasoningStarted) {
        controller.enqueue({ type: 'reasoning-start', id: 'reasoning-0' });
        reasoningStarted = true;
      }
      controller.enqueue({ type: 'reasoning-delta', id: 'reasoning-0', delta: text });
      return;
    }
    if (type === 'reasoning-end') {
      if (reasoningStarted) controller.enqueue({ type: 'reasoning-end', id: 'reasoning-0' });
      reasoningStarted = false;
      return;
    }
    if (type === 'tool-call') {
      const toolCallId = String(event.toolCallId || event.tool_call_id || `tool-${Date.now()}`);
      const toolName = String(event.toolName || event.tool_name || 'function');
      const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input ?? {});
      controller.enqueue({ type: 'tool-input-start', id: toolCallId, toolName });
      controller.enqueue({ type: 'tool-input-end', id: toolCallId });
      controller.enqueue({ type: 'tool-call', toolCallId, toolName, input });
      finishReason = { unified: 'tool-calls', raw: 'tool_calls' };
      return;
    }
    if (type === 'finish' || type === 'finish-step') {
      markTerminal(mapFinishReason(String(event.finishReason || event.rawFinishReason || 'stop')));
      usage = mapUsage(event.totalUsage || event.usage);
      return;
    }
    if (type === 'error') {
      const message = eventErrorMessage(event.error || event.message);
      controller.enqueue({ type: 'error', error: message });
      markTerminal({ unified: 'error', raw: 'error' });
      return;
    }
    if (type === 'abort') {
      markTerminal({ unified: 'error', raw: 'abort' });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleEvent(JSON.parse(trimmed) as CommandCodeEvent);
      } catch {
        // Ignore a malformed event; the next event still has a chance to finish the run.
      }
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    try {
      handleEvent(JSON.parse(pending.trim()) as CommandCodeEvent);
    } catch {
      // Ignore an incomplete trailing event.
    }
  }
  if (!sawTerminalEvent) {
    const message = 'Command Code stream ended without a terminal event.';
    controller.enqueue({ type: 'error', error: message });
    finishReason = { unified: 'error', raw: 'truncated' };
  }
  if (textStarted) controller.enqueue({ type: 'text-end', id: 'text-0' });
  if (reasoningStarted) controller.enqueue({ type: 'reasoning-end', id: 'reasoning-0' });
  controller.enqueue({ type: 'finish', finishReason, usage });
  return { finishReason, usage };
};

export function createCommandCodeModel(
  modelId: string,
  apiKey: string,
  baseUrl = 'https://api.commandcode.ai',
): LanguageModelV3 {
  const url = `${baseUrl.replace(/\/+$/, '')}${COMMAND_CODE_GENERATE_PATH}`;
  const fetchImpl = extensionFetch;

  return {
    specificationVersion: 'v3',
    provider: 'command-code',
    modelId,
    supportedUrls: {},
    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const streamResult = await this.doStream(options);
      const reader = streamResult.stream.getReader();
      let text = '';
      let reasoning = '';
      const toolCalls: Array<{ toolCallId: string; toolName: string; input: string }> = [];
      let finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined };
      let usage = emptyUsage();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'text-delta') text += value.delta;
        if (value.type === 'reasoning-delta') reasoning += value.delta;
        if (value.type === 'tool-call') toolCalls.push(value);
        if (value.type === 'finish') {
          finishReason = value.finishReason;
          usage = value.usage;
        }
        if (value.type === 'error') throw new Error(eventErrorMessage(value.error));
      }
      const content: LanguageModelV3GenerateResult['content'] = [];
      if (reasoning) content.push({ type: 'reasoning', text: reasoning });
      if (text) content.push({ type: 'text', text });
      for (const call of toolCalls) {
        content.push({ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
      }
      return { content, finishReason, usage, warnings: [] };
    },
    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const body = buildCommandCodeRequestBody(options, modelId);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
          'User-Agent': 'cli',
          'x-command-code-version': COMMAND_CODE_CLIENT_VERSION,
          'x-cli-environment': 'production',
          'x-taste-learning': 'false',
          'x-co-flag': 'false',
          ...(options.headers || {}),
        },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Command Code request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}.`,
        );
      }
      if (!response.body) throw new Error('Command Code response stream missing.');
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          void consumeNdjson(response.body as ReadableStream<Uint8Array>, controller)
            .then(() => controller.close())
            .catch((error) => {
              controller.enqueue({ type: 'error', error });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'error', raw: 'error' },
                usage: emptyUsage(),
              });
              controller.close();
            });
        },
      });
      return { stream, request: { body }, response: { headers: undefined } };
    },
  };
}
