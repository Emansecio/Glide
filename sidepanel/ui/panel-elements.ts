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
  settingsBtn: byId<HTMLButtonElement>('settingsBtn'),
  newChatBtn: byId<HTMLButtonElement>('newChatBtn'),
  settingsPanel: byId<HTMLElement>('settingsPanel'),
  chatInterface: byId<HTMLElement>('chatInterface'),
  statusBar: byId<HTMLElement>('statusBar'),
  statusText: byId<HTMLElement>('statusText'),
  statusMeta: byId<HTMLElement>('statusMeta'),
  activityPanel: byId<HTMLElement>('activityPanel'),
  activityCloseBtn: byId<HTMLButtonElement>('activityCloseBtn'),
  activityToggleBtn: byId<HTMLButtonElement>('activityToggleBtn'),
  toolLog: byId<HTMLElement>('toolLog'),
  thinkingPanel: byId<HTMLElement>('thinkingPanel'),
  agentNav: byId<HTMLElement>('agentNav'),

  tabSelectorBtn: byId<HTMLButtonElement>('tabSelectorBtn'),
  tabSelector: byId<HTMLElement>('tabSelector'),
  tabSelectorSummary: byId<HTMLElement>('tabSelectorSummary'),
  tabSelectorAddActive: byId<HTMLButtonElement>('tabSelectorAddActive'),
  tabSelectorClear: byId<HTMLButtonElement>('tabSelectorClear'),
  tabList: byId<HTMLElement>('tabList'),
  closeTabSelector: byId<HTMLButtonElement>('closeTabSelector'),
  selectedTabsBar: byId<HTMLElement>('selectedTabsBar'),
  scrollToLatestBtn: byId<HTMLButtonElement>('scrollToLatestBtn'),
  viewChatBtn: byId<HTMLButtonElement>('viewChatBtn'),
  viewHistoryBtn: byId<HTMLButtonElement>('viewHistoryBtn'),
  historyPanel: byId<HTMLElement>('historyPanel'),
  historyItems: byId<HTMLElement>('historyItems'),
  clearHistoryBtn: byId<HTMLButtonElement>('clearHistoryBtn'),
  startNewSessionBtn: byId<HTMLButtonElement>('startNewSessionBtn'),
  settingsTabGeneralBtn: byId<HTMLButtonElement>('settingsTabGeneralBtn'),
  settingsTabProfilesBtn: byId<HTMLButtonElement>('settingsTabProfilesBtn'),
  settingsTabGeneral: byId<HTMLElement>('settingsTabGeneral'),
  settingsTabProfiles: byId<HTMLElement>('settingsTabProfiles'),
  newProfileNameInput: byId<HTMLInputElement>('newProfileNameInput'),
  createProfileBtn: byId<HTMLButtonElement>('createProfileBtn'),
  openGeneralBtn: byId<HTMLButtonElement>('openGeneralBtn'),
  openProfilesBtn: byId<HTMLButtonElement>('openProfilesBtn'),
  generalProfileSelect: byId<HTMLSelectElement>('generalProfileSelect'),
  profileEditorTitle: byId<HTMLElement>('profileEditorTitle'),
  profileEditorName: byId<HTMLInputElement>('profileEditorName'),
  profileEditorProvider: byId<HTMLSelectElement>('profileEditorProvider'),
  profileEditorApiKey: byId<HTMLInputElement>('profileEditorApiKey'),
  profileEditorModel: byId<HTMLInputElement>('profileEditorModel'),
  profileEditorEndpoint: byId<HTMLInputElement>('profileEditorEndpoint'),
  profileEditorEndpointGroup: byId<HTMLElement>('profileEditorEndpointGroup'),
  profileEditorTemperature: byId<HTMLInputElement>('profileEditorTemperature'),
  profileEditorTemperatureValue: byId<HTMLElement>('profileEditorTemperatureValue'),
  profileEditorMaxTokens: byId<HTMLInputElement>('profileEditorMaxTokens'),
  profileEditorTimeout: byId<HTMLInputElement>('profileEditorTimeout'),
  profileEditorEnableScreenshots: byId<HTMLInputElement>('profileEditorEnableScreenshots'),
  profileEditorSendScreenshots: byId<HTMLInputElement>('profileEditorSendScreenshots'),
  profileEditorScreenshotQuality: byId<HTMLSelectElement>('profileEditorScreenshotQuality'),
  profileEditorPrompt: byId<HTMLTextAreaElement>('profileEditorPrompt'),
  saveProfileBtn: byId<HTMLButtonElement>('saveProfileBtn'),
  permissionRead: byId<HTMLInputElement>('permissionRead'),
  permissionInteract: byId<HTMLInputElement>('permissionInteract'),
  permissionNavigate: byId<HTMLInputElement>('permissionNavigate'),
  permissionTabs: byId<HTMLInputElement>('permissionTabs'),
  permissionScreenshots: byId<HTMLInputElement>('permissionScreenshots'),
  allowedDomains: byId<HTMLTextAreaElement>('allowedDomains'),
  exportSettingsBtn: byId<HTMLButtonElement>('exportSettingsBtn'),
  importSettingsBtn: byId<HTMLButtonElement>('importSettingsBtn'),
  importSettingsInput: byId<HTMLInputElement>('importSettingsInput'),

  // Form elements - Provider & model
  provider: byId<HTMLSelectElement>('provider'),
  apiKey: byId<HTMLInputElement>('apiKey'),
  model: byId<HTMLInputElement>('model'),
  customEndpoint: byId<HTMLInputElement>('customEndpoint'),
  customEndpointGroup: byId<HTMLElement>('customEndpointGroup'),

  // Form elements - Model parameters
  temperature: byId<HTMLInputElement>('temperature'),
  temperatureValue: byId<HTMLElement>('temperatureValue'),
  maxTokens: byId<HTMLInputElement>('maxTokens'),
  contextLimit: byId<HTMLInputElement>('contextLimit'),
  timeout: byId<HTMLInputElement>('timeout'),

  // Form elements - Screenshots & vision
  enableScreenshots: byId<HTMLInputElement>('enableScreenshots'),
  sendScreenshotsAsImages: byId<HTMLInputElement>('sendScreenshotsAsImages'),
  screenshotQuality: byId<HTMLSelectElement>('screenshotQuality'),
  visionBridge: byId<HTMLInputElement>('visionBridge'),
  visionProfile: byId<HTMLSelectElement>('visionProfile'),

  // Form elements - Behavior
  showThinking: byId<HTMLInputElement>('showThinking'),
  streamResponses: byId<HTMLInputElement>('streamResponses'),
  autoScroll: byId<HTMLSelectElement>('autoScroll'),
  confirmActions: byId<HTMLInputElement>('confirmActions'),
  saveHistory: byId<HTMLInputElement>('saveHistory'),

  // Form elements - Orchestrator
  orchestratorToggle: byId<HTMLInputElement>('orchestratorToggle') ?? byId<HTMLInputElement>('useOrchestrator'),
  orchestratorProfile: byId<HTMLSelectElement>('orchestratorProfile'),

  // Form elements - System prompt
  systemPrompt: byId<HTMLTextAreaElement>('systemPrompt'),

  // Settings actions
  saveSettingsBtn: byId<HTMLButtonElement>('saveSettingsBtn'),
  cancelSettingsBtn: byId<HTMLButtonElement>('cancelSettingsBtn'),

  // Profile management
  activeConfig: byId<HTMLSelectElement>('activeConfig'),
  newConfigBtn: byId<HTMLButtonElement>('newConfigBtn'),
  deleteConfigBtn: byId<HTMLButtonElement>('deleteConfigBtn'),
  refreshProfilesBtn: byId<HTMLButtonElement>('refreshProfilesBtn'),
  agentGrid: byId<HTMLElement>('agentGrid'),

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
  planStatus: byId<HTMLElement>('planStatus'),
  planDrawer: byId<HTMLElement>('planDrawer'),
  planDrawerToggle: byId<HTMLButtonElement>('planDrawerToggle'),
  planDrawerContent: byId<HTMLElement>('planDrawerContent'),
  planChecklist: byId<HTMLOListElement>('planChecklist'),
  planStepCount: byId<HTMLElement>('planStepCount'),
  planClearBtn: byId<HTMLButtonElement>('planClearBtn'),
});
