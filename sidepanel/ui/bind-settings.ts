import {
  parseAnthropicCredentials,
  reconcileManualAnthropicToken,
  writeAnthropicOAuth,
} from '../../ai/anthropic-oauth.js';
import {
  clearCodexChatGptAuth,
  parseCodexAuthJson,
  resolveCodexApiKeyFieldValue,
  writeCodexChatGptAuth,
} from '../../ai/codex-auth.js';
import { parseQwenSettings, resolveWorkingQwenImport } from '../../ai/qwen-settings.js';
import { parseGrokAuthJson, reconcileManualXaiToken, writeXaiOAuth } from '../../ai/xai-oauth.js';
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
  startAnthropicOAuth?: () => void | Promise<void>;
  startCodexOAuth?: () => void | Promise<void>;
  saveSettings: () => void | Promise<void>;
  cancelSettings: () => void | Promise<void>;
  persistAllSettings?: (opts?: { silent?: boolean }) => void | Promise<void>;
  getSelectedProvider?: () => string;
  settingsHydrated?: boolean;
  userModelSelectionLocked?: boolean;
  showSuccessToast: (message: string) => void;
  showErrorBanner?: (message: string) => void;
  codexChatGptSession?: import('../../ai/codex-auth.js').CodexChatGptAuthBundle | null;
};

type CredentialProvider = 'anthropic' | 'codex' | 'qwen' | 'xai';

type OpenFilePickerOptions = {
  id?: string;
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
};

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
};

const CREDENTIAL_PICKER_IDS: Record<CredentialProvider, string> = {
  anthropic: 'glide-credentials-claude-code',
  codex: 'glide-credentials-codex',
  qwen: 'glide-credentials-qwen',
  xai: 'glide-credentials-xai-grok',
};

const asCredentialProvider = (provider: string): CredentialProvider => {
  if (provider === 'codex') return 'codex';
  if (provider === 'qwen' || provider === 'qwencloud' || provider === 'bailian') return 'qwen';
  if (provider === 'xai' || provider === 'grok' || provider === 'grokcloud') return 'xai';
  return 'anthropic';
};

export const bindSettings = (ui: SettingsBindContext) => {
  const { elements } = ui;

  elements.provider?.addEventListener('change', () => {
    if (ui.settingsHydrated === false) return;
    ui.handleProviderChange?.();
    ui.toggleCustomEndpoint();
  });

  // Settings model is a <select> — mirror into the composer picker and persist.
  elements.model?.addEventListener('change', () => {
    const model = String(elements.model?.value || '').trim();
    if (!model) return;
    ui.userModelSelectionLocked = true;
    if (elements.modelSelect) {
      const select = elements.modelSelect;
      if (!select.querySelector(`option[value="${CSS.escape(model)}"]`)) {
        const opt = document.createElement('option');
        opt.value = model;
        opt.textContent = model;
        select.appendChild(opt);
      }
      select.value = model;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      void ui.persistAllSettings?.({ silent: true });
    }
  });

  // O campo só é considerado "editado à mão" quando o usuário digita/cola nele.
  // Preencher via loadSettings ou pós-OAuth seta `.value` programaticamente e NÃO
  // dispara 'input' — assim um simples foco+blur após um refresh em background (que
  // deixa o campo exibindo o token antigo) não aciona o reconcile destrutivo.
  let apiKeyUserEdited = false;
  elements.apiKey?.addEventListener('input', () => {
    apiKeyUserEdited = true;
  });

  // Persist the credential the moment it changes (paste + blur), so it survives a
  // panel reload even without clicking "Salvar". Um token do Claude colado à mão
  // substitui a sessão OAuth armazenada — sem isso o bundle antigo teria
  // precedência e o token novo ficaria inerte. Mas isso SÓ vale quando o usuário
  // de fato editou o campo; caso contrário preservamos o bundle OAuth (com refresh).
  elements.apiKey?.addEventListener('change', () => {
    const provider = ui.getSelectedProvider?.() || '';
    const pasted = String(elements.apiKey?.value || '');
    const editedThisTime = apiKeyUserEdited;
    apiKeyUserEdited = false;
    let reconcile: Promise<unknown> = Promise.resolve();
    if (editedThisTime && provider === 'anthropic') {
      reconcile = reconcileManualAnthropicToken(pasted).catch(() => {});
    } else if (editedThisTime && (provider === 'xai' || provider === 'grok')) {
      reconcile = reconcileManualXaiToken(pasted).catch(() => {});
    }
    void reconcile.then(() => ui.persistAllSettings?.({ silent: true }));
  });

  elements.detectModelsBtn?.addEventListener('click', () => {
    void ui.detectProviderModels?.();
  });

  elements.anthropicOauthBtn?.addEventListener('click', () => {
    void ui.startAnthropicOAuth?.();
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

  const importCredentialsFile = async (file: File, provider: CredentialProvider) => {
    try {
      const text = await file.text();
      const json = JSON.parse(text);

      if (provider === 'codex') {
        const parsed = parseCodexAuthJson(json);
        if (parsed.mode === 'api_key') {
          if (elements.apiKey) elements.apiKey.value = parsed.apiKey;
          ui.codexChatGptSession = null;
          await clearCodexChatGptAuth();
          await ui.persistAllSettings?.({ silent: true });
          ui.showSuccessToast('API key da OpenAI importada com sucesso!');
          return;
        }
        if (parsed.mode === 'chatgpt') {
          await writeCodexChatGptAuth(parsed.bundle);
          ui.codexChatGptSession = parsed.bundle;
          if (elements.apiKey) {
            elements.apiKey.value = resolveCodexApiKeyFieldValue(parsed.bundle, '');
          }
          await ui.persistAllSettings?.({ silent: true });
          ui.showSuccessToast('Sessão ChatGPT do Codex importada!');
          return;
        }
        ui.showErrorBanner?.(
          parsed.reason ||
            'Arquivo lido, mas nenhuma credencial Codex válida foi encontrada. Use ~/.codex/auth.json com auth_mode chatgpt ou OPENAI_API_KEY sk-.',
        );
        return;
      }

      // Grok CLI / xAI: ~/.grok/auth.json
      if (provider === 'xai') {
        const bundle = parseGrokAuthJson(json);
        if (!bundle) {
          ui.showErrorBanner?.(
            'Arquivo lido, mas não achei sessão Grok. Use ~/.grok/auth.json (após `grok login`) ou cole uma API key xai-… de console.x.ai.',
          );
          return;
        }
        await writeXaiOAuth(bundle);
        if (elements.apiKey) elements.apiKey.value = bundle.accessToken;
        if (elements.customEndpoint && !String(elements.customEndpoint.value || '').trim()) {
          elements.customEndpoint.value = 'https://api.x.ai/v1';
        }
        if (elements.provider && elements.provider.value !== 'xai') {
          elements.provider.value = 'xai';
          ui.handleProviderChange?.();
          ui.toggleCustomEndpoint();
        }
        // Prefer Grok 4.5 se o modelo atual não for da família xAI.
        if (elements.model) {
          const current = String(elements.model.value || '');
          if (!current || !/grok|composer/i.test(current)) {
            const select = elements.model as HTMLSelectElement;
            if (select.tagName === 'SELECT' && !select.querySelector('option[value="grok-4.5"]')) {
              const opt = document.createElement('option');
              opt.value = 'grok-4.5';
              opt.textContent = 'Grok 4.5';
              select.appendChild(opt);
            }
            select.value = 'grok-4.5';
            ui.userModelSelectionLocked = true;
          }
        }
        await ui.persistAllSettings?.({ silent: true });
        const email = bundle.email ? ` (${bundle.email})` : '';
        ui.showSuccessToast(`Grok/xAI importado${email} — token renova sozinho.`);
        return;
      }

      // Qwen Code / ModelStudio: ~/.qwen/settings.json
      if (provider === 'qwen') {
        const parsed = parseQwenSettings(json);
        if (!parsed) {
          ui.showErrorBanner?.(
            'Arquivo lido, mas não achei chave ModelStudio. Use ~/.qwen/settings.json (BAILIAN_CODING_PLAN_API_KEY ou BAILIAN_TOKEN_PLAN_API_KEY).',
          );
          return;
        }
        const qwen = await resolveWorkingQwenImport(parsed);
        if (elements.apiKey) elements.apiKey.value = qwen.apiKey;
        if (elements.customEndpoint) elements.customEndpoint.value = qwen.baseUrl;
        if (elements.model && qwen.model) {
          const select = elements.model as HTMLSelectElement;
          if (select.tagName === 'SELECT' && !select.querySelector(`option[value="${CSS.escape(qwen.model)}"]`)) {
            const opt = document.createElement('option');
            opt.value = qwen.model;
            opt.textContent = qwen.model;
            select.appendChild(opt);
          }
          select.value = qwen.model;
          ui.userModelSelectionLocked = true;
        }
        if (elements.provider && elements.provider.value !== 'qwen') {
          elements.provider.value = 'qwen';
          ui.handleProviderChange?.();
          ui.toggleCustomEndpoint();
        }
        await ui.persistAllSettings?.({ silent: true });
        const switched = qwen.switchedFrom ? ` (trocou de ${qwen.switchedFrom})` : '';
        const statusNote =
          qwen.probeStatus === 429
            ? ' — auth OK, cota temporariamente esgotada'
            : qwen.probeStatus === 401
              ? ' — atenção: a chave ainda retornou 401'
              : qwen.probeStatus >= 200 && qwen.probeStatus < 300
                ? ' — auth OK'
                : ` — probe HTTP ${qwen.probeStatus}`;
        ui.showSuccessToast(`Qwen/ModelStudio importado (${qwen.plan}${switched}): ${qwen.model}${statusNote}`);
        return;
      }

      // Também aceita settings.json do Qwen se o usuário importar com Claude selecionado
      // mas o arquivo for claramente ModelStudio.
      const qwenMaybe = parseQwenSettings(json);
      if (qwenMaybe && !isAnthropicOAuthToken(String(json?.claudeAiOauth?.accessToken || json?.accessToken || ''))) {
        const qwen = await resolveWorkingQwenImport(qwenMaybe);
        if (elements.provider) {
          elements.provider.value = 'qwen';
          ui.handleProviderChange?.();
          ui.toggleCustomEndpoint();
        }
        if (elements.apiKey) elements.apiKey.value = qwen.apiKey;
        if (elements.customEndpoint) elements.customEndpoint.value = qwen.baseUrl;
        if (elements.model && qwen.model) {
          elements.model.value = qwen.model;
          ui.userModelSelectionLocked = true;
        }
        await ui.persistAllSettings?.({ silent: true });
        ui.showSuccessToast(`Qwen/ModelStudio importado (${qwen.plan}, probe HTTP ${qwen.probeStatus}).`);
        return;
      }

      // Auto-detect ~/.grok/auth.json mesmo com outro provedor selecionado.
      const grokMaybe = parseGrokAuthJson(json);
      if (grokMaybe?.refreshToken && grokMaybe.accessToken) {
        await writeXaiOAuth(grokMaybe);
        if (elements.provider) {
          elements.provider.value = 'xai';
          ui.handleProviderChange?.();
          ui.toggleCustomEndpoint();
        }
        if (elements.apiKey) elements.apiKey.value = grokMaybe.accessToken;
        if (elements.customEndpoint) elements.customEndpoint.value = 'https://api.x.ai/v1';
        await ui.persistAllSettings?.({ silent: true });
        ui.showSuccessToast('Grok/xAI importado a partir do auth.json.');
        return;
      }

      const token = String(json?.claudeAiOauth?.accessToken || json?.accessToken || json?.apiKey || text.trim());

      const looksValid = isAnthropicOAuthToken(token);
      if (token && looksValid) {
        if (elements.apiKey) {
          elements.apiKey.value = token;
        }
        const bundle = parseAnthropicCredentials(json);
        if (bundle) {
          await writeAnthropicOAuth(bundle);
        }
        // Persist immediately so the credential survives a panel reload even if
        // the user never clicks "Salvar" (writeAnthropicOAuth only runs for a
        // full OAuth bundle; a pasted/partial token would otherwise be lost).
        await ui.persistAllSettings?.({ silent: true });
        ui.showSuccessToast('Token OAuth do Claude Code importado com sucesso!');
      } else {
        // Falha de importação é ERRO, não sucesso: antes ia pelo toast verde.
        ui.showErrorBanner?.(
          'Arquivo lido, mas nenhuma credencial válida foi encontrada. Exporte ~/.claude/.credentials.json, ~/.qwen/settings.json, ~/.grok/auth.json ou cole o token manualmente.',
        );
      }
    } catch (err) {
      console.error('[Glide] Erro ao ler arquivo de credenciais:', err);
      ui.showErrorBanner?.('Não foi possível ler o arquivo: confirme que é um JSON de credenciais válido.');
    }
  };

  elements.importCredentialsBtn?.addEventListener('click', () => {
    const input = elements.credentialsFileInput;
    if (!input) return;

    const provider = asCredentialProvider(ui.getSelectedProvider?.() || 'anthropic');
    const filePickerWindow = window as FilePickerWindow;
    if (!filePickerWindow.showOpenFilePicker) {
      input.click();
      return;
    }

    // `id` faz o Chrome memorizar uma pasta diferente para Claude e Codex.
    // Depois da primeira escolha em .claude/.codex, o seletor volta direto para ela.
    void filePickerWindow
      .showOpenFilePicker({
        id: CREDENTIAL_PICKER_IDS[provider],
        multiple: false,
        excludeAcceptAllOption: true,
        types: [{ description: 'Arquivo JSON de credenciais', accept: { 'application/json': ['.json'] } }],
      })
      .then(async ([handle]) => {
        if (!handle) return;
        await importCredentialsFile(await handle.getFile(), provider);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('[Glide] Erro ao abrir seletor de credenciais:', error);
        ui.showErrorBanner?.('Não foi possível abrir o seletor de credenciais. Tente novamente.');
      });
  });

  elements.credentialsFileInput?.addEventListener('change', async (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    await importCredentialsFile(file, asCredentialProvider(ui.getSelectedProvider?.() || 'anthropic'));
    input.value = '';
  });
};
