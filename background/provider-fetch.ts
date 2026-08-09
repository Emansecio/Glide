import { normalizeProviderId, resolveProviderBaseUrl } from '../ai/sdk-client.js';
import { type OllamaModelInfo, type OllamaProbeResult, formatOllamaListSummary, probeOllama } from './ollama-detect.js';

export type ProviderModelsRequest = {
  provider: string;
  apiKey?: string;
  customEndpoint?: string;
};

export type ProviderModelsResult = {
  models: string[];
  /** Rich rows for Ollama (`ollama list` style). Empty for other providers. */
  modelDetails: OllamaModelInfo[];
  online: boolean;
  endpoint?: string;
  summary?: string;
  latencyMs?: number;
};

export async function detectOllamaDetailed(customEndpoint?: string): Promise<OllamaProbeResult> {
  return probeOllama({ customEndpoint, timeoutMs: 8000 });
}

export async function detectOpenAiCompatibleModels(
  provider: string,
  apiKey: string,
  customEndpoint?: string,
): Promise<string[]> {
  const normalized = normalizeProviderId(provider);
  const base = resolveProviderBaseUrl(normalized, customEndpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const data = await response.json();
    const entries = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    return entries
      .map((entry: { id?: string; name?: string }) => String(entry?.id || entry?.name || ''))
      .filter(Boolean)
      .sort();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProviderModels(request: ProviderModelsRequest): Promise<ProviderModelsResult> {
  const provider = normalizeProviderId(request.provider);
  const apiKey = String(request.apiKey || '');
  const customEndpoint = String(request.customEndpoint || '').trim();

  if (provider === 'ollama') {
    const probe = await detectOllamaDetailed(customEndpoint);
    if (!probe.online) {
      throw new Error(
        probe.error
          ? `Ollama offline: ${probe.error}. Inicie o Ollama (ollama serve) e confira ollama list.`
          : 'Ollama offline. Inicie o Ollama e confira com: ollama list',
      );
    }
    return {
      models: probe.modelNames,
      modelDetails: probe.models,
      online: true,
      endpoint: probe.endpoint,
      summary: formatOllamaListSummary(probe),
      latencyMs: probe.latencyMs,
    };
  }

  const models = await detectOpenAiCompatibleModels(provider, apiKey, customEndpoint);
  return {
    models,
    modelDetails: [],
    online: true,
    endpoint: resolveProviderBaseUrl(provider, customEndpoint),
  };
}

export type { OllamaModelInfo, OllamaProbeResult };
