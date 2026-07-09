type NullableElement<T extends Element> = T | null;

const byId = <T extends HTMLElement>(id: string): NullableElement<T> =>
  document.getElementById(id) as NullableElement<T>;
const bySelector = <T extends Element>(selector: string): NullableElement<T> =>
  document.querySelector(selector) as NullableElement<T>;

export type SidePanelElements = Record<string, any>;

export const getSidePanelElements = (): SidePanelElements => ({
  // Sidebar elements
  sidebar: byId<HTMLElement>('sidebar'),
  sidebarBackdrop: byId<HTMLElement>('sidebarBackdrop'),
  openSidebarBtn: byId<HTMLButtonElement>('openSidebarBtn'),
  closeSidebarBtn: byId<HTMLButtonElement>('closeSidebarBtn'),
  navChatBtn: byId<HTMLButtonElement>('navChatBtn'),
  navHistoryBtn: byId<HTMLButtonElement>('navHistoryBtn'),
  navSettingsBtn: byId<HTMLButtonElement>('navSettingsBtn'),
  rightPanel: byId<HTMLElement>('rightPanel'),
  rightPanelPanels: byId<HTMLElement>('rightPanelPanels') ?? bySelector<HTMLElement>('.right-panel-panels'),

  // Legacy references (kept for compatibility)
  newChatBtn: byId<HTMLButtonElement>('newChatBtn'),
  settingsPanel: byId<HTMLElement>('settingsPanel'),
  chatInterface: byId<HTMLElement>('chatInterface'),
  statusBar: byId<HTMLElement>('statusBar'),
  statusText: byId<HTMLElement>('statusText'),
  statusMeta: byId<HTMLElement>('statusMeta'),
  activityPanel: byId<HTMLElement>('activityPanel'),
  activityCloseBtn: byId<HTMLButtonElement>('activityCloseBtn'),
  activityToggleBtn: byId<HTMLButtonElement>('activityToggleBtn'),
  exportExecutionLogBtn: byId<HTMLButtonElement>('exportExecutionLogBtn'),
  toolLog: byId<HTMLElement>('toolLog'),
  thinkingPanel: byId<HTMLElement>('thinkingPanel'),
  agentNav: byId<HTMLElement>('agentNav'),

  scrollToLatestBtn: byId<HTMLButtonElement>('scrollToLatestBtn'),
  historyPanel: byId<HTMLElement>('historyPanel'),
  historyItems: byId<HTMLElement>('historyItems'),
  clearHistoryBtn: byId<HTMLButtonElement>('clearHistoryBtn'),
  startNewSessionBtn: byId<HTMLButtonElement>('startNewSessionBtn'),
  settingsTabGeneral: byId<HTMLElement>('settingsTabGeneral'),

  detectModelsBtn: byId<HTMLButtonElement>('detectModelsBtn'),
  codexOauthBtn: byId<HTMLButtonElement>('codexOauthBtn'),

  // Form elements - Provider & model
  provider: byId<HTMLSelectElement>('provider'),
  apiKey: byId<HTMLInputElement>('apiKey'),
  apiKeyGroup: byId<HTMLElement>('apiKeyGroup'),
  model: byId<HTMLInputElement>('model'),
  customEndpoint: byId<HTMLInputElement>('customEndpoint'),
  customEndpointGroup: byId<HTMLElement>('customEndpointGroup'),

  // Form elements - System prompt
  systemPrompt: byId<HTMLTextAreaElement>('systemPrompt'),

  // Settings actions
  saveSettingsBtn: byId<HTMLButtonElement>('saveSettingsBtn'),
  cancelSettingsBtn: byId<HTMLButtonElement>('cancelSettingsBtn'),
  importCredentialsBtn: byId<HTMLButtonElement>('importCredentialsBtn'),
  oauthHelpBtn: byId<HTMLButtonElement>('oauthHelpBtn'),
  credentialsFileInput: byId<HTMLInputElement>('credentialsFileInput'),
  oauthHelpModal: byId<HTMLElement>('oauthHelpModal'),
  closeOauthHelpBtn: byId<HTMLButtonElement>('closeOauthHelpBtn'),
  closeOauthHelpBtnOk: byId<HTMLButtonElement>('closeOauthHelpBtnOk'),
  oauthHelpModalBackdrop: byId<HTMLElement>('oauthHelpModalBackdrop'),

  // Chat interface
  chatMessages: byId<HTMLElement>('chatMessages'),
  chatEmptyState: byId<HTMLElement>('chatEmptyState'),
  userInput: byId<HTMLTextAreaElement>('userInput'),
  sendBtn: byId<HTMLButtonElement>('sendBtn'),
  composer: byId<HTMLElement>('composer'),
  modelSelect: byId<HTMLSelectElement>('modelSelect'),
  modelSelectTrigger: byId<HTMLButtonElement>('modelSelectTrigger'),
  modelSelectValue: byId<HTMLElement>('modelSelectValue'),
  modelSelectMenu: byId<HTMLElement>('modelSelectMenu'),
  fileBtn: byId<HTMLButtonElement>('fileBtn'),
  fileInput: byId<HTMLInputElement>('fileInput'),
  attachmentsBar: byId<HTMLElement>('attachmentsBar'),
  planStatus: byId<HTMLElement>('planStatus'),
  planDrawer: byId<HTMLElement>('planDrawer'),
  planDrawerToggle: byId<HTMLButtonElement>('planDrawerToggle'),
  planDrawerContent: byId<HTMLElement>('planDrawerContent'),
  planChecklist: byId<HTMLOListElement>('planChecklist'),
  planStepCount: byId<HTMLElement>('planStepCount'),
  planClearBtn: byId<HTMLButtonElement>('planClearBtn'),
});
