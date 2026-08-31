import { buildToolDefinitions } from '../tools/tool-definitions.js';
import type { ToolDefinition } from '../tools/tool-schema.js';
import { normalizeTaskIntentText } from './task-intent.js';

export type ToolPackName = 'core' | 'forms' | 'extract' | 'diagnostics' | 'tabs' | 'advanced';
export type ToolPackIntent = {
  text?: string;
  activeFailure?: boolean;
  outstandingToolNames?: string[];
  recentToolNames?: string[];
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
  tabs: [
    'openTab',
    'getTabs',
    'closeTab',
    'switchTab',
    'focusTab',
    'groupTabs',
    'describeSessionTabs',
    'navigateHistory',
  ],
  advanced: ['hover', 'mouse', 'executeScript', 'httpRequest', 'cdp', 'captureDownload'],
};

const packForTool = (toolName: string): ToolPackName | undefined =>
  (Object.keys(PACK_TOOLS) as ToolPackName[]).find((pack) => PACK_TOOLS[pack].includes(toolName));

export function selectToolPacks(input: ToolPackIntent): ToolPackName[] {
  const text = normalizeTaskIntentText(input.text);
  const selected = new Set<ToolPackName>(['core']);
  const formsIntent =
    /\b(form|formular\w*|field|campo|input|select|selecion\w*|opcao|dropdown|checkbox|radio|fill|preench\w*|submit|upload|anex\w*|arquivo)\b/.test(
      text,
    );
  const extractIntent =
    /\b(analy[sz]\w*|analis\w*|extract\w*|extrai\w*|table|tabela|collect\w*|colet\w*|scrape|rasp\w*|harvest|content|conteudo|report|relatorio)\b/.test(
      text,
    );
  const tabsIntent = /\b(tab|tabs|aba|abas|window|janela|history|historico|back|voltar|forward|avancar)\b/.test(text);
  const advancedIntent =
    /\b(hover|drag|arrast\w*|script|request|requisicao|download|baixar|baixe|cdp|native|nativo)\b/.test(text);
  const diagnosticsIntent =
    /\b(debug|depur\w*|diagnos\w*|console|network|rede|screenshot|print|storage|armazenamento|performance|desempenho)\b/.test(
      text,
    );
  const explicitCoreIntent =
    /\b(click|clique|clicar|open|abra|abrir|navigate|naveg\w*|scroll|role|rolar|wait|aguard\w*|esper\w*|read|leia|type|digit\w*|dismiss|feche)\b/.test(
      text,
    );
  const continuationIntent =
    /\b(continue|continuar|prossiga|prosseguir|retome|retomar|siga|seguir|next|adiante)\b|de onde parou/.test(text);

  if (formsIntent) selected.add('forms');
  if (extractIntent) selected.add('extract');
  if (tabsIntent) selected.add('tabs');
  if (advancedIntent) selected.add('advanced');
  if (input.activeFailure || diagnosticsIntent) selected.add('diagnostics');

  for (const name of input.outstandingToolNames || []) {
    const pack = packForTool(name);
    if (pack) selected.add(pack);
  }
  if (continuationIntent) {
    for (const name of input.recentToolNames || []) {
      const pack = packForTool(name);
      if (pack) selected.add(pack);
    }
  }

  const hasTaskSpecificPack = [...selected].some(
    (pack) => pack === 'forms' || pack === 'extract' || pack === 'tabs' || pack === 'advanced',
  );
  const uncertainIntent = Boolean(text) && !explicitCoreIntent && !diagnosticsIntent && !hasTaskSpecificPack;
  if (uncertainIntent) {
    // Unknown locale or underspecified continuation: expose safe form/extract schemas
    // rather than fail closed to core. Advanced effect packs still require evidence.
    selected.add('forms');
    selected.add('extract');
  }

  const order: ToolPackName[] = ['core', 'forms', 'extract', 'diagnostics', 'tabs', 'advanced'];
  return order.filter((pack) => selected.has(pack));
}

export function filterToolDefinitionsForPacks(definitions: ToolDefinition[], packs: ToolPackName[]): ToolDefinition[] {
  const allowed = new Set(packs.flatMap((pack) => [...PACK_TOOLS[pack]]));
  const browserToolNames = new Set(Object.values(PACK_TOOLS).flatMap((names) => [...names]));
  return definitions.filter((definition) => !browserToolNames.has(definition.name) || allowed.has(definition.name));
}

export function buildPackedToolDefinitions(packs: ToolPackName[], maxSessionTabs: number): ToolDefinition[] {
  return filterToolDefinitionsForPacks(buildToolDefinitions(maxSessionTabs), packs);
}

export const describeToolPackState = (packs: ToolPackName[]): string =>
  `Active browser tool packs: ${packs.join(', ')}.`;
