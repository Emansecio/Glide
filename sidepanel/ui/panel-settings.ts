import { migrateAnthropicModel } from '../../ai/anthropic-options.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../ai/default-prompt.js';
import {
  PROVIDER_DEFAULT_ENDPOINTS,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_UI,
  migrateStoredProvider,
  normalizeProviderId,
} from '../../ai/providers.js';
import { SidePanelUI } from './panel-ui.js';
import { SETTINGS_LOAD_KEYS, readSettings, writeSettings } from './settings-keys.js';

type PanelConfig = {
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint: string;
  systemPrompt: string;
};

const normalizeConfig = (raw: Record<string, any> = {}, fallbackPrompt = ''): PanelConfig => {
  const provider = migrateStoredProvider(raw.provider, raw.customEndpoint);
  const rawModel = String(raw.model || PROVIDER_DEFAULT_MODELS[provider] || '');
  const model = provider === 'anthropic' ? migrateAnthropicModel(rawModel) : rawModel;
  return {
    provider,
    apiKey: String(raw.apiKey || ''),
    model,
    customEndpoint: String(raw.customEndpoint || ''),
    systemPrompt: String(raw.systemPrompt || fallbackPrompt || ''),
  };
};

(SidePanelUI.prototype as any).cancelSettings = async function cancelSettings() {
  await this.loadSettings();
  this.closeSidebar();
  this.openChatView();
};

(SidePanelUI.prototype as any).getSelectedProvider = function getSelectedProvider() {
  return normalizeProviderId(this.elements.provider?.value || this.configs?.[this.currentConfig]?.provider);
};

(SidePanelUI.prototype as any).startCodexOAuth = async function startCodexOAuth() {
  const button = document.getElementById('codexOauthBtn') as HTMLButtonElement | null;
  if (button) {
    button.disabled = true;
    button.textContent = 'Aguardando login…';
  }
  this.updateStatus('Login OAuth em andamento no navegador…', 'active');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'codex_oauth' });
    if (!response?.success) {
      throw new Error(response?.error || 'Falha no login OAuth.');
    }
    if (response.apiKey) {
      if (this.elements.apiKey) {
        this.elements.apiKey.value = response.apiKey;
      }
      this.showSuccessToast('API key gerada via OAuth com sucesso!');
      this.updateStatus('Pronto', 'success');
    } else {
      this.showErrorBanner?.(
        'Login concluído, mas a conta não liberou uma API key da plataforma. Cole uma chave manualmente ou habilite o acesso à plataforma OpenAI na organização.',
      );
      this.updateStatus('OAuth concluído sem API key', 'warning');
    }
  } catch (error: any) {
    this.showErrorBanner?.(error?.message || 'Falha no login OAuth.');
    this.updateStatus('Falha no login OAuth', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '🔐 Conectar via navegador';
    }
  }
};

(SidePanelUI.prototype as any).handleProviderChange = function handleProviderChange() {
  const provider = this.getSelectedProvider();
  const config = this.configs?.[this.currentConfig];
  if (config) config.provider = provider;
  this._detectedModels = null;
  if (this.elements.model) {
    this.elements.model.value = PROVIDER_DEFAULT_MODELS[provider] || '';
  }
  if (config) config.model = this.elements.model?.value || '';
  this.refreshAvailableModels?.();
  // Persist immediately so sending a message after switching provider in settings uses the new choice
  this.persistAllSettings?.({ silent: true }).catch(() => {});
};

(SidePanelUI.prototype as any).toggleCustomEndpoint = function toggleCustomEndpoint() {
  const provider = this.getSelectedProvider();
  const ui = PROVIDER_UI[provider] || PROVIDER_UI.anthropic;

  if (this.elements.apiKeyGroup) {
    this.elements.apiKeyGroup.classList.remove('hidden');
  }
  const keyLabel = document.getElementById('apiKeyLabel');
  if (keyLabel) keyLabel.textContent = ui.keyLabel;
  const keyHint = document.getElementById('apiKeyHint');
  if (keyHint) keyHint.textContent = ui.keyHint;
  if (this.elements.apiKey) {
    (this.elements.apiKey as HTMLInputElement).placeholder = ui.keyPlaceholder;
  }

  // Ajuda de OAuth e import de credenciais só fazem sentido para Claude Code/Codex.
  const oauthHelpBtn = document.getElementById('oauthHelpBtn');
  if (oauthHelpBtn) oauthHelpBtn.classList.toggle('hidden', provider !== 'anthropic');
  const importBtn = document.getElementById('importCredentialsBtn');
  if (importBtn) importBtn.classList.toggle('hidden', provider !== 'anthropic' && provider !== 'codex');
  const codexOauthBtn = document.getElementById('codexOauthBtn');
  if (codexOauthBtn) codexOauthBtn.classList.toggle('hidden', provider !== 'codex');

  if (this.elements.customEndpointGroup) {
    this.elements.customEndpointGroup.classList.toggle('hidden', !ui.showEndpoint);
  }
  if (this.elements.customEndpoint) {
    (this.elements.customEndpoint as HTMLInputElement).placeholder = PROVIDER_DEFAULT_ENDPOINTS[provider] || '';
  }
  const endpointHint = document.getElementById('endpointHint');
  if (endpointHint) {
    endpointHint.textContent =
      provider === 'ollama'
        ? 'Endereço do servidor Ollama (padrão: http://localhost:11434). Se a detecção falhar, inicie o Ollama com OLLAMA_ORIGINS=chrome-extension://*.'
        : `Deixe vazio para usar o endpoint padrão (${PROVIDER_DEFAULT_ENDPOINTS[provider]}).`;
  }

  const modelHint = document.getElementById('modelHint');
  if (modelHint) modelHint.textContent = ui.modelHint;

  const detectGroup = document.getElementById('detectModelsGroup');
  if (detectGroup) detectGroup.classList.toggle('hidden', !ui.canDetectModels);
};

(SidePanelUI.prototype as any).switchSettingsTab = function switchSettingsTab(_tab?: string) {
  this.currentSettingsTab = 'general';
  this.elements.settingsTabGeneral?.classList.remove('hidden');
};

(SidePanelUI.prototype as any).loadSettings = async function loadSettings() {
  const settings = await readSettings(SETTINGS_LOAD_KEYS);
  const fallbackPrompt = this.getDefaultSystemPrompt();
  const activeConfig = normalizeConfig(settings, fallbackPrompt);

  this.currentConfig = 'default';
  this.configs = { default: activeConfig };

  if (this.elements.provider) this.elements.provider.value = activeConfig.provider;
  if (this.elements.apiKey) this.elements.apiKey.value = activeConfig.apiKey;
  if (this.elements.model) this.elements.model.value = activeConfig.model;
  if (this.elements.customEndpoint) this.elements.customEndpoint.value = activeConfig.customEndpoint;
  if (this.elements.systemPrompt) this.elements.systemPrompt.value = activeConfig.systemPrompt || fallbackPrompt;

  this.toggleCustomEndpoint();
  this.refreshAvailableModels?.();
};

(SidePanelUI.prototype as any).saveSettings = async function saveSettings() {
  const profile = this.collectCurrentFormProfile();
  this.configs[this.currentConfig] = profile;
  try {
    await this.persistAllSettings();
  } catch (error) {
    console.error('Falha ao salvar configurações:', error);
    this.showErrorBanner?.('Falha ao salvar configurações. Verifique o armazenamento e tente novamente.');
    this.updateStatus('Erro ao salvar configurações', 'error');
    return;
  }

  this.showSuccessToast('Configurações salvas com sucesso');
  this.updateStatus('Pronto', 'default');
  this.closeSidebar();
  this.openChatView();
};

(SidePanelUI.prototype as any).collectCurrentFormProfile = function collectCurrentFormProfile() {
  const current = normalizeConfig(this.configs[this.currentConfig] || {}, this.getDefaultSystemPrompt());
  const provider = this.getSelectedProvider();
  return normalizeConfig(
    {
      provider,
      apiKey: this.elements.apiKey?.value || current.apiKey || '',
      model: this.elements.model?.value || PROVIDER_DEFAULT_MODELS[provider] || current.model || '',
      customEndpoint: String(this.elements.customEndpoint?.value || '').trim(),
      systemPrompt: this.elements.systemPrompt?.value || current.systemPrompt || this.getDefaultSystemPrompt(),
    },
    this.getDefaultSystemPrompt(),
  );
};

(SidePanelUI.prototype as any).persistAllSettings = async function persistAllSettings({ silent = false } = {}) {
  const activeProfile = this.collectCurrentFormProfile();
  const payload = {
    provider: activeProfile.provider || 'ollama',
    apiKey: activeProfile.apiKey || '',
    model: activeProfile.model || PROVIDER_DEFAULT_MODELS[normalizeProviderId(activeProfile.provider)] || '',
    customEndpoint: activeProfile.customEndpoint || '',
    systemPrompt: activeProfile.systemPrompt || this.getDefaultSystemPrompt(),
  };

  this.currentConfig = 'default';
  this.configs = { default: normalizeConfig(payload, this.getDefaultSystemPrompt()) };

  await writeSettings(payload);
  this.updateContextUsage?.();
  if (!silent) {
    this.updateStatus('Configurações salvas com sucesso', 'success');
  }
};

(SidePanelUI.prototype as any).getDefaultSystemPrompt = function getDefaultSystemPrompt() {
  return DEFAULT_SYSTEM_PROMPT;
};
