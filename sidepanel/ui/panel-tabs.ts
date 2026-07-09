import { getPanelOwnerTab } from './panel-tab-id.js';
import { SidePanelUI } from './panel-ui.js';

(SidePanelUI.prototype as any).handleFileSelection = async function handleFileSelection(event: Event) {
  const input = event.target as HTMLInputElement | null;
  if (!input) return;
  const files = Array.from(input.files || []) as File[];
  if (!files.length) return;

  const maxPerFile = 4000;
  const fileTexts = await Promise.all(
    files.map(async (file) => {
      try {
        const text = await file.text();
        const trimmed = text.length > maxPerFile ? `${text.slice(0, maxPerFile)}\n... (truncado)` : text;
        return `\n\n[File: ${file.name}]\n` + trimmed;
      } catch (e) {
        console.warn('Falha ao ler arquivo', file.name, e);
        return '';
      }
    }),
  );
  for (const text of fileTexts) {
    if (text) this.elements.userInput.value += text;
  }
  input.value = '';
  this.elements.userInput.focus();
};

(SidePanelUI.prototype as any).toggleTabSelector = async function toggleTabSelector() {
  if (this.tabSelectorController) {
    await this.tabSelectorController.toggle();
    return;
  }
  const isHidden = this.elements.tabSelector.classList.contains('hidden');
  if (isHidden) {
    await this.loadTabs();
    this.updateTabSelectorButton();
    this.elements.tabSelector.classList.remove('hidden');
  } else {
    this.closeTabSelector();
  }
};

(SidePanelUI.prototype as any).closeTabSelector = function closeTabSelector() {
  if (this.tabSelectorController) {
    this.tabSelectorController.close();
    return;
  }
  this.elements.tabSelector.classList.add('hidden');
};

(SidePanelUI.prototype as any).addActiveTabToSelection = async function addActiveTabToSelection() {
  const activeTab = await getPanelOwnerTab();
  if (!activeTab || typeof activeTab.id !== 'number') return;
  this.selectedTabs.set(activeTab.id, this.buildSelectedTab(activeTab));
  this.updateSelectedTabsBar();
  this.updateTabSelectorButton();
  this.loadTabs();
};

(SidePanelUI.prototype as any).clearSelectedTabs = function clearSelectedTabs() {
  if (this.selectedTabs.size === 0) return;
  this.selectedTabs.clear();
  this.updateSelectedTabsBar();
  this.updateTabSelectorButton();
  this.loadTabs();
};

(SidePanelUI.prototype as any).loadTabs = async function loadTabs() {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  this.tabGroupInfo = new Map(groups.map((group) => [group.id, group]));
  this.elements.tabList.innerHTML = '';

  const groupedTabs = new Map<number, chrome.tabs.Tab[]>();
  const ungroupedTabs: chrome.tabs.Tab[] = [];

  tabs
    .filter((tab) => typeof tab.id === 'number')
    .forEach((tab) => {
      if (tab.groupId !== undefined && tab.groupId >= 0) {
        if (!groupedTabs.has(tab.groupId)) groupedTabs.set(tab.groupId, []);
        const bucket = groupedTabs.get(tab.groupId);
        if (bucket) bucket.push(tab);
      } else {
        ungroupedTabs.push(tab);
      }
    });

  const fallbackFavicon =
    'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23707085%27 stroke-width=%272%27%3E%3Crect x=%273%27 y=%273%27 width=%2718%27 height=%2718%27 rx=%274%27/%3E%3Cpath d=%27M8 12h8%27/%3E%3C/svg%3E';

  const renderGroup = (
    label: string,
    color: string,
    groupTabs: chrome.tabs.Tab[],
    groupId: string | number = 'ungrouped',
  ) => {
    if (!groupTabs.length) return;
    const section = document.createElement('div');
    section.className = 'tab-group';
    section.dataset.groupId = String(groupId);
    const allSelected = groupTabs.every((tab) => typeof tab.id === 'number' && this.selectedTabs.has(tab.id));
    const safeColor = this.escapeAttribute(color);
    section.innerHTML = `
      <div class="tab-group-header" style="--group-color: ${safeColor}">
        <div class="tab-group-label">
          <span>${this.escapeHtml(label)}</span>
          <span class="tab-group-count">${groupTabs.length}</span>
        </div>
        <button class="tab-group-toggle" type="button">${allSelected ? 'Limpar' : 'Adicionar todas'}</button>
      </div>
    `;

    const toggleBtn = section.querySelector('.tab-group-toggle');
    toggleBtn?.addEventListener('click', (event) => {
      event.stopPropagation();
      const shouldSelect = groupTabs.some((tab) => typeof tab.id === 'number' && !this.selectedTabs.has(tab.id));
      this.toggleGroupSelection(groupTabs, shouldSelect);
    });

    const fragment = document.createDocumentFragment();
    groupTabs.forEach((tab) => {
      const tabId = tab.id;
      const isSelected = typeof tabId === 'number' && this.selectedTabs.has(tabId);
      const item = document.createElement('div');
      item.className = `tab-item${isSelected ? ' selected' : ''}`;
      if (typeof tabId === 'number') {
        item.dataset.tabId = String(tabId);
      }
      item.dataset.groupId = String(groupId);
      const urlLabel = this.formatTabLabel(tab.url || '');
      // Only http(s) or data-image favicons are allowed as an <img> source, per
      // the project image-protocol policy; anything else uses the local fallback.
      const rawFavicon = String(tab.favIconUrl || '').trim();
      const faviconUrl = /^(https?:|data:image\/)/i.test(rawFavicon) ? rawFavicon : fallbackFavicon;
      const safeFaviconUrl = this.escapeAttribute(faviconUrl);
      item.innerHTML = `
        <div class="tab-item-checkbox"></div>
        <img class="tab-item-favicon" src="${safeFaviconUrl}">
        <div class="tab-item-text">
          <span class="tab-item-title">${this.escapeHtml(tab.title || 'Sem titulo')}</span>
          ${urlLabel ? `<span class="tab-item-url">${this.escapeHtml(urlLabel)}</span>` : ''}
        </div>
      `;
      const favicon = item.querySelector('.tab-item-favicon') as HTMLImageElement | null;
      if (favicon) {
        favicon.addEventListener('error', () => {
          if (favicon.src !== fallbackFavicon) favicon.src = fallbackFavicon;
        });
      }
      item.addEventListener('click', () => this.toggleTabSelection(tab, item));
      fragment.appendChild(item);
    });
    section.appendChild(fragment);

    this.elements.tabList.appendChild(section);
  };

  groupedTabs.forEach((groupTabs, groupId) => {
    const group = this.tabGroupInfo.get(groupId);
    const label = group?.title || `Grupo ${groupId}`;
    const color = this.mapGroupColor(group?.color);
    renderGroup(label, color, groupTabs, groupId);
  });

  renderGroup('Sem grupo', 'var(--muted-dim)', ungroupedTabs);
};

(SidePanelUI.prototype as any).toggleGroupSelection = function toggleGroupSelection(
  groupTabs: chrome.tabs.Tab[],
  shouldSelect: boolean,
) {
  const changedTabIds: number[] = [];
  groupTabs.forEach((tab) => {
    if (typeof tab.id !== 'number') return;
    if (shouldSelect) {
      this.selectedTabs.set(tab.id, this.buildSelectedTab(tab));
    } else {
      this.selectedTabs.delete(tab.id);
    }
    changedTabIds.push(tab.id);
  });
  this.updateSelectedTabsBar();
  this.updateTabSelectorButton();
  this.syncRenderedTabSelection(changedTabIds);
};

(SidePanelUI.prototype as any).toggleTabSelection = function toggleTabSelection(
  tab: chrome.tabs.Tab,
  itemElement: HTMLElement,
) {
  if (typeof tab.id !== 'number') return;
  if (this.selectedTabs.has(tab.id)) {
    this.selectedTabs.delete(tab.id);
    itemElement.classList.remove('selected');
  } else {
    this.selectedTabs.set(tab.id, this.buildSelectedTab(tab));
    itemElement.classList.add('selected');
  }
  this.updateSelectedTabsBar();
  this.updateTabSelectorButton();
  this.updateTabGroupToggleStates();
};

(SidePanelUI.prototype as any).syncRenderedTabSelection = function syncRenderedTabSelection(tabIds?: number[]) {
  const tabList = this.elements.tabList as HTMLElement | null;
  if (!tabList) return;

  if (Array.isArray(tabIds) && tabIds.length > 0) {
    tabIds.forEach((tabId) => {
      const items = tabList.querySelectorAll(`.tab-item[data-tab-id="${tabId}"]`);
      items.forEach((item) => {
        item.classList.toggle('selected', this.selectedTabs.has(tabId));
      });
    });
  } else {
    const items = tabList.querySelectorAll('.tab-item[data-tab-id]');
    items.forEach((item) => {
      const tabId = Number.parseInt((item as HTMLElement).dataset.tabId || '', 10);
      if (!Number.isFinite(tabId)) return;
      item.classList.toggle('selected', this.selectedTabs.has(tabId));
    });
  }

  this.updateTabGroupToggleStates();
};

(SidePanelUI.prototype as any).updateTabGroupToggleStates = function updateTabGroupToggleStates() {
  const tabList = this.elements.tabList as HTMLElement | null;
  if (!tabList) return;
  const groups = tabList.querySelectorAll('.tab-group');
  groups.forEach((group) => {
    const items = group.querySelectorAll('.tab-item[data-tab-id]');
    if (!items.length) return;
    const allSelected = Array.from(items).every((item) => item.classList.contains('selected'));
    const toggleButton = group.querySelector('.tab-group-toggle');
    if (toggleButton) {
      toggleButton.textContent = allSelected ? 'Limpar' : 'Adicionar todas';
    }
  });
};

(SidePanelUI.prototype as any).buildSelectedTab = function buildSelectedTab(tab: chrome.tabs.Tab) {
  const group = this.tabGroupInfo.get(tab.groupId);
  const hasGroup = tab.groupId !== undefined && tab.groupId >= 0;
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    windowId: tab.windowId,
    groupId: tab.groupId,
    groupTitle: hasGroup ? group?.title || `Grupo ${tab.groupId}` : 'Sem grupo',
    groupColor: hasGroup ? this.mapGroupColor(group?.color) : 'var(--muted-dim)',
  };
};

(SidePanelUI.prototype as any).updateSelectedTabsBar = function updateSelectedTabsBar() {
  if (this.selectedTabs.size === 0) {
    this.elements.selectedTabsBar.classList.add('hidden');
    return;
  }

  this.elements.selectedTabsBar.classList.remove('hidden');
  this.elements.selectedTabsBar.innerHTML = '';
  const grouped = new Map<string, Array<any>>();
  this.selectedTabs.forEach((tab: any) => {
    const key = tab.groupId && tab.groupId >= 0 ? `group-${tab.groupId}` : 'ungrouped';
    if (!grouped.has(key)) grouped.set(key, []);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(tab);
  });

  grouped.forEach((tabs) => {
    const groupTitle = tabs[0]?.groupTitle || 'Sem grupo';
    const groupLabel = this.truncateText(groupTitle, 18) || 'Sem grupo';
    const groupColor = tabs[0]?.groupColor || 'var(--muted-dim)';
    const safeGroupColor = this.escapeAttribute(groupColor);
    const groupWrap = document.createElement('div');
    groupWrap.className = 'selected-tabs-group';
    groupWrap.innerHTML = `
      <div class="selected-group-label" style="--group-color: ${safeGroupColor}">
        <span>${this.escapeHtml(groupLabel)}</span>
        <span class="selected-group-count">${tabs.length}</span>
      </div>
      <div class="selected-tabs-chips"></div>
    `;

    const chipsRow = groupWrap.querySelector('.selected-tabs-chips');
    if (!chipsRow) {
      this.elements.selectedTabsBar.appendChild(groupWrap);
      return;
    }

    tabs.forEach((tab: any) => {
      const chip = document.createElement('div');
      chip.className = 'selected-tab-chip';
      chip.innerHTML = `
        <span>${this.escapeHtml(tab.title?.substring(0, 25) || 'Aba')}${tab.title?.length > 25 ? '...' : ''}</span>
        <button title="Remover">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;
      const removeBtn = chip.querySelector('button');
      removeBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        this.selectedTabs.delete(tab.id);
        this.updateSelectedTabsBar();
        this.updateTabSelectorButton();
        this.syncRenderedTabSelection([tab.id]);
      });
      chipsRow.appendChild(chip);
    });

    this.elements.selectedTabsBar.appendChild(groupWrap);
  });
};

(SidePanelUI.prototype as any).updateTabSelectorButton = function updateTabSelectorButton() {
  const count = this.selectedTabs.size;
  if (count > 0) {
    this.elements.tabSelectorBtn.classList.add('has-selection');
    this.elements.tabSelectorBtn.dataset.count = String(count);
  } else {
    this.elements.tabSelectorBtn.classList.remove('has-selection');
    delete this.elements.tabSelectorBtn.dataset.count;
  }
  if (this.elements.tabSelectorSummary) {
    this.elements.tabSelectorSummary.textContent =
      count > 0 ? `${count} selecionada${count > 1 ? 's' : ''}` : 'Nenhuma aba selecionada';
  }
};

(SidePanelUI.prototype as any).mapGroupColor = function mapGroupColor(colorName: string) {
  const palette: Record<string, string> = {
    grey: '#9aa0a6',
    blue: '#4c8bf5',
    red: '#ea4335',
    yellow: '#fbbc04',
    green: '#34a853',
    pink: '#f06292',
    purple: '#a142f4',
    cyan: '#24c1e0',
    orange: '#f29900',
  };
  return palette[colorName] || 'var(--muted-dim)';
};

(SidePanelUI.prototype as any).formatTabLabel = function formatTabLabel(url?: string) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

(SidePanelUI.prototype as any).getSelectedTabsContext = function getSelectedTabsContext() {
  if (this.selectedTabs.size === 0) return '';

  const lines = Array.from(this.selectedTabs.values()).map((tab: any) => {
    const tabTitle = tab.title || 'Sem titulo';
    const groupLabel = tab.groupTitle ? `${tab.groupTitle} - ` : '';
    const urlLabel = tab.url || '';
    return `- ${groupLabel}"${tabTitle}": ${urlLabel}`;
  });
  return '\n\n[Contexto das abas selecionadas:]\n' + lines.join('\n') + '\n';
};
