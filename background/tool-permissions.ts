// Single source of truth for how browser tools map to user-facing permission
// categories. Kept in its own module so the mapping is unit-testable without
// loading the whole background service worker.

export type ToolPermissionCategory =
  | 'navigate'
  | 'interact'
  | 'read'
  | 'sensitiveDataRead'
  | 'screenshots'
  | 'tabs'
  | 'clipboard'
  | 'fileUpload'
  | 'scripting'
  | 'downloads';

const TOOL_PERMISSION_MAP: Record<string, ToolPermissionCategory> = {
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
  clipboard: 'clipboard',
  setInputFiles: 'fileUpload',
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
  getStorageData: 'sensitiveDataRead',
  getNetworkRequests: 'sensitiveDataRead',
  getConsoleOutput: 'sensitiveDataRead',
  getPerformanceMetrics: 'sensitiveDataRead',
  // Network allowlist / method split is out of scope (segurança-api).
  httpRequest: 'read',
  executeScript: 'scripting',
  // CDP está sempre disponível; segue a permissão geral de interação.
  cdp: 'interact',
};

export function getToolPermissionCategory(toolName: string): ToolPermissionCategory | null {
  return TOOL_PERMISSION_MAP[toolName] || null;
}

// Opt-in categories: deny unless the user explicitly enables them.
const OPT_IN_TOOL_PERMISSIONS = new Set<ToolPermissionCategory>([
  'scripting',
  'sensitiveDataRead',
  'clipboard',
  'fileUpload',
  'downloads',
]);

export const DEFAULT_TOOL_PERMISSIONS: Record<ToolPermissionCategory, boolean> = {
  read: true,
  interact: true,
  navigate: true,
  tabs: true,
  screenshots: true,
  sensitiveDataRead: false,
  clipboard: false,
  fileUpload: false,
  scripting: false,
  downloads: false,
};

export function isToolCategoryAllowed(
  category: ToolPermissionCategory | null,
  permissions: Record<string, unknown> = {},
): boolean {
  if (!category) return true;
  if (OPT_IN_TOOL_PERMISSIONS.has(category)) return permissions[category] === true;
  return permissions[category] !== false;
}

/** Stable category order for session-tool cache keys. Matches DEFAULT_TOOL_PERMISSIONS. */
const TOOL_PERMISSION_CACHE_CATEGORIES = Object.keys(DEFAULT_TOOL_PERMISSIONS) as ToolPermissionCategory[];

export function toolPermissionsCacheKey(permissions: Record<string, unknown> = {}): string {
  return TOOL_PERMISSION_CACHE_CATEGORIES.map((category) =>
    isToolCategoryAllowed(category, permissions) ? '1' : '0',
  ).join('');
}
