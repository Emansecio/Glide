import { resolveProviderBaseUrl } from '../ai/sdk-client.js';

export const COMMAND_CODE_PRESET_MODELS = ['moonshotai/Kimi-K3'] as const;
const PROBE_TIMEOUT_MS = 8000;

export type CommandCodeProbeResult = {
  online: boolean;
  models: string[];
  endpoint: string;
  latencyMs?: number;
  error?: string;
};

const parseModelIds = (data: unknown): string[] => {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const entries = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const row = entry as { id?: string; name?: string };
        return String(row.id || row.name || '');
      }
      return '';
    })
    .filter(Boolean);
};

export async function probeCommandCode(
  apiKey: string,
  customEndpoint?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CommandCodeProbeResult> {
  const endpoint = resolveProviderBaseUrl('command-code', customEndpoint);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/provider/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (response.status === 401 || response.status === 403) {
      return {
        online: false,
        models: [],
        endpoint,
        latencyMs,
        error: `HTTP ${response.status}: credencial do Command Code rejeitada.`,
      };
    }
    if (response.status >= 500) {
      return {
        online: false,
        models: [],
        endpoint,
        latencyMs,
        error: `HTTP ${response.status}: Command Code indisponível.`,
      };
    }
    if (response.status === 404) {
      return {
        online: true,
        models: [...COMMAND_CODE_PRESET_MODELS],
        endpoint,
        latencyMs,
      };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        online: false,
        models: [],
        endpoint,
        latencyMs,
        error: `HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`,
      };
    }
    const data = await response.json().catch(() => null);
    const models = parseModelIds(data);
    return {
      online: true,
      models: models.length ? models : [...COMMAND_CODE_PRESET_MODELS],
      endpoint,
      latencyMs,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      online: false,
      models: [],
      endpoint,
      latencyMs: Date.now() - startedAt,
      error: aborted ? 'Command Code não respondeu a tempo.' : String((error as Error)?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}
