// Single source of truth for how browser tools map to user-facing permission
// categories. Kept in its own module so the mapping is unit-testable without
// loading the whole background service worker.

export type ToolPermissionCategory = 'navigate' | 'interact' | 'read' | 'screenshots' | 'tabs' | 'scripting';

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
  getContent: 'read',
  findElement: 'read',
  screenshot: 'screenshots',
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
  // Arbitrary JS execution in the page — its own opt-in category.
  executeScript: 'scripting',
};

export function getToolPermissionCategory(toolName: string): ToolPermissionCategory | null {
  return TOOL_PERMISSION_MAP[toolName] || null;
}

// Default answer for each permission toggle. `scripting` is default-deny:
// arbitrary JS execution in a page is opt-in; everything else is on by default.
export const DEFAULT_TOOL_PERMISSIONS: Record<ToolPermissionCategory, boolean> = {
  read: true,
  interact: true,
  navigate: true,
  tabs: true,
  screenshots: true,
  scripting: false,
};

// A category is granted when its toggle is not explicitly false. `scripting`
// is the exception: it must be explicitly enabled (missing/undefined = denied).
export function isToolCategoryAllowed(
  category: ToolPermissionCategory | null,
  permissions: Record<string, unknown> = {},
): boolean {
  if (!category) return true;
  if (category === 'scripting') return permissions.scripting === true;
  return permissions[category] !== false;
}
