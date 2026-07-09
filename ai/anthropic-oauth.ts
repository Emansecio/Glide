// Claude Code OAuth token refresh. Access tokens (sk-ant-oat01…) are short-lived
// and rotated by the Claude CLI, so a static import becomes "Invalid bearer token"
// after a few hours. We persist the refresh token + expiry alongside the access
// token and renew it against the Claude Code public OAuth client before it lapses.

const ANTHROPIC_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const OAUTH_FETCH_TIMEOUT_MS = 10_000;
const STORAGE_KEY = 'anthropicOAuth';

export type AnthropicOAuthBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

/** Coalesces concurrent refresh attempts so a single refresh_token is not double-used. */
let refreshInFlight: Promise<string> | null = null;

export function parseAnthropicCredentials(json: any): AnthropicOAuthBundle | null {
  const source = json?.claudeAiOauth ?? json ?? {};
  const accessToken = String(source.accessToken || source.access_token || '');
  const refreshToken = String(source.refreshToken || source.refresh_token || '');
  if (!accessToken || !refreshToken) return null;
  let expiresAt = Number(source.expiresAt ?? source.expires_at ?? source.expires ?? 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) expiresAt = 0;
  else if (expiresAt < 1e12) expiresAt *= 1000; // seconds → ms
  return { accessToken, refreshToken, expiresAt };
}

export async function readAnthropicOAuth(): Promise<AnthropicOAuthBundle | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const bundle = stored?.[STORAGE_KEY];
  if (bundle && typeof bundle === 'object' && bundle.refreshToken) {
    return bundle as AnthropicOAuthBundle;
  }
  return null;
}

export async function writeAnthropicOAuth(bundle: AnthropicOAuthBundle): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: bundle, apiKey: bundle.accessToken });
}

export async function refreshAnthropicToken(refreshToken: string): Promise<AnthropicOAuthBundle> {
  const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Anthropic token refresh failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }
  const data = await response.json();
  const accessToken = String(data?.access_token || '');
  if (!accessToken) throw new Error('Anthropic token refresh returned no access_token.');
  const expiresIn = Number(data?.expires_in);
  return {
    accessToken,
    refreshToken: data?.refresh_token ? String(data.refresh_token) : refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
  };
}

/**
 * Returns a valid Anthropic access token, refreshing proactively when the stored
 * token is within REFRESH_MARGIN_MS of expiry. Falls back to the current token
 * when no refresh material is stored or the refresh call fails.
 */
export async function ensureFreshAnthropicToken(currentToken: string): Promise<string> {
  const bundle = await readAnthropicOAuth();
  if (!bundle?.refreshToken) return currentToken;

  const needsRefresh = !bundle.expiresAt || bundle.expiresAt - Date.now() <= REFRESH_MARGIN_MS;
  if (!needsRefresh) return bundle.accessToken || currentToken;

  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const refreshed = await refreshAnthropicToken(bundle.refreshToken);
      await writeAnthropicOAuth(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      console.error('[Glide] Anthropic OAuth refresh failed:', error);
      return bundle.accessToken || currentToken;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}
