import { migrateAnthropicModel } from '../../ai/anthropic-options.js';
import {
  CODEX_CHATGPT_STORAGE_KEY,
  type CodexChatGptAuthBundle,
  clearCodexChatGptAuth,
  isCodexChatGptDisplayToken,
  isOpenAiApiKey,
  readCodexChatGptAuth,
  resolveCodexApiKeyFieldValue,
} from '../../ai/codex-auth.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../ai/default-prompt.js';
import { resolveHistoryPersistenceMode } from '../../ai/persist-tool-args.js';
import { resolveSystemPromptMode, type SystemPromptMode } from '../../ai/system-prompt-mode.js';
import {
  MODEL_DISPLAY_LABELS,
  PROVIDER_DEFAULT_ENDPOINTS,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_PRESET_MODELS,
  PROVIDER_UI,
  filterProviderModels,
  migrateStoredProvider,
  normalizeProviderId,
  normalizeProviderModel,
} from '../../ai/providers.js';
import { DEFAULT_TOOL_PERMISSIONS } from '../../background/tool-permissions.js';
import { SidePanelUI } from './panel-ui.js';
import {
  PROVIDER_KEY_IDS,
  SETTINGS_LOAD_KEYS,
  providerApiKeyField,
  readProviderKeyMap,
  readSettings,
  resolveProviderApiKey,
  writeSettings,
} from './settings-keys.js';

type PanelConfig = {
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint: string;
  systemPrompt: string;
  systemPromptMode: SystemPromptMode;
};

const normalizeConfig = (raw: Record<string, any> = {}, fallbackPrompt = ''): PanelConfig => {
  const provider = migrateStoredProvider(raw.provider, raw.customEndpoint);
  const rawModel = String(raw.model || PROVIDER_DEFAULT_MODELS[provider] || '');
  const migratedModel = provider === 'anthropic' ? migrateAnthropicModel(rawModel) : rawModel;
  const model = normalizeProviderModel(provider, migratedModel);
  return {
    provider,
    apiKey: String(raw.apiKey || ''),
    model,
    customEndpoint: String(raw.customEndpoint || ''),
    systemPrompt: String(raw.systemPrompt || fallbackPrompt || ''),
    systemPromptMode: resolveSystemPromptMode(raw.systemPrompt || fallbackPrompt, raw.systemPromptMode),
  };
};

SidePanelUI.prototype.cancelSettings = async function cancelSettings() {
  await this.loadSettings();
  this.closeSidebar();
  this.openChatView();
};

SidePanelUI.prototype.getSelectedProvider = function getSelectedProvider() {
  return normalizeProviderId(this.elements.provider?.value || this.configs?.[this.currentConfig]?.provider);
};

SidePanelUI.prototype.startAnthropicOAuth = async function startAnthropicOAuth() {
  const oauthProvider = 'anthropic';
  this.pendingOAuthProvider = oauthProvider;
  const button = this.elements.anthropicOauthBtn as HTMLButtonElement | null;
  const setBtnLabel = (text: string) => {
    const label = button?.querySelector('.btn-label') as HTMLElement | null;
    if (label) label.textContent = text;
    else if (button) button.textContent = text;
  };
  if (button) {
    button.disabled = true;
    setBtnLabel('Aguardando login…');
  }
  this.updateStatus('Login OAuth em andamento no navegador…', 'active');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'anthropic_oauth' });
    if (this.pendingOAuthProvider !== oauthProvider || this.getSelectedProvider() !== oauthProvider) {
      this.updateStatus('Login OAuth ignorado — provedor alterado durante o fluxo.', 'warning');
      return;
    }
    if (!response?.success || !response.accessToken) {
      throw new Error(response?.error || 'Falha no login OAuth.');
    }
    if (this.elements.apiKey) {
      this.elements.apiKey.value = response.accessToken;
    }
    // O bundle OAuth (refresh token) já foi persistido pelo background; aqui só
    // sincronizamos o formulário/settings com o access token atual.
    await this.persistAllSettings?.({ silent: true });
    this.showSuccessToast('Claude conectado! O token renova sozinho a partir de agora.');
    this.updateStatus('Pronto', 'success');
  } catch (error: any) {
    this.showErrorBanner?.(error?.message || 'Falha no login OAuth.');
    this.updateStatus('Falha no login OAuth', 'error');
  } finally {
    if (this.pendingOAuthProvider === oauthProvider) {
      this.pendingOAuthProvider = null;
    }
    if (button) {
      button.disabled = false;
      setBtnLabel('Conectar com Claude');
    }
  }
};

SidePanelUI.prototype.startCodexOAuth = async function startCodexOAuth() {
  const oauthProvider = 'codex';
  this.pendingOAuthProvider = oauthProvider;
  const button = document.getElementById('codexOauthBtn') as HTMLButtonElement | null;
  const setBtnLabel = (text: string) => {
    const label = button?.querySelector('.btn-label') as HTMLElement | null;
    if (label) label.textContent = text;
    else if (button) button.textContent = text;
  };
  if (button) {
    button.disabled = true;
    setBtnLabel('Aguardando login…');
  }
  this.updateStatus('Login OAuth em andamento no navegador…', 'active');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'codex_oauth' });
    if (this.pendingOAuthProvider !== oauthProvider || this.getSelectedProvider() !== oauthProvider) {
      this.updateStatus('Login OAuth ignorado — provedor alterado durante o fluxo.', 'warning');
      return;
    }
    if (!response?.success) {
      throw new Error(response?.error || 'Falha no login OAuth.');
    }
    if (response.apiKey) {
      if (this.elements.apiKey) {
        this.elements.apiKey.value = response.apiKey;
      }
      await this.persistAllSettings?.({ silent: true });
      this.showSuccessToast('API key gerada via OAuth com sucesso!');
      this.updateStatus('Pronto', 'success');
    } else if (response.chatgptAuth) {
      this.codexChatGptSession = (await readCodexChatGptAuth()) || null;
      if (this.elements.apiKey) {
        this.elements.apiKey.value = resolveCodexApiKeyFieldValue(this.codexChatGptSession, '');
      }
      await this.persistAllSettings?.({ silent: true });
      this.showSuccessToast('Sessão ChatGPT do Codex conectada! O token renova sozinho.');
      this.updateStatus('Pronto', 'success');
    } else {
      this.showErrorBanner?.(
        'Login concluído, mas não foi possível persistir a sessão ChatGPT do Codex. Importe ~/.codex/auth.json ou cole uma API key sk- manualmente.',
      );
      this.updateStatus('OAuth concluído sem sessão utilizável', 'warning');
    }
  } catch (error: any) {
    this.showErrorBanner?.(error?.message || 'Falha no login OAuth.');
    this.updateStatus('Falha no login OAuth', 'error');
  } finally {
    if (this.pendingOAuthProvider === oauthProvider) {
      this.pendingOAuthProvider = null;
    }
    if (button) {
      button.disabled = false;
      setBtnLabel('Conectar via navegador');
    }
  }
};

SidePanelUI.prototype.handleProviderChange = function handleProviderChange() {
  if (!this.settingsHydrated) return;
  const provider = this.getSelectedProvider();
  const config = this.configs?.[this.currentConfig];
  const previousProvider = normalizeProviderId(config?.provider || '');

  // Arquiva a credencial que está no campo sob o provedor ANTERIOR e traz a do novo.
  // Sem isto, a chave visível era persistida sob o provedor recém-escolhido — como o
  // token do Claude indo para o slot do Codex e sendo enviado à OpenAI.
  this.providerKeys = this.providerKeys || {};
  const visibleKey = String(this.elements.apiKey?.value || '');
  if (previousProvider && previousProvider !== provider) {
    this.providerKeys[previousProvider] = visibleKey;
    if (this.pendingOAuthProvider && this.pendingOAuthProvider !== provider) {
      this.pendingOAuthProvider = null;
    }
  }
  const restoredKey = resolveProviderApiKey(this.providerKeys, provider, '');
  const displayKey =
    provider === 'codex' ? resolveCodexApiKeyFieldValue(this.codexChatGptSession, restoredKey) : restoredKey;
  if (this.elements.apiKey) {
    this.elements.apiKey.value = displayKey;
  }

  if (config) {
    config.provider = provider;
    config.apiKey = displayKey;
  }
  this._detectedModels = null;
  const defaultModel = PROVIDER_DEFAULT_MODELS[provider] || '';
  this.fillSettingsModelSelect?.(provider, defaultModel);
  if (config) config.model = this.elements.model?.value || defaultModel;
  this.refreshAvailableModels?.();
  // Persist immediately so sending a message after switching provider in settings uses the new choice
  this.persistAllSettings?.({ silent: true }).catch(() => {});
};

/** Populate the settings model <select> from presets (and keep a custom current value if needed). */
SidePanelUI.prototype.fillSettingsModelSelect = function fillSettingsModelSelect(
  provider: string,
  currentModel?: string,
  extraModels: string[] = [],
) {
  const select = this.elements.model as HTMLSelectElement | null;
  if (!select || select.tagName !== 'SELECT') return;

  const pid = normalizeProviderId(provider);
  const presets = filterProviderModels(pid, PROVIDER_PRESET_MODELS[pid] || []);
  const selected = normalizeProviderModel(
    pid,
    String(currentModel || select.value || PROVIDER_DEFAULT_MODELS[pid] || '').trim(),
  );
  const models = [...presets];
  for (const m of filterProviderModels(pid, extraModels)) {
    if (m && !models.includes(m)) models.push(m);
  }
  if (selected && !models.includes(selected)) models.unshift(selected);

  select.innerHTML = '';
  if (!models.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = pid === 'ollama' ? 'Detecte modelos ou selecione depois' : 'Nenhum modelo';
    empty.disabled = true;
    empty.selected = true;
    select.appendChild(empty);
    return;
  }

  for (const id of models) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = MODEL_DISPLAY_LABELS[id] || id;
    if (id === selected) opt.selected = true;
    select.appendChild(opt);
  }
  if (selected) select.value = selected;
};

SidePanelUI.prototype.toggleCustomEndpoint = function toggleCustomEndpoint() {
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

  // Import: Claude, Codex, ~/.qwen/settings.json e ~/.grok/auth.json.
  const oauthHelpBtn = document.getElementById('oauthHelpBtn');
  if (oauthHelpBtn) oauthHelpBtn.classList.toggle('hidden', provider !== 'anthropic');
  const importBtn = document.getElementById('importCredentialsBtn');
  if (importBtn) {
    importBtn.classList.toggle(
      'hidden',
      provider !== 'anthropic' && provider !== 'codex' && provider !== 'qwen' && provider !== 'xai',
    );
  }
  const anthropicOauthBtn = document.getElementById('anthropicOauthBtn');
  if (anthropicOauthBtn) anthropicOauthBtn.classList.toggle('hidden', provider !== 'anthropic');
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
        : provider === 'qwen'
          ? 'Coding Plan intl: https://coding-intl.dashscope.aliyuncs.com/v1 · Token Plan: https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'
          : provider === 'xai'
            ? 'Padrão: https://api.x.ai/v1 (OpenAI-compatible). Sessão Grok CLI também autentica neste endpoint.'
            : `Deixe vazio para usar o endpoint padrão (${PROVIDER_DEFAULT_ENDPOINTS[provider]}).`;
  }

  const modelHint = document.getElementById('modelHint');
  if (modelHint) modelHint.textContent = ui.modelHint;

  const detectGroup = document.getElementById('detectModelsGroup');
  if (detectGroup) detectGroup.classList.toggle('hidden', !ui.canDetectModels);
};

SidePanelUI.prototype.loadSettings = async function loadSettings() {
  this.settingsHydrated = false;
  this.setSettingsControlsEnabled?.(false);
  const settings = await readSettings([
    ...SETTINGS_LOAD_KEYS,
    'toolPermissions',
    'historyPersistence',
    'notifyOnComplete',
    CODEX_CHATGPT_STORAGE_KEY,
  ]);
  const fallbackPrompt = this.getDefaultSystemPrompt();
  const activeConfig = normalizeConfig(settings, fallbackPrompt);
  const codexBundle = settings?.[CODEX_CHATGPT_STORAGE_KEY];
  this.codexChatGptSession =
    codexBundle && typeof codexBundle === 'object' && (codexBundle as CodexChatGptAuthBundle).refreshToken
      ? (codexBundle as CodexChatGptAuthBundle)
      : null;

  // Mapa provedor→credencial (com migração do slot legado `apiKey`).
  this.providerKeys = readProviderKeyMap(settings as Record<string, unknown>, activeConfig.provider);
  activeConfig.apiKey = resolveProviderApiKey(this.providerKeys, activeConfig.provider, activeConfig.apiKey);
  if (activeConfig.provider === 'codex') {
    activeConfig.apiKey = resolveCodexApiKeyFieldValue(this.codexChatGptSession, activeConfig.apiKey);
  }

  this.currentConfig = 'default';
  this.configs = { default: activeConfig };

  if (this.elements.provider) this.elements.provider.value = activeConfig.provider;
  if (this.elements.apiKey) this.elements.apiKey.value = activeConfig.apiKey;
  this.fillSettingsModelSelect?.(activeConfig.provider, activeConfig.model);
  if (this.elements.customEndpoint) this.elements.customEndpoint.value = activeConfig.customEndpoint;
  if (this.elements.systemPrompt) this.elements.systemPrompt.value = activeConfig.systemPrompt || fallbackPrompt;
  if (this.elements.enableDebugger) {
    const perms = (settings as Record<string, any>).toolPermissions || {};
    this.elements.enableDebugger.checked = perms.debugger === true;
  }
  this.applyPermissionCheckboxes((settings as Record<string, any>).toolPermissions || {});
  this.historyPersistence = resolveHistoryPersistenceMode((settings as Record<string, unknown>).historyPersistence);
  this.bindHistoryPersistenceControl();
  this.syncHistoryPersistenceSegments();
  this.notifyOnComplete = (settings as Record<string, unknown>).notifyOnComplete === true;
  if (this.elements.notifyOnComplete) {
    this.elements.notifyOnComplete.checked = this.notifyOnComplete;
  }

  this.toggleCustomEndpoint();
  this.userModelSelectionLocked = false;
  this.refreshAvailableModels?.();
  this.settingsHydrated = true;
  this.setSettingsControlsEnabled?.(true);
};

SidePanelUI.prototype.saveSettings = async function saveSettings() {
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

SidePanelUI.prototype.collectCurrentFormProfile = function collectCurrentFormProfile() {
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

SidePanelUI.prototype.persistAllSettings = async function persistAllSettings({ silent = false } = {}) {
  if (!this.settingsHydrated) return;
  const activeProfile = this.collectCurrentFormProfile();
  const activeProvider = normalizeProviderId(activeProfile.provider) || 'ollama';
  this.providerKeys = this.providerKeys || {};
  const rawFieldKey = activeProfile.apiKey || '';
  const displayOnlyCodexJwt =
    activeProvider === 'codex' && isCodexChatGptDisplayToken(rawFieldKey, this.codexChatGptSession);
  this.providerKeys[activeProvider] = displayOnlyCodexJwt ? '' : rawFieldKey;

  const existing = await readSettings(['toolPermissions']);
  const prevPerms =
    existing.toolPermissions && typeof existing.toolPermissions === 'object'
      ? { ...(existing.toolPermissions as Record<string, unknown>) }
      : {};
  // Only touch debugger when the control is mounted. Silent saves (OAuth, model
  // picker) must not clobber an existing opt-in just because the checkbox is
  // unchecked/missing before loadSettings.
  if (this.elements.enableDebugger) {
    prevPerms.debugger = this.elements.enableDebugger.checked === true;
  }
  this.collectPermissionCheckboxes(prevPerms);

  const payload: Record<string, unknown> = {
    provider: activeProvider,
    apiKey: displayOnlyCodexJwt ? '' : rawFieldKey,
    model: activeProfile.model || PROVIDER_DEFAULT_MODELS[activeProvider] || '',
    customEndpoint: activeProfile.customEndpoint || '',
    systemPrompt: activeProfile.systemPrompt || this.getDefaultSystemPrompt(),
    systemPromptMode: resolveSystemPromptMode(activeProfile.systemPrompt, activeProfile.systemPromptMode),
    toolPermissions: prevPerms,
    historyPersistence: this.historyPersistence || 'redacted',
    notifyOnComplete: this.elements.notifyOnComplete?.checked === true,
  };
  // Persiste TODOS os slots conhecidos: assim a credencial de cada provedor
  // sobrevive a trocas de provedor e a recarregamentos do painel.
  for (const provider of PROVIDER_KEY_IDS) {
    payload[providerApiKeyField(provider)] = this.providerKeys[provider] || '';
  }

  if (activeProvider === 'codex') {
    const key = String(rawFieldKey || '');
    if (key && isOpenAiApiKey(key)) {
      this.codexChatGptSession = null;
      await clearCodexChatGptAuth();
    }
  }

  this.currentConfig = 'default';
  this.configs = { default: normalizeConfig(payload, this.getDefaultSystemPrompt()) };

  await writeSettings(payload);
  this.notifyOnComplete = payload.notifyOnComplete === true;
  this.updateContextUsage?.();
  if (!silent) {
    this.updateStatus('Configurações salvas com sucesso', 'success');
  }
};

const PERMISSION_CHECKBOXES: Array<{ key: string; element: string }> = [
  { key: 'read', element: 'permRead' },
  { key: 'interact', element: 'permInteract' },
  { key: 'navigate', element: 'permNavigate' },
  { key: 'tabs', element: 'permTabs' },
  { key: 'screenshots', element: 'permScreenshots' },
  { key: 'sensitiveDataRead', element: 'permSensitiveDataRead' },
  { key: 'clipboard', element: 'permClipboard' },
  { key: 'fileUpload', element: 'permFileUpload' },
  { key: 'downloads', element: 'permDownloads' },
  { key: 'scripting', element: 'permScripting' },
];

SidePanelUI.prototype.applyPermissionCheckboxes = function applyPermissionCheckboxes(perms: Record<string, unknown>) {
  const merged = { ...DEFAULT_TOOL_PERMISSIONS, ...perms };
  for (const item of PERMISSION_CHECKBOXES) {
    const input = this.elements[item.element] as HTMLInputElement | null;
    if (input) input.checked = merged[item.key] === true;
  }
};

SidePanelUI.prototype.collectPermissionCheckboxes = function collectPermissionCheckboxes(
  perms: Record<string, unknown>,
) {
  for (const item of PERMISSION_CHECKBOXES) {
    const input = this.elements[item.element] as HTMLInputElement | null;
    if (input) perms[item.key] = input.checked === true;
  }
};

SidePanelUI.prototype.syncHistoryPersistenceSegments = function syncHistoryPersistenceSegments() {
  const group = this.elements.historyPersistenceSegmented as HTMLElement | null;
  if (!group) return;
  const mode = this.historyPersistence || 'redacted';
  const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('[data-history-persistence]'));
  for (const button of buttons) {
    const selected = button.dataset.historyPersistence === mode;
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  }
};

SidePanelUI.prototype.bindHistoryPersistenceControl = function bindHistoryPersistenceControl() {
  const group = this.elements.historyPersistenceSegmented as HTMLElement | null;
  if (!group || group.dataset.bound === 'true') return;
  group.dataset.bound = 'true';
  group.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-history-persistence]');
    if (!button) return;
    this.historyPersistence = resolveHistoryPersistenceMode(button.dataset.historyPersistence);
    this.syncHistoryPersistenceSegments();
  });
};

SidePanelUI.prototype.getDefaultSystemPrompt = function getDefaultSystemPrompt() {
  return DEFAULT_SYSTEM_PROMPT;
};
