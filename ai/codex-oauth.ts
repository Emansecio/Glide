// Fluxo OAuth do Codex (o mesmo usado pelo `codex login`): PKCE no navegador,
// interceptação do redirect para localhost:1455 e troca do id_token por uma
// API key da plataforma. Uma extensão não pode abrir o servidor local que o
// CLI usa, então o redirect é capturado observando a URL da aba de login.

import { randomUrlSafe, runAuthorizeTabFlow, sha256Challenge, startServiceWorkerKeepAlive } from './oauth-pkce.js';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
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

export async function runCodexOAuthFlow(): Promise<CodexOAuthResult> {
  const stopKeepAlive = startServiceWorkerKeepAlive();

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

    const callbackUrl = await runAuthorizeTabFlow(authorizeUrl.toString(), CODEX_REDIRECT_URI, state, OAUTH_TIMEOUT_MS);

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
    stopKeepAlive();
  }
}
