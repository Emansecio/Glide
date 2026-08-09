export type ToolPresentation = { icon: string; running: string; done: string };

export const PRESS_KEY_MODIFIER_LABELS: Record<string, string> = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Meta: 'Meta',
};

export const WAIT_CONDITION_LABELS: Record<string, string> = {
  time: 'tempo',
  selector: 'seletor visível',
  visible: 'elemento visível',
  hidden: 'elemento oculto',
  dialog: 'modal',
  networkidle: 'rede ociosa',
  networkIdle: 'rede ociosa',
};

export const formatPressKeyPreview = (key: string, modifiers?: string[]): string => {
  const mods = (modifiers || [])
    .map((mod) => PRESS_KEY_MODIFIER_LABELS[String(mod || '').trim()] || String(mod || '').trim())
    .filter(Boolean)
    .join('+');
  return mods ? `${mods}+${key}` : key;
};

export const formatWaitPreview = (condition: string, selector?: string, idleMs?: number): string => {
  const label = WAIT_CONDITION_LABELS[String(condition || '').trim()] || String(condition || 'condição');
  if (selector) return `${label}: ${selector.substring(0, 28)}`;
  if (String(condition).toLowerCase() === 'networkidle' && typeof idleMs === 'number') {
    return `${label} ${idleMs}ms`;
  }
  return label;
};

export const TOOL_ICON_PATHS: Record<string, string> = {
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  plusSquare:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  pointer: '<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  key: '<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  scroll: '<polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>',
  fileText:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  camera:
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  tabs: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
};

export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  navigate: { icon: 'compass', running: 'Navegando', done: 'Navegou' },
  openTab: { icon: 'plusSquare', running: 'Abrindo aba', done: 'Abriu aba' },
  click: { icon: 'pointer', running: 'Clicando', done: 'Clicou' },
  type: { icon: 'type', running: 'Digitando', done: 'Digitou' },
  pressKey: { icon: 'key', running: 'Pressionando tecla', done: 'Pressionou tecla' },
  scroll: { icon: 'scroll', running: 'Rolando a página', done: 'Rolou a página' },
  getContent: { icon: 'fileText', running: 'Lendo a página', done: 'Leu a página' },
  screenshot: { icon: 'camera', running: 'Capturando a tela', done: 'Capturou a tela' },
  annotatedScreenshot: { icon: 'camera', running: 'Capturando tela anotada', done: 'Capturou tela anotada' },
  elementScreenshot: { icon: 'camera', running: 'Capturando elemento', done: 'Capturou elemento' },
  getTabs: { icon: 'tabs', running: 'Listando abas', done: 'Listou abas' },
  closeTab: { icon: 'tabs', running: 'Fechando aba', done: 'Fechou aba' },
  switchTab: { icon: 'tabs', running: 'Trocando de aba', done: 'Trocou de aba' },
  focusTab: { icon: 'tabs', running: 'Focando aba', done: 'Focou aba' },
  groupTabs: { icon: 'tabs', running: 'Agrupando abas', done: 'Agrupou abas' },
  describeSessionTabs: { icon: 'tabs', running: 'Resumindo abas', done: 'Resumiu abas' },
  executeScript: { icon: 'code', running: 'Executando script', done: 'Executou script' },
  httpRequest: { icon: 'activity', running: 'Requisição HTTP', done: 'Requisição HTTP' },
  findElement: { icon: 'search', running: 'Procurando elemento', done: 'Procurou elemento' },
  wait: { icon: 'clock', running: 'Aguardando', done: 'Aguardou' },
  getNetworkRequests: { icon: 'activity', running: 'Inspecionando rede', done: 'Inspecionou rede' },
  getStorageData: { icon: 'database', running: 'Lendo armazenamento', done: 'Leu armazenamento' },
  getPerformanceMetrics: { icon: 'zap', running: 'Medindo desempenho', done: 'Mediu desempenho' },
  getConsoleOutput: { icon: 'terminal', running: 'Lendo console', done: 'Leu console' },
  readPage: { icon: 'search', running: 'Mapeando a página', done: 'Mapeou a página' },
  clipboard: { icon: 'fileText', running: 'Área de transferência', done: 'Área de transferência' },
  setInputFiles: { icon: 'fileText', running: 'Anexando arquivo', done: 'Anexou arquivo' },
  selectOption: { icon: 'type', running: 'Selecionando opção', done: 'Selecionou opção' },
  fillForm: { icon: 'type', running: 'Preenchendo formulário', done: 'Preencheu formulário' },
  navigateHistory: { icon: 'compass', running: 'Navegando no histórico', done: 'Navegou no histórico' },
  highlightElement: { icon: 'pointer', running: 'Destacando elemento', done: 'Destacou elemento' },
  captureDownload: { icon: 'fileText', running: 'Capturando download', done: 'Capturou download' },
  findInPage: { icon: 'search', running: 'Procurando na página', done: 'Procurou na página' },
  extractTable: { icon: 'fileText', running: 'Extraindo tabela', done: 'Extraiu tabela' },
  harvestScroll: { icon: 'scroll', running: 'Coletando rolagem infinita', done: 'Coletou rolagem infinita' },
  mouse: { icon: 'pointer', running: 'Mouse', done: 'Mouse' },
  hover: { icon: 'pointer', running: 'Hover', done: 'Hover' },
  dismissModal: { icon: 'pointer', running: 'Fechando modal', done: 'Fechou modal' },
  cdp: { icon: 'terminal', running: 'CDP', done: 'CDP' },
};

export const getToolPresentation = (toolName: string): ToolPresentation => {
  const known = TOOL_PRESENTATION[String(toolName || '').trim()];
  if (known) return known;
  const label = String(toolName || 'ferramenta');
  return { icon: 'wrench', running: label, done: label };
};

export const buildToolIconSvg = (iconKey: string) => {
  const paths = TOOL_ICON_PATHS[iconKey] || TOOL_ICON_PATHS.wrench;
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
};
