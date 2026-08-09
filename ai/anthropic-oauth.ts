// Claude Code OAuth token refresh. Access tokens (sk-ant-oat01…) are short-lived
// and rotated by the Claude CLI, so a static import becomes "Invalid bearer token"
// after a few hours. We persist the refresh token + expiry alongside the access
// token and renew it against the Claude Code public OAuth client before it lapses.

export const ANTHROPIC_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Default access-token TTL when the refresh response omits expires_in (avoids thrash). */
const DEFAULT_ACCESS_TTL_MS = 8 * 60 * 60 * 1000;
const OAUTH_FETCH_TIMEOUT_MS = 10_000;
const STORAGE_KEY = 'anthropicOAuth';

export type AnthropicOAuthBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /**
   * Momento em que o servidor rejeitou o refresh_token (invalid_grant). Um
   * refresh revogado não se recupera sozinho, então paramos de tentar até o
   * usuário reconectar ou importar credenciais novas (writeAnthropicOAuth limpa).
   */
  refreshRejectedAt?: number;
};

export type AnthropicAuthHealth = {
  ok: boolean;
  /** 'reauth' = sessão OAuth morta, o usuário precisa reconectar. */
  reason?: 'reauth';
};

/** Erro de refresh com o status HTTP para o chamador distinguir revogação de falha de rede. */
export class AnthropicRefreshError extends Error {
  status: number;
  /**
   * true só quando o servidor respondeu `invalid_grant` — refresh_token revogado
   * ou expirado, que não se recupera sozinho. Um 400/401 transitório (hiccup do
   * endpoint, corpo malformado, clock skew) NÃO seta isto, para não brickar a
   * sessão de forma permanente.
   */
  invalidGrant: boolean;
  constructor(message: string, status: number, invalidGrant = false) {
    super(message);
    this.name = 'AnthropicRefreshError';
    this.status = status;
    this.invalidGrant = invalidGrant;
  }
}

// resolveLanguageModel também roda em testes Node, onde não há chrome.storage.
const hasChromeStorage = () => typeof chrome !== 'undefined' && Boolean(chrome?.storage?.local);

/** Coalesces concurrent refresh attempts keyed by refresh token generation. */
let refreshInFlight: { key: string; promise: Promise<string> } | null = null;

/** Test-only: clear in-flight refresh coalescing state. */
export const resetAnthropicOAuthRefreshState = () => {
  refreshInFlight = null;
};

/**
 * Espelho do bundle em memória.
 *
 * ensureFreshAnthropicToken roda no fetch de CADA request ao modelo — e uma
 * passe do agente faz uma request por step (até dezenas). Sem este espelho,
 * cada uma dessas requests começava com um `chrome.storage.local.get`, que é
 * IPC para o processo do navegador: alguns milissegundos parados antes de o
 * socket sequer abrir, no caminho crítico, dezenas de vezes por run.
 *
 * A invalidação real é o listener de onChanged (dispara inclusive no contexto
 * que escreveu, então painel e service worker se mantêm coerentes). O TTL é só
 * uma rede de segurança adicional.
 *
 * Sem onChanged disponível NÃO cacheamos nada. Um cache sem invalidador serviria
 * um bundle obsoleto por segundos — inclusive um cuja sessão já foi revogada por
 * outro contexto. Perder a otimização é aceitável; servir credencial velha não.
 */
const BUNDLE_CACHE_TTL_MS = 10_000;
let cachedBundle: AnthropicOAuthBundle | null = null;
let cachedBundleAt = 0;
let bundleWatchBound = false;

const invalidateBundleCache = () => {
  cachedBundle = null;
  cachedBundleAt = 0;
};

/** true quando há um invalidador ativo — única condição para o cache valer. */
const bindBundleInvalidation = (): boolean => {
  if (bundleWatchBound) return true;
  if (typeof chrome === 'undefined' || !chrome?.storage?.onChanged?.addListener) return false;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && STORAGE_KEY in changes) invalidateBundleCache();
  });
  bundleWatchBound = true;
  return true;
};

const setCachedBundle = (bundle: AnthropicOAuthBundle | null) => {
  if (!bundleWatchBound) return;
  cachedBundle = bundle;
  cachedBundleAt = Date.now();
};

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
  if (!hasChromeStorage()) return null;
  const canCache = bindBundleInvalidation();
  if (canCache && cachedBundle && Date.now() - cachedBundleAt < BUNDLE_CACHE_TTL_MS) {
    return cachedBundle;
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const bundle = stored?.[STORAGE_KEY];
  if (bundle && typeof bundle === 'object' && bundle.refreshToken) {
    setCachedBundle(bundle as AnthropicOAuthBundle);
    return bundle as AnthropicOAuthBundle;
  }
  invalidateBundleCache();
  return null;
}

export async function writeAnthropicOAuth(bundle: AnthropicOAuthBundle): Promise<void> {
  // Credencial nova sempre zera o estado de revogação anterior.
  const fresh: AnthropicOAuthBundle = {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresAt: bundle.expiresAt,
  };
  // Grava os DOIS slots: o global (que o runtime lê) e o slot do provedor anthropic
  // (arquivo por provedor). Se só o global fosse atualizado, um slot antigo poderia
  // ressuscitar um access token expirado ao recarregar as configurações.
  await chrome.storage.local.set({
    [STORAGE_KEY]: fresh,
    apiKey: fresh.accessToken,
    apiKey_anthropic: fresh.accessToken,
  });
  // Atualiza o espelho na hora: o onChanged chega um tick depois, e até lá a
  // próxima request leria o bundle velho — justo depois de um refresh.
  setCachedBundle(fresh);
}

export async function clearAnthropicOAuth(): Promise<void> {
  if (!hasChromeStorage()) return;
  invalidateBundleCache();
  // Também limpa slots de key que ainda espelham o access token do bundle —
  // senão ensureFreshAnthropicToken some, mas o form/runtime ainda mandam o OAT velho.
  let accessToClear = '';
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, 'apiKey', 'apiKey_anthropic']);
    const bundle = stored?.[STORAGE_KEY];
    if (bundle && typeof bundle === 'object' && typeof bundle.accessToken === 'string') {
      accessToClear = bundle.accessToken;
    }
    const patch: Record<string, string> = {};
    if (accessToClear) {
      if (stored?.apiKey === accessToClear) patch.apiKey = '';
      if (stored?.apiKey_anthropic === accessToClear) patch.apiKey_anthropic = '';
    }
    await chrome.storage.local.remove(STORAGE_KEY);
    if (Object.keys(patch).length > 0) {
      await chrome.storage.local.set(patch);
    }
  } catch {
    await chrome.storage.local.remove(STORAGE_KEY).catch(() => {});
  }
}

/**
 * O usuário colou/importou um token manualmente. Se ele difere do token da
 * sessão OAuth armazenada, a sessão antiga deixaria o token manual inerte
 * (o bundle tem precedência em ensureFreshAnthropicToken) — então descartamos
 * o bundle obsoleto e passamos a usar o token manual.
 */
export async function reconcileManualAnthropicToken(token: string): Promise<void> {
  const manual = String(token || '').trim();
  if (!manual) return;
  const bundle = await readAnthropicOAuth();
  if (bundle && bundle.accessToken !== manual) {
    await clearAnthropicOAuth();
  }
}

/** Estado da sessão OAuth para a UI/background avisarem o usuário com clareza. */
export async function getAnthropicAuthHealth(): Promise<AnthropicAuthHealth> {
  const bundle = await readAnthropicOAuth();
  if (bundle?.refreshRejectedAt) return { ok: false, reason: 'reauth' };
  return { ok: true };
}

async function markRefreshRejected(bundle: AnthropicOAuthBundle): Promise<void> {
  if (!hasChromeStorage()) return;
  const rejected = { ...bundle, refreshRejectedAt: Date.now() };
  // Espelho antes do await: é justamente este flag que impede a próxima request
  // de martelar o endpoint de refresh já revogado.
  setCachedBundle(rejected);
  await chrome.storage.local.set({ [STORAGE_KEY]: rejected });
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
    // O endpoint OAuth sinaliza refresh revogado/expirado com `invalid_grant`.
    // Qualquer outro erro (mesmo 400/401) é tratado como transitório.
    const isInvalidGrant = /invalid_grant/i.test(detail);
    throw new AnthropicRefreshError(
      `Anthropic token refresh failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`,
      response.status,
      isInvalidGrant,
    );
  }
  const data = await response.json();
  const accessToken = String(data?.access_token || '');
  if (!accessToken) throw new Error('Anthropic token refresh returned no access_token.');
  const expiresIn = Number(data?.expires_in);
  return {
    accessToken,
    refreshToken: data?.refresh_token ? String(data.refresh_token) : refreshToken,
    // Sem expires_in, assume 8h — expiresAt=0 forçava refresh em CADA request do modelo.
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + DEFAULT_ACCESS_TTL_MS,
  };
}

/**
 * Returns a valid Anthropic access token, refreshing proactively when the stored
 * token is within REFRESH_MARGIN_MS of expiry. `forceRefresh` renova mesmo com
 * expiry distante (usado após um 401 da API — token revogado no servidor).
 *
 * Regras de fallback quando o refresh não é possível/falha:
 * - refresh_token revogado (HTTP 400/401): marca a sessão como morta (para de
 *   martelar o endpoint a cada request) e usa o token manual, se o usuário
 *   colou um diferente do da sessão.
 * - falha transitória (rede/5xx): mantém o token atual e tenta de novo depois.
 */
export async function ensureFreshAnthropicToken(
  currentToken: string,
  options?: { forceRefresh?: boolean },
): Promise<string> {
  if (!hasChromeStorage()) return currentToken;
  // Depois de um 401 não dá para confiar no espelho: outro contexto pode ter
  // rotacionado o token, e é exatamente esse valor novo que queremos.
  if (options?.forceRefresh) invalidateBundleCache();
  const bundle = await readAnthropicOAuth();
  if (!bundle?.refreshToken) return currentToken;

  const manualOverride = currentToken && currentToken !== bundle.accessToken ? currentToken : '';
  if (bundle.refreshRejectedAt) {
    return manualOverride || bundle.accessToken || currentToken;
  }

  // expiresAt=0 em bundle legado: um único soft-refresh (escreve TTL default) em
  // vez de martelar o endpoint a cada step. forceRefresh sempre renova.
  const needsRefresh = options?.forceRefresh || !bundle.expiresAt || bundle.expiresAt - Date.now() <= REFRESH_MARGIN_MS;
  if (!needsRefresh) return bundle.accessToken || currentToken;

  const refreshKey = bundle.refreshToken;
  if (refreshInFlight?.key === refreshKey) return refreshInFlight.promise;

  const refreshPromise = (async () => {
    const refreshTokenAtStart = bundle.refreshToken;
    try {
      const refreshed = await refreshAnthropicToken(refreshTokenAtStart);
      const current = await readAnthropicOAuth();
      if (!current || current.refreshToken !== refreshTokenAtStart) {
        return current?.accessToken || manualOverride || bundle.accessToken || currentToken;
      }
      await writeAnthropicOAuth(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      console.error('[Glide] Anthropic OAuth refresh failed:', error);
      // Só marca a sessão como morta quando o refresh_token foi de fato revogado
      // (invalid_grant). Falhas transitórias mantêm o bundle e são retentadas no
      // próximo request — sem isto, um 400 pontual brickava a sessão até reconectar.
      if (error instanceof AnthropicRefreshError && error.invalidGrant) {
        await markRefreshRejected(bundle).catch(() => {});
      }
      return manualOverride || bundle.accessToken || currentToken;
    } finally {
      if (refreshInFlight?.key === refreshKey) {
        refreshInFlight = null;
      }
    }
  })();

  refreshInFlight = { key: refreshKey, promise: refreshPromise };
  return refreshPromise;
}
