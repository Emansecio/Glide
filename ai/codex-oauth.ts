// Fluxo OAuth do Codex (o mesmo usado pelo `codex login`): PKCE no navegador,
// interceptação do redirect para localhost:1455 e troca do id_token por uma
// API key da plataforma. Uma extensão não pode abrir o servidor local que o
// CLI usa, então o redirect é capturado observando a URL da aba de login.

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_ISSUER = 'https://auth.openai.com';
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
/** Network timeout for token exchange fetches (not the interactive login wait). */
const OAUTH_FETCH_TIMEOUT_MS = 10_000;

export type CodexOAuthResult = {
  apiKey: string | null;
  accessToken: string;
  idToken: string;
  refreshToken: string | null;
};

const base64UrlEncode = (bytes: ArrayBuffer | Uint8Array) => {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = '';
  for (const byte of array) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const randomUrlSafe = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
};

const sha256Challenge = async (verifier: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
};

// Aguarda a aba de login navegar para o redirect_uri e devolve a URL completa
// (com code/state). O localhost:1455 não responde, mas a URL da navegação já
// chega em tabs.onUpdated antes da falha de conexão.
const waitForCallbackUrl = (tabId: number, expectedState: string): Promise<URL> => {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (updatedTabId !== tabId) return;
      const candidate = changeInfo.url || tab?.pendingUrl || tab?.url || '';
      if (!candidate.startsWith(CODEX_REDIRECT_URI)) return;
      try {
        const url = new URL(candidate);
        if (expectedState && url.searchParams.get('state') !== expectedState) {
          settle(() => reject(new Error('OAuth state mismatch — tente novamente.')));
          return;
        }
        settle(() => resolve(url));
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        settle(() => reject(new Error('Login cancelado (a aba foi fechada).')));
      }
    };

    const timer = setTimeout(
      () => settle(() => reject(new Error('Tempo esgotado aguardando a conclusão do login.'))),
      OAUTH_TIMEOUT_MS,
    );

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
};

export async function runCodexOAuthFlow(): Promise<CodexOAuthResult> {
  // Mantém o service worker MV3 vivo enquanto o usuário completa o login.
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo?.();
  }, 20000);

  try {
    const verifier = randomUrlSafe(64);
    const challenge = await sha256Challenge(verifier);
    const state = randomUrlSafe(32);

    const authorizeUrl = new URL(`${CODEX_ISSUER}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', CODEX_CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', CODEX_REDIRECT_URI);
    authorizeUrl.searchParams.set('scope', 'openid profile email offline_access');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('id_token_add_organizations', 'true');
    authorizeUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authorizeUrl.searchParams.set('state', state);

    const tab = await chrome.tabs.create({ url: authorizeUrl.toString(), active: true });
    if (typeof tab.id !== 'number') {
      throw new Error('Não foi possível abrir a aba de login.');
    }

    let callbackUrl: URL;
    try {
      callbackUrl = await waitForCallbackUrl(tab.id, state);
    } finally {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // Aba já fechada pelo usuário.
      }
    }

    const oauthError = callbackUrl.searchParams.get('error');
    if (oauthError) {
      const description = callbackUrl.searchParams.get('error_description') || oauthError;
      throw new Error(`Login recusado: ${description}`);
    }
    const code = callbackUrl.searchParams.get('code');
    if (!code) {
      throw new Error('Código de autorização ausente no retorno do login.');
    }

    const tokenResponse = await fetch(`${CODEX_ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CODEX_REDIRECT_URI,
        client_id: CODEX_CLIENT_ID,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
    });
    if (!tokenResponse.ok) {
      throw new Error(`Falha na troca do código de autorização (HTTP ${tokenResponse.status}).`);
    }
    const tokens = await tokenResponse.json();
    const idToken = String(tokens?.id_token || '');
    const accessToken = String(tokens?.access_token || '');
    const refreshToken = tokens?.refresh_token ? String(tokens.refresh_token) : null;
    if (!idToken && !accessToken) {
      throw new Error('Resposta de token inválida do servidor OAuth.');
    }

    // Troca o id_token por uma API key da plataforma (mesma rota do Codex CLI).
    // Pode falhar se a conta/organização não tiver acesso à plataforma — nesse
    // caso devolvemos apiKey null e o chamador orienta o usuário.
    let apiKey: string | null = null;
    if (idToken) {
      try {
        const exchange = await fetch(`${CODEX_ISSUER}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            client_id: CODEX_CLIENT_ID,
            requested_token: 'openai-api-key',
            subject_token: idToken,
            subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          }),
          signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
        });
        if (exchange.ok) {
          const data = await exchange.json();
          if (typeof data?.access_token === 'string' && data.access_token.startsWith('sk-')) {
            apiKey = data.access_token;
          }
        }
      } catch (error) {
        console.warn('[Glide] Troca por API key falhou (opcional):', error);
      }
    }

    return { apiKey, accessToken, idToken, refreshToken };
  } finally {
    clearInterval(keepAlive);
  }
}
