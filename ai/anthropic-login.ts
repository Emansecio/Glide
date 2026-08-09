// Login OAuth do Claude Code (mesmo cliente público usado pelo `claude login`):
// PKCE no navegador, captura do redirect para a página de callback do console
// e troca do code por access_token + refresh_token da assinatura (Pro/Max).
// Dispensa importar ~/.claude/.credentials.json manualmente.

import {
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_TOKEN_URL,
  type AnthropicOAuthBundle,
  writeAnthropicOAuth,
} from './anthropic-oauth.js';
import { randomUrlSafe, runAuthorizeTabFlow, sha256Challenge, startServiceWorkerKeepAlive } from './oauth-pkce.js';

const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const ANTHROPIC_OAUTH_SCOPE = 'org:create_api_key user:profile user:inference';
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
/** Network timeout for the token exchange fetch (not the interactive login wait). */
const OAUTH_FETCH_TIMEOUT_MS = 10_000;

export async function runAnthropicOAuthFlow(): Promise<AnthropicOAuthBundle> {
  const stopKeepAlive = startServiceWorkerKeepAlive();
  try {
    const verifier = randomUrlSafe(64);
    const challenge = await sha256Challenge(verifier);
    const state = randomUrlSafe(32);

    const authorizeUrl = new URL(ANTHROPIC_AUTHORIZE_URL);
    authorizeUrl.searchParams.set('code', 'true');
    authorizeUrl.searchParams.set('client_id', ANTHROPIC_OAUTH_CLIENT_ID);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', ANTHROPIC_REDIRECT_URI);
    authorizeUrl.searchParams.set('scope', ANTHROPIC_OAUTH_SCOPE);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);

    const callbackUrl = await runAuthorizeTabFlow(
      authorizeUrl.toString(),
      ANTHROPIC_REDIRECT_URI,
      state,
      OAUTH_TIMEOUT_MS,
    );

    const oauthError = callbackUrl.searchParams.get('error');
    if (oauthError) {
      const description = callbackUrl.searchParams.get('error_description') || oauthError;
      throw new Error(`Login recusado: ${description}`);
    }
    const code = callbackUrl.searchParams.get('code');
    if (!code) {
      throw new Error('Código de autorização ausente no retorno do login.');
    }

    const tokenResponse = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        state,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        redirect_uri: ANTHROPIC_REDIRECT_URI,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
    });
    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => '');
      throw new Error(
        `Falha na troca do código de autorização (HTTP ${tokenResponse.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`,
      );
    }
    const tokens = await tokenResponse.json();
    const accessToken = String(tokens?.access_token || '');
    const refreshToken = String(tokens?.refresh_token || '');
    if (!accessToken || !refreshToken) {
      throw new Error('Resposta de token inválida do servidor OAuth.');
    }
    const expiresIn = Number(tokens?.expires_in);
    const bundle: AnthropicOAuthBundle = {
      accessToken,
      refreshToken,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    };
    await writeAnthropicOAuth(bundle);
    return bundle;
  } finally {
    stopKeepAlive();
  }
}
