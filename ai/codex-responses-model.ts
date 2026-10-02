// ChatGPT-managed Codex: Responses API adapter for https://chatgpt.com/backend-api/codex/responses

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
import { ensureFreshCodexChatGptToken, readCodexChatGptAuth } from './codex-auth.js';
import { createProviderHttpError, createTruncatedStreamError } from './provider-http-error.js';
import { extensionFetch } from './sdk-client.js';

export const CODEX_CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

const CODEX_ORIGINATOR = 'codex_cli_rs';
const CODEX_USER_AGENT = 'codex_cli_rs/0.0.1';

type ToolCallAccum = {
  id: string;
  name: string;
  arguments: string;
  inputStarted: boolean;
  inputEnded: boolean;
  emittedCall: boolean;
};

const emptyUsage = (): LanguageModelV3Usage => ({
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});

const toolResultToOutput = (output: { type: string; value?: unknown; text?: string; reason?: string }): string => {
  if (output.type === 'text' || output.type === 'error-text') {
    return String(output.value ?? output.text ?? '');
  }
  if (output.type === 'json') {
    try {
      return JSON.stringify(output.value ?? {});
    } catch {
      return '{}';
    }
  }
  if (output.type === 'execution-denied') {
    return String(output.reason || 'Tool execution denied.');
  }
  if (output.type === 'error-json') {
    try {
      return JSON.stringify(output.value ?? {});
    } catch {
      return '{"error":"tool error"}';
    }
  }
  return String(output.value ?? output.text ?? '');
};

const convertPrompt = (prompt: LanguageModelV3Prompt): { instructions: string; input: unknown[] } => {
  const instructionsParts: string[] = [];
  const input: unknown[] = [];

  for (const message of prompt) {
    if (message.role === 'system') {
      if (message.content.trim()) instructionsParts.push(message.content);
      continue;
    }

    if (message.role === 'user') {
      const content = message.content
        .map((part) => {
          if (part.type === 'text') return { type: 'input_text', text: part.text };
          if (part.type === 'file') {
            return { type: 'input_text', text: '[attached file omitted for Codex ChatGPT auth]' };
          }
          return null;
        })
        .filter(Boolean);
      if (content.length) input.push({ type: 'message', role: 'user', content });
      continue;
    }

    if (message.role === 'assistant') {
      let pendingMessageContent: unknown[] = [];
      const flushAssistantMessage = () => {
        if (!pendingMessageContent.length) return;
        input.push({ type: 'message', role: 'assistant', content: pendingMessageContent });
        pendingMessageContent = [];
      };

      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          pendingMessageContent.push({ type: 'output_text', text: part.text });
        }
        if (part.type === 'reasoning' && part.text) {
          pendingMessageContent.push({ type: 'output_text', text: `[reasoning omitted]\n${part.text}` });
        }
        if (part.type === 'tool-call') {
          // Responses API: function_call is a top-level input item, not message content.
          flushAssistantMessage();
          input.push({
            type: 'function_call',
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
          });
        }
        if (part.type === 'tool-result') {
          flushAssistantMessage();
          input.push({
            type: 'function_call_output',
            call_id: part.toolCallId,
            output: toolResultToOutput(part.output),
          });
        }
      }
      flushAssistantMessage();
      continue;
    }

    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          input.push({
            type: 'function_call_output',
            call_id: part.toolCallId,
            output: toolResultToOutput(part.output),
          });
        }
      }
    }
  }

  return { instructions: instructionsParts.join('\n\n'), input };
};

/** Exported for unit tests — Codex ChatGPT prompt → Responses API input shape. */
export const convertCodexChatGptPrompt = convertPrompt;

const convertTools = (tools: LanguageModelV3CallOptions['tools']): unknown[] | undefined => {
  if (!tools?.length) return undefined;
  return tools
    .filter((tool): tool is LanguageModelV3FunctionTool => tool.type === 'function')
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: (tool.inputSchema as JSONSchema7) || { type: 'object', properties: {} },
      strict: false,
    }));
};

const mapFinishReason = (raw: string | undefined): LanguageModelV3FinishReason => {
  switch (raw) {
    case 'stop':
      return { unified: 'stop', raw };
    case 'length':
    case 'max_output_tokens':
      return { unified: 'length', raw };
    case 'content_filter':
      return { unified: 'content-filter', raw };
    case 'tool_calls':
    case 'function_call':
      return { unified: 'tool-calls', raw };
    default:
      return { unified: raw ? 'other' : 'stop', raw };
  }
};

const mapUsage = (usage: Record<string, unknown> | undefined): LanguageModelV3Usage => {
  if (!usage) return emptyUsage();
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  const reasoning = Number((usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  return {
    inputTokens: {
      total: Number.isFinite(input) ? input : undefined,
      noCache: undefined,
      cacheRead: Number(usage.cached_input_tokens) || undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: Number.isFinite(output) ? output : undefined,
      text: undefined,
      reasoning: Number.isFinite(reasoning) ? reasoning : undefined,
    },
  };
};

const buildCodexHeaders = async (accountId: string, accessToken: string): Promise<Record<string, string>> => ({
  Authorization: `Bearer ${accessToken}`,
  'ChatGPT-Account-Id': accountId,
  'chatgpt-account-id': accountId,
  originator: CODEX_ORIGINATOR,
  'User-Agent': CODEX_USER_AGENT,
  'OpenAI-Beta': 'responses=experimental',
  Accept: 'text/event-stream',
  'Content-Type': 'application/json',
});

const parseSseEvents = (
  chunk: string,
  pending: string,
): { events: Array<{ event: string; data: string }>; rest: string } => {
  // Normaliza CRLF: servidores que separam eventos com \r\n\r\n não produziam evento nenhum.
  const combined = (pending + chunk).replace(/\r\n/g, '\n');
  const blocks = combined.split('\n\n');
  const rest = blocks.pop() || '';
  const events: Array<{ event: string; data: string }> = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
  }
  return { events, rest };
};

const createCodexStream = (
  body: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
): Promise<{ finishReason: LanguageModelV3FinishReason; usage: LanguageModelV3Usage }> =>
  new Promise((resolve, reject) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let textStarted = false;
    let reasoningStarted = false;
    let sawTerminal = false;
    const textId = 'txt-0';
    const reasoningId = 'reasoning-0';
    const itemIdToOutputIndex = new Map<string, number>();
    /** Responses streams deltas with item_id (fc_…) while toolCallId must be call_id (call_…). */
    const itemIdToCallId = new Map<string, string>();
    const toolCalls = new Map<string, ToolCallAccum>();
    let finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined };
    let usage = emptyUsage();
    let textBuffer = '';

    const resolveOutputIndex = (parsed: Record<string, unknown>): number | undefined => {
      const direct = parsed.output_index;
      if (typeof direct === 'number') return direct;
      const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : '';
      if (itemId && itemIdToOutputIndex.has(itemId)) return itemIdToOutputIndex.get(itemId);
      return undefined;
    };

    const resolveCallId = (parsed: Record<string, unknown>, item?: Record<string, unknown>): string => {
      const direct = String(parsed.call_id || item?.call_id || '').trim();
      if (direct) return direct;
      const itemId = String(parsed.item_id || item?.id || '').trim();
      if (itemId && itemIdToCallId.has(itemId)) return itemIdToCallId.get(itemId) || itemId;
      return itemId;
    };

    const linkItemToCall = (itemId: string, callId: string) => {
      if (!itemId || !callId || itemId === callId) return;
      itemIdToCallId.set(itemId, callId);
    };

    const ensureTool = (callId: string, name?: string): ToolCallAccum => {
      const existing = toolCalls.get(callId);
      if (existing) {
        if (name && !existing.name) existing.name = name;
        return existing;
      }
      const created: ToolCallAccum = {
        id: callId,
        name: name || '',
        arguments: '',
        inputStarted: false,
        inputEnded: false,
        emittedCall: false,
      };
      toolCalls.set(callId, created);
      return created;
    };

    const emitToolCall = (tool: ToolCallAccum) => {
      if (tool.emittedCall || !tool.name) return;
      if (!tool.inputEnded) {
        controller.enqueue({ type: 'tool-input-end', id: tool.id });
        tool.inputEnded = true;
      }
      controller.enqueue({
        type: 'tool-call',
        toolCallId: tool.id,
        toolName: tool.name,
        input: tool.arguments || '{}',
      });
      tool.emittedCall = true;
      finishReason = { unified: 'tool-calls', raw: 'tool_calls' };
    };

    const applyFunctionCallItem = (item: Record<string, unknown>, emit: boolean) => {
      if (item.type !== 'function_call') return;
      const itemId = typeof item.id === 'string' ? item.id : '';
      const callId = String(item.call_id || itemId || '').trim();
      if (!callId) return;
      if (itemId) linkItemToCall(itemId, callId);
      const name = String(item.name || '');
      const tool = ensureTool(callId, name);
      if (!tool.inputStarted) {
        controller.enqueue({ type: 'tool-input-start', id: callId, toolName: name || tool.name || 'function' });
        tool.inputStarted = true;
      }
      if (typeof item.arguments === 'string' && item.arguments) {
        tool.arguments = item.arguments;
      }
      if (emit) emitToolCall(tool);
    };

    const handleParsed = (parsed: Record<string, unknown>) => {
      const type = String(parsed.type || '');

      if (type === 'response.created' || type === 'response.in_progress') {
        const response = parsed.response as Record<string, unknown> | undefined;
        if (response?.id) {
          controller.enqueue({
            type: 'response-metadata',
            id: String(response.id),
            modelId: typeof response.model === 'string' ? response.model : undefined,
          });
        }
        return;
      }

      if (type === 'response.output_item.added') {
        const item = parsed.item as Record<string, unknown> | undefined;
        const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : undefined;
        const itemId =
          typeof item?.id === 'string' ? item.id : typeof parsed.item_id === 'string' ? parsed.item_id : '';
        if (itemId && typeof outputIndex === 'number') itemIdToOutputIndex.set(itemId, outputIndex);
        if (item) applyFunctionCallItem(item, false);
        return;
      }

      // Authoritative final function_call — Codex often only puts full args here.
      if (type === 'response.output_item.done') {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item) applyFunctionCallItem(item, true);
        return;
      }

      if (type === 'response.function_call_arguments.delta') {
        const callId = resolveCallId(parsed);
        if (!callId) return;
        const delta = String(parsed.delta || '');
        const tool = ensureTool(callId);
        if (!tool.inputStarted) {
          controller.enqueue({ type: 'tool-input-start', id: callId, toolName: tool.name || 'function' });
          tool.inputStarted = true;
        }
        tool.arguments += delta;
        if (delta) controller.enqueue({ type: 'tool-input-delta', id: callId, delta });
        return;
      }

      if (type === 'response.function_call_arguments.done') {
        const callId = resolveCallId(parsed);
        if (!callId) return;
        const tool = ensureTool(callId);
        if (typeof parsed.arguments === 'string') tool.arguments = parsed.arguments;
        // Prefer waiting for output_item.done when args may still be incomplete;
        // emit here only if we already have a name and non-empty arguments.
        if (tool.name && tool.arguments) emitToolCall(tool);
        return;
      }

      if (type === 'response.output_text.delta') {
        resolveOutputIndex(parsed);
        const delta = String(parsed.delta || '');
        if (!delta) return;
        if (!textStarted) {
          controller.enqueue({ type: 'text-start', id: textId });
          textStarted = true;
        }
        controller.enqueue({ type: 'text-delta', id: textId, delta });
        textBuffer += delta;
        return;
      }

      if (type === 'response.output_text.done') {
        resolveOutputIndex(parsed);
        // Deltas already delivered the text — .done carries the full string again.
        if (textStarted) return;
        const delta = String(parsed.text || '');
        if (!delta) return;
        controller.enqueue({ type: 'text-start', id: textId });
        textStarted = true;
        controller.enqueue({ type: 'text-delta', id: textId, delta });
        textBuffer += delta;
        return;
      }

      if (
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta' ||
        type === 'response.reasoning_summary_text.done'
      ) {
        // `.done` repete o texto já entregue por `.delta`; só vale se nenhum delta chegou.
        if (type.endsWith('.done') && reasoningStarted) return;
        const delta = type.endsWith('.delta') ? String(parsed.delta || '') : String(parsed.text || '');
        if (!delta) return;
        if (!reasoningStarted) {
          controller.enqueue({ type: 'reasoning-start', id: reasoningId });
          reasoningStarted = true;
        }
        controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta });
        return;
      }

      if (type === 'response.completed' || type === 'response.incomplete') {
        sawTerminal = true;
        const response = parsed.response as Record<string, unknown> | undefined;
        usage = mapUsage(response?.usage as Record<string, unknown> | undefined);
        const incompleteReason = (response?.incomplete_details as { reason?: unknown } | undefined)?.reason;
        finishReason =
          incompleteReason === 'max_output_tokens'
            ? { unified: 'length', raw: 'max_output_tokens' }
            : mapFinishReason(typeof response?.status === 'string' ? response.status : type.replace('response.', ''));
        const output = Array.isArray(response?.output) ? response.output : [];
        for (const raw of output) {
          if (raw && typeof raw === 'object') applyFunctionCallItem(raw as Record<string, unknown>, true);
        }
        // Deltas may land on item_id before call_id is known — fold orphans into the call_id tool.
        for (const [itemId, callId] of itemIdToCallId) {
          if (itemId === callId) continue;
          const orphan = toolCalls.get(itemId);
          const primary = toolCalls.get(callId);
          if (!orphan || !primary) continue;
          if (!primary.arguments && orphan.arguments) primary.arguments = orphan.arguments;
          if (!primary.name && orphan.name) primary.name = orphan.name;
        }
        for (const tool of toolCalls.values()) emitToolCall(tool);
        return;
      }

      if (type === 'response.failed' || type === 'error') {
        sawTerminal = true;
        const response = parsed.response as Record<string, unknown> | undefined;
        const errObj = (parsed.error || response?.error) as Record<string, unknown> | undefined;
        const message = String(errObj?.message || parsed.message || 'Codex ChatGPT request failed.');
        controller.enqueue({ type: 'error', error: message });
        finishReason = { unified: 'error', raw: type };
      }
    };

    const pump = (): void => {
      reader
        .read()
        .then(({ done, value }) => {
          const dispatchEvents = (events: Array<{ event: string; data: string }>) => {
            for (const evt of events) {
              if (evt.data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(evt.data) as Record<string, unknown>;
                handleParsed(parsed.type ? parsed : { ...parsed, type: evt.event });
              } catch {
                // ignore malformed chunks
              }
            }
          };
          if (done) {
            // Último evento sem "\n\n" final (e bytes UTF-8 retidos pelo decoder) ainda conta:
            // perdê-lo descartava o response.completed.
            const tail = pending + decoder.decode();
            pending = '';
            if (tail.trim()) dispatchEvents(parseSseEvents('', `${tail}\n\n`).events);
            if (!sawTerminal) {
              // Conexão fechada sem response.completed/failed: não é sucesso. Texto parcial ou
              // function_call truncado seria aceito como resposta final.
              reject(createTruncatedStreamError('Codex ChatGPT'));
              return;
            }
            if (textStarted) controller.enqueue({ type: 'text-end', id: textId });
            if (reasoningStarted) controller.enqueue({ type: 'reasoning-end', id: reasoningId });
            controller.enqueue({ type: 'finish', finishReason, usage });
            resolve({ finishReason, usage });
            return;
          }
          const { events, rest } = parseSseEvents(decoder.decode(value, { stream: true }), pending);
          pending = rest;
          dispatchEvents(events);
          pump();
        })
        .catch(reject);
    };

    controller.enqueue({ type: 'stream-start', warnings: [] });
    pump();
  });

const createCodexChatGptFetch = (): typeof globalThis.fetch => {
  return async (input, init) => {
    const bundle = await readCodexChatGptAuth();
    if (!bundle?.accountId) {
      throw new Error('Sessão ChatGPT do Codex ausente. Importe ~/.codex/auth.json ou reconecte via navegador.');
    }
    let token = bundle.accessToken;
    try {
      token = (await ensureFreshCodexChatGptToken()) || token;
    } catch {
      // fall through with current token
    }
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? {});
    const authHeaders = await buildCodexHeaders(bundle.accountId, token);
    for (const [key, value] of Object.entries(authHeaders)) headers.set(key, value);
    const response = await extensionFetch(input, { ...init, headers });
    if (response.status !== 401) return response;

    let retryToken = '';
    try {
      retryToken = (await ensureFreshCodexChatGptToken({ forceRefresh: true })) || '';
    } catch {
      retryToken = '';
    }
    if (!retryToken || retryToken === token) return response;
    const retryHeaders = new Headers((init?.headers as HeadersInit | undefined) ?? {});
    const refreshed = await buildCodexHeaders(bundle.accountId, retryToken);
    for (const [key, value] of Object.entries(refreshed)) retryHeaders.set(key, value);
    return extensionFetch(input, { ...init, headers: retryHeaders });
  };
};

const buildRequestBody = (options: LanguageModelV3CallOptions, modelId: string, stream: boolean) => {
  const { instructions, input } = convertPrompt(options.prompt);
  const tools = convertTools(options.tools);
  const body: Record<string, unknown> = {
    model: modelId,
    instructions: instructions || "You are Codex, OpenAI's coding agent.",
    input,
    store: false,
    stream,
    parallel_tool_calls: true,
  };
  // Codex ChatGPT backend rejects max_output_tokens (HTTP 400).
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
};

export function createCodexChatGptModel(modelId: string): LanguageModelV3 {
  const fetchImpl = createCodexChatGptFetch();
  return {
    specificationVersion: 'v3',
    provider: 'codex-chatgpt',
    modelId,
    supportedUrls: {},
    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const streamResult = await this.doStream(options);
      const reader = streamResult.stream.getReader();
      let text = '';
      let reasoning = '';
      let finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined };
      let usage = emptyUsage();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'text-delta') text += value.delta;
        if (value.type === 'reasoning-delta') reasoning += value.delta;
        if (value.type === 'finish') {
          finishReason = value.finishReason;
          usage = value.usage;
        }
        if (value.type === 'error') throw new Error(String(value.error));
      }
      const content: LanguageModelV3GenerateResult['content'] = [];
      if (reasoning) content.push({ type: 'reasoning', text: reasoning });
      if (text) content.push({ type: 'text', text });
      return { content, finishReason, usage, warnings: [] };
    },
    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const body = buildRequestBody(options, modelId, true);
      const response = await fetchImpl(CODEX_CHATGPT_RESPONSES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
      if (!response.ok) {
        throw await createProviderHttpError(
          'Codex ChatGPT',
          response,
          'Reimporte ~/.codex/auth.json ou reconecte em Configurações.',
        );
      }
      if (!response.body) throw new Error('Codex ChatGPT response stream missing.');
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          void createCodexStream(response.body as ReadableStream<Uint8Array>, controller)
            .then(() => {
              controller.close();
            })
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
      return {
        stream,
        request: { body },
        response: { headers: undefined },
      };
    },
  };
}
