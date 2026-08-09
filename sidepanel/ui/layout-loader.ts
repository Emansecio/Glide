const loadTemplate = async (path: string) => {
  const url = chrome.runtime.getURL(`sidepanel/templates/${path}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to load template: ${path}`);
    }
    return response.text();
  } finally {
    clearTimeout(timeoutId);
  }
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

  const [sidebarShell, mainContent, historyPanel, settingsPanel, settingsGeneral, oauthHelp] = await Promise.all([
    loadTemplate('sidebar-shell.html'),
    loadTemplate('main.html'),
    loadTemplate('panels/history.html'),
    loadTemplate('panels/settings.html'),
    loadTemplate('panels/settings-general.html'),
    loadTemplate('modals/oauth-help.html'),
  ]);

  appRoot.className = 'app-container';
  appRoot.innerHTML = '';
  const appContainer = appRoot as HTMLElement;

  appContainer.insertAdjacentHTML('beforeend', sidebarShell.trim());
  appContainer.insertAdjacentHTML('beforeend', mainContent.trim());

  const rightPanels = appContainer.querySelector('#rightPanelPanels') as HTMLElement | null;
  rightPanels?.insertAdjacentHTML('beforeend', (historyPanel + settingsPanel).trim());

  replaceWithHtml(appContainer, '#settingsTabGeneral', settingsGeneral);

  const modalRoot = document.getElementById('modalRoot');
  if (modalRoot) {
    modalRoot.innerHTML = oauthHelp.trim();
  }
};
