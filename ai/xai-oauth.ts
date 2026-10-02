/**
 * xAI / Grok session auth (Grok CLI OAuth at auth.x.ai).
 *
 * O CLI grava em ~/.grok/auth.json:
 *   { "https://auth.x.ai::<clientId>": { key, refresh_token, expires_at, auth_mode, ... } }
 *
 * O access token (JWT) autentica em https://api.x.ai/v1 (chat.completions).
 * Refresh: POST https://auth.x.ai/oauth2/token com client_id + refresh_token.
 */

export const XAI_API_BASE_URL = 'https://api.x.ai/v1';
const XAI_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const STORAGE_KEY = 'xaiOAuth';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** TTL assumido quando o endpoint de token não devolve expires_in. */
const DEFAULT_ACCESS_TTL_MS = 30 * 60 * 1000;
const OAUTH_FETCH_TIMEOUT_MS = 15_000;

export type XaiOAuthBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  email?: string;
  /** Momento em que o refresh foi rejeitado (invalid_grant). */
  refreshRejectedAt?: number;
};

export type XaiAuthHealth = {
  ok: boolean;
  reason?: 'reauth';
};

class XaiRefreshError extends Error {
  status: number;
  invalidGrant: boolean;
  constructor(message: string, status: number, invalidGrant = false) {
    super(message);
    this.name = 'XaiRefreshError';
    this.status = status;
    this.invalidGrant = invalidGrant;
  }
}

const hasChromeStorage = () => typeof chrome !== 'undefined' && Boolean(chrome?.storage?.local);

let refreshInFlight: Promise<string> | null = null;

/** Parse ~/.grok/auth.json (ou blob exportado). */
export function parseGrokAuthJson(json: unknown): XaiOAuthBundle | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const root = json as Record<string, unknown>;

  // Flat shape: { accessToken, refreshToken, clientId, expiresAt }
  if (typeof root.accessToken === 'string' || typeof root.access_token === 'string') {
    const accessToken = String(root.accessToken || root.access_token || '').trim();
    const refreshToken = String(root.refreshToken || root.refresh_token || '').trim();
    const clientId = String(root.clientId || root.client_id || '').trim();
    if (!accessToken) return null;
    let expiresAt = Number(root.expiresAt ?? root.expires_at ?? 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) expiresAt = 0;
    else if (expiresAt < 1e12) expiresAt *= 1000;
    return {
      accessToken,
      refreshToken,
      clientId: clientId || 'unknown',
      expiresAt,
      email: typeof root.email === 'string' ? root.email : undefined,
    };
  }

  // Grok CLI map: { "https://auth.x.ai::<uuid>": { key, refresh_token, expires_at, ... } }
  for (const [storageKey, value] of Object.entries(root)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const accessToken = String(entry.key || entry.access_token || entry.accessToken || '').trim();
    if (!accessToken) continue;
    const refreshToken = String(entry.refresh_token || entry.refreshToken || '').trim();
    let clientId = '';
    if (storageKey.includes('::')) {
      clientId = storageKey.split('::').pop()?.trim() || '';
    }
    if (!clientId) clientId = String(entry.client_id || entry.clientId || '').trim();
    let expiresAt = 0;
    if (typeof entry.expires_at === 'string') {
      const parsed = Date.parse(entry.expires_at);
      expiresAt = Number.isFinite(parsed) ? parsed : 0;
    } else if (typeof entry.expires_at === 'number') {
      expiresAt = entry.expires_at < 1e12 ? entry.expires_at * 1000 : entry.expires_at;
    } else if (typeof entry.expiresAt === 'number') {
      expiresAt = entry.expiresAt < 1e12 ? entry.expiresAt * 1000 : entry.expiresAt;
    }
    return {
      accessToken,
      refreshToken,
      clientId: clientId || 'unknown',
      expiresAt,
      email: typeof entry.email === 'string' ? entry.email : undefined,
    };
  }

  return null;
}

export async function readXaiOAuth(): Promise<XaiOAuthBundle | null> {
  if (!hasChromeStorage()) return null;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const bundle = stored?.[STORAGE_KEY];
  if (bundle && typeof bundle === 'object' && bundle.accessToken) {
    return bundle as XaiOAuthBundle;
  }
  return null;
}

export async function writeXaiOAuth(bundle: XaiOAuthBundle): Promise<void> {
  const fresh: XaiOAuthBundle = {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresAt: bundle.expiresAt,
    clientId: bundle.clientId,
    email: bundle.email,
  };
  await chrome.storage.local.set({
    [STORAGE_KEY]: fresh,
    apiKey: fresh.accessToken,
    apiKey_xai: fresh.accessToken,
  });
}

async function clearXaiOAuth(): Promise<void> {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.remove(STORAGE_KEY);
}

export async function getXaiAuthHealth(): Promise<XaiAuthHealth> {
  const bundle = await readXaiOAuth();
  if (bundle?.refreshRejectedAt) return { ok: false, reason: 'reauth' };
  return { ok: true };
}

/**
 * Token manual (API key xai-… ou JWT colado). Se difere do access da sessão OAuth,
 * descarta o bundle para o manual não ficar inerte.
 */
export async function reconcileManualXaiToken(token: string): Promise<void> {
  const manual = String(token || '').trim();
  if (!manual) return;
  const bundle = await readXaiOAuth();
  if (bundle && bundle.accessToken !== manual) {
    await clearXaiOAuth();
  }
}

async function markRefreshRejected(failed: XaiOAuthBundle): Promise<void> {
  if (!hasChromeStorage()) return;
  const current = await readXaiOAuth();
  if (!current) return;
  if (current.refreshToken !== failed.refreshToken) return;
  if (current.accessToken !== failed.accessToken) return;
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...current, refreshRejectedAt: Date.now() },
  });
}

async function refreshXaiToken(bundle: XaiOAuthBundle): Promise<XaiOAuthBundle> {
  if (!bundle.refreshToken || !bundle.clientId || bundle.clientId === 'unknown') {
    throw new XaiRefreshError('Missing refresh_token or client_id for xAI OAuth refresh.', 0, false);
  }
  const response = await fetch(XAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refreshToken,
      client_id: bundle.clientId,
    }),
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const isInvalidGrant = /invalid_grant/i.test(detail);
    throw new XaiRefreshError(
      `xAI token refresh failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`,
      response.status,
      isInvalidGrant,
    );
  }
  const data = await response.json();
  const accessToken = String(data?.access_token || '');
  if (!accessToken) throw new Error('xAI token refresh returned no access_token.');
  const expiresIn = Number(data?.expires_in);
  return {
    accessToken,
    refreshToken: data?.refresh_token ? String(data.refresh_token) : bundle.refreshToken,
    // Sem expires_in, expiresAt=0 forçava refresh (e rotação do refresh_token) a CADA request.
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + DEFAULT_ACCESS_TTL_MS,
    clientId: bundle.clientId,
    email: bundle.email,
  };
}

/**
 * Returns a valid xAI access token (session JWT or API key).
 * Session OAuth: refreshes proactively near expiry and on forceRefresh after 401.
 */
export async function ensureFreshXaiToken(currentToken: string, options?: { forceRefresh?: boolean }): Promise<string> {
  if (!hasChromeStorage()) return currentToken;
  const bundle = await readXaiOAuth();
  if (!bundle?.refreshToken) return currentToken;

  const manualOverride = currentToken && currentToken !== bundle.accessToken ? currentToken : '';
  // API keys xai-… never go through OAuth refresh.
  if (manualOverride.startsWith('xai-')) return manualOverride;

  if (bundle.refreshRejectedAt) {
    return manualOverride || bundle.accessToken || currentToken;
  }

  const needsRefresh = options?.forceRefresh || !bundle.expiresAt || bundle.expiresAt - Date.now() <= REFRESH_MARGIN_MS;
  if (!needsRefresh) return bundle.accessToken || currentToken;

  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const refreshed = await refreshXaiToken(bundle);
      await writeXaiOAuth(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      console.error('[Glide] xAI OAuth refresh failed:', error);
      if (error instanceof XaiRefreshError && error.invalidGrant) {
        await markRefreshRejected(bundle).catch(() => {});
      }
      if (bundle.accessToken && bundle.expiresAt > Date.now()) return bundle.accessToken;
      return manualOverride || bundle.accessToken || currentToken;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}
