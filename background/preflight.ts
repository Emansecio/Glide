import { normalizeProviderId } from '../ai/providers.js';
import { isCustomEndpointAllowed } from '../ai/sdk-client.js';

/**
 * Checagem de credencial/config ANTES de gastar um run.
 *
 * Sem isto, um provedor sem chave (ou com sessão OAuth revogada) só falhava no meio
 * da chamada, aparecendo como "erro do provedor" — texto técnico, no lugar errado,
 * sem dizer o que fazer. Aqui a mensagem é acionável e o painel ganha um atalho
 * direto para as Configurações (`action: 'open_settings'`).
 */
export type PreflightIssue = {
  message: string;
  action?: 'open_settings';
  reason: 'missing_credential' | 'revoked_session' | 'invalid_endpoint';
};

export type PreflightInput = {
  provider: unknown;
  apiKey?: unknown;
  customEndpoint?: unknown;
  /** false quando o refresh token do Claude foi revogado (getAnthropicAuthHealth). */
  authHealthOk?: boolean;
  /** true quando existe um bundle OAuth persistido (Claude Code), mesmo sem apiKey no form. */
  hasOAuthSession?: boolean;
  /** true quando existe sessão ChatGPT do Codex (codexChatGptAuth), sem API key sk-. */
  hasCodexChatGptSession?: boolean;
  /** false quando o refresh token do Codex ChatGPT foi revogado. */
  codexAuthHealthOk?: boolean;
  /** true quando existe bundle OAuth do Grok CLI (xaiOAuth). */
  hasXaiOAuthSession?: boolean;
  /** false quando o refresh do Grok/xAI foi rejeitado. */
  xaiAuthHealthOk?: boolean;
};

const hasText = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

export function checkProviderReadiness(input: PreflightInput): PreflightIssue | null {
  const provider = normalizeProviderId(typeof input.provider === 'string' ? input.provider : '');
  const hasKey = hasText(input.apiKey);

  if (provider === 'anthropic') {
    if (input.authHealthOk === false) {
      return {
        reason: 'revoked_session',
        action: 'open_settings',
        message:
          'A sessão do Claude expirou (o login foi revogado). Reconecte em Configurações → "Conectar com Claude" para continuar.',
      };
    }
    if (!hasKey && input.hasOAuthSession !== true) {
      return {
        reason: 'missing_credential',
        action: 'open_settings',
        message:
          'Conecte sua conta do Claude para começar: Configurações → "Conectar com Claude" (ou cole um token do Claude Code).',
      };
    }
    return null;
  }

  if (provider === 'codex') {
    if (input.codexAuthHealthOk === false) {
      return {
        reason: 'revoked_session',
        action: 'open_settings',
        message:
          'A sessão ChatGPT do Codex expirou (login revogado). Reconecte em Configurações → "Conectar via navegador" ou importe ~/.codex/auth.json.',
      };
    }
    if (!hasKey && input.hasCodexChatGptSession !== true) {
      return {
        reason: 'missing_credential',
        action: 'open_settings',
        message:
          'Falta credencial do Codex: em Configurações use "Conectar via navegador", importe ~/.codex/auth.json, ou cole uma API key sk- da OpenAI.',
      };
    }
    return null;
  }

  if (provider === 'opencode') {
    if (!hasKey) {
      return {
        reason: 'missing_credential',
        action: 'open_settings',
        message: 'Falta a API key do OpenCode Zen. Adicione-a em Configurações para usar este provedor.',
      };
    }
    return null;
  }

  if (provider === 'qwen') {
    if (!hasKey) {
      return {
        reason: 'missing_credential',
        action: 'open_settings',
        message:
          'Falta a chave do Qwen/ModelStudio. Em Configurações escolha "Qwen Cloud", importe ~/.qwen/settings.json ou cole BAILIAN_CODING_PLAN_API_KEY / BAILIAN_TOKEN_PLAN_API_KEY.',
      };
    }
    return null;
  }

  if (provider === 'xai') {
    if (input.xaiAuthHealthOk === false) {
      return {
        reason: 'revoked_session',
        action: 'open_settings',
        message:
          'A sessão do Grok/xAI expirou (refresh revogado). Rode `grok login` e importe de novo ~/.grok/auth.json, ou cole uma API key de console.x.ai.',
      };
    }
    if (!hasKey && input.hasXaiOAuthSession !== true) {
      return {
        reason: 'missing_credential',
        action: 'open_settings',
        message:
          'Falta a credencial do Grok/xAI. Em Configurações escolha "Grok (xAI)", importe ~/.grok/auth.json ou cole uma API key de console.x.ai (xai-…).',
      };
    }
    return null;
  }

  // Ollama é local e não usa credencial: um endpoint inválido é o único problema
  // detectável antes da chamada.
  if (provider === 'command-code') {
    if (!hasKey) {
      return {
        reason: 'missing_credential',
        action: 'open_settings',
        message: 'Falta a chave do Command Code. Adicione-a em Configurações para usar este provedor.',
      };
    }
    return null;
  }

  if (hasText(input.customEndpoint)) {
    try {
      new URL(String(input.customEndpoint));
    } catch {
      return {
        reason: 'invalid_endpoint',
        action: 'open_settings',
        message: `O endpoint configurado não é uma URL válida: "${String(input.customEndpoint).slice(0, 80)}".`,
      };
    }
    // sdk-client ignora em silêncio endpoint http que não seja loopback e usa o padrão: um Ollama
    // em `http://192.168.x.x:11434` ia para localhost sem nenhum aviso. Falha cedo, com o motivo.
    if (provider === 'ollama' && !isCustomEndpointAllowed(provider, String(input.customEndpoint).trim())) {
      return {
        reason: 'invalid_endpoint',
        action: 'open_settings',
        message: `O endpoint "${String(input.customEndpoint).slice(0, 80)}" não é permitido: use https:// ou http://localhost para o Ollama (http em outro host é bloqueado).`,
      };
    }
  }
  return null;
}
