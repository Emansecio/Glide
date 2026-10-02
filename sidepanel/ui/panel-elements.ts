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
  chatInterface: byId<HTMLElement>('chatInterface'),
  statusBar: byId<HTMLElement>('statusBar'),
  statusText: byId<HTMLElement>('statusText'),
  statusMeta: byId<HTMLElement>('statusMeta'),
  statusTarget: byId<HTMLElement>('statusTarget'),
  activityPanel: byId<HTMLElement>('activityPanel'),
  activityCloseBtn: byId<HTMLButtonElement>('activityCloseBtn'),
  activityToggleBtn: byId<HTMLButtonElement>('activityToggleBtn'),
  exportExecutionLogBtn: byId<HTMLButtonElement>('exportExecutionLogBtn'),
  toolLog: byId<HTMLElement>('toolLog'),
  sessionUsage: byId<HTMLElement>('sessionUsage'),
  thinkingPanel: byId<HTMLElement>('thinkingPanel'),

  scrollToLatestBtn: byId<HTMLButtonElement>('scrollToLatestBtn'),
  historyPanel: byId<HTMLElement>('historyPanel'),
  historyItems: byId<HTMLElement>('historyItems'),
  historySearch: byId<HTMLInputElement>('historySearch'),
  clearHistoryBtn: byId<HTMLButtonElement>('clearHistoryBtn'),
  startNewSessionBtn: byId<HTMLButtonElement>('startNewSessionBtn'),
  privateSessionBtn: byId<HTMLButtonElement>('privateSessionBtn'),
  settingsTabGeneral: byId<HTMLElement>('settingsTabGeneral'),

  detectModelsBtn: byId<HTMLButtonElement>('detectModelsBtn'),
  anthropicOauthBtn: byId<HTMLButtonElement>('anthropicOauthBtn'),
  codexOauthBtn: byId<HTMLButtonElement>('codexOauthBtn'),

  // Form elements - Provider & model
  provider: byId<HTMLSelectElement>('provider'),
  apiKey: byId<HTMLInputElement>('apiKey'),
  apiKeyGroup: byId<HTMLElement>('apiKeyGroup'),
  model: byId<HTMLSelectElement>('model'),
  customEndpoint: byId<HTMLInputElement>('customEndpoint'),
  customEndpointGroup: byId<HTMLElement>('customEndpointGroup'),

  // Form elements - System prompt
  systemPrompt: byId<HTMLTextAreaElement>('systemPrompt'),
  notifyOnComplete: byId<HTMLInputElement>('notifyOnComplete'),
  permRead: byId<HTMLInputElement>('permRead'),
  permInteract: byId<HTMLInputElement>('permInteract'),
  permNavigate: byId<HTMLInputElement>('permNavigate'),
  permTabs: byId<HTMLInputElement>('permTabs'),
  permScreenshots: byId<HTMLInputElement>('permScreenshots'),
  permSensitiveDataRead: byId<HTMLInputElement>('permSensitiveDataRead'),
  permClipboard: byId<HTMLInputElement>('permClipboard'),
  permFileUpload: byId<HTMLInputElement>('permFileUpload'),
  permDownloads: byId<HTMLInputElement>('permDownloads'),
  permScripting: byId<HTMLInputElement>('permScripting'),
  historyPersistenceSegmented: byId<HTMLElement>('historyPersistenceSegmented'),

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
  stopBtn: byId<HTMLButtonElement>('stopBtn'),
  composer: byId<HTMLElement>('composer'),
  modelSelect: byId<HTMLSelectElement>('modelSelect'),
  modelSelectTrigger: byId<HTMLButtonElement>('modelSelectTrigger'),
  modelSelectValue: byId<HTMLElement>('modelSelectValue'),
  modelSelectMenu: byId<HTMLElement>('modelSelectMenu'),
  fileBtn: byId<HTMLButtonElement>('fileBtn'),
  fileInput: byId<HTMLInputElement>('fileInput'),
  attachmentsBar: byId<HTMLElement>('attachmentsBar'),
  planDrawer: byId<HTMLElement>('planDrawer'),
  planDrawerToggle: byId<HTMLButtonElement>('planDrawerToggle'),
  planDrawerContent: byId<HTMLElement>('planDrawerContent'),
  planChecklist: byId<HTMLOListElement>('planChecklist'),
  planStepCount: byId<HTMLElement>('planStepCount'),
  planCurrentStep: byId<HTMLElement>('planCurrentStep'),
  planClearBtn: byId<HTMLButtonElement>('planClearBtn'),
});
