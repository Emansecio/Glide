import { SidePanelUI } from './panel-ui.js';

const DEFAULT_LOCAL_API_ENDPOINT = 'http://localhost:11434';
const DEFAULT_KIMI_API_ENDPOINT = 'https://api.kimi.com/coding';
const LEGACY_PROFILE_KEYS = ['configs', 'activeConfig', 'auxAgentProfiles', 'visionProfile', 'orchestratorProfile', 'temperature'];

type PanelConfig = {
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint: string;
  systemPrompt: string;
  maxTokens: number;
  contextLimit: number;
  timeout: number;
  enableScreenshots: boolean;
  sendScreenshotsAsImages: boolean;
  screenshotQuality: 'high' | 'low' | string;
  showThinking: boolean;
  streamResponses: boolean;
  autoScroll: boolean;
  confirmActions: boolean;
  saveHistory: boolean;
  autoRecoveryMode: string;
  screenshotOnFailure: boolean;
  screenshotRetention: string;
  qualityMode: 'max' | 'balanced' | 'speed' | string;
  autoTuneSafety: boolean;
  minimumReportSections: number;
};

const parseSelectBoolean = (element: HTMLSelectElement | null | undefined, fallback: boolean) => {
  if (!element) return fallback;
  const raw = String(element.value || '').toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

const normalizeEndpointForProvider = (provider: string, endpoint: string) => {
  const normalizedProvider = String(provider || 'openai').toLowerCase();
  const normalizedEndpoint = String(endpoint || '').trim();
  if (normalizedProvider === 'ollama') return normalizedEndpoint || DEFAULT_LOCAL_API_ENDPOINT;
  if (normalizedProvider === 'kimi') return normalizedEndpoint || DEFAULT_KIMI_API_ENDPOINT;
  if (normalizedProvider === 'custom') return normalizedEndpoint;
  return '';
};

const normalizeConfig = (raw: Record<string, any> = {}, fallbackPrompt = ''): PanelConfig => {
  const provider = String(raw.provider || 'openai').toLowerCase();
  const systemPrompt = String(raw.systemPrompt || fallbackPrompt || '');
  return {
    provider,
    apiKey: String(raw.apiKey || ''),
    model: String(raw.model || ''),
    customEndpoint: normalizeEndpointForProvider(provider, String(raw.customEndpoint || '')),
    systemPrompt,
    maxTokens: clampNumber(raw.maxTokens, 4096, 256, 64000),
    contextLimit: clampNumber(raw.contextLimit, 200000, 4000, 2000000),
    timeout: clampNumber(raw.timeout, 90000, 5000, 600000),
    enableScreenshots: raw.enableScreenshots !== false,
    sendScreenshotsAsImages: raw.sendScreenshotsAsImages === true,
    screenshotQuality: String(raw.screenshotQuality || 'high'),
    showThinking: raw.showThinking !== false,
    streamResponses: raw.streamResponses !== false,
    autoScroll: raw.autoScroll !== false,
    confirmActions: raw.confirmActions !== false,
    saveHistory: raw.saveHistory !== false,
    autoRecoveryMode: String(raw.autoRecoveryMode || 'balanced'),
    screenshotOnFailure: raw.screenshotOnFailure !== false,
    screenshotRetention: String(raw.screenshotRetention || 'ephemeral'),
    qualityMode: String(raw.qualityMode || 'max'),
    autoTuneSafety: raw.autoTuneSafety !== false,
    minimumReportSections: clampNumber(raw.minimumReportSections, 5, 3, 8),
  };
};

const pickLegacyProfile = (settings: Record<string, any>) => {
  const configs = settings?.configs && typeof settings.configs === 'object' ? settings.configs : null;
  if (!configs) return null;
  const activeName = String(settings.activeConfig || 'default');
  const fromActive = configs[activeName];
  if (fromActive && typeof fromActive === 'object') return fromActive as Record<string, any>;
  const fromDefault = configs.default;
  if (fromDefault && typeof fromDefault === 'object') return fromDefault as Record<string, any>;
  const firstProfile = Object.values(configs).find((entry) => entry && typeof entry === 'object');
  return firstProfile && typeof firstProfile === 'object' ? (firstProfile as Record<string, any>) : null;
};

const hasLegacyProfileState = (settings: Record<string, any>) => {
  return LEGACY_PROFILE_KEYS.some((key) => settings[key] !== undefined);
};

const buildSingleConfigFromSettings = (settings: Record<string, any>, fallbackPrompt: string) => {
  const legacy = pickLegacyProfile(settings) || {};
  const topLevelConfig = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    model: settings.model,
    customEndpoint: settings.customEndpoint,
    systemPrompt: settings.systemPrompt,
    maxTokens: settings.maxTokens,
    contextLimit: settings.contextLimit,
    timeout: settings.timeout,
    enableScreenshots: settings.enableScreenshots,
    sendScreenshotsAsImages: settings.sendScreenshotsAsImages,
    screenshotQuality: settings.screenshotQuality,
    showThinking: settings.showThinking,
    streamResponses: settings.streamResponses,
    autoScroll: settings.autoScroll,
    confirmActions: settings.confirmActions,
    saveHistory: settings.saveHistory,
    autoRecoveryMode: settings.autoRecoveryMode,
    screenshotOnFailure: settings.screenshotOnFailure,
    screenshotRetention: settings.screenshotRetention,
    qualityMode: settings.qualityMode,
    autoTuneSafety: settings.autoTuneSafety,
    minimumReportSections: settings.minimumReportSections,
  };
  return normalizeConfig({ ...legacy, ...topLevelConfig }, fallbackPrompt);
};

const defaultToolPermissions = () => ({
  read: true,
  interact: true,
  navigate: true,
  tabs: true,
  screenshots: true,
});

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
  this.switchSettingsTab('general');
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

  if (previousProvider && previousProvider !== provider) {
    if (this.elements.model) this.elements.model.value = '';
    if (this.elements.modelSelect) this.elements.modelSelect.value = '';
    this.syncModelTrigger();
  }

  if (this.elements.provider) {
    this.elements.provider.dataset.previousProvider = provider;
  }

  if (this.elements.customEndpointGroup) {
    this.elements.customEndpointGroup.classList.toggle('required', requiresEndpoint);
    this.elements.customEndpointGroup.classList.toggle('hidden', !requiresEndpoint);

    const optionalBadge = this.elements.customEndpointGroup.querySelector('.optional-badge');
    if (optionalBadge) {
      optionalBadge.classList.toggle('hidden', provider === 'custom');
    }
  }

  if (this.elements.customEndpoint) {
    if (provider === 'ollama') {
      const currentValue = this.elements.customEndpoint.value;
      const isOtherProviderUrl = currentValue && (currentValue.includes('openrouter') || currentValue.includes('kimi.com'));
      if (!currentValue || isOtherProviderUrl) {
        this.elements.customEndpoint.value = DEFAULT_LOCAL_API_ENDPOINT;
      }
      this.elements.customEndpoint.placeholder = DEFAULT_LOCAL_API_ENDPOINT;
    } else if (provider === 'kimi') {
      const currentValue = this.elements.customEndpoint.value;
      const isOtherProviderUrl = currentValue && (currentValue.includes('openrouter') || currentValue === DEFAULT_LOCAL_API_ENDPOINT);
      if (!currentValue || isOtherProviderUrl) {
        this.elements.customEndpoint.value = DEFAULT_KIMI_API_ENDPOINT;
      }
      this.elements.customEndpoint.placeholder = DEFAULT_KIMI_API_ENDPOINT;
    } else if (requiresEndpoint) {
      const currentValue = this.elements.customEndpoint.value;
      const isKnownProviderUrl = currentValue && (currentValue === DEFAULT_LOCAL_API_ENDPOINT || currentValue.includes('kimi.com'));
      if (isKnownProviderUrl) {
        this.elements.customEndpoint.value = '';
      }
      this.elements.customEndpoint.placeholder = 'https://openrouter.ai/api/v1';
    } else {
      this.elements.customEndpoint.value = '';
      this.elements.customEndpoint.placeholder = '';
    }
  }

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
    this.elements.customEndpoint.style.borderColor = 'var(--error)';
    return false;
  }
};

(SidePanelUI.prototype as any).switchSettingsTab = function switchSettingsTab(tabName: 'general' = 'general') {
  this.currentSettingsTab = tabName === 'general' ? 'general' : 'general';
  const general = this.elements.settingsTabGeneral;
  general?.classList.remove('hidden');
  this.elements.settingsTabGeneralBtn?.classList.add('active');
};

(SidePanelUI.prototype as any).loadSettings = async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'provider',
    'apiKey',
    'model',
    'customEndpoint',
    'systemPrompt',
    'maxTokens',
    'contextLimit',
    'timeout',
    'enableScreenshots',
    'sendScreenshotsAsImages',
    'screenshotQuality',
    'visionBridge',
    'useOrchestrator',
    'showThinking',
    'streamResponses',
    'autoScroll',
    'confirmActions',
    'saveHistory',
    'toolPermissions',
    'allowedDomains',
    'autoRecoveryMode',
    'screenshotOnFailure',
    'screenshotRetention',
    'qualityMode',
    'autoTuneSafety',
    'minimumReportSections',
    ...LEGACY_PROFILE_KEYS,
  ]);

  const fallbackPrompt = this.getDefaultSystemPrompt();
  const activeConfig = buildSingleConfigFromSettings(settings, fallbackPrompt);

  this.currentConfig = 'default';
  this.configs = { default: activeConfig };

  if (this.elements.provider) this.elements.provider.value = activeConfig.provider;
  if (this.elements.apiKey) this.elements.apiKey.value = activeConfig.apiKey;
  if (this.elements.model) this.elements.model.value = activeConfig.model;
  if (this.elements.customEndpoint) this.elements.customEndpoint.value = activeConfig.customEndpoint;
  if (this.elements.systemPrompt) this.elements.systemPrompt.value = activeConfig.systemPrompt || fallbackPrompt;
  if (this.elements.maxTokens) this.elements.maxTokens.value = String(activeConfig.maxTokens);
  if (this.elements.contextLimit) this.elements.contextLimit.value = String(activeConfig.contextLimit);
  if (this.elements.timeout) this.elements.timeout.value = String(activeConfig.timeout);
  if (this.elements.enableScreenshots) this.elements.enableScreenshots.value = activeConfig.enableScreenshots ? 'true' : 'false';
  if (this.elements.sendScreenshotsAsImages) {
    this.elements.sendScreenshotsAsImages.value = activeConfig.sendScreenshotsAsImages ? 'true' : 'false';
  }
  if (this.elements.screenshotQuality) this.elements.screenshotQuality.value = activeConfig.screenshotQuality;
  if (this.elements.visionBridge) {
    this.elements.visionBridge.value = settings.visionBridge !== undefined ? String(settings.visionBridge) : 'true';
  }
  if (this.elements.orchestratorToggle) {
    this.elements.orchestratorToggle.value = settings.useOrchestrator !== undefined ? String(settings.useOrchestrator) : 'false';
  }
  if (this.elements.showThinking) this.elements.showThinking.value = activeConfig.showThinking ? 'true' : 'false';
  if (this.elements.streamResponses) this.elements.streamResponses.value = activeConfig.streamResponses ? 'true' : 'false';
  if (this.elements.autoScroll) this.elements.autoScroll.value = activeConfig.autoScroll ? 'true' : 'false';
  if (this.elements.confirmActions) this.elements.confirmActions.value = activeConfig.confirmActions ? 'true' : 'false';
  if (this.elements.saveHistory) this.elements.saveHistory.value = activeConfig.saveHistory ? 'true' : 'false';
  if (this.elements.qualityMode) this.elements.qualityMode.value = String(activeConfig.qualityMode || 'max');
  if (this.elements.autoTuneSafety) this.elements.autoTuneSafety.value = activeConfig.autoTuneSafety ? 'true' : 'false';
  if (this.elements.minimumReportSections) {
    this.elements.minimumReportSections.value = String(activeConfig.minimumReportSections);
  }

  const toolPermissions = {
    ...defaultToolPermissions(),
    ...(settings.toolPermissions || {}),
  };
  if (this.elements.permissionRead) this.elements.permissionRead.value = String(toolPermissions.read);
  if (this.elements.permissionInteract) this.elements.permissionInteract.value = String(toolPermissions.interact);
  if (this.elements.permissionNavigate) this.elements.permissionNavigate.value = String(toolPermissions.navigate);
  if (this.elements.permissionTabs) this.elements.permissionTabs.value = String(toolPermissions.tabs);
  if (this.elements.permissionScreenshots) this.elements.permissionScreenshots.value = String(toolPermissions.screenshots);
  if (this.elements.allowedDomains) this.elements.allowedDomains.value = settings.allowedDomains || '';

  this.toggleCustomEndpoint();
  this.updateScreenshotToggleState();

  if (hasLegacyProfileState(settings)) {
    await this.persistAllSettings({ silent: true });
  }
};

(SidePanelUI.prototype as any).saveSettings = async function saveSettings() {
  if (
    (this.elements.provider?.value === 'custom' || this.elements.provider?.value === 'kimi' || this.elements.provider?.value === 'ollama') &&
    !this.validateCustomEndpoint()
  ) {
    this.updateStatus('URL da API inválida', 'error');
    return;
  }

  const profile = this.collectCurrentFormProfile();
  this.configs[this.currentConfig] = profile;
  await this.persistAllSettings();

  this.refreshAvailableModels();
  const riskyConfig =
    profile.autoTuneSafety === false &&
    profile.qualityMode === 'max' &&
    (Number(profile.timeout || 0) < 90000 || Number(profile.maxTokens || 0) < 3072);

  this.showSuccessToast('Configurações salvas com sucesso');
  this.updateStatus(
    riskyConfig
      ? 'Configuração de risco detectada: aumente timeout/tokens ou habilite auto-ajuste.'
      : 'Pronto',
    riskyConfig ? 'warning' : 'default',
  );
};

(SidePanelUI.prototype as any).exportSettings = async function exportSettings() {
  try {
    const keys = [
      'provider',
      'apiKey',
      'model',
      'customEndpoint',
      'systemPrompt',
      'maxTokens',
      'contextLimit',
      'timeout',
      'enableScreenshots',
      'sendScreenshotsAsImages',
      'screenshotQuality',
      'visionBridge',
      'useOrchestrator',
      'showThinking',
      'streamResponses',
      'autoScroll',
      'confirmActions',
      'saveHistory',
      'toolPermissions',
      'allowedDomains',
      'autoRecoveryMode',
      'screenshotOnFailure',
      'screenshotRetention',
      'qualityMode',
      'autoTuneSafety',
      'minimumReportSections',
    ];
    const settings = await chrome.storage.local.get(keys);
    const { apiKey, ...safeSettings } = settings;

    const payload = {
      ...safeSettings,
      exportedAt: new Date().toISOString(),
      exportVersion: 2,
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
  } catch {
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
    const fallbackPrompt = this.getDefaultSystemPrompt();
    const config = buildSingleConfigFromSettings(data || {}, fallbackPrompt);

    const payload = {
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      customEndpoint: config.customEndpoint,
      systemPrompt: config.systemPrompt || fallbackPrompt,
      maxTokens: config.maxTokens,
      contextLimit: config.contextLimit,
      timeout: config.timeout,
      enableScreenshots: config.enableScreenshots,
      sendScreenshotsAsImages: config.sendScreenshotsAsImages,
      screenshotQuality: config.screenshotQuality,
      visionBridge: data?.visionBridge !== undefined ? data.visionBridge !== false : true,
      useOrchestrator: data?.useOrchestrator === true,
      showThinking: config.showThinking,
      streamResponses: config.streamResponses,
      autoScroll: config.autoScroll,
      confirmActions: config.confirmActions,
      saveHistory: config.saveHistory,
      toolPermissions: {
        ...defaultToolPermissions(),
        ...(data?.toolPermissions || {}),
      },
      allowedDomains: String(data?.allowedDomains || ''),
      autoRecoveryMode: config.autoRecoveryMode,
      screenshotOnFailure: config.screenshotOnFailure,
      screenshotRetention: config.screenshotRetention,
      qualityMode: config.qualityMode,
      autoTuneSafety: config.autoTuneSafety,
      minimumReportSections: config.minimumReportSections,
    };

    await chrome.storage.local.set(payload);
    await chrome.storage.local.remove(LEGACY_PROFILE_KEYS);
    await this.loadSettings();
    this.showSuccessToast('Configurações importadas com sucesso');
  } catch {
    this.updateStatus('Não foi possível importar configurações', 'error');
  } finally {
    if (input) input.value = '';
  }
};

(SidePanelUI.prototype as any).collectCurrentFormProfile = function collectCurrentFormProfile() {
  const current = normalizeConfig(this.configs[this.currentConfig] || {}, this.getDefaultSystemPrompt());
  const provider = String(this.elements.provider?.value || current.provider || 'openai').toLowerCase();
  const endpointInput = this.elements.customEndpoint?.value?.trim() || '';
  const fallbackEndpoint = String(current.customEndpoint || '').trim();

  let customEndpoint = '';
  if (provider === 'ollama') {
    customEndpoint = endpointInput || fallbackEndpoint || DEFAULT_LOCAL_API_ENDPOINT;
  } else if (provider === 'kimi') {
    customEndpoint = endpointInput || fallbackEndpoint || DEFAULT_KIMI_API_ENDPOINT;
  } else if (provider === 'custom') {
    customEndpoint = endpointInput;
  }

  return normalizeConfig(
    {
      ...current,
      provider,
      apiKey: this.elements.apiKey?.value || current.apiKey || '',
      model: this.elements.model?.value || current.model || '',
      customEndpoint,
      systemPrompt: this.elements.systemPrompt?.value || current.systemPrompt || this.getDefaultSystemPrompt(),
      maxTokens: Number.parseInt(this.elements.maxTokens?.value) || current.maxTokens || 4096,
      contextLimit: Number.parseInt(this.elements.contextLimit?.value) || current.contextLimit || 200000,
      timeout: Number.parseInt(this.elements.timeout?.value) || current.timeout || 90000,
      enableScreenshots: parseSelectBoolean(this.elements.enableScreenshots, current.enableScreenshots !== false),
      sendScreenshotsAsImages: parseSelectBoolean(
        this.elements.sendScreenshotsAsImages,
        current.sendScreenshotsAsImages === true,
      ),
      screenshotQuality: this.elements.screenshotQuality?.value || current.screenshotQuality || 'high',
      showThinking: this.elements.showThinking?.value === 'true',
      streamResponses: this.elements.streamResponses?.value === 'true',
      autoScroll: this.elements.autoScroll?.value === 'true',
      confirmActions: this.elements.confirmActions?.value === 'true',
      saveHistory: this.elements.saveHistory?.value === 'true',
      qualityMode: this.elements.qualityMode?.value || current.qualityMode || 'max',
      autoTuneSafety: parseSelectBoolean(this.elements.autoTuneSafety, current.autoTuneSafety !== false),
      minimumReportSections: Number.parseInt(this.elements.minimumReportSections?.value || '') || current.minimumReportSections || 5,
    },
    this.getDefaultSystemPrompt(),
  );
};

(SidePanelUI.prototype as any).collectToolPermissions = function collectToolPermissions() {
  return {
    read: this.elements.permissionRead?.value !== 'false',
    interact: this.elements.permissionInteract?.value !== 'false',
    navigate: this.elements.permissionNavigate?.value !== 'false',
    tabs: this.elements.permissionTabs?.value !== 'false',
    screenshots: this.elements.permissionScreenshots
      ? this.elements.permissionScreenshots.value !== 'false'
      : true,
  };
};

(SidePanelUI.prototype as any).persistAllSettings = async function persistAllSettings({ silent = false } = {}) {
  const activeProfile = this.collectCurrentFormProfile();
  const payload = {
    provider: activeProfile.provider || 'openai',
    apiKey: activeProfile.apiKey || '',
    model: activeProfile.model || '',
    customEndpoint: normalizeEndpointForProvider(activeProfile.provider || 'openai', activeProfile.customEndpoint || ''),
    systemPrompt: activeProfile.systemPrompt || this.getDefaultSystemPrompt(),
    maxTokens: activeProfile.maxTokens || 4096,
    contextLimit: activeProfile.contextLimit || 200000,
    timeout: activeProfile.timeout || 90000,
    enableScreenshots: activeProfile.enableScreenshots ?? true,
    sendScreenshotsAsImages: activeProfile.sendScreenshotsAsImages ?? false,
    screenshotQuality: activeProfile.screenshotQuality || 'high',
    showThinking: activeProfile.showThinking !== false,
    streamResponses: activeProfile.streamResponses !== false,
    autoScroll: activeProfile.autoScroll !== false,
    confirmActions: activeProfile.confirmActions !== false,
    saveHistory: activeProfile.saveHistory !== false,
    autoRecoveryMode: activeProfile.autoRecoveryMode || 'balanced',
    screenshotOnFailure: activeProfile.screenshotOnFailure !== false,
    screenshotRetention: activeProfile.screenshotRetention || 'ephemeral',
    qualityMode: activeProfile.qualityMode || 'max',
    autoTuneSafety: activeProfile.autoTuneSafety !== false,
    minimumReportSections: clampNumber(activeProfile.minimumReportSections, 5, 3, 8),
    visionBridge: this.elements.visionBridge?.value === 'true',
    useOrchestrator: this.elements.orchestratorToggle?.value === 'true',
    toolPermissions: this.collectToolPermissions(),
    allowedDomains: this.elements.allowedDomains?.value || '',
  };

  this.currentConfig = 'default';
  this.configs = { default: normalizeConfig(payload, this.getDefaultSystemPrompt()) };

  await chrome.storage.local.set(payload);
  await chrome.storage.local.remove(LEGACY_PROFILE_KEYS);
  this.updateContextUsage();
  if (!silent) {
    this.updateStatus('Configurações salvas com sucesso', 'success');
  }
};

(SidePanelUI.prototype as any).updateScreenshotToggleState = function updateScreenshotToggleState() {
  if (!this.elements.enableScreenshots) return;
  const wantsScreens = this.elements.enableScreenshots.value === 'true';
  const controls = [this.elements.sendScreenshotsAsImages, this.elements.screenshotQuality];
  controls.forEach((ctrl) => {
    if (!ctrl) return;
    ctrl.disabled = !wantsScreens;
    ctrl.parentElement?.classList.toggle('disabled', !wantsScreens);
  });
};

(SidePanelUI.prototype as any).getDefaultSystemPrompt = function getDefaultSystemPrompt() {
  return `You are Glide, a browser automation agent. You execute tasks by calling tools in a strict sequence.

<rules priority="CRITICAL">
1. NO PLAN = NO ACTION - Your FIRST tool call MUST be set_plan.
2. ACTION -> VERIFY -> MARK - Every action MUST be followed by getContent and update_plan.
3. SEQUENTIAL EXECUTION - Complete step N before starting step N+1.
4. EVIDENCE ONLY - Only claim to see content fetched with getContent.
5. FAILURE RECOVERY - If an action fails or page state is ambiguous, call screenshot() before finalizing.
6. RESILIENCE - Use getContent({ mode: "structure" }) and retry with alternative selectors when actions fail.
7. NO EARLY FINALIZATION - Do not finalize while any plan step is pending.
8. REPORT DEPTH - Final answer must include sections for sidebar/navigation, workspace/cards, detected functions, and evidence.
</rules>

Use the available browser tools to complete user tasks efficiently.`;
};
