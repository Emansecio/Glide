// ChatGPT-managed Codex OAuth: parse ~/.codex/auth.json, persist separately from
// apiKey_codex, refresh against auth.openai.com, and derive account_id metadata.

import { CODEX_CLIENT_ID, CODEX_ISSUER } from './codex-oauth.js';
import { normalizeProviderId } from './sdk-client.js';

export const CODEX_CHATGPT_STORAGE_KEY = 'codexChatGptAuth';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TTL_MS = 60 * 60 * 1000;
const OAUTH_FETCH_TIMEOUT_MS = 10_000;
const BUNDLE_CACHE_TTL_MS = 10_000;

export type CodexAuthMode = 'chatgpt' | 'api_key';

export type CodexChatGptAuthBundle = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  expiresAt: number;
  lastRefresh?: number;
  /** Set when refresh_token is rejected (invalid_grant). */
  refreshRejectedAt?: number;
};

type CodexAuthMetadata = {
  authMode: CodexAuthMode | 'unknown';
  hasOpenAiApiKey: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasIdToken: boolean;
  hasAccountId: boolean;
  accountIdLength: number;
  lastRefresh?: string;
};

export type CodexAuthParseResult =
  | { mode: 'api_key'; apiKey: string; metadata: CodexAuthMetadata }
  | { mode: 'chatgpt'; bundle: CodexChatGptAuthBundle; metadata: CodexAuthMetadata }
  | { mode: 'invalid'; reason: string; metadata?: CodexAuthMetadata };

class CodexRefreshError extends Error {
  status: number;
  invalidGrant: boolean;
  constructor(message: string, status: number, invalidGrant = false) {
    super(message);
    this.name = 'CodexRefreshError';
    this.status = status;
    this.invalidGrant = invalidGrant;
  }
}

const hasChromeStorage = () => typeof chrome !== 'undefined' && Boolean(chrome?.storage?.local);

let refreshInFlight: { key: string; promise: Promise<string | null> } | null = null;
let cachedBundle: CodexChatGptAuthBundle | null = null;
let cachedBundleAt = 0;
let bundleWatchBound = false;

export const resetCodexOAuthRefreshState = () => {
  refreshInFlight = null;
};

export const resetCodexOAuthCache = () => {
  cachedBundle = null;
  cachedBundleAt = 0;
};

const invalidateBundleCache = () => {
  cachedBundle = null;
  cachedBundleAt = 0;
};

const bindBundleInvalidation = (): boolean => {
  if (bundleWatchBound) return true;
  if (typeof chrome === 'undefined' || !chrome?.storage?.onChanged?.addListener) return false;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && CODEX_CHATGPT_STORAGE_KEY in changes) invalidateBundleCache();
  });
  bundleWatchBound = true;
  return true;
};

const setCachedBundle = (bundle: CodexChatGptAuthBundle | null) => {
  if (!bundleWatchBound) return;
  cachedBundle = bundle;
  cachedBundleAt = Date.now();
};

export const isOpenAiApiKey = (value: string): boolean => {
  const trimmed = String(value || '').trim();
  return trimmed.startsWith('sk-') && !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(trimmed);
};

export const isJwtToken = (value: string): boolean =>
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(String(value || '').trim());

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const segment = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = segment.padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=');
    const json = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export const extractJwtExpiryMs = (token: string): number => {
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
};

export const extractChatGptAccountId = (accessToken: string, idToken?: string): string | null => {
  const authClaim = 'https://api.openai.com/auth';
  for (const token of [accessToken, idToken]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    const auth = payload?.[authClaim];
    if (auth && typeof auth === 'object') {
      const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof accountId === 'string' && accountId.trim()) return accountId.trim();
    }
  }
  return null;
};

const parseLastRefreshMs = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const buildMetadata = (
  json: Record<string, unknown>,
  overrides: Partial<CodexAuthMetadata> = {},
): CodexAuthMetadata => {
  const tokens = json.tokens && typeof json.tokens === 'object' ? (json.tokens as Record<string, unknown>) : {};
  const openAiKey = typeof json.OPENAI_API_KEY === 'string' ? json.OPENAI_API_KEY.trim() : '';
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id.trim() : '';
  const authModeRaw = String(json.auth_mode || '')
    .trim()
    .toLowerCase();
  return {
    authMode:
      overrides.authMode ||
      (authModeRaw === 'chatgpt' ? 'chatgpt' : openAiKey && isOpenAiApiKey(openAiKey) ? 'api_key' : 'unknown'),
    hasOpenAiApiKey: Boolean(openAiKey),
    hasAccessToken: Boolean(tokens.access_token),
    hasRefreshToken: Boolean(tokens.refresh_token),
    hasIdToken: Boolean(tokens.id_token),
    hasAccountId: Boolean(accountId || overrides.hasAccountId),
    accountIdLength: accountId.length || overrides.accountIdLength || 0,
    lastRefresh: typeof json.last_refresh === 'string' ? json.last_refresh : overrides.lastRefresh,
  };
};

export function parseCodexAuthJson(json: unknown): CodexAuthParseResult {
  if (!json || typeof json !== 'object') {
    return { mode: 'invalid', reason: 'Arquivo inválido: esperado um objeto JSON.' };
  }
  const root = json as Record<string, unknown>;
  const metadata = buildMetadata(root);
  const openAiKey = typeof root.OPENAI_API_KEY === 'string' ? root.OPENAI_API_KEY.trim() : '';
  const authMode = String(root.auth_mode || '')
    .trim()
    .toLowerCase();
  const tokens = root.tokens && typeof root.tokens === 'object' ? (root.tokens as Record<string, unknown>) : null;

  if (openAiKey && isOpenAiApiKey(openAiKey)) {
    return {
      mode: 'api_key',
      apiKey: openAiKey,
      metadata: { ...metadata, authMode: 'api_key', hasOpenAiApiKey: true },
    };
  }

  const accessToken = String(tokens?.access_token || '');
  const refreshToken = String(tokens?.refresh_token || '');
  const idToken = String(tokens?.id_token || '');

  if (authMode === 'chatgpt' || (tokens && accessToken && refreshToken && !openAiKey)) {
    if (!accessToken || !refreshToken) {
      return {
        mode: 'invalid',
        reason: 'Sessão ChatGPT incompleta: faltam access_token ou refresh_token.',
        metadata,
      };
    }
    if (isOpenAiApiKey(accessToken)) {
      return {
        mode: 'invalid',
        reason: 'access_token parece uma API key, não um JWT de sessão ChatGPT.',
        metadata,
      };
    }
    let accountId = typeof tokens?.account_id === 'string' ? tokens.account_id.trim() : '';
    if (!accountId) accountId = extractChatGptAccountId(accessToken, idToken) || '';
    if (!accountId) {
      return {
        mode: 'invalid',
        reason: 'Não foi possível determinar o ChatGPT-Account-Id (account_id ausente no arquivo).',
        metadata,
      };
    }
    return {
      mode: 'chatgpt',
      bundle: {
        accessToken,
        refreshToken,
        idToken,
        accountId,
        expiresAt: extractJwtExpiryMs(accessToken),
        lastRefresh: parseLastRefreshMs(root.last_refresh),
      },
      metadata: {
        ...metadata,
        authMode: 'chatgpt',
        hasAccountId: true,
        accountIdLength: accountId.length,
      },
    };
  }

  if (openAiKey) {
    return {
      mode: 'invalid',
      reason: 'OPENAI_API_KEY não é uma chave sk- válida da OpenAI.',
      metadata,
    };
  }

  return {
    mode: 'invalid',
    reason: 'Nenhuma credencial Codex reconhecida (auth_mode chatgpt ou OPENAI_API_KEY sk-).',
    metadata,
  };
}

export type CodexOAuthTokens = {
  accessToken: string;
  idToken: string;
  refreshToken: string | null;
};

export function buildCodexChatGptBundleFromOAuth(tokens: CodexOAuthTokens): CodexChatGptAuthBundle | null {
  const accessToken = String(tokens.accessToken || '');
  const refreshToken = tokens.refreshToken ? String(tokens.refreshToken) : '';
  const idToken = String(tokens.idToken || '');
  if (!accessToken || !refreshToken) return null;
  const accountId = extractChatGptAccountId(accessToken, idToken);
  if (!accountId) return null;
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId,
    expiresAt: extractJwtExpiryMs(accessToken),
    lastRefresh: Date.now(),
  };
}

export async function readCodexChatGptAuth(): Promise<CodexChatGptAuthBundle | null> {
  if (!hasChromeStorage()) return null;
  const canCache = bindBundleInvalidation();
  if (canCache && cachedBundle && Date.now() - cachedBundleAt < BUNDLE_CACHE_TTL_MS) {
    return cachedBundle;
  }
  const stored = await chrome.storage.local.get(CODEX_CHATGPT_STORAGE_KEY);
  const bundle = stored?.[CODEX_CHATGPT_STORAGE_KEY];
  if (bundle && typeof bundle === 'object' && (bundle as CodexChatGptAuthBundle).refreshToken) {
    setCachedBundle(bundle as CodexChatGptAuthBundle);
    return bundle as CodexChatGptAuthBundle;
  }
  invalidateBundleCache();
  return null;
}

export async function writeCodexChatGptAuth(bundle: CodexChatGptAuthBundle): Promise<void> {
  const fresh: CodexChatGptAuthBundle = {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    idToken: bundle.idToken,
    accountId: bundle.accountId,
    expiresAt: bundle.expiresAt,
    lastRefresh: bundle.lastRefresh ?? Date.now(),
  };
  const patch: Record<string, unknown> = { [CODEX_CHATGPT_STORAGE_KEY]: fresh };
  // Never mirror JWTs into apiKey_codex — that slot is for sk- keys only.
  const stored = await chrome.storage.local.get(['apiKey', 'apiKey_codex']);
  const access = fresh.accessToken;
  if (stored?.apiKey === access) patch.apiKey = '';
  if (stored?.apiKey_codex === access || isJwtToken(String(stored?.apiKey_codex || ''))) {
    patch.apiKey_codex = '';
  }
  await chrome.storage.local.set(patch);
  setCachedBundle(fresh);
}

export async function clearCodexChatGptAuth(): Promise<void> {
  if (!hasChromeStorage()) return;
  invalidateBundleCache();
  const stored = await chrome.storage.local.get([CODEX_CHATGPT_STORAGE_KEY, 'apiKey', 'apiKey_codex']);
  const bundle = stored?.[CODEX_CHATGPT_STORAGE_KEY] as CodexChatGptAuthBundle | undefined;
  const patch: Record<string, string> = {};
  if (bundle?.accessToken) {
    if (stored?.apiKey === bundle.accessToken) patch.apiKey = '';
    if (stored?.apiKey_codex === bundle.accessToken) patch.apiKey_codex = '';
  }
  await chrome.storage.local.remove(CODEX_CHATGPT_STORAGE_KEY);
  if (Object.keys(patch).length > 0) await chrome.storage.local.set(patch);
}

export async function getCodexAuthHealth(): Promise<{ ok: boolean; reason?: 'reauth' }> {
  const bundle = await readCodexChatGptAuth();
  if (bundle?.refreshRejectedAt) return { ok: false, reason: 'reauth' };
  return { ok: true };
}

export async function refreshCodexChatGptToken(refreshToken: string): Promise<CodexChatGptAuthBundle> {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const invalidGrant = /invalid_grant|refresh_token_(?:expired|reused|invalidated)/i.test(detail);
    throw new CodexRefreshError(
      `Codex token refresh failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`,
      response.status,
      invalidGrant,
    );
  }
  const data = await response.json();
  const accessToken = String(data?.access_token || '');
  const nextRefresh = data?.refresh_token ? String(data.refresh_token) : refreshToken;
  const idToken = data?.id_token ? String(data.id_token) : '';
  if (!accessToken) throw new Error('Codex token refresh returned no access_token.');
  const current = await readCodexChatGptAuth();
  const accountId =
    (current?.accountId && extractChatGptAccountId(accessToken, idToken || current.idToken)) ||
    current?.accountId ||
    extractChatGptAccountId(accessToken, idToken) ||
    '';
  if (!accountId) throw new Error('Codex token refresh lost ChatGPT account id.');
  const expiresIn = Number(data?.expires_in);
  return {
    accessToken,
    refreshToken: nextRefresh,
    idToken: idToken || current?.idToken || '',
    accountId,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : extractJwtExpiryMs(accessToken) || Date.now() + DEFAULT_ACCESS_TTL_MS,
    lastRefresh: Date.now(),
  };
}

async function markCodexRefreshRejected(bundle: CodexChatGptAuthBundle): Promise<void> {
  if (!hasChromeStorage()) return;
  // Não sobrescreve credencial nova gravada (re-login) enquanto o refresh antigo estava em voo.
  invalidateBundleCache();
  const current = await readCodexChatGptAuth();
  if (!current || current.refreshToken !== bundle.refreshToken) return;
  const rejected = { ...current, refreshRejectedAt: Date.now() };
  setCachedBundle(rejected);
  await chrome.storage.local.set({ [CODEX_CHATGPT_STORAGE_KEY]: rejected });
}

export async function ensureFreshCodexChatGptToken(options?: { forceRefresh?: boolean }): Promise<string | null> {
  if (!hasChromeStorage()) return null;
  if (options?.forceRefresh) invalidateBundleCache();
  const bundle = await readCodexChatGptAuth();
  if (!bundle?.refreshToken) return bundle?.accessToken || null;
  if (bundle.refreshRejectedAt) return bundle.accessToken || null;

  const needsRefresh = options?.forceRefresh || !bundle.expiresAt || bundle.expiresAt - Date.now() <= REFRESH_MARGIN_MS;
  if (!needsRefresh) return bundle.accessToken;

  const refreshKey = bundle.refreshToken;
  if (refreshInFlight?.key === refreshKey) return refreshInFlight.promise;

  const refreshPromise = (async () => {
    const refreshTokenAtStart = bundle.refreshToken;
    try {
      const refreshed = await refreshCodexChatGptToken(refreshTokenAtStart);
      const current = await readCodexChatGptAuth();
      if (!current || current.refreshToken !== refreshTokenAtStart) {
        return current?.accessToken || refreshed.accessToken;
      }
      await writeCodexChatGptAuth(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      console.error('[Glide] Codex ChatGPT OAuth refresh failed:', error);
      if (error instanceof CodexRefreshError && error.invalidGrant) {
        await markCodexRefreshRejected(bundle).catch(() => {});
      }
      return bundle.accessToken || null;
    } finally {
      if (refreshInFlight?.key === refreshKey) refreshInFlight = null;
    }
  })();

  refreshInFlight = { key: refreshKey, promise: refreshPromise };
  return refreshPromise;
}

export function resolveCodexAuthMode(raw: Record<string, unknown>): CodexAuthMode | null {
  const provider = normalizeProviderId(typeof raw.provider === 'string' ? raw.provider : '');
  if (provider !== 'codex') return null;
  const bundle = raw[CODEX_CHATGPT_STORAGE_KEY];
  if (bundle && typeof bundle === 'object') {
    const auth = bundle as CodexChatGptAuthBundle;
    if (auth.accessToken && auth.refreshToken && auth.accountId) return 'chatgpt';
  }
  const providerKey = typeof raw.apiKey_codex === 'string' ? raw.apiKey_codex.trim() : '';
  const activeKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  const key = providerKey || activeKey;
  if (key && isOpenAiApiKey(key)) return 'api_key';
  return null;
}

/** Settings field: sk- keys pass through; ChatGPT sessions show the access token for UX. */
export function resolveCodexApiKeyFieldValue(
  bundle: CodexChatGptAuthBundle | null | undefined,
  storedKey = '',
): string {
  const key = String(storedKey || '').trim();
  if (key && isOpenAiApiKey(key)) return key;
  if (bundle?.accessToken) return bundle.accessToken;
  return key;
}

/** True when the apiKey field holds a display-only JWT mirrored from codexChatGptAuth. */
export function isCodexChatGptDisplayToken(
  fieldValue: string,
  bundle: CodexChatGptAuthBundle | null | undefined,
): boolean {
  const value = String(fieldValue || '').trim();
  if (!value || !bundle?.accessToken) return false;
  return value === bundle.accessToken && isJwtToken(value);
}
