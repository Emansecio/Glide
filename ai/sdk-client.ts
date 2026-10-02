import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, tool } from 'ai';
import { ensureFreshAnthropicToken } from './anthropic-oauth.js';
import { resolveProviderOptions } from './anthropic-options.js';
import { createCodexChatGptModel } from './codex-responses-model.js';
import { createCommandCodeModel } from './command-code-model.js';
import { QWEN_DEFAULT_BASE_URL, normalizeQwenModelId } from './qwen-settings.js';
import { wrapUntrustedContent } from './untrusted-content.js';
import { XAI_API_BASE_URL, ensureFreshXaiToken } from './xai-oauth.js';

export type SDKModelSettings = {
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint?: string;
  /** When provider=codex: chatgpt uses Codex Responses OAuth; api_key uses OpenAI-compatible. */
  codexAuthMode?: 'chatgpt' | 'api_key' | null;
};

// Chrome service-worker APIs require the original global object as `this`.
// The Anthropic SDK stores fetch in a local variable before calling it, which
// otherwise makes Chrome throw "Illegal invocation" in the extension runtime.
export const extensionFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

// Provedores suportados. 'anthropic' é o Claude Code (OAuth); os demais falam
// o protocolo OpenAI-compatible em endpoints distintos.
export type ProviderId = 'anthropic' | 'codex' | 'opencode' | 'ollama' | 'qwen' | 'xai' | 'command-code';

export function normalizeProviderId(provider?: string): ProviderId {
  const normalized = String(provider || '')
    .trim()
    .toLowerCase();
  if (normalized === 'codex' || normalized === 'openai') return 'codex';
  if (normalized === 'opencode') return 'opencode';
  if (normalized === 'ollama') return 'ollama';
  if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
  if (
    normalized === 'qwen' ||
    normalized === 'qwencloud' ||
    normalized === 'qwen-cloud' ||
    normalized === 'bailian' ||
    normalized === 'dashscope' ||
    normalized === 'modelstudio'
  ) {
    return 'qwen';
  }
  if (normalized === 'xai' || normalized === 'grok' || normalized === 'grokcloud' || normalized === 'grok-cloud') {
    return 'xai';
  }
  if (normalized === 'command-code' || normalized === 'commandcode' || normalized === 'command_code') {
    return 'command-code';
  }
  if (!normalized) return 'ollama'; // Empty / unknown -> local Ollama by default (Ollama-first)
  return 'ollama';
}

// Maps legacy stored provider ids to the current four-provider model.
export function migrateStoredProvider(provider?: string, customEndpoint?: string): ProviderId {
  const normalized = String(provider || '')
    .trim()
    .toLowerCase();
  if (normalized === 'openai-compatible') return 'ollama';
  if (normalized === 'custom') {
    const endpoint = String(customEndpoint || '').trim();
    if (endpoint) {
      try {
        const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
          return 'ollama';
        }
      } catch {
        // Non-URL custom endpoints fall through to codex.
      }
    }
    return 'codex';
  }
  return normalizeProviderId(provider);
}

export const PROVIDER_DEFAULT_ENDPOINTS: Record<ProviderId, string> = {
  anthropic: 'https://api.anthropic.com',
  codex: 'https://api.openai.com/v1',
  opencode: 'https://opencode.ai/zen/v1',
  ollama: 'http://localhost:11434/v1',
  qwen: QWEN_DEFAULT_BASE_URL,
  xai: XAI_API_BASE_URL,
  'command-code': 'https://api.commandcode.ai',
};

export const PROVIDER_DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-5',
  codex: 'gpt-5.6-luna',
  opencode: 'qwen3-coder',
  ollama: 'llama3.1',
  qwen: 'deepseek-v4-flash-0731',
  xai: 'grok-4.5',
  'command-code': 'moonshotai/Kimi-K3',
};

// A custom endpoint receives the provider API key on every request, so it must
// be https — except a local Ollama, which is loopback cleartext by design.
// Anything else (http to a remote host, a non-URL string) is ignored and the
// safe provider default is used instead, so a crafted endpoint cannot exfiltrate
// the key.
export function isCustomEndpointAllowed(provider: string, endpoint: string): boolean {
  const normalized = normalizeProviderId(provider);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return normalized === 'ollama' && isLoopback;
  }
  return false;
}

export function resolveProviderBaseUrl(provider: string, customEndpoint?: string): string {
  const normalized = normalizeProviderId(provider);
  const custom = String(customEndpoint || '').trim();
  let base = custom && isCustomEndpointAllowed(normalized, custom) ? custom : PROVIDER_DEFAULT_ENDPOINTS[normalized];
  base = base.replace(/\/+$/, '');
  // O Ollama expõe a API OpenAI-compatible sob /v1; usuários costumam informar só host:porta.
  if (normalized === 'ollama' && !/\/v1$/i.test(base)) {
    base = `${base}/v1`;
  }
  return base;
}

export type ToolDefinition = {
  name: string;
  description?: string;
  input_schema?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export function buildAnthropicOAuthHeaders(
  apiKey: string,
  options?: { allowBrowserAccess?: boolean },
): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': undefined,
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    'x-app': 'cli',
  };
  // User-Agent is a forbidden browser fetch header. The MV3 network rule applies
  // the Claude CLI identity after Chrome has accepted the request headers.
  // Side-panel pages that call Anthropic directly must opt in. The MV3 service
  // worker strips Origin via declarativeNetRequest instead — never send this
  // header there or Anthropic enforces org-level CORS restrictions.
  if (options?.allowBrowserAccess) {
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  return headers;
}

const withBearerToken = (init: RequestInit | undefined, token: string): RequestInit => {
  const headers = new Headers((init?.headers as HeadersInit | undefined) ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  headers.delete('x-api-key');
  return { ...init, headers };
};

/**
 * Fetch com Authorization renovado a cada requisição. Os headers estáticos do
 * createAnthropic ficam congelados no modelo cacheado, então um token que expira
 * no meio de um run longo passaria a responder 401 sem recuperação. Este wrapper
 * pede um token fresco por request e, num 401 (token revogado no servidor antes
 * do expiry local), força um refresh e repete a requisição uma única vez.
 * O corpo já chega serializado (string) do SDK, então o retry é seguro.
 */
const createAnthropicAuthFetch = (fallbackToken: string): typeof globalThis.fetch => {
  return async (input, init) => {
    let token = fallbackToken;
    try {
      token = (await ensureFreshAnthropicToken(fallbackToken)) || fallbackToken;
    } catch {
      // Sem storage/refresh disponível: segue com o token estático.
    }
    const response = await globalThis.fetch(input, withBearerToken(init, token));
    if (response.status !== 401) return response;

    let retryToken = '';
    try {
      retryToken = await ensureFreshAnthropicToken(fallbackToken, { forceRefresh: true });
    } catch {
      retryToken = '';
    }
    if (!retryToken || retryToken === token) return response;
    return globalThis.fetch(input, withBearerToken(init, retryToken));
  };
};

/** Fetch xAI com Bearer renovado (sessão Grok CLI / OIDC). */
const createXaiAuthFetch = (fallbackToken: string): typeof globalThis.fetch => {
  return async (input, init) => {
    let token = fallbackToken;
    try {
      token = (await ensureFreshXaiToken(fallbackToken)) || fallbackToken;
    } catch {
      // Sem storage/refresh: segue com o token estático (API key xai-… ou JWT).
    }
    const response = await globalThis.fetch(input, withBearerToken(init, token));
    if (response.status !== 401) return response;

    let retryToken = '';
    try {
      retryToken = await ensureFreshXaiToken(fallbackToken, { forceRefresh: true });
    } catch {
      retryToken = '';
    }
    if (!retryToken || retryToken === token) return response;
    return globalThis.fetch(input, withBearerToken(init, retryToken));
  };
};

export function resolveLanguageModel(settings: SDKModelSettings) {
  const provider = normalizeProviderId(settings.provider);
  // Qwen: normaliza aliases (deepseek-v4-flash → deepseek-v4-flash-0731).
  let modelId = settings.model || PROVIDER_DEFAULT_MODELS[provider];
  if (provider === 'qwen') {
    modelId = normalizeQwenModelId(modelId);
  }
  const apiKey = settings.apiKey || 'no-key';

  if (provider === 'anthropic') {
    // Claude Code OAuth: o token vai em "Authorization: Bearer <token>".
    // Três detalhes obrigatórios do SDK v3.0.17 (createAnthropic):
    //   1. baseURL PRECISA terminar em /v1 (o SDK posta em `${baseURL}/messages`);
    //      sem isso a chamada bate em /messages e retorna 404.
    //   2. loadApiKey() roda dentro de getHeaders() e LANÇA se apiKey/env estiverem
    //      ausentes — por isso passamos um placeholder para não estourar antes do request.
    //   3. o header x-api-key (derivado do placeholder) precisa ser REMOVIDO
    //      (override para undefined), senão a API responde 401 "invalid x-api-key"
    //      em vez de aceitar o Bearer do OAuth.
    // x-api-key: undefined remove o header no fetch layer do SDK; o tipo do SDK
    // exige string, então tipamos como Record<string, string | undefined>.
    const oauthHeaders = buildAnthropicOAuthHeaders(apiKey);
    const anthropic = createAnthropic({
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'oauth-placeholder',
      headers: oauthHeaders as Record<string, string>,
      // Authorization dinâmico por request: sobrevive a expiração/rotação de
      // token no meio de um run longo (o header estático acima é só fallback).
      fetch: createAnthropicAuthFetch(apiKey),
    });
    return anthropic(modelId);
  }

  // Codex ChatGPT OAuth: Responses API on chatgpt.com — never send JWT to api.openai.com.
  if (provider === 'codex' && settings.codexAuthMode === 'chatgpt') {
    return createCodexChatGptModel(modelId);
  }

  // xAI / Grok: OpenAI-compatible em api.x.ai com refresh de sessão OIDC.
  if (provider === 'xai') {
    const compat = createOpenAICompatible({
      name: 'xai',
      baseURL: resolveProviderBaseUrl(provider, settings.customEndpoint),
      apiKey: apiKey || 'no-key',
      fetch: createXaiAuthFetch(apiKey),
    });
    return compat(modelId);
  }

  if (provider === 'command-code') {
    return createCommandCodeModel(modelId, apiKey, resolveProviderBaseUrl(provider, settings.customEndpoint));
  }

  // Codex API key, OpenCode Zen, Qwen/ModelStudio e Ollama: OpenAI-compatible.
  const compat = createOpenAICompatible({
    name: provider,
    baseURL: resolveProviderBaseUrl(provider, settings.customEndpoint),
    // Ollama ignora a chave, mas o header precisa existir para o SDK.
    apiKey: settings.apiKey || (provider === 'ollama' ? 'ollama' : 'no-key'),
    fetch: extensionFetch,
  });
  return compat(modelId);
}

export const serializeToolOutputForMedia = (output: unknown): string => {
  const safeOutput = output && typeof output === 'object' && !Array.isArray(output) ? { ...output } : output;
  if (safeOutput && typeof safeOutput === 'object' && !Array.isArray(safeOutput)) {
    delete (safeOutput as Record<string, unknown>).dataUrl;
    delete (safeOutput as Record<string, unknown>).recoveryScreenshotDataUrl;
  }
  let serialized = '{"success":false,"error":"Tool output could not be serialized."}';
  try {
    serialized = JSON.stringify(safeOutput ?? {}).slice(0, 4000);
  } catch {
    // keep fallback
  }
  return wrapUntrustedContent(serialized, 'tool-result');
};

export function buildToolSet(
  tools: ToolDefinition[],
  execute: (toolName: string, args: Record<string, unknown>, options: { toolCallId: string }) => Promise<unknown>,
  provider?: string,
  getScreenshotImage?: (toolCallId: string) => string | undefined,
) {
  const isAnthropic = normalizeProviderId(provider) === 'anthropic';

  const entries = tools.map((definition) => {
    let name = definition.name;

    // Alias mapping for Anthropic Claude Code OAuth quota routing safety
    if (isAnthropic) {
      if (name === 'session_search') {
        name = 'session_lookup';
      } else if (name === 'skills_list') {
        name = 'list_skills';
      }
    }

    const schema = definition.input_schema || {
      type: 'object',
      properties: {},
    };

    const toolInit: Record<string, unknown> = {
      description: definition.description,
      inputSchema: jsonSchema(schema),
      execute: async (args: unknown, options: { toolCallId: string }) => {
        // Map alias back to original name for execution
        const originalName = definition.name;
        return execute(originalName, args as Record<string, unknown>, {
          toolCallId: options.toolCallId,
        });
      },
    };

    // Claude-for-Chrome vision: a screenshot may come from screenshot() itself or
    // from automatic failure recovery on another browser tool. Preserve the JSON
    // tool result alongside the image so the model sees both failure state and UI.
    if (isAnthropic && getScreenshotImage) {
      toolInit.toModelOutput = ({ toolCallId, output }: { toolCallId: string; output: any }) => {
        try {
          const dataUrl = getScreenshotImage(toolCallId);
          const match = typeof dataUrl === 'string' ? dataUrl.match(/^data:([^;]+);base64,(.+)$/) : null;
          if (match) {
            const outputText = serializeToolOutputForMedia(output);
            return {
              type: 'content',
              value: [
                {
                  type: 'text',
                  text: `Tool result: ${outputText}\nScreenshot of the current page. Use the visible layout to choose a verified next action; do not guess selectors or URLs.`,
                },
                { type: 'media', data: match[2], mediaType: match[1] },
              ],
            };
          }
        } catch {
          // fall through to JSON output
        }
        return { type: 'json', value: output ?? {} };
      };
    }

    return [name, tool(toolInit as any)] as const;
  });
  return Object.fromEntries(entries);
}

export async function describeImageWithModel({
  settings,
  dataUrl,
  prompt,
  maxTokens = 512,
  abortSignal,
}: {
  settings: SDKModelSettings;
  dataUrl: string;
  prompt: string;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}) {
  const model = resolveLanguageModel(settings);
  const result = await generateText({
    model,
    ...resolveProviderOptions(settings.provider),
    maxOutputTokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', image: dataUrl },
        ],
      },
    ],
    abortSignal,
  });
  return result.text;
}
