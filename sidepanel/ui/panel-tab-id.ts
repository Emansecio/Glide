const PANEL_TAB_STORAGE_KEY = 'glideSidePanelTabId';

export async function resolvePanelTabId(): Promise<number | undefined> {
  let storedTabId: number | undefined;
  try {
    const stored = await chrome.storage.session.get([PANEL_TAB_STORAGE_KEY]);
    if (typeof stored?.[PANEL_TAB_STORAGE_KEY] === 'number') {
      storedTabId = stored[PANEL_TAB_STORAGE_KEY];
    }
  } catch {
    // storage.session may be unavailable in some environments
  }

  if (typeof storedTabId === 'number') {
    try {
      const tab = await chrome.tabs.get(storedTabId);
      if (typeof tab?.id === 'number') {
        return tab.id;
      }
    } catch {
      // Owner tab was closed; fall through to active-tab query.
    }
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return typeof activeTab?.id === 'number' ? activeTab.id : undefined;
}
