/** Maps tool names to BrowserTools method names used by executeTool. */
export const TOOL_HANDLER_REGISTRY: Record<string, string> = {
  navigate: 'navigate',
  openTab: 'openTab',
  click: 'click',
  hover: 'hover',
  mouse: 'mouse',
  type: 'type',
  pressKey: 'pressKey',
  scroll: 'scroll',
  getContent: 'getContent',
  screenshot: 'screenshot',
  getTabs: 'getTabs',
  closeTab: 'closeTab',
  switchTab: 'focusTab',
  focusTab: 'focusTab',
  groupTabs: 'groupTabs',
  executeScript: 'executeScript',
  getNetworkRequests: 'getNetworkRequests',
  findElement: 'findElement',
  wait: 'wait',
  dismissModal: 'dismissModal',
  getStorageData: 'getStorageData',
  getPerformanceMetrics: 'getPerformanceMetrics',
  getConsoleOutput: 'getConsoleOutput',
};

/** Tools handled inline in executeTool rather than via a class method. */
export const INLINE_TOOL_HANDLERS = new Set(['describeSessionTabs']);
