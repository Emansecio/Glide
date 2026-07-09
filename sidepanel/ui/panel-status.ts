import { PROVIDER_DEFAULT_MODELS, PROVIDER_PRESET_MODELS, normalizeProviderId } from '../../ai/providers.js';
import { SidePanelUI } from './panel-ui.js';

type OllamaModelDetail = {
  name: string;
  id?: string;
  sizeLabel?: string;
  modifiedLabel?: string;
  isCloud?: boolean;
  parameterSize?: string;
  family?: string;
};

type ProviderModelsResponse = {
  success?: boolean;
  models?: string[];
  modelDetails?: OllamaModelDetail[];
  online?: boolean;
  endpoint?: string;
  summary?: string;
  latencyMs?: number;
  error?: string;
};

type DetectedModelsCache = {
  provider: string;
  models: string[];
  modelDetails: OllamaModelDetail[];
  endpoint?: string;
  summary?: string;
  online?: boolean;
};

async function requestProviderModelsFromBackground(
  provider: string,
  apiKey: string,
  customEndpoint?: string,
): Promise<ProviderModelsResponse> {
  const response = (await chrome.runtime.sendMessage({
    type: 'detect_provider_models',
    provider,
    apiKey,
    customEndpoint: customEndpoint || '',
  })) as ProviderModelsResponse | undefined;
  if (!response?.success) {
    throw new Error(response?.error || 'Falha ao detectar modelos via service worker.');
  }
  return response;
}

const PROVIDER_FAMILY_LABELS: Record<string, string> = {
  anthropic: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  ollama: 'Ollama',
};

(SidePanelUI.prototype as any).updateStatus = function updateStatus(text: string, type = 'default') {
  if (this.elements.statusText) {
    this.elements.statusText.textContent = text;
  }
  const statusDot = this.elements.statusDot || document.getElementById('statusDot');
  if (statusDot) {
    statusDot.className = 'status-dot';
    if (type === 'success') statusDot.classList.add('success');
    else if (type === 'error') statusDot.classList.add('error');
    else if (type === 'warning') statusDot.classList.add('warning');
    else if (type === 'active') statusDot.classList.add('active');
  }
  this.updateActivityState();
};

(SidePanelUI.prototype as any).updateModelDisplay = function updateModelDisplay() {
  const config = this.configs[this.currentConfig] || {};
  const modelName = config.model || '';
  if (this.elements.modelSelect) {
    this.elements.modelSelect.value = modelName;
  }
  this.syncModelTrigger();
};

(SidePanelUI.prototype as any).refreshAvailableModels = function refreshAvailableModels() {
  void this.fetchAvailableModels();
};

(SidePanelUI.prototype as any).getModelSourceContext = function getModelSourceContext() {
  const config = this.configs?.[this.currentConfig] || {};
  const provider = normalizeProviderId(config.provider);
  const apiKey = config.apiKey || '';
  const customEndpoint = String(config.customEndpoint || '').trim();
  const model = String(this.elements.model?.value || config.model || PROVIDER_DEFAULT_MODELS[provider]).trim();
  return { provider, apiKey, customEndpoint, model };
};

(SidePanelUI.prototype as any).resolveModelFamilyFromEndpoint = function resolveModelFamilyFromEndpoint(
  rawEndpoint: string,
  fallbackFamily: string,
) {
  const endpoint = String(rawEndpoint || '').toLowerCase();
  if (!endpoint) return fallbackFamily;
  if (endpoint.includes('localhost:11434') || endpoint.includes(':11434') || endpoint.includes('ollama')) {
    return 'Ollama';
  }
  if (endpoint.includes('openrouter.ai')) return 'OpenRouter';
  if (endpoint.includes('api.openai.com')) return 'OpenAI';
  if (endpoint.includes('anthropic.com')) return 'Anthropic';
  if (endpoint.includes('generativelanguage.googleapis.com') || endpoint.includes('googleapis.com')) {
    return 'Google';
  }
  if (endpoint.includes('kimi.com') || endpoint.includes('moonshot')) return 'Kimi';
  return fallbackFamily;
};

(SidePanelUI.prototype as any).resolveModelFamilyBySource = function resolveModelFamilyBySource(
  provider: string,
  _customEndpoint = '',
) {
  return PROVIDER_FAMILY_LABELS[normalizeProviderId(provider)] || 'Claude Code';
};

(SidePanelUI.prototype as any).isLikelyOllamaEndpoint = function isLikelyOllamaEndpoint(endpoint: string) {
  const value = String(endpoint || '').toLowerCase();
  return value.includes(':11434') || value.includes('ollama');
};

// Model discovery runs in the background service worker to avoid browser CORS
// limits from the side panel (OpenCode, Codex, Ollama, etc.).
(SidePanelUI.prototype as any).detectOllamaModels = async function detectOllamaModels(customEndpoint?: string) {
  const result = await requestProviderModelsFromBackground('ollama', '', customEndpoint);
  return Array.isArray(result.models) ? result.models : [];
};

(SidePanelUI.prototype as any).detectOllamaDetailed = async function detectOllamaDetailed(customEndpoint?: string) {
  return requestProviderModelsFromBackground('ollama', '', customEndpoint);
};

(SidePanelUI.prototype as any).detectOpenAiCompatibleModels = async function detectOpenAiCompatibleModels(
  provider: string,
  apiKey: string,
  customEndpoint?: string,
) {
  const result = await requestProviderModelsFromBackground(provider, apiKey, customEndpoint);
  return Array.isArray(result.models) ? result.models : [];
};

(SidePanelUI.prototype as any).applyDetectedModels = function applyDetectedModels(
  provider: string,
  response: ProviderModelsResponse,
  options: { selectFirstIfMissing?: boolean; toast?: boolean } = {},
) {
  const models = Array.isArray(response.models) ? response.models.filter(Boolean) : [];
  const modelDetails = Array.isArray(response.modelDetails) ? response.modelDetails : [];
  const cache: DetectedModelsCache = {
    provider,
    models,
    modelDetails,
    endpoint: response.endpoint,
    summary: response.summary,
    online: response.online !== false,
  };
  this._detectedModels = cache;

  if (!models.length) return cache;

  const family = PROVIDER_FAMILY_LABELS[provider] || provider;
  const current = String(this.elements.model?.value || this.configs?.[this.currentConfig]?.model || '').trim();
  const activeModel =
    current && models.includes(current)
      ? current
      : options.selectFirstIfMissing !== false
        ? models[0]
        : current || models[0];

  if (this.elements.model) this.elements.model.value = activeModel;
  if (this.configs?.[this.currentConfig]) {
    this.configs[this.currentConfig].model = activeModel;
  }
  this.populateModelSelect(models, activeModel, family, modelDetails);

  if (options.toast) {
    const cloudCount = modelDetails.filter((m) => m.isCloud).length;
    const cloudNote = cloudCount ? ` · ${cloudCount} cloud` : '';
    this.showSuccessToast?.(
      response.summary ||
        `${models.length} modelo${models.length === 1 ? '' : 's'} detectado${models.length === 1 ? '' : 's'} (${family})${cloudNote}`,
    );
  }
  return cache;
};

// Botão "Detectar modelos disponíveis" nas configurações.
(SidePanelUI.prototype as any).detectProviderModels = async function detectProviderModels() {
  const provider = this.getSelectedProvider?.() || 'ollama';
  const apiKey = String(this.elements.apiKey?.value || '');
  const customEndpoint = String(this.elements.customEndpoint?.value || '').trim();
  const button = document.getElementById('detectModelsBtn') as HTMLButtonElement | null;
  const setBtnLabel = (text: string) => {
    const label = button?.querySelector('.btn-label') as HTMLElement | null;
    if (label) label.textContent = text;
    else if (button) button.textContent = text;
  };
  if (button) {
    button.disabled = true;
    setBtnLabel('Detectando…');
  }

  try {
    const response = await requestProviderModelsFromBackground(provider, apiKey, customEndpoint);
    const models = Array.isArray(response.models) ? response.models : [];
    if (!models.length) {
      this.showErrorBanner?.(
        provider === 'ollama'
          ? 'Ollama online, mas nenhum modelo listado. Rode: ollama pull <nome> (ou ollama list).'
          : 'Nenhum modelo encontrado neste endpoint.',
      );
      return;
    }
    this.applyDetectedModels(provider, response, { toast: true });
  } catch (error: any) {
    console.warn('[Glide] Falha ao detectar modelos:', error);
    const hint =
      provider === 'ollama'
        ? ' Confira se o Ollama está rodando (`ollama serve` / bandeja) e se `ollama list` mostra modelos.'
        : ' Verifique a chave de API e o endpoint.';
    this.showErrorBanner?.(`Falha ao detectar modelos.${hint}`);
  } finally {
    if (button) {
      button.disabled = false;
      setBtnLabel('Detectar modelos disponíveis');
    }
  }
};

/**
 * Startup / refresh path: fill the model picker for the *currently selected* provider.
 * Ollama is probed only when provider is Ollama — never force-switch away from
 * anthropic/codex/opencode (that snapped the settings dropdown back to Ollama).
 */
(SidePanelUI.prototype as any).fetchAvailableModels = async function fetchAvailableModels() {
  const config = this.configs[this.currentConfig] || {};
  // Prefer the live <select> value so a just-changed provider is not overwritten
  // by a stale configs.provider while an older probe is still in flight.
  const provider = normalizeProviderId(
    this.elements.provider?.value || config.provider || this.getSelectedProvider?.(),
  );
  const apiKey = String(this.elements.apiKey?.value || config.apiKey || '');
  const customEndpoint = String(this.elements.customEndpoint?.value || config.customEndpoint || '').trim();

  if (provider === 'ollama') {
    let ollamaProbe: ProviderModelsResponse | null = null;
    try {
      ollamaProbe = await this.detectOllamaDetailed(customEndpoint);
    } catch (error) {
      ollamaProbe = null;
      console.warn('[Glide] Ollama probe failed:', error);
    }

    const ollamaOnline = Boolean(ollamaProbe?.success && (ollamaProbe.models?.length || ollamaProbe.online));
    // Re-check provider after await — user may have switched to Anthropic mid-probe.
    const stillOllama =
      normalizeProviderId(this.elements.provider?.value || this.configs?.[this.currentConfig]?.provider) === 'ollama';
    if (!stillOllama) {
      return;
    }

    if (ollamaOnline && ollamaProbe) {
      this.applyDetectedModels('ollama', ollamaProbe, { toast: false });
      const count = Array.isArray(ollamaProbe.models) ? ollamaProbe.models.length : 0;
      this.updateStatus?.(ollamaProbe.summary || `Ollama · ${count} modelo(s)`, 'success');
      return;
    }

    this._detectedModels = { provider: 'ollama', models: [], modelDetails: [], online: false };
    this.populateModelSelect([], config.model || '', 'Ollama', []);
    this.updateStatus?.('Ollama offline — inicie o Ollama e rode ollama list', 'warning');
    return;
  }

  const family = PROVIDER_FAMILY_LABELS[provider] || provider;
  let models: string[] = this._detectedModels?.provider === provider ? this._detectedModels.models : [];
  if (!models.length) {
    models = PROVIDER_PRESET_MODELS[provider] || [];
  }

  // Non-Ollama providers: optional live detect when we only have presets.
  if ((!models.length || models === PROVIDER_PRESET_MODELS[provider]) && apiKey) {
    try {
      const live = await requestProviderModelsFromBackground(provider, apiKey, customEndpoint);
      // Abort if user switched provider while the request was in flight.
      const stillSame =
        normalizeProviderId(this.elements.provider?.value || this.configs?.[this.currentConfig]?.provider) ===
        provider;
      if (!stillSame) return;
      if (live.models?.length) {
        this.applyDetectedModels(provider, live, { toast: false });
        return;
      }
    } catch {
      // keep presets
    }
  }

  const stillSameProvider =
    normalizeProviderId(this.elements.provider?.value || this.configs?.[this.currentConfig]?.provider) === provider;
  if (!stillSameProvider) return;

  const currentModel = config.model || models[0] || PROVIDER_DEFAULT_MODELS[provider];
  this.populateModelSelect(models, currentModel, family, this._detectedModels?.modelDetails || []);
};

(SidePanelUI.prototype as any).populateModelSelect = function populateModelSelect(
  models: string[],
  currentModel?: string,
  sourceFamily?: string,
  modelDetails: OllamaModelDetail[] = [],
) {
  let select = this.elements.modelSelect;
  if (!select) {
    select = document.getElementById('modelSelect') as HTMLSelectElement;
    if (select) {
      this.elements.modelSelect = select;
    }
  }

  if (!select) {
    return;
  }

  const config = this.configs[this.currentConfig] || {};
  const selectedModel = currentModel || config.model || '';
  const normalizedSourceFamily = String(sourceFamily || '').trim();
  const detailsByName = new Map<string, OllamaModelDetail>();
  for (const detail of modelDetails || []) {
    if (detail?.name) detailsByName.set(detail.name, detail);
  }
  // Prefer cache if caller did not pass details.
  if (!detailsByName.size && this._detectedModels?.modelDetails) {
    for (const detail of this._detectedModels.modelDetails as OllamaModelDetail[]) {
      if (detail?.name) detailsByName.set(detail.name, detail);
    }
  }

  const normalizedModels = models.filter((model) => Boolean(model && String(model).trim())) as string[];
  let finalModels = normalizedModels.length > 0 ? normalizedModels : [];
  if (selectedModel && !finalModels.includes(selectedModel)) {
    finalModels = [selectedModel, ...finalModels];
  }

  select.innerHTML = '';

  if (!selectedModel && !finalModels.length) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Selecionar modelo';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
  }

  for (const model of finalModels) {
    const option = document.createElement('option');
    option.value = model;
    const detail = detailsByName.get(model);
    // Primary label stays the tag name (what the API expects).
    option.textContent = model;
    if (normalizedSourceFamily) {
      option.dataset.modelFamily = normalizedSourceFamily;
    }
    if (detail?.id) option.dataset.modelId = detail.id;
    if (detail?.sizeLabel) option.dataset.sizeLabel = detail.sizeLabel;
    if (detail?.modifiedLabel) option.dataset.modifiedLabel = detail.modifiedLabel;
    if (detail?.isCloud) option.dataset.isCloud = '1';
    if (detail?.parameterSize) option.dataset.parameterSize = detail.parameterSize;
    // Secondary line for the custom menu: ID · SIZE · MODIFIED (ollama list columns).
    const metaParts = [
      detail?.id && detail.id !== '—' ? detail.id : '',
      detail?.sizeLabel && detail.sizeLabel !== '—' ? detail.sizeLabel : detail?.isCloud ? 'cloud' : '',
      detail?.modifiedLabel && detail.modifiedLabel !== '—' ? detail.modifiedLabel : '',
    ].filter(Boolean);
    if (metaParts.length) option.dataset.modelMeta = metaParts.join(' · ');
    if (model === selectedModel) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  this.renderModelMenu();
  this.syncModelTrigger();
};

(SidePanelUI.prototype as any).syncModelTrigger = function syncModelTrigger() {
  const select = this.elements.modelSelect as HTMLSelectElement | null;
  const valueEl = this.elements.modelSelectValue as HTMLElement | null;
  if (!select || !valueEl) return;

  const config = this.configs?.[this.currentConfig] || {};
  const selectedOption = select.selectedOptions?.[0];
  const text = selectedOption?.textContent?.trim() || select.value || config.model || 'Selecionar modelo';
  valueEl.textContent = text;
};

(SidePanelUI.prototype as any).inferModelFamily = function inferModelFamily(_modelId: string) {
  const sourceContext = this.getModelSourceContext();
  return this.resolveModelFamilyBySource(sourceContext.provider, sourceContext.customEndpoint);
};

(SidePanelUI.prototype as any).getVisibleModelOptions = function getVisibleModelOptions() {
  const menu = this.elements.modelSelectMenu as HTMLElement | null;
  if (!menu || menu.classList.contains('hidden')) return [] as HTMLButtonElement[];
  return Array.from(menu.querySelectorAll('.model-option')) as HTMLButtonElement[];
};

(SidePanelUI.prototype as any).focusModelOptionByIndex = function focusModelOptionByIndex(index: number) {
  const options = this.getVisibleModelOptions();
  if (!options.length) return;
  const normalized = index < 0 ? options.length - 1 : Math.min(index, options.length - 1);
  options[normalized]?.focus();
};

(SidePanelUI.prototype as any).focusSelectedModelOption = function focusSelectedModelOption() {
  const options = this.getVisibleModelOptions();
  if (!options.length) return;
  const selectedIndex = options.findIndex((option) => option.classList.contains('selected'));
  this.focusModelOptionByIndex(selectedIndex >= 0 ? selectedIndex : 0);
};

(SidePanelUI.prototype as any).moveModelMenuFocus = function moveModelMenuFocus(direction: number) {
  const options = this.getVisibleModelOptions();
  if (!options.length) return;

  const activeElement = document.activeElement as HTMLElement | null;
  let currentIndex = options.findIndex((option) => option === activeElement);
  if (currentIndex < 0) {
    const selectedIndex = options.findIndex((option) => option.classList.contains('selected'));
    currentIndex = selectedIndex >= 0 ? selectedIndex : direction > 0 ? -1 : 0;
  }

  let nextIndex = currentIndex + direction;
  if (nextIndex < 0) nextIndex = options.length - 1;
  if (nextIndex >= options.length) nextIndex = 0;
  options[nextIndex]?.focus();
};

(SidePanelUI.prototype as any).selectModelOptionByElement = function selectModelOptionByElement(
  optionEl: HTMLElement | null,
) {
  const select = this.elements.modelSelect as HTMLSelectElement | null;
  if (!select || !optionEl) return;
  const value = optionEl.dataset.value || '';
  if (!value) return;
  select.value = value;
  this.handleModelSelectChange();
  this.closeModelMenu();
};

(SidePanelUI.prototype as any).renderModelMenu = function renderModelMenu() {
  const select = this.elements.modelSelect as HTMLSelectElement | null;
  const menu = this.elements.modelSelectMenu as HTMLElement | null;
  if (!select || !menu) return;

  menu.innerHTML = '';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Modelos disponíveis');

  const options = Array.from(select.options).filter((option) => option.value && !option.disabled);
  if (!options.length) return;

  const grouped = new Map<string, HTMLOptionElement[]>();
  for (const option of options) {
    const family = option.dataset.modelFamily || this.inferModelFamily(option.value);
    if (!grouped.has(family)) grouped.set(family, []);
    grouped.get(family)?.push(option);
  }

  const preferredOrder = ['Ollama', 'Custom', 'Modelo'];
  const preferredSet = new Set(preferredOrder);
  const dynamicFamilies = Array.from(grouped.keys())
    .filter((family) => !preferredSet.has(family))
    .sort((a, b) => a.localeCompare(b));
  const orderedFamilies = [...preferredOrder.filter((family) => grouped.has(family)), ...dynamicFamilies];

  for (const family of orderedFamilies) {
    const familyOptions = grouped.get(family);
    if (!familyOptions?.length) continue;

    const section = document.createElement('section');
    section.className = 'model-group';

    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'model-group-label';
    sectionLabel.textContent = family;
    section.appendChild(sectionLabel);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'model-group-items';

    for (const option of familyOptions) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'model-option';
      item.setAttribute('role', 'option');
      item.dataset.value = option.value;

      const modelName = document.createElement('span');
      modelName.className = 'model-option-name';
      modelName.textContent = option.textContent || option.value;
      item.appendChild(modelName);

      const metaText =
        option.dataset.modelMeta ||
        [option.dataset.modelId, option.dataset.sizeLabel, option.dataset.modifiedLabel]
          .filter((part) => part && part !== '—')
          .join(' · ');
      if (metaText) {
        const modelMeta = document.createElement('span');
        modelMeta.className = 'model-option-meta';
        modelMeta.textContent = metaText;
        item.appendChild(modelMeta);
      }

      if (option.value === select.value) {
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
      } else {
        item.setAttribute('aria-selected', 'false');
      }

      item.addEventListener('click', (event: Event) => {
        event.stopPropagation();
        this.selectModelOptionByElement(item);
      });

      itemsWrap.appendChild(item);
    }

    section.appendChild(itemsWrap);
    menu.appendChild(section);
  }
};

(SidePanelUI.prototype as any).isModelMenuOpen = function isModelMenuOpen() {
  const menu = this.elements.modelSelectMenu as HTMLElement | null;
  return Boolean(menu && !menu.classList.contains('hidden'));
};

(SidePanelUI.prototype as any).toggleModelMenu = function toggleModelMenu(
  focusTarget: 'none' | 'first' | 'last' | 'selected' = 'none',
) {
  const menu = this.elements.modelSelectMenu as HTMLElement | null;
  const trigger = this.elements.modelSelectTrigger as HTMLButtonElement | null;
  if (!menu || !trigger) return;

  const isOpen = this.isModelMenuOpen();
  if (isOpen) {
    this.closeModelMenu();
    return;
  }

  this.renderModelMenu();
  menu.classList.remove('hidden');
  menu.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');

  if (focusTarget === 'first') {
    this.focusModelOptionByIndex(0);
  } else if (focusTarget === 'last') {
    this.focusModelOptionByIndex(-1);
  } else if (focusTarget === 'selected') {
    this.focusSelectedModelOption();
  }
};

(SidePanelUI.prototype as any).closeModelMenu = function closeModelMenu(options?: {
  focusTrigger?: boolean;
}) {
  const menu = this.elements.modelSelectMenu as HTMLElement | null;
  const trigger = this.elements.modelSelectTrigger as HTMLButtonElement | null;
  if (!menu) return;
  menu.classList.add('hidden');
  menu.classList.remove('open');
  trigger?.setAttribute('aria-expanded', 'false');
  if (options?.focusTrigger) {
    trigger?.focus();
  }
};

(SidePanelUI.prototype as any).handleModelSelectChange = function handleModelSelectChange() {
  const select = this.elements.modelSelect;
  if (!select) return;

  const selectedModel = select.value;
  if (!selectedModel) return;

  if (this.configs[this.currentConfig]) {
    this.configs[this.currentConfig].model = selectedModel;
  }

  if (this.elements.model) {
    this.elements.model.value = selectedModel;
  }

  this.syncModelTrigger();
  this.persistAllSettings({ silent: true }).catch((error: unknown) => {
    console.error('Falha ao salvar seleção de modelo:', error);
    this.showErrorBanner?.('Falha ao salvar a seleção de modelo.');
  });
};
