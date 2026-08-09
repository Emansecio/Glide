import type { SidePanelElements } from './panel-elements.js';

// Pure navigation helpers with NO dependency on SidePanelUI. Kept separate so
// panel-ui.ts can use them without importing panel-navigation.ts, which would
// create a circular import (panel-navigation augments SidePanelUI.prototype at
// load time, so importing it back into panel-ui leaves SidePanelUI undefined).

export type RightPanelName = 'history' | 'settings' | null;
export type NavName = 'chat' | 'history' | 'settings';

const PANEL_SELECTOR = '.right-panel-content';

export const setSidebarOpen = (elements: SidePanelElements, open: boolean) => {
  const sidebar = elements.sidebar as HTMLElement | null;
  if (sidebar) {
    const activeElement = document.activeElement;
    const shouldRestoreFocus = !open && activeElement instanceof HTMLElement && sidebar.contains(activeElement);

    sidebar.classList.toggle('closed', !open);
    sidebar.toggleAttribute('inert', !open);
    sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');

    if (shouldRestoreFocus) {
      const returnTarget = elements.openSidebarBtn as HTMLButtonElement | null;
      window.requestAnimationFrame(() => returnTarget?.focus());
    }
  }
  elements.sidebarBackdrop?.classList.toggle('visible', open);
};

export const showRightPanel = (elements: SidePanelElements, panelName: RightPanelName) => {
  const container = elements.rightPanelPanels ?? elements.rightPanel;
  if (!container) {
    return;
  }

  // Hide all panels
  const panels = container.querySelectorAll(PANEL_SELECTOR);
  panels.forEach((panel) => (panel as HTMLElement).classList.add('hidden'));

  if (!panelName) return;

  // Show the target panel
  const targetPanel = container.querySelector(`${PANEL_SELECTOR}[data-panel="${panelName}"]`) as HTMLElement | null;
  if (targetPanel) {
    targetPanel?.classList.remove('hidden');
  } else {
    // Fallback: try rightPanel directly in case of layout mismatch.
    if (elements.rightPanel) {
      const fallbackPanel = elements.rightPanel.querySelector(
        `${PANEL_SELECTOR}[data-panel="${panelName}"]`,
      ) as HTMLElement | null;
      if (fallbackPanel) {
        fallbackPanel.classList.remove('hidden');
      }
    }
  }
};

export const updateNavActive = (elements: SidePanelElements, navName: NavName) => {
  const items: Array<{ el: HTMLButtonElement | null | undefined; name: NavName }> = [
    { el: elements.navChatBtn, name: 'chat' },
    { el: elements.navHistoryBtn, name: 'history' },
    { el: elements.navSettingsBtn, name: 'settings' },
  ];

  for (const { el, name } of items) {
    if (!el) continue;
    const isActive = name === navName;
    el.classList.toggle('active', isActive);
    if (isActive) {
      el.setAttribute('aria-current', 'page');
    } else {
      el.removeAttribute('aria-current');
    }
  }
};
