import { SidePanelUI } from './panel-ui.js';

(SidePanelUI.prototype as any).updateStatus = function updateStatus(text: string, type = 'default') {
  if (this.elements.statusText) {
    this.elements.statusText.textContent = text;
  }
  const statusDot = document.getElementById('statusDot');
  if (statusDot) {
    statusDot.className = 'status-dot';
    if (type === 'error') statusDot.classList.add('error');
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

(SidePanelUI.prototype as any).fetchAvailableModels = async function fetchAvailableModels() {
  const config = this.configs[this.currentConfig] || {};
  const provider = config.provider || 'anthropic';
  const apiKey = config.apiKey || '';
  const customEndpoint = config.customEndpoint || '';

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

  if (provider === 'anthropic') {
    this.populateModelSelect(ANTHROPIC_MODELS, config.model);
    return;
  }

  if (provider === 'google') {
    this.populateModelSelect(GOOGLE_MODELS, config.model);
    return;
  }

  if (provider === 'ollama') {
    this.populateModelSelect([config.model || OLLAMA_MODELS[0], ...OLLAMA_MODELS], config.model);
    return;
  }

  if (provider === 'kimi') {
    this.populateModelSelect([config.model || 'kimi-for-coding'], config.model);
    return;
  }

  if (provider === 'openai' && !customEndpoint) {
    this.populateModelSelect(OPENAI_MODELS, config.model);
    return;
  }

  if (!apiKey && provider === 'custom') {
    this.populateModelSelect([config.model || 'gpt-4o'], config.model);
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
    this.populateModelSelect([config.model || 'gpt-4o'], config.model);
    return;
  }

  const modelsUrl = `${baseUrl}/v1/models`;

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      this.populateModelSelect([config.model || 'gpt-4o'], config.model);
      return;
    }

    const data = await response.json();
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
      this.populateModelSelect(models, config.model);
    } else {
      this.populateModelSelect([config.model || 'gpt-4o'], config.model);
    }
  } catch (_error) {
    this.populateModelSelect([config.model || 'gpt-4o'], config.model);
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
  if (!value) return 'modelo';
  if (value.startsWith('gpt') || value.startsWith('o1') || value.startsWith('o3') || value.startsWith('o4')) {
    return 'openai';
  }
  if (value.startsWith('claude')) return 'anthropic';
  if (value.startsWith('gemini')) return 'google';
  if (
    value.includes('llama') ||
    value.includes('qwen') ||
    value.includes('mistral') ||
    value.includes('deepseek') ||
    value.includes('mixtral')
  ) {
    return 'local';
  }
  if (value.startsWith('kimi')) return 'kimi';
  return 'custom';
};

(SidePanelUI.prototype as any).renderModelMenu = function renderModelMenu() {
  const select = this.elements.modelSelect as HTMLSelectElement | null;
  const menu = this.elements.modelSelectMenu as HTMLElement | null;
  if (!select || !menu) return;

  menu.innerHTML = '';

  const options = Array.from(select.options).filter((option) => option.value && !option.disabled);
  for (const option of options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'model-select-option';
    item.setAttribute('role', 'option');
    item.dataset.value = option.value;

    const modelText = option.textContent || option.value;
    const modelName = document.createElement('span');
    modelName.className = 'model-select-name';
    modelName.textContent = modelText;

    const modelFamily = document.createElement('span');
    modelFamily.className = 'model-select-family';
    modelFamily.textContent = this.inferModelFamily(option.value);

    item.appendChild(modelName);
    item.appendChild(modelFamily);

    if (option.value === select.value) {
      item.classList.add('selected');
      item.setAttribute('aria-selected', 'true');
    } else {
      item.setAttribute('aria-selected', 'false');
    }

    item.addEventListener('click', (event: Event) => {
      event.stopPropagation();
      select.value = option.value;
      this.handleModelSelectChange();
      this.closeModelMenu();
    });

    menu.appendChild(item);
  }
};

(SidePanelUI.prototype as any).toggleModelMenu = function toggleModelMenu() {
  const menu = this.elements.modelSelectMenu as HTMLElement | null;
  const trigger = this.elements.modelSelectTrigger as HTMLButtonElement | null;
  if (!menu || !trigger) return;

  const isOpen = !menu.classList.contains('hidden');
  if (isOpen) {
    this.closeModelMenu();
    return;
  }

  this.renderModelMenu();
  menu.classList.remove('hidden');
  menu.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
};

(SidePanelUI.prototype as any).closeModelMenu = function closeModelMenu() {
  const menu = this.elements.modelSelectMenu as HTMLElement | null;
  const trigger = this.elements.modelSelectTrigger as HTMLButtonElement | null;
  if (!menu) return;
  menu.classList.add('hidden');
  menu.classList.remove('open');
  trigger?.setAttribute('aria-expanded', 'false');
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
