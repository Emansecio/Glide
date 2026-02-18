import { SidePanelUI } from './panel-ui.js';

const DEFAULT_LOCAL_API_ENDPOINT = 'http://localhost:11434';

(SidePanelUI.prototype as any).toggleSettings = async function toggleSettings(saveOnClose = true) {
  const isOpen = this.elements.settingsPanel ? !this.elements.settingsPanel.classList.contains('hidden') : false;
  if (isOpen) {
    if (saveOnClose) {
      this.configs[this.currentConfig] = this.collectCurrentFormProfile();
      await this.persistAllSettings({ silent: true });
    }
    this.settingsOpen = false;
    this.showRightPanel(null);
    this.setNavActive('chat');
    return;
  }
  this.settingsOpen = true;
  this.openSidebar();
  this.showRightPanel('settings');
  this.switchSettingsTab(this.currentSettingsTab || 'general');
  this.setNavActive('settings');
};

(SidePanelUI.prototype as any).cancelSettings = async function cancelSettings() {
  await this.loadSettings();
  await this.toggleSettings(false);
};

(SidePanelUI.prototype as any).toggleCustomEndpoint = function toggleCustomEndpoint() {
  const provider = this.elements.provider?.value;
  const previousProvider = this.elements.provider?.dataset?.previousProvider || '';
  const requiresEndpoint = provider === 'custom' || provider === 'kimi' || provider === 'ollama';

  // Limpar modelo quando trocar de provider
  if (previousProvider && previousProvider !== provider) {
    if (this.elements.model) {
      this.elements.model.value = '';
    }
    if (this.elements.modelSelect) {
      this.elements.modelSelect.value = '';
    }
    this.syncModelTrigger();
  }

  // Salvar provider atual para proxima comparacao
  if (this.elements.provider) {
    this.elements.provider.dataset.previousProvider = provider;
  }

  // Always show the endpoint field, but highlight when required
  if (this.elements.customEndpointGroup) {
    // Add visual emphasis when custom provider selected
    this.elements.customEndpointGroup.classList.toggle('required', requiresEndpoint);
  }

  // Update placeholder and value based on provider
  if (this.elements.customEndpoint) {
    if (provider === 'ollama') {
      // Só preencher se estiver vazio ou tiver valor de outro provider
      const currentValue = this.elements.customEndpoint.value;
      const isOtherProviderUrl = currentValue &&
        (currentValue.includes('openrouter') || currentValue.includes('kimi.com'));
      if (!currentValue || isOtherProviderUrl) {
        this.elements.customEndpoint.value = DEFAULT_LOCAL_API_ENDPOINT;
      }
      this.elements.customEndpoint.placeholder = DEFAULT_LOCAL_API_ENDPOINT;
    } else if (provider === 'kimi') {
      const currentValue = this.elements.customEndpoint.value;
      const isOtherProviderUrl = currentValue &&
        (currentValue.includes('openrouter') || currentValue === DEFAULT_LOCAL_API_ENDPOINT);
      if (!currentValue || isOtherProviderUrl) {
        this.elements.customEndpoint.value = 'https://api.kimi.com/coding';
      }
      this.elements.customEndpoint.placeholder = 'https://api.kimi.com/coding';
    } else if (requiresEndpoint) {
      // Para provider custom, limpar o valor se for de outro provider conhecido
      const currentValue = this.elements.customEndpoint.value;
      const isKnownProviderUrl = currentValue &&
        (currentValue === DEFAULT_LOCAL_API_ENDPOINT || currentValue.includes('kimi.com'));
      if (isKnownProviderUrl) {
        this.elements.customEndpoint.value = '';
      }
      this.elements.customEndpoint.placeholder = 'https://openrouter.ai/api/v1';
    } else {
      // Providers que nao precisam de endpoint (anthropic, openai, google) - limpar campo
      this.elements.customEndpoint.value = '';
      this.elements.customEndpoint.placeholder = '';
    }
  }

  // Update model hint based on provider
  const modelHint = document.getElementById('modelHint');
  if (modelHint) {
    switch (provider) {
      case 'anthropic':
        modelHint.textContent = 'Recomendado: claude-sonnet-4-20250514';
        break;
      case 'openai':
        modelHint.textContent = 'Recomendado: gpt-4o ou gpt-4-turbo';
        break;
      case 'google':
        modelHint.textContent = 'Recomendado: gemini-2.0-flash ou gemini-1.5-pro';
        break;
      case 'ollama':
        modelHint.textContent = 'Recomendado: qwen3, llama3.1, mistral, deepseek-r1';
        break;
      case 'kimi':
        modelHint.textContent = 'Recomendado: kimi-for-coding (ou seu ID de modelo Kimi)';
        break;
      case 'custom':
        modelHint.textContent = 'Informe o ID de modelo do seu provedor';
        break;
      default:
        modelHint.textContent = '';
    }
  }
};

(SidePanelUI.prototype as any).validateCustomEndpoint = function validateCustomEndpoint() {
  if (!this.elements.customEndpoint) return true;
  const url = this.elements.customEndpoint.value.trim();
  if (!url) return true;
  try {
    new URL(url);
    this.elements.customEndpoint.style.borderColor = '';
    return true;
  } catch {
    this.elements.customEndpoint.style.borderColor = 'var(--status-error)';
    return false;
  }
};

(SidePanelUI.prototype as any).toggleProfileEditorEndpoint = function toggleProfileEditorEndpoint() {
  if (!this.elements.profileEditorEndpointGroup) return;
  const provider = this.elements.profileEditorProvider?.value;
  this.elements.profileEditorEndpointGroup.style.display = provider === 'custom' || provider === 'kimi' ? 'block' : 'none';
};

(SidePanelUI.prototype as any).switchSettingsTab = function switchSettingsTab(
  tabName: 'general' | 'profiles' = 'general',
) {
  if (this.currentSettingsTab === 'general' && tabName === 'profiles') {
    this.configs[this.currentConfig] = this.collectCurrentFormProfile();
    void this.persistAllSettings({ silent: true });
  }
  this.currentSettingsTab = tabName;
  const general = this.elements.settingsTabGeneral;
  const profiles = this.elements.settingsTabProfiles;
  general?.classList.toggle('hidden', tabName !== 'general');
  profiles?.classList.toggle('hidden', tabName !== 'profiles');
  this.elements.settingsTabGeneralBtn?.classList.toggle('active', tabName === 'general');
  this.elements.settingsTabProfilesBtn?.classList.toggle('active', tabName === 'profiles');
};

(SidePanelUI.prototype as any).createProfileFromInput = function createProfileFromInput() {
  const name = (this.elements.newProfileNameInput?.value || '').trim();
  if (!name) {
    this.updateStatus('Enter a profile name first', 'warning');
    return;
  }
  if (this.configs[name]) {
    this.updateStatus('Profile already exists', 'warning');
    return;
  }
  if (this.elements.newProfileNameInput) this.elements.newProfileNameInput.value = '';
  this.createNewConfig(name);
  this.editProfile(name, true);
};

(SidePanelUI.prototype as any).loadSettings = async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'visionBridge',
    'visionProfile',
    'useOrchestrator',
    'orchestratorProfile',
    'showThinking',
    'streamResponses',
    'autoScroll',
    'confirmActions',
    'saveHistory',
    'toolPermissions',
    'allowedDomains',
    'activeConfig',
    'configs',
    'auxAgentProfiles',
  ]);

  const storedConfigs = settings.configs || {};
  const baseConfig = {
    provider: 'openai',
    apiKey: '',
    model: 'gpt-4o',
    customEndpoint: DEFAULT_LOCAL_API_ENDPOINT,
    systemPrompt: this.getDefaultSystemPrompt(),
    temperature: 0.7,
    maxTokens: 4096,
    contextLimit: 200000,
    timeout: 30000,
    sendScreenshotsAsImages: false,
    screenshotQuality: 'high',
    showThinking: true,
    streamResponses: true,
    autoScroll: true,
    confirmActions: true,
    saveHistory: true,
    enableScreenshots: false,
  };

  this.configs = {
    default: { ...baseConfig, ...(storedConfigs.default || {}) },
    ...storedConfigs,
  };
  if (!this.configs.default.customEndpoint) {
    this.configs.default.customEndpoint = DEFAULT_LOCAL_API_ENDPOINT;
  }
  this.currentConfig = this.configs[settings.activeConfig] ? settings.activeConfig : 'default';
  this.auxAgentProfiles = settings.auxAgentProfiles || [];

  if (this.elements.visionBridge)
    this.elements.visionBridge.value = settings.visionBridge !== undefined ? String(settings.visionBridge) : 'true';
  if (this.elements.visionProfile) this.elements.visionProfile.value = settings.visionProfile || '';
  if (this.elements.orchestratorToggle)
    this.elements.orchestratorToggle.value =
      settings.useOrchestrator !== undefined ? String(settings.useOrchestrator) : 'false';
  if (this.elements.orchestratorProfile) this.elements.orchestratorProfile.value = settings.orchestratorProfile || '';
  if (this.elements.showThinking)
    this.elements.showThinking.value = settings.showThinking !== undefined ? String(settings.showThinking) : 'true';
  if (this.elements.streamResponses)
    this.elements.streamResponses.value =
      settings.streamResponses !== undefined ? String(settings.streamResponses) : 'true';
  if (this.elements.autoScroll)
    this.elements.autoScroll.value = settings.autoScroll !== undefined ? String(settings.autoScroll) : 'true';
  if (this.elements.confirmActions)
    this.elements.confirmActions.value =
      settings.confirmActions !== undefined ? String(settings.confirmActions) : 'true';
  if (this.elements.saveHistory)
    this.elements.saveHistory.value = settings.saveHistory !== undefined ? String(settings.saveHistory) : 'true';

  const defaultPermissions = {
    read: true,
    interact: true,
    navigate: true,
    tabs: true,
    screenshots: false,
  };
  const toolPermissions = {
    ...defaultPermissions,
    ...(settings.toolPermissions || {}),
  };
  if (this.elements.permissionRead) this.elements.permissionRead.value = String(toolPermissions.read);
  if (this.elements.permissionInteract) this.elements.permissionInteract.value = String(toolPermissions.interact);
  if (this.elements.permissionNavigate) this.elements.permissionNavigate.value = String(toolPermissions.navigate);
  if (this.elements.permissionTabs) this.elements.permissionTabs.value = String(toolPermissions.tabs);
  if (this.elements.permissionScreenshots)
    this.elements.permissionScreenshots.value = String(toolPermissions.screenshots);
  if (this.elements.allowedDomains) this.elements.allowedDomains.value = settings.allowedDomains || '';

  this.refreshConfigDropdown();
  this.setActiveConfig(this.currentConfig, true);
  this.toggleCustomEndpoint();
  this.updateScreenshotToggleState();
  this.editProfile(this.currentConfig, true);
};

(SidePanelUI.prototype as any).saveSettings = async function saveSettings() {
  if (
    (this.elements.provider?.value === 'custom' ||
      this.elements.provider?.value === 'kimi' ||
      this.elements.provider?.value === 'ollama') &&
    !this.validateCustomEndpoint()
  ) {
    this.updateStatus('URL da API inválida', 'error');
    return;
  }
  this.configs[this.currentConfig] = this.collectCurrentFormProfile();
  await this.persistAllSettings();

  // Refresh models after saving settings
  this.refreshAvailableModels();

  this.showSuccessToast('Configurações salvas com sucesso');
  this.updateStatus('Pronto', 'default');
};

(SidePanelUI.prototype as any).exportSettings = async function exportSettings() {
  try {
    const keys = [
      'configs',
      'activeConfig',
      'auxAgentProfiles',
      'visionBridge',
      'visionProfile',
      'useOrchestrator',
      'orchestratorProfile',
      'showThinking',
      'streamResponses',
      'autoScroll',
      'confirmActions',
      'saveHistory',
      'toolPermissions',
      'allowedDomains',
    ];
    const settings = await chrome.storage.local.get(keys);

    // Strip apiKey from every profile to prevent credential leakage
    const sanitizedConfigs: Record<string, any> = {};
    if (settings.configs && typeof settings.configs === 'object') {
      for (const [name, profile] of Object.entries(settings.configs)) {
        const { apiKey, ...safeProfile } = profile as Record<string, any>;
        sanitizedConfigs[name] = safeProfile;
      }
    }

    const payload = {
      ...settings,
      configs: sanitizedConfigs,
      exportedAt: new Date().toISOString(),
      exportVersion: 1,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `Glide-settings-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.showSuccessToast('Configurações exportadas');
  } catch (error) {
    this.updateStatus('Não foi possível exportar configurações', 'error');
  }
};

(SidePanelUI.prototype as any).importSettings = async function importSettings(event: Event) {
  const input = event?.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const payload: Record<string, any> = {};
    const allowedKeys = [
      'configs',
      'activeConfig',
      'auxAgentProfiles',
      'visionBridge',
      'visionProfile',
      'useOrchestrator',
      'orchestratorProfile',
      'showThinking',
      'streamResponses',
      'autoScroll',
      'confirmActions',
      'saveHistory',
      'toolPermissions',
      'allowedDomains',
    ];
    allowedKeys.forEach((key) => {
      if (data[key] !== undefined) {
        payload[key] = data[key];
      }
    });
    if (payload.configs && typeof payload.configs !== 'object') {
      throw new Error('Invalid configs payload');
    }
    await chrome.storage.local.set(payload);
    await this.loadSettings();
    this.renderProfileGrid();
    this.showSuccessToast('Configurações importadas com sucesso');
  } catch (error) {
    this.updateStatus('Não foi possível importar configurações', 'error');
  } finally {
    if (input) input.value = '';
  }
};

(SidePanelUI.prototype as any).collectCurrentFormProfile = function collectCurrentFormProfile() {
  const current = this.configs[this.currentConfig] || {};
  return {
    provider: this.elements.provider?.value || current.provider || 'openai',
    apiKey: this.elements.apiKey?.value || current.apiKey || '',
    model: this.elements.model?.value || current.model || 'gpt-4o',
    customEndpoint: this.elements.customEndpoint?.value || current.customEndpoint || DEFAULT_LOCAL_API_ENDPOINT,
    systemPrompt: this.elements.systemPrompt?.value || current.systemPrompt || '',
    temperature: Number.parseFloat(this.elements.temperature?.value) || current.temperature || 0.7,
    maxTokens: Number.parseInt(this.elements.maxTokens?.value) || current.maxTokens || 4096,
    contextLimit: Number.parseInt(this.elements.contextLimit?.value) || current.contextLimit || 200000,
    timeout: Number.parseInt(this.elements.timeout?.value) || current.timeout || 30000,
    enableScreenshots: this.elements.enableScreenshots?.value === 'true' || current.enableScreenshots || false,
    sendScreenshotsAsImages:
      this.elements.sendScreenshotsAsImages?.value === 'true' || current.sendScreenshotsAsImages || false,
    screenshotQuality: this.elements.screenshotQuality?.value || current.screenshotQuality || 'high',
    showThinking: this.elements.showThinking?.value === 'true',
    streamResponses: this.elements.streamResponses?.value === 'true',
    autoScroll: this.elements.autoScroll?.value === 'true',
    confirmActions: this.elements.confirmActions?.value === 'true',
    saveHistory: this.elements.saveHistory?.value === 'true',
  };
};

(SidePanelUI.prototype as any).collectToolPermissions = function collectToolPermissions() {
  return {
    read: this.elements.permissionRead?.value !== 'false',
    interact: this.elements.permissionInteract?.value !== 'false',
    navigate: this.elements.permissionNavigate?.value !== 'false',
    tabs: this.elements.permissionTabs?.value !== 'false',
    screenshots: this.elements.permissionScreenshots?.value === 'true',
  };
};

(SidePanelUI.prototype as any).persistAllSettings = async function persistAllSettings({ silent = false } = {}) {
  const activeProfile = this.configs[this.currentConfig] || {};
  const payload = {
    provider: activeProfile.provider || 'openai',
    apiKey: activeProfile.apiKey || '',
    model: activeProfile.model || 'gpt-4o',
    customEndpoint: activeProfile.customEndpoint || '',
    systemPrompt: activeProfile.systemPrompt || this.getDefaultSystemPrompt(),
    temperature: activeProfile.temperature ?? 0.7,
    maxTokens: activeProfile.maxTokens || 4096,
    contextLimit: activeProfile.contextLimit || 200000,
    timeout: activeProfile.timeout || 30000,
    enableScreenshots: activeProfile.enableScreenshots ?? false,
    sendScreenshotsAsImages: activeProfile.sendScreenshotsAsImages ?? false,
    screenshotQuality: activeProfile.screenshotQuality || 'high',
    showThinking: activeProfile.showThinking !== false,
    streamResponses: activeProfile.streamResponses !== false,
    autoScroll: activeProfile.autoScroll !== false,
    confirmActions: activeProfile.confirmActions !== false,
    saveHistory: activeProfile.saveHistory !== false,
    visionBridge: this.elements.visionBridge?.value === 'true',
    visionProfile: this.elements.visionProfile?.value || '',
    useOrchestrator: this.elements.orchestratorToggle?.value === 'true',
    orchestratorProfile: this.elements.orchestratorProfile?.value || '',
    toolPermissions: this.collectToolPermissions(),
    allowedDomains: this.elements.allowedDomains?.value || '',
    auxAgentProfiles: this.auxAgentProfiles,
    activeConfig: this.currentConfig,
    configs: this.configs,
  };
  await chrome.storage.local.set(payload);
  this.updateContextUsage();
  if (!silent) {
    this.updateStatus('Configurações salvas com sucesso', 'success');
  }
};

(SidePanelUI.prototype as any).updateScreenshotToggleState = function updateScreenshotToggleState() {
  if (!this.elements.enableScreenshots) return;
  const wantsScreens = this.elements.enableScreenshots.value === 'true';
  const visionProfile = this.elements.visionProfile?.value;
  const provider = this.elements.provider?.value;
  const hasVision = (provider && provider !== 'custom') || visionProfile;
  const controls = [this.elements.sendScreenshotsAsImages, this.elements.screenshotQuality];
  controls.forEach((ctrl) => {
    if (!ctrl) return;
    ctrl.disabled = !wantsScreens;
    ctrl.parentElement?.classList.toggle('disabled', !wantsScreens);
  });
  if (wantsScreens && !hasVision) {
    this.updateStatus('Enable a vision-capable profile before sending screenshots.', 'warning');
  }
};

(SidePanelUI.prototype as any).getDefaultSystemPrompt = function getDefaultSystemPrompt() {
  return `You are Glide, a browser automation agent. You execute tasks by calling tools in a strict sequence.

<rules priority="CRITICAL">
1. NO PLAN = NO ACTION - Your FIRST tool call MUST be set_plan.
2. ACTION → VERIFY → MARK - Every action MUST be followed by getContent and update_plan.
3. SEQUENTIAL EXECUTION - Complete step N before starting step N+1.
4. EVIDENCE ONLY - Only claim to see content fetched with getContent.
</rules>

Use the available browser tools to complete user tasks efficiently.`;
};
