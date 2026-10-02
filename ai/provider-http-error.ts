import { APICallError } from '@ai-sdk/provider';

const isRetryableStatus = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;

/**
 * Erro HTTP de provedor como APICallError: preserva statusCode, Retry-After e isRetryable
 * para o motor de retry (um `new Error(texto)` perdia tudo isso).
 */
export async function createProviderHttpError(
  label: string,
  response: Response,
  hintForAuthFailure = '',
): Promise<APICallError> {
  const detail = await response.text().catch(() => '');
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const authFailure = response.status === 401 || response.status === 403;
  return new APICallError({
    message: `${label} request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}.${
      authFailure && hintForAuthFailure ? ` ${hintForAuthFailure}` : ''
    }`,
    url: response.url || '',
    requestBodyValues: {},
    statusCode: response.status,
    responseHeaders,
    responseBody: detail.slice(0, 2000),
    isRetryable: isRetryableStatus(response.status),
  });
}

/** Stream encerrado sem evento terminal: tratado como falha transitória (retentável). */
export function createTruncatedStreamError(label: string): APICallError {
  return new APICallError({
    message: `${label} stream ended before a terminal event (connection closed early).`,
    url: '',
    requestBodyValues: {},
    isRetryable: true,
  });
}
