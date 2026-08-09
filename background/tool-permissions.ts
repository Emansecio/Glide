// Single source of truth for how browser tools map to user-facing permission
// categories. Kept in its own module so the mapping is unit-testable without
// loading the whole background service worker.

export type ToolPermissionCategory =
  | 'navigate'
  | 'interact'
  | 'read'
  | 'screenshots'
  | 'tabs'
  | 'scripting'
  | 'downloads'
  | 'debugger';

export const TOOL_PERMISSION_MAP: Record<string, ToolPermissionCategory> = {
  navigate: 'navigate',
  openTab: 'navigate',
  click: 'interact',
  type: 'interact',
  pressKey: 'interact',
  scroll: 'interact',
  hover: 'interact',
  mouse: 'interact',
  dismissModal: 'interact',
  wait: 'interact',
  clipboard: 'interact',
  setInputFiles: 'interact',
  selectOption: 'interact',
  fillForm: 'interact',
  highlightElement: 'interact',
  navigateHistory: 'navigate',
  captureDownload: 'downloads',
  findInPage: 'read',
  extractTable: 'read',
  harvestScroll: 'read',
  getContent: 'read',
  findElement: 'read',
  readPage: 'read',
  screenshot: 'screenshots',
  annotatedScreenshot: 'screenshots',
  elementScreenshot: 'screenshots',
  getTabs: 'tabs',
  closeTab: 'tabs',
  switchTab: 'tabs',
  groupTabs: 'tabs',
  focusTab: 'tabs',
  describeSessionTabs: 'tabs',
  // Data-inspection tools read cookies, storage, traffic and console output.
  // They belong to the "read" category so the read toggle can disable them.
  getStorageData: 'read',
  getNetworkRequests: 'read',
  getConsoleOutput: 'read',
  getPerformanceMetrics: 'read',
  // Extension-host HTTP (outside page CSP). Treated as read/network inspection.
  httpRequest: 'read',
  // Arbitrary JS execution in the page — its own opt-in category.
  executeScript: 'scripting',
  // chrome.debugger / CDP — opt-in only (yellow infobar).
  cdp: 'debugger',
};

export function getToolPermissionCategory(toolName: string): ToolPermissionCategory | null {
  return TOOL_PERMISSION_MAP[toolName] || null;
}

// Defaults for each permission category. Page tools (including executeScript)
// are on by default. CDP/debugger stays OFF until the user opts in.
export const DEFAULT_TOOL_PERMISSIONS: Record<ToolPermissionCategory, boolean> = {
  read: true,
  interact: true,
  navigate: true,
  tabs: true,
  screenshots: true,
  scripting: true,
  downloads: true,
  debugger: false,
};

// Most categories: allow unless explicitly false.
// debugger: deny unless explicitly true (opt-in CDP).
export function isToolCategoryAllowed(
  category: ToolPermissionCategory | null,
  permissions: Record<string, unknown> = {},
): boolean {
  if (!category) return true;
  if (category === 'debugger') return permissions.debugger === true;
  return permissions[category] !== false;
}
