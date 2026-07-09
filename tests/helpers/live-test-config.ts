import { probeOllama as probeOllamaDetailed } from '../../background/ollama-detect.js';

export function liveTestsEnabled(): boolean {
  return process.env.GLIDE_LIVE_TESTS === '1';
}

export function skipUnlessLive(reason: string): void {
  if (!liveTestsEnabled()) {
    throw new Error(`SKIPPED: ${reason} (set GLIDE_LIVE_TESTS=1 to run)`);
  }
}

/** Lightweight probe used by live tests — wraps shared Ollama detector. */
export async function probeOllama(endpoint = process.env.TEST_OLLAMA_ENDPOINT || 'http://localhost:11434'): Promise<{
  ok: boolean;
  models: string[];
  endpoint: string;
}> {
  const result = await probeOllamaDetailed({ customEndpoint: endpoint, timeoutMs: 5000 });
  return {
    ok: result.online && result.modelNames.length > 0,
    models: result.modelNames,
    endpoint: result.endpoint,
  };
}

export async function resolveLiveOllamaModel(): Promise<{ endpoint: string; model: string }> {
  const preferredEndpoint = process.env.TEST_OLLAMA_ENDPOINT || 'http://localhost:11434';
  const explicit = String(process.env.TEST_OLLAMA_MODEL || '').trim();
  const probe = await probeOllamaDetailed({ customEndpoint: preferredEndpoint, timeoutMs: 5000 });
  if (!probe.online || !probe.modelNames.length) {
    throw new Error('No Ollama models available. Start Ollama and run: ollama list');
  }
  const endpoint = probe.endpoint || preferredEndpoint;
  if (explicit) {
    if (!probe.modelNames.includes(explicit)) {
      console.warn(
        `[live-tests] TEST_OLLAMA_MODEL="${explicit}" not in ollama list; available: ${probe.modelNames.join(', ')}`,
      );
    }
    return { endpoint, model: explicit };
  }
  return { endpoint, model: probe.modelNames[0] };
}
