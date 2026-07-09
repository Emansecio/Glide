export type TabResolution = {
  tabId: number;
  tab: chrome.tabs.Tab;
  requestedTabId: number | null;
  fallbackUsed: boolean;
};

export type TabResolveResult = { ok: true; resolution: TabResolution } | { ok: false; result: Record<string, any> };

export type TabResolvable = {
  resolveExecutableTab(args: Record<string, any>, toolName: string): Promise<TabResolveResult>;
};

export const withResolvedTab = async <T extends Record<string, any>>(
  tools: TabResolvable,
  args: Record<string, any>,
  toolName: string,
  handler: (resolution: TabResolution) => Promise<T>,
): Promise<T> => {
  const resolved = await tools.resolveExecutableTab(args, toolName);
  if (!resolved.ok) {
    return resolved.result as T;
  }
  return handler(resolved.resolution);
};
