import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, tool } from 'ai';
import { resolveProviderOptions } from './anthropic-options.js';

export type SDKModelSettings = {
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint?: string;
};

// Provedores suportados. 'anthropic' é o Claude Code (OAuth); os demais falam
// o protocolo OpenAI-compatible em endpoints distintos.
export type ProviderId = 'anthropic' | 'codex' | 'opencode' | 'ollama';

export function normalizeProviderId(provider?: string): ProviderId {
  const normalized = String(provider || '')
    .trim()
    .toLowerCase();
  if (normalized === 'codex' || normalized === 'openai') return 'codex';
  if (normalized === 'opencode') return 'opencode';
  if (normalized === 'ollama') return 'ollama';
  if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
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
};

export const PROVIDER_DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-5',
  codex: 'gpt-5.1-codex',
  opencode: 'qwen3-coder',
  ollama: 'llama3.1',
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
    'user-agent': 'claude-cli/2.1.108 (external, cli)',
  };
  // Side-panel pages that call Anthropic directly must opt in. The MV3 service
  // worker strips Origin via declarativeNetRequest instead — never send this
  // header there or Anthropic enforces org-level CORS restrictions.
  if (options?.allowBrowserAccess) {
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  return headers;
}

export function resolveLanguageModel(settings: SDKModelSettings) {
  const provider = normalizeProviderId(settings.provider);
  const modelId = settings.model || PROVIDER_DEFAULT_MODELS[provider];
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
    });
    return anthropic(modelId);
  }

  // Codex (OpenAI), OpenCode Zen e Ollama: protocolo OpenAI-compatible.
  const compat = createOpenAICompatible({
    name: provider,
    baseURL: resolveProviderBaseUrl(provider, settings.customEndpoint),
    // Ollama ignora a chave, mas o header precisa existir para o SDK.
    apiKey: settings.apiKey || (provider === 'ollama' ? 'ollama' : 'no-key'),
  });
  return compat(modelId);
}

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

    // Claude-for-Chrome vision: let the multimodal model SEE the screenshot as an
    // image tool-result instead of only reading DOM text. Fail-safe: any missing
    // image or shape falls back to the normal JSON output (current behaviour).
    if (isAnthropic && name === 'screenshot' && getScreenshotImage) {
      toolInit.toModelOutput = ({ toolCallId, output }: { toolCallId: string; output: any }) => {
        try {
          const dataUrl = getScreenshotImage(toolCallId);
          const match = typeof dataUrl === 'string' ? dataUrl.match(/^data:([^;]+);base64,(.+)$/) : null;
          if (match) {
            return {
              type: 'content',
              value: [
                {
                  type: 'text',
                  text: 'Screenshot of the current page. Use it to see the real layout, then act: findElement by the visible text you see, then click. Do not guess URLs.',
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
