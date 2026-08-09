export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
  rng?: () => number;
};

const DEFAULT_QUIT_PHRASES = [
  'please try again',
  'i could not produce a final summary',
  'i could not produce a final response',
  'unable to produce a final summary',
  'unable to provide a final response',
];

export function createExponentialBackoff(options: BackoffOptions = {}) {
  const baseMs = Number.isFinite(options.baseMs) ? Number(options.baseMs) : 500;
  const maxMs = Number.isFinite(options.maxMs) ? Number(options.maxMs) : 8000;
  const jitter = Number.isFinite(options.jitter) ? Number(options.jitter) : 0.2;
  const rng = options.rng || Math.random;

  return (attempt: number) => {
    const safeAttempt = Math.max(1, Math.floor(attempt));
    const raw = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
    if (jitter <= 0) return Math.round(raw);
    const jitterFactor = 1 + (rng() * 2 - 1) * jitter;
    return Math.round(raw * jitterFactor);
  };
}

export function isRetryableProviderError(status: unknown): boolean {
  const code = typeof status === 'number' ? status : Number(status);
  if (!Number.isFinite(code)) return false;
  if (code === 400 || code === 401 || code === 403) return false;
  if (code === 408 || code === 429) return true;
  return code >= 500;
}

/**
 * Erros de sobrecarga/limite que chegam SEM status numérico — comum no caminho de
 * streaming, onde o provedor fecha a conexão com uma mensagem em texto. Sem isto,
 * um "overloaded_error" da Anthropic (retentável por natureza) matava o run.
 */
export function isOverloadedProviderError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || error || '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('overloaded') ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('too many requests') ||
    message.includes('service unavailable') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout') ||
    message.includes('temporarily unavailable')
  );
}

/**
 * `retry-after` do provedor em ms (header em segundos ou data HTTP). 0 quando ausente.
 * Respeitar essa janela é o que impede queimar as tentativas restantes em rajada.
 */
export function extractRetryAfterMs(error: unknown, now = Date.now()): number {
  if (!error || typeof error !== 'object') return 0;
  const candidate = error as Record<string, any>;
  const headers = candidate.responseHeaders || candidate.headers || candidate.response?.headers;
  let raw: unknown;
  if (headers && typeof headers === 'object') {
    if (typeof (headers as any).get === 'function') {
      raw = (headers as any).get('retry-after') ?? (headers as any).get('Retry-After');
    } else {
      const record = headers as Record<string, unknown>;
      raw = record['retry-after'] ?? record['Retry-After'];
    }
  }
  if (raw == null) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    // Cap em 60s: uma janela maior que isso é melhor reportada ao usuário do que
    // esperada em silêncio dentro de um run.
    return Math.min(60_000, Math.round(seconds * 1000));
  }
  const asDate = Date.parse(String(raw));
  if (Number.isFinite(asDate)) {
    return Math.min(60_000, Math.max(0, asDate - now));
  }
  return 0;
}

export function extractProviderErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  if (typeof candidate.status === 'number') return candidate.status;
  const response = candidate.response;
  if (response && typeof response === 'object') {
    const responseStatus = (response as Record<string, unknown>).status;
    if (typeof responseStatus === 'number') return responseStatus;
  }
  return undefined;
}

export function isValidFinalResponse(
  text: unknown,
  options: { quitPhrases?: string[]; allowEmpty?: boolean } = {},
): text is string {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  // Allow empty responses if tool calls were made (model communicated through actions)
  if (!trimmed) return options.allowEmpty === true;
  const lowered = trimmed.toLowerCase();
  const phrases = options.quitPhrases || DEFAULT_QUIT_PHRASES;
  return !phrases.some((phrase) => lowered.includes(phrase));
}
