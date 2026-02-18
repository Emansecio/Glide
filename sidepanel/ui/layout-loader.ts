const loadTemplate = async (path: string) => {
  const url = chrome.runtime.getURL(`sidepanel/templates/${path}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load template: ${path}`);
  }
  return response.text();
};

const replaceWithHtml = (root: HTMLElement, selector: string, html: string) => {
  const target = root.querySelector(selector);
  if (!target) return;
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const element = template.content.firstElementChild;
  if (element) {
    target.replaceWith(element);
  }
};

export const loadPanelLayout = async () => {
  const appRoot = document.getElementById('appRoot');
  if (!appRoot) return;

  const [
    sidebarShell,
    mainContent,
    historyPanel,
    settingsPanel,
    settingsGeneral,
    settingsProfiles,
    tabSelector,
  ] = await Promise.all([
    loadTemplate('sidebar-shell.html'),
    loadTemplate('main.html'),
    loadTemplate('panels/history.html'),
    loadTemplate('panels/settings.html'),
    loadTemplate('panels/settings-general.html'),
    loadTemplate('panels/settings-profiles.html'),
    loadTemplate('tab-selector.html'),
  ]);

  appRoot.className = 'app-container';
  appRoot.innerHTML = '';
  const appContainer = appRoot as HTMLElement;

  appContainer.insertAdjacentHTML('beforeend', sidebarShell.trim());
  appContainer.insertAdjacentHTML('beforeend', mainContent.trim());

  const rightPanels = appContainer.querySelector('#rightPanelPanels') as HTMLElement | null;
  rightPanels?.insertAdjacentHTML('beforeend', (historyPanel + settingsPanel).trim());

  replaceWithHtml(appContainer, '#settingsTabGeneral', settingsGeneral);
  replaceWithHtml(appContainer, '#settingsTabProfiles', settingsProfiles);

  const modalRoot = document.getElementById('modalRoot');
  if (modalRoot) {
    modalRoot.innerHTML = tabSelector;
  }
};
