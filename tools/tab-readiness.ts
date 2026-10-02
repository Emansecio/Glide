import { isBridgeAvailable } from './content-bridge.js';
import { isHttpUrl } from './validation.js';

export type TabReadinessSnapshot = {
  status?: string;
  url?: string;
};

export type TabReadinessResult = {
  ready: boolean;
  loadComplete: boolean;
  bridgeReady: boolean;
  url: string;
  warning?: string;
};

export const isTabLoadComplete = (tab: TabReadinessSnapshot | null | undefined) =>
  tab?.status === 'complete' && isHttpUrl(tab.url);

/**
 * Espera `delayMs` ou o próximo `tabs.onUpdated` da aba, o que vier primeiro: a
 * página que termina de carregar logo depois de uma sondagem não espera o resto
 * do intervalo. O intervalo continua como rede de segurança.
 */
const waitForTabUpdate = (tabId: number, delayMs: number) =>
  new Promise<void>((resolve) => {
    const onUpdated = chrome.tabs?.onUpdated;
    const listener = (updatedTabId: number) => {
      if (updatedTabId === tabId) done();
    };
    const timer = setTimeout(() => done(), delayMs);
    const done = () => {
      clearTimeout(timer);
      onUpdated?.removeListener(listener);
      resolve();
    };
    onUpdated?.addListener(listener);
  });

export async function waitForTabReadiness(
  tabId: number,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    getTab?: (id: number) => Promise<TabReadinessSnapshot>;
    probeBridge?: (id: number, timeoutMs: number) => Promise<boolean>;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<TabReadinessResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const getTab = options.getTab ?? ((id: number) => chrome.tabs.get(id));
  const probeBridge = options.probeBridge ?? isBridgeAvailable;
  const sleep = options.sleep ?? ((delayMs: number) => waitForTabUpdate(tabId, delayMs));
  const startedAt = Date.now();
  let lastTab: TabReadinessSnapshot | null = null;
  let loadComplete = false;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastTab = await getTab(tabId);
      loadComplete = isTabLoadComplete(lastTab);
      if (loadComplete) {
        const remainingMs = Math.max(100, timeoutMs - (Date.now() - startedAt));
        const bridgeReady = await probeBridge(tabId, Math.min(750, remainingMs));
        if (bridgeReady) {
          return {
            ready: true,
            loadComplete: true,
            bridgeReady: true,
            url: lastTab.url || '',
          };
        }
      }
    } catch {
      // The tab may be transitioning between documents; retry until the bounded deadline.
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  return {
    ready: false,
    loadComplete,
    bridgeReady: false,
    url: lastTab?.url || '',
    warning: loadComplete
      ? 'Page loaded, but the automation bridge is not ready. Call wait or inspect page structure before acting.'
      : 'Navigation was accepted, but the page is still loading. Call wait before the next browser action.',
  };
}

export type HistoryTransitionResult = {
  moved: boolean;
  url: string;
  status?: string;
};

/**
 * After history.back/forward/reload, wait for URL change or a loading→complete transition.
 * Back/forward with no history returns moved:false; reload legitimately keeps the same URL.
 */
export async function waitForHistoryTransition(
  tabId: number,
  preUrl: string,
  action: 'back' | 'forward' | 'reload',
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    getTab?: (id: number) => Promise<TabReadinessSnapshot>;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<HistoryTransitionResult> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const getTab = options.getTab ?? ((id: number) => chrome.tabs.get(id));
  const sleep = options.sleep ?? ((delayMs: number) => waitForTabUpdate(tabId, delayMs));
  const startedAt = Date.now();
  let sawLoading = false;
  let lastUrl = preUrl;
  let lastStatus: string | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const tab = await getTab(tabId);
      lastUrl = tab.url || lastUrl;
      lastStatus = tab.status;
      if (action === 'reload') {
        if (tab.status === 'loading') sawLoading = true;
        if (sawLoading && tab.status === 'complete') {
          return { moved: true, url: lastUrl, status: lastStatus };
        }
      } else if (lastUrl !== preUrl) {
        return { moved: true, url: lastUrl, status: lastStatus };
      }
      if (tab.status === 'loading' && action !== 'reload') {
        sawLoading = true;
      }
      if (sawLoading && tab.status === 'complete' && lastUrl !== preUrl) {
        return { moved: true, url: lastUrl, status: lastStatus };
      }
    } catch {
      // Tab may be mid-navigation.
    }
    await sleep(pollIntervalMs);
  }

  return { moved: false, url: lastUrl, status: lastStatus };
}
