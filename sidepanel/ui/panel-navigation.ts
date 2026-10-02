import type { SidePanelElements } from './panel-elements.js';
import { setSidebarOpen } from './panel-navigation-helpers.js';
import { SidePanelUI } from './panel-ui.js';
// Re-export the pure helpers so existing importers of this module keep working.

type NavigationHandlers = {
  onOpen: () => void;
  onClose: () => void;
  onChat: () => void;
  onHistory: () => void;
  onSettings: () => void;
};

export const bindSidebarNavigation = (elements: SidePanelElements, handlers: NavigationHandlers) => {
  elements.openSidebarBtn?.addEventListener('click', () => {
    const sidebar = elements.sidebar;
    if (!sidebar) {
      handlers.onOpen();
      return;
    }
    if (sidebar.classList.contains('closed')) {
      handlers.onOpen();
    } else {
      handlers.onClose();
    }
  });
  elements.closeSidebarBtn?.addEventListener('click', handlers.onClose);
  elements.sidebarBackdrop?.addEventListener('click', handlers.onClose);

  // Bind nav buttons
  elements.navChatBtn?.addEventListener('click', handlers.onChat);
  elements.navHistoryBtn?.addEventListener('click', handlers.onHistory);
  elements.navSettingsBtn?.addEventListener('click', handlers.onSettings);
};

SidePanelUI.prototype.openSidebar = function openSidebar() {
  setSidebarOpen(this.elements, true);
};

SidePanelUI.prototype.closeSidebar = function closeSidebar() {
  setSidebarOpen(this.elements, false);
};
