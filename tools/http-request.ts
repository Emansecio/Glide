/**
 * Background-side HTTP for the agent (outside page CSP / eval).
 * Uses extension host_permissions so same-site cookies are included.
 */

import { isCrossOriginRedirect, isUrlAllowedByDomains, parseAllowedDomains } from './domain-policy.js';
import { requireHttpUrl } from './validation.js';

export const HTTP_REQUEST_MAX_BODY_CHARS = 100_000;
export const HTTP_REQUEST_DEFAULT_TIMEOUT_MS = 30_000;
export const HTTP_REQUEST_MAX_TIMEOUT_MS = 90_000;

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'cookie',
  'cookie2',
  'host',
  'origin',
  'referer',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
]);

/** Strip on cross-origin redirect hops so secrets do not follow open-redirect chains. */
export const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-api-token',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-csrftoken',
  'x-xsrf-token',
  'x-requested-with',
  'x-ig-www-claim',
  'x-instagram-ajax',
]);

export type HttpRequestArgs = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBodyChars?: number;
  /** Optional enterprise allowlist (comma/newline string or hostname array). */
  allowedDomains?: string | string[];
  /** Combined with the request timeout; used for run-level stop. */
  signal?: AbortSignal;
};

export type HttpRequestResult = {
  success: boolean;
  status?: number;
  statusText?: string;
  ok?: boolean;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyLength?: number;
  truncated?: boolean;
  error?: string;
  hint?: string;
  timedOut?: boolean;
  code?: string;
  dispatched?: boolean;
  outcomeCertainty?: 'known_completed' | 'known_not_executed' | 'unknown';
};

export function normalizeHttpMethod(raw: unknown): string {
  const m = String(raw || 'GET')
    .trim()
    .toUpperCase();
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) return m;
  return 'GET';
}

export function resolveAllowedDomainList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) =>
        String(entry || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  }
  if (typeof raw === 'string') return parseAllowedDomains(raw);
  return [];
}

export function stripSensitiveHeadersForRedirect(
  headers: Record<string, string>,
  fromUrl: string,
  toUrl: string,
): Record<string, string> {
  if (!isCrossOriginRedirect(fromUrl, toUrl)) return headers;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_REDIRECT_HEADERS.has(key.toLowerCase())) continue;
    next[key] = value;
  }
  return next;
}

export function sanitizeHttpHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(key || '').trim();
    if (!name) continue;
    if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    if (value == null) continue;
    out[name] = String(value);
  }
  return out;
}

export function resolveHttpTimeoutMs(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return HTTP_REQUEST_DEFAULT_TIMEOUT_MS;
  return Math.min(HTTP_REQUEST_MAX_TIMEOUT_MS, Math.max(1000, Math.round(n)));
}

export function resolveHttpMaxBodyChars(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50_000;
  return Math.min(HTTP_REQUEST_MAX_BODY_CHARS, Math.max(500, Math.round(n)));
}

/** Max redirect hops when following manually (re-check private hosts each hop). */
export const HTTP_REQUEST_MAX_REDIRECTS = 10;

const isRedirectStatus = (status: number) =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/**
 * Resolve a redirect Location against the current request URL and re-run the
 * private/loopback host guard. Without this, `redirect: 'follow'` could land on
 * metadata/LAN after a public open-redirect.
 */
export function resolveRedirectUrl(
  currentUrl: string,
  locationHeader: string | null,
): { ok: true; url: string } | { ok: false; error: string; hint?: string } {
  const location = String(locationHeader || '').trim();
  if (!location) {
    return { ok: false, error: 'Redirect response missing Location header.' };
  }
  let absolute: string;
  try {
    absolute = new URL(location, currentUrl).toString();
  } catch {
    return { ok: false, error: `Invalid redirect Location: "${location}".` };
  }
  return requireHttpUrl(absolute, 'httpRequest redirect');
}

async function readResponseTextLimited(
  response: Response,
  maxBodyChars: number,
): Promise<{ text: string; rawLength: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const rawText = await response.text();
    const truncated = rawText.length > maxBodyChars;
    return {
      text: truncated ? rawText.slice(0, maxBodyChars) : rawText,
      rawLength: rawText.length,
      truncated,
    };
  }

  const decoder = new TextDecoder();
  let text = '';
  let rawLength = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rawLength += value.byteLength;
    if (!truncated) {
      text += decoder.decode(value, { stream: true });
      if (text.length > maxBodyChars) {
        text = text.slice(0, maxBodyChars);
        truncated = true;
      }
    }
  }
  text += decoder.decode();
  if (text.length > maxBodyChars) {
    text = text.slice(0, maxBodyChars);
    truncated = true;
  }
  if (rawLength > maxBodyChars) truncated = true;

  return { text, rawLength, truncated };
}

export async function performHttpRequest(
  args: HttpRequestArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpRequestResult> {
  const urlCheck = requireHttpUrl(String(args.url || ''), 'httpRequest url');
  if (!urlCheck.ok) {
    return { success: false, error: urlCheck.error, hint: urlCheck.hint };
  }
  const allowlist = resolveAllowedDomainList(args.allowedDomains);
  if (!isUrlAllowedByDomains(urlCheck.url, allowlist)) {
    return {
      success: false,
      error: 'httpRequest URL blocked by allowedDomains policy.',
      hint: 'Add the target host to allowedDomains in Settings or use an allowed URL.',
      url: urlCheck.url,
    };
  }
  let url = urlCheck.url;
  let method = normalizeHttpMethod(args.method);
  let headers = sanitizeHttpHeaders(args.headers);
  const timeoutMs = resolveHttpTimeoutMs(args.timeoutMs);
  const maxBodyChars = resolveHttpMaxBodyChars(args.maxBodyChars);
  let body = method === 'GET' || method === 'HEAD' ? undefined : args.body != null ? String(args.body) : undefined;

  const controller = new AbortController();
  const onRunAbort = () => controller.abort();
  args.signal?.addEventListener('abort', onRunAbort);
  if (args.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatched = false;
  try {
    // Manual redirect following: re-validate every hop so a public open-redirect
    // cannot pivot the extension fetch (host_permissions + cookies) onto private
    // / loopback / cloud-metadata hosts.
    let response: Response | null = null;
    for (let hop = 0; hop <= HTTP_REQUEST_MAX_REDIRECTS; hop += 1) {
      dispatched = true;
      response = await fetchImpl(url, {
        method,
        headers,
        body,
        credentials: 'include',
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!isRedirectStatus(response.status)) break;
      if (hop === HTTP_REQUEST_MAX_REDIRECTS) {
        return {
          success: false,
          error: `httpRequest exceeded ${HTTP_REQUEST_MAX_REDIRECTS} redirects.`,
          url,
          status: response.status,
        };
      }
      const next = resolveRedirectUrl(url, response.headers.get('Location'));
      if (!next.ok) {
        return {
          success: false,
          error: next.error,
          hint: next.hint || 'Redirect target blocked (private/loopback/non-http).',
          url,
          status: response.status,
        };
      }
      if (!isUrlAllowedByDomains(next.url, allowlist)) {
        return {
          success: false,
          error: 'httpRequest redirect blocked by allowedDomains policy.',
          hint: 'Redirect target is outside allowedDomains.',
          url: next.url,
          status: response.status,
        };
      }
      headers = stripSensitiveHeadersForRedirect(headers, url, next.url);
      // 303 (and common 301/302 for POST) switch to GET without body.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')
      ) {
        method = 'GET';
        body = undefined;
      }
      url = next.url;
    }
    if (!response) {
      return { success: false, error: 'httpRequest produced no response.' };
    }
    const bodyRead =
      method === 'HEAD'
        ? { text: '', rawLength: 0, truncated: false }
        : await readResponseTextLimited(response, maxBodyChars);
    const { text, rawLength: rawTextLength, truncated } = bodyRead;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      // Avoid dumping set-cookie volumes; keep useful API metadata.
      if (key.toLowerCase() === 'set-cookie') return;
      responseHeaders[key] = value;
    });
    // Final URL must still pass the guard (opaque redirects / edge cases).
    const finalUrl = response.url || url;
    const finalCheck = requireHttpUrl(finalUrl, 'httpRequest final url');
    if (!finalCheck.ok) {
      return {
        success: false,
        error: finalCheck.error,
        hint: finalCheck.hint,
        url: finalUrl,
        status: response.status,
      };
    }
    if (!isUrlAllowedByDomains(finalUrl, allowlist)) {
      return {
        success: false,
        error: 'httpRequest final URL blocked by allowedDomains policy.',
        hint: 'The response landed on a host outside allowedDomains.',
        url: finalUrl,
        status: response.status,
      };
    }
    return {
      success: true,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      url: finalUrl,
      headers: responseHeaders,
      body: text,
      bodyLength: rawTextLength,
      truncated,
      dispatched,
      outcomeCertainty: 'known_completed',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const runAborted = Boolean(args.signal?.aborted);
    const timedOut = !runAborted && /abort/i.test(message);
    return {
      success: false,
      error: runAborted
        ? 'httpRequest cancelled because the run was stopped.'
        : timedOut
          ? `httpRequest timed out after ${timeoutMs}ms`
          : message,
      timedOut,
      code: runAborted ? 'RUN_ABORTED' : undefined,
      dispatched,
      outcomeCertainty: dispatched ? 'unknown' : 'known_not_executed',
      hint: runAborted
        ? 'The user stopped the run while this request was in flight.'
        : timedOut
          ? 'Increase timeoutMs or paginate with smaller pages.'
          : 'Check URL/headers. For Instagram, set X-IG-App-ID and X-CSRFToken (from executeScript document.cookie). Cookies are sent automatically via credentials:include.',
    };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onRunAbort);
  }
}
