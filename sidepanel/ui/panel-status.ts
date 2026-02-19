import { SidePanelUI } from './panel-ui.js';

const MODEL_FETCH_TIMEOUT_MS = 8000;

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
  const provider = String(this.elements.provider?.value || config.provider || 'anthropic').toLowerCase();
  const apiKey = String(this.elements.apiKey?.value ?? config.apiKey ?? '');

  const endpointInput = this.elements.customEndpoint?.value;
  let customEndpoint = String(
    endpointInput !== undefined && endpointInput !== null ? endpointInput : config.customEndpoint || '',
  ).trim();

  if (provider === 'ollama' && !customEndpoint) {
    customEndpoint = 'http://localhost:11434';
  } else if (provider === 'kimi' && !customEndpoint) {
    customEndpoint = 'https://api.kimi.com/coding';
  } else if (provider !== 'custom' && provider !== 'ollama' && provider !== 'kimi') {
    customEndpoint = '';
  }

  const model = String(this.elements.model?.value || config.model || '').trim();
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
  customEndpoint = '',
) {
  const normalizedProvider = String(provider || '').toLowerCase();
  if (normalizedProvider === 'openai') {
    return customEndpoint
      ? this.resolveModelFamilyFromEndpoint(customEndpoint, 'OpenAI')
      : 'OpenAI';
  }
  if (normalizedProvider === 'anthropic') return 'Anthropic';
  if (normalizedProvider === 'google') return 'Google';
  if (normalizedProvider === 'kimi') return 'Kimi';
  if (normalizedProvider === 'ollama') return 'Ollama';
  if (normalizedProvider === 'custom') {
    return this.resolveModelFamilyFromEndpoint(customEndpoint, 'Custom');
  }
  return this.resolveModelFamilyFromEndpoint(customEndpoint, 'Modelo');
};

(SidePanelUI.prototype as any).isLikelyOllamaEndpoint = function isLikelyOllamaEndpoint(endpoint: string) {
  const value = String(endpoint || '').toLowerCase();
  if (!value) return false;
  return value.includes('localhost:11434') || value.includes(':11434') || value.includes('ollama');
};

(SidePanelUI.prototype as any).fetchAvailableModels = async function fetchAvailableModels() {
  const config = this.configs[this.currentConfig] || {};
  const sourceContext = this.getModelSourceContext();
  const provider = sourceContext.provider || 'anthropic';
  const apiKey = sourceContext.apiKey || '';
  const customEndpoint = sourceContext.customEndpoint || '';
  const currentModel = sourceContext.model || config.model;

  if (this.modelsFetchController) {
    this.modelsFetchController.abort();
    this.modelsFetchController = null;
  }
  const requestId = (this.modelsFetchSeq || 0) + 1;
  this.modelsFetchSeq = requestId;

  const isCurrentRequest = (controller?: AbortController | null) => {
    if (this.modelsFetchSeq !== requestId) return false;
    if (!controller) return true;
    return this.modelsFetchController === controller;
  };
  const defaultSourceFamily = this.resolveModelFamilyBySource(provider, customEndpoint);
  const applyModels = (models: string[], sourceFamily = defaultSourceFamily) => {
    if (!isCurrentRequest()) return;
    this.populateModelSelect(models, currentModel, sourceFamily);
  };
  const setModelFetchError = (code: string | null, message = '') => {
    this.lastModelFetchError = code
      ? {
          code,
          message,
          timestamp: Date.now(),
        }
      : null;
  };
  const hasConnectionForSource = (() => {
    if (provider === 'ollama') {
      return Boolean(customEndpoint);
    }
    if (provider === 'custom') {
      if (!customEndpoint) return false;
      if (this.isLikelyOllamaEndpoint(customEndpoint)) return true;
      return Boolean(apiKey);
    }
    if (provider === 'openai' || provider === 'anthropic' || provider === 'google' || provider === 'kimi') {
      return Boolean(apiKey);
    }
    return Boolean(apiKey || customEndpoint);
  })();
  if (!hasConnectionForSource) {
    setModelFetchError(null);
    applyModels([]);
    return;
  }
  const createController = () => {
    const controller = new AbortController();
    this.modelsFetchController = controller;
    return controller;
  };
  const fetchOllamaModels = async (endpoint: string) => {
    const controller = createController();
    let timeoutReached = false;
    const timeoutId = window.setTimeout(() => {
      timeoutReached = true;
      controller.abort();
    }, MODEL_FETCH_TIMEOUT_MS);
    try {
      const baseUrl = endpoint.replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      if (!isCurrentRequest(controller)) return;
      if (!response.ok) {
        setModelFetchError(null);
        applyModels([], 'Ollama');
        return;
      }
      const data = await response.json();
      if (!isCurrentRequest(controller)) return;
      const models = (data.models || [])
        .map((m: any) => m.name)
        .filter(Boolean)
        .sort();
      setModelFetchError(null);
      applyModels(models, 'Ollama');
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        if (timeoutReached) {
          setModelFetchError('MODEL_FETCH_TIMEOUT', `Timeout after ${MODEL_FETCH_TIMEOUT_MS}ms`);
          applyModels(currentModel ? [currentModel] : [], 'Ollama');
        }
        return;
      }
      setModelFetchError(null);
      applyModels([], 'Ollama');
    } finally {
      window.clearTimeout(timeoutId);
      if (isCurrentRequest(controller)) {
        this.modelsFetchController = null;
      }
    }
  };

  if (provider === 'anthropic') {
    // Anthropic does not expose a stable public model-list endpoint for this flow.
    // Keep only the user-configured model instead of guessing a static catalog.
    setModelFetchError(null);
    applyModels(currentModel ? [currentModel] : [], 'Anthropic');
    return;
  }

  if (provider === 'google') {
    // Same approach as Anthropic: no static guesses.
    setModelFetchError(null);
    applyModels(currentModel ? [currentModel] : [], 'Google');
    return;
  }

  if (provider === 'ollama' || (provider === 'custom' && this.isLikelyOllamaEndpoint(customEndpoint))) {
    void fetchOllamaModels(customEndpoint || 'http://localhost:11434');
    return;
  }

  if (provider === 'kimi') {
    // Kimi flow is anthropic-compatible; keep current configured model only.
    setModelFetchError(null);
    applyModels(currentModel ? [currentModel] : [], 'Kimi');
    return;
  }

  let baseUrl = '';
  if (provider === 'custom' && customEndpoint) {
    baseUrl = customEndpoint
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/completions\/?$/i, '')
      .replace(/\/v1\/models\/?$/i, '')
      .replace(/\/v1\/?$/i, '')
      .replace(/\/+$/, '');
  } else if (provider === 'openai') {
    baseUrl = 'https://api.openai.com';
  }

  if (!baseUrl) {
    setModelFetchError(null);
    applyModels(currentModel ? [currentModel] : []);
    return;
  }

  const sourceFamilyForEndpoint = this.resolveModelFamilyBySource(provider, baseUrl);
  const modelsUrl = `${baseUrl}/v1/models`;
  const controller = createController();
  let timeoutReached = false;
  const timeoutId = window.setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, MODEL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!isCurrentRequest(controller)) return;

    if (!response.ok) {
      setModelFetchError(null);
      applyModels(currentModel ? [currentModel] : [], sourceFamilyForEndpoint);
      return;
    }

    const data = await response.json();
    if (!isCurrentRequest(controller)) return;
    const allModels = (data.data || []) as Array<{ id: string; active?: boolean }>;
    const activeModels = allModels
      .filter((m) => m.id && m.active === true)
      .map((m) => m.id)
      .sort((a, b) => a.localeCompare(b));

    const inactiveModels = allModels
      .filter((m) => m.id && m.active !== true)
      .map((m) => m.id)
      .sort((a, b) => a.localeCompare(b));

    const models = [...activeModels, ...inactiveModels].filter(Boolean);

    if (models.length > 0) {
      setModelFetchError(null);
      applyModels(models, sourceFamilyForEndpoint);
    } else {
      setModelFetchError(null);
      applyModels(currentModel ? [currentModel] : [], sourceFamilyForEndpoint);
    }
  } catch (_error) {
    if ((_error as { name?: string })?.name === 'AbortError') {
      if (timeoutReached) {
        setModelFetchError('MODEL_FETCH_TIMEOUT', `Timeout after ${MODEL_FETCH_TIMEOUT_MS}ms`);
        applyModels(currentModel ? [currentModel] : [], sourceFamilyForEndpoint);
      }
      return;
    }
    setModelFetchError(null);
    applyModels(currentModel ? [currentModel] : [], sourceFamilyForEndpoint);
  } finally {
    window.clearTimeout(timeoutId);
    if (isCurrentRequest(controller)) {
      this.modelsFetchController = null;
    }
  }
};

(SidePanelUI.prototype as any).populateModelSelect = function populateModelSelect(
  models: string[],
  currentModel?: string,
  sourceFamily?: string,
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

  const normalizedModels = models.filter((model) => Boolean(model && model.trim?.())) as string[];
  let finalModels = normalizedModels.length > 0 ? normalizedModels : [];
  if (selectedModel && !finalModels.includes(selectedModel)) {
    finalModels = [selectedModel, ...finalModels];
  }

  select.innerHTML = '';

  if (!selectedModel) {
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
    option.textContent = model;
    if (normalizedSourceFamily) {
      option.dataset.modelFamily = normalizedSourceFamily;
    }
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
  const text =
    selectedOption?.textContent?.trim() || select.value || config.model || 'Selecionar modelo';
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

  const preferredOrder = [
    'OpenAI',
    'Anthropic',
    'Google',
    'Kimi',
    'Ollama',
    'OpenRouter',
    'Custom',
    'Modelo',
  ];
  const dynamicFamilies = Array.from(grouped.keys())
    .filter((family) => !preferredOrder.includes(family))
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
  this.persistAllSettings({ silent: true });
};
