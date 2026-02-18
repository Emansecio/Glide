import { SidePanelUI } from './panel-ui.js';

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

(SidePanelUI.prototype as any).fetchAvailableModels = async function fetchAvailableModels() {
  const config = this.configs[this.currentConfig] || {};
  const provider = config.provider || 'anthropic';
  const apiKey = config.apiKey || '';
  const customEndpoint = config.customEndpoint || '';
  const currentModel = config.model;

  if (this.modelsFetchController) {
    this.modelsFetchController.abort();
    this.modelsFetchController = null;
  }
  const requestId = (this.modelsFetchSeq || 0) + 1;
  this.modelsFetchSeq = requestId;

  const ANTHROPIC_MODELS = [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
  ];

  const GOOGLE_MODELS = [
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.5-pro-preview-05-06',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ];

  const OPENAI_MODELS = [
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'o1',
    'o1-mini',
    'o1-pro',
    'o3',
    'o3-mini',
    'o4-mini',
  ];

  const OLLAMA_MODELS = ['qwen3', 'qwen3:4b', 'llama3.1', 'mistral', 'deepseek-r1'];

  const isCurrentRequest = (controller?: AbortController | null) => {
    if (this.modelsFetchSeq !== requestId) return false;
    if (!controller) return true;
    return this.modelsFetchController === controller;
  };
  const applyModels = (models: string[]) => {
    if (!isCurrentRequest()) return;
    this.populateModelSelect(models, currentModel);
  };
  const createController = () => {
    const controller = new AbortController();
    this.modelsFetchController = controller;
    return controller;
  };

  if (provider === 'anthropic') {
    applyModels(ANTHROPIC_MODELS);
    return;
  }

  if (provider === 'google') {
    applyModels(GOOGLE_MODELS);
    return;
  }

  if (provider === 'ollama') {
    // Tentar buscar modelos da API do Ollama
    const controller = createController();
    try {
      const endpoint = customEndpoint || 'http://localhost:11434';
      const baseUrl = endpoint.replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });

      if (!isCurrentRequest(controller)) return;

      if (response.ok) {
        const data = await response.json();
        if (!isCurrentRequest(controller)) return;
        const models = (data.models || [])
          .map((m: any) => m.name)
          .filter(Boolean)
          .sort();

        if (models.length > 0) {
          applyModels(models);
          return;
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      // Silenciosamente falha para o fallback
    } finally {
      if (isCurrentRequest(controller)) {
        this.modelsFetchController = null;
      }
    }

    if (!isCurrentRequest()) return;
    // Fallback: lista hardcoded se a API nao responder
    applyModels([currentModel || OLLAMA_MODELS[0], ...OLLAMA_MODELS]);
    return;
  }

  if (provider === 'kimi') {
    applyModels([currentModel || 'kimi-for-coding']);
    return;
  }

  if (provider === 'openai' && !customEndpoint) {
    applyModels(OPENAI_MODELS);
    return;
  }

  if (!apiKey && provider === 'custom') {
    applyModels([currentModel || 'gpt-4o']);
    return;
  }

  let baseUrl = '';
  if (customEndpoint) {
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
    applyModels([currentModel || 'gpt-4o']);
    return;
  }

  const modelsUrl = `${baseUrl}/v1/models`;
  const controller = createController();

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
      applyModels([currentModel || 'gpt-4o']);
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
      applyModels(models);
    } else {
      applyModels([currentModel || 'gpt-4o']);
    }
  } catch (_error) {
    if ((_error as { name?: string })?.name === 'AbortError') return;
    applyModels([currentModel || 'gpt-4o']);
  } finally {
    if (isCurrentRequest(controller)) {
      this.modelsFetchController = null;
    }
  }
};

(SidePanelUI.prototype as any).populateModelSelect = function populateModelSelect(
  models: string[],
  currentModel?: string,
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

  const normalizedModels = models.filter((model) => Boolean(model && model.trim?.())) as string[];
  const fallbackModel = selectedModel || 'gpt-4o';

  let finalModels = normalizedModels.length > 0 ? normalizedModels : [fallbackModel];
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

(SidePanelUI.prototype as any).inferModelFamily = function inferModelFamily(modelId: string) {
  const value = (modelId || '').toLowerCase();
  if (!value) return 'Modelo';
  if (value.startsWith('gpt') || value.startsWith('o1') || value.startsWith('o3') || value.startsWith('o4')) {
    return 'OpenAI';
  }
  if (value.startsWith('claude')) return 'Anthropic';
  if (value.startsWith('gemini')) return 'Google';
  if (value.startsWith('kimi')) return 'Kimi';
  if (
    value.includes('llama') ||
    value.includes('qwen') ||
    value.includes('mistral') ||
    value.includes('deepseek')
  ) {
    return 'Local';
  }
  return 'Personalizado';
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
    const family = this.inferModelFamily(option.value);
    if (!grouped.has(family)) grouped.set(family, []);
    grouped.get(family)?.push(option);
  }

  const preferredOrder = ['OpenAI', 'Anthropic', 'Google', 'Kimi', 'Local', 'Personalizado', 'Modelo'];
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
