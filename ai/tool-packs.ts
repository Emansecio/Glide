import { buildToolDefinitions } from '../tools/tool-definitions.js';
import type { ToolDefinition } from '../tools/tool-schema.js';

export type ToolPackName = 'core' | 'forms' | 'extract' | 'diagnostics' | 'tabs' | 'advanced';
export type ToolPackIntent = {
  text?: string;
  activeFailure?: boolean;
  outstandingToolNames?: string[];
};

const PACK_TOOLS: Record<ToolPackName, readonly string[]> = {
  core: ['navigate', 'readPage', 'findElement', 'click', 'type', 'wait', 'scroll', 'dismissModal'],
  forms: ['selectOption', 'fillForm', 'pressKey', 'setInputFiles', 'clipboard', 'highlightElement'],
  extract: ['getContent', 'findInPage', 'extractTable', 'harvestScroll'],
  diagnostics: [
    'getNetworkRequests',
    'getConsoleOutput',
    'getStorageData',
    'getPerformanceMetrics',
    'screenshot',
    'annotatedScreenshot',
    'elementScreenshot',
  ],
  tabs: ['openTab', 'getTabs', 'closeTab', 'switchTab', 'focusTab', 'groupTabs', 'describeSessionTabs', 'navigateHistory'],
  advanced: ['hover', 'mouse', 'executeScript', 'httpRequest', 'cdp', 'captureDownload'],
};

const packForTool = (toolName: string): ToolPackName | undefined =>
  (Object.keys(PACK_TOOLS) as ToolPackName[]).find((pack) => PACK_TOOLS[pack].includes(toolName));

export function selectToolPacks(input: ToolPackIntent): ToolPackName[] {
  const text = String(input.text || '').toLowerCase();
  const selected = new Set<ToolPackName>(['core']);
  if (/\b(form|field|input|select|dropdown|checkbox|radio|fill|submit|upload)\b/.test(text)) selected.add('forms');
  if (/\b(analy[sz]e|extract|table|collect|scrape|harvest|content|report)\b/.test(text)) selected.add('extract');
  if (/\b(tab|tabs|window|history|back|forward)\b/.test(text)) selected.add('tabs');
  if (/\b(hover|drag|script|request|download|cdp|native)\b/.test(text)) selected.add('advanced');
  if (input.activeFailure || /\b(debug|diagnos|console|network|screenshot|storage|performance)\b/.test(text)) {
    selected.add('diagnostics');
  }
  for (const name of input.outstandingToolNames || []) {
    const pack = packForTool(name);
    if (pack) selected.add(pack);
  }
  const order: ToolPackName[] = ['core', 'forms', 'extract', 'diagnostics', 'tabs', 'advanced'];
  return order.filter((pack) => selected.has(pack));
}

export function filterToolDefinitionsForPacks(
  definitions: ToolDefinition[],
  packs: ToolPackName[],
): ToolDefinition[] {
  const allowed = new Set(packs.flatMap((pack) => [...PACK_TOOLS[pack]]));
  const browserToolNames = new Set(Object.values(PACK_TOOLS).flatMap((names) => [...names]));
  return definitions.filter((definition) => !browserToolNames.has(definition.name) || allowed.has(definition.name));
}

export function buildPackedToolDefinitions(packs: ToolPackName[], maxSessionTabs: number): ToolDefinition[] {
  return filterToolDefinitionsForPacks(buildToolDefinitions(maxSessionTabs), packs);
}

export const describeToolPackState = (packs: ToolPackName[]): string =>
  `Active browser tool packs: ${packs.join(', ')}.`;
