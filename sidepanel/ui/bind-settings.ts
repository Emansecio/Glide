import { parseAnthropicCredentials, writeAnthropicOAuth } from '../../ai/anthropic-oauth.js';
import type { SidePanelElements } from './panel-elements.js';

const isAnthropicOAuthToken = (token: string) => {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('sk-ant-')) return true;
  // JWT access tokens from ~/.claude/.credentials.json (claudeAiOauth.accessToken).
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(trimmed);
};

export type SettingsBindContext = {
  elements: SidePanelElements;
  handleProviderChange?: () => void;
  toggleCustomEndpoint: () => void;
  detectProviderModels?: () => void | Promise<void>;
  startCodexOAuth?: () => void | Promise<void>;
  saveSettings: () => void | Promise<void>;
  cancelSettings: () => void | Promise<void>;
  persistAllSettings?: (opts?: { silent?: boolean }) => void | Promise<void>;
  getSelectedProvider?: () => string;
  showSuccessToast: (message: string) => void;
};

export const bindSettings = (ui: SettingsBindContext) => {
  const { elements } = ui;

  elements.provider?.addEventListener('change', () => {
    ui.handleProviderChange?.();
    ui.toggleCustomEndpoint();
  });

  // Persist the credential the moment it changes (paste + blur), so it survives a
  // panel reload even without clicking "Salvar".
  elements.apiKey?.addEventListener('change', () => {
    void ui.persistAllSettings?.({ silent: true });
  });

  elements.detectModelsBtn?.addEventListener('click', () => {
    void ui.detectProviderModels?.();
  });

  elements.codexOauthBtn?.addEventListener('click', () => {
    void ui.startCodexOAuth?.();
  });

  elements.saveSettingsBtn?.addEventListener('click', () => {
    void ui.saveSettings();
  });

  elements.cancelSettingsBtn?.addEventListener('click', () => {
    void ui.cancelSettings();
  });

  elements.importCredentialsBtn?.addEventListener('click', () => {
    elements.credentialsFileInput?.click();
  });

  elements.credentialsFileInput?.addEventListener('change', async (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const provider = ui.getSelectedProvider?.() || 'anthropic';

      const token = String(
        json?.claudeAiOauth?.accessToken ||
          json?.OPENAI_API_KEY ||
          json?.tokens?.access_token ||
          json?.accessToken ||
          json?.apiKey ||
          text.trim(),
      );

      const looksValid = provider === 'anthropic' ? isAnthropicOAuthToken(token) : token.length > 8;
      if (token && looksValid) {
        if (elements.apiKey) {
          elements.apiKey.value = token;
        }
        if (provider === 'anthropic') {
          const bundle = parseAnthropicCredentials(json);
          if (bundle) {
            await writeAnthropicOAuth(bundle);
          }
        }
        // Persist immediately so the credential survives a panel reload even if
        // the user never clicks "Salvar" (writeAnthropicOAuth only runs for a
        // full OAuth bundle; a pasted/partial token would otherwise be lost).
        await ui.persistAllSettings?.({ silent: true });
        ui.showSuccessToast(
          provider === 'anthropic'
            ? 'Token OAuth do Claude Code importado com sucesso!'
            : 'Credencial importada com sucesso!',
        );
      } else {
        ui.showSuccessToast('Arquivo importado, mas token não encontrado ou formato inválido.');
      }
    } catch (err) {
      console.error('[Glide] Erro ao ler arquivo de credenciais:', err);
      ui.showSuccessToast('Erro ao ler ou processar arquivo JSON.');
    } finally {
      input.value = '';
    }
  });
};
