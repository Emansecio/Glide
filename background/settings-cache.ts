import { migrateAnthropicModel } from '../ai/anthropic-options.js';
import { CODEX_CHATGPT_STORAGE_KEY, isJwtToken, isOpenAiApiKey, resolveCodexAuthMode } from '../ai/codex-auth.js';
import { resolveHistoryPersistenceMode } from '../ai/persist-tool-args.js';
import { normalizeProviderModel } from '../ai/providers.js';
import { invalidateRuntimeCaches } from '../ai/runtime-cache.js';
import { resolveSystemPromptMode } from '../ai/system-prompt-mode.js';
import { migrateStoredProvider } from '../ai/sdk-client.js';
import { PROVIDER_API_KEY_FIELDS, providerApiKeyField } from '../sidepanel/ui/settings-keys.js';
import { SETTINGS_STORAGE_KEYS } from '../sidepanel/ui/settings-keys.js';
import { invalidateProviderNetRequestRulesCache } from './provider-net-rules.js';
import { DEFAULT_TOOL_PERMISSIONS } from './tool-permissions.js';

export const RUNTIME_SETTINGS_KEYS = [
  ...SETTINGS_STORAGE_KEYS,
  ...PROVIDER_API_KEY_FIELDS,
  CODEX_CHATGPT_STORAGE_KEY,
  'sendScreenshotsAsImages',
  'screenshotQuality',
  'streamResponses',
  'maxTokens',
  'contextLimit',
  'timeout',
  'enableScreenshots',
  'toolPermissions',
  'historyPersistence',
  'allowedDomains',
  'visionBridge',
  'visionBridgeSync',
  'useContentBridge',
  'autoFindElementOnFailure',
  'autoRecoveryMode',
  'screenshotOnFailure',
  'screenshotRetention',
  'deferCompaction',
  'systemPromptMode',
] as const;
const CACHE_TTL_MS = 30_000;

let cachedSettings: Record<string, unknown> | null = null;
let cachedAt = 0;
let invalidationBound = false;

export const normalizeRuntimeSettings = (raw: Record<string, unknown>): Record<string, any> => {
  const settings = { ...raw } as Record<string, any>;

  if (settings.enableScreenshots === undefined) settings.enableScreenshots = true;
  if (settings.sendScreenshotsAsImages === undefined) settings.sendScreenshotsAsImages = false;
  if (settings.visionBridge === undefined) settings.visionBridge = true;
  if (settings.visionBridgeSync === undefined) settings.visionBridgeSync = false;
  if (settings.useContentBridge === undefined) settings.useContentBridge = true;
  if (settings.autoFindElementOnFailure === undefined) {
    settings.autoFindElementOnFailure = true;
  }
  if (!settings.toolPermissions) {
    settings.toolPermissions = { ...DEFAULT_TOOL_PERMISSIONS };
  } else {
    // Clone so we never mutate a frozen/shared storage object in place.
    settings.toolPermissions = { ...DEFAULT_TOOL_PERMISSIONS, ...settings.toolPermissions };
    // Previous builds auto-promoted scripting:true. executeScript is broken under
    // extension CSP, so revoke that promotion once; an explicit true still wins later.
    if (settings.toolPermissionsScriptingPromoted === true && settings.toolPermissionsScriptingRevoked !== true) {
      settings.toolPermissions.scripting = false;
      settings.toolPermissionsScriptingRevoked = true;
    }
  }
  settings.historyPersistence = resolveHistoryPersistenceMode(settings.historyPersistence);
  if (settings.allowedDomains === undefined) settings.allowedDomains = '';
  if (settings.autoRecoveryMode === undefined) settings.autoRecoveryMode = 'balanced';
  if (settings.screenshotOnFailure === undefined) settings.screenshotOnFailure = true;
  if (settings.screenshotRetention === undefined) settings.screenshotRetention = 'ephemeral';
  if (settings.deferCompaction === undefined) settings.deferCompaction = false;
  settings.systemPromptMode = resolveSystemPromptMode(settings.systemPrompt, settings.systemPromptMode);

  const migrated = migrateStoredProvider(settings.provider, settings.customEndpoint);
  // Force a safe default for first-run / empty configs (Ollama local focus)
  settings.provider = migrated || 'ollama';

  // A credencial do provedor ATIVO manda sobre o slot global `apiKey`. Isso torna o
  // runtime imune a um `apiKey` desatualizado/de outro provedor (ver settings-keys.ts)
  // — nenhuma chave é usada com o provedor errado.
  const providerKey = settings[providerApiKeyField(String(settings.provider))];
  if (typeof providerKey === 'string' && providerKey.trim()) {
    settings.apiKey = providerKey;
  }
  if (settings.provider === 'anthropic' && typeof settings.model === 'string') {
    settings.model = migrateAnthropicModel(settings.model);
  }
  if (settings.provider === 'qwen' && typeof settings.model === 'string') {
    // deepseek-v4-flash sem data → 403; força o id canônico com sufixo.
    settings.model = normalizeProviderModel('qwen', settings.model);
  }

  settings.codexAuthMode = resolveCodexAuthMode(settings);
  if (settings.provider === 'codex') {
    const key = String(settings.apiKey || '');
    if (settings.codexAuthMode === 'chatgpt') {
      // JWTs must never masquerade as apiKey for Codex ChatGPT auth.
      if (!isOpenAiApiKey(key)) settings.apiKey = '';
    } else if (key && isJwtToken(key) && !isOpenAiApiKey(key)) {
      settings.apiKey = '';
    }
  }

  return settings;
};

export const invalidateRuntimeSettingsCache = () => {
  cachedSettings = null;
  cachedAt = 0;
};

export const bindRuntimeSettingsCacheInvalidation = () => {
  if (invalidationBound) return;
  invalidationBound = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (RUNTIME_SETTINGS_KEYS.some((key) => key in changes)) {
      invalidateRuntimeSettingsCache();
      invalidateRuntimeCaches();
      void invalidateProviderNetRequestRulesCache();
    }
  });
};

export const loadCachedRuntimeSettings = async (): Promise<Record<string, any>> => {
  const now = Date.now();
  if (cachedSettings && now - cachedAt < CACHE_TTL_MS) {
    return cachedSettings as Record<string, any>;
  }

  const raw = await chrome.storage.local.get([
    ...RUNTIME_SETTINGS_KEYS,
    'toolPermissionsScriptingPromoted',
    'toolPermissionsScriptingRevoked',
  ]);
  const settings = normalizeRuntimeSettings(raw as Record<string, unknown>);
  if ((raw as Record<string, unknown>).systemPromptMode === undefined) {
    void chrome.storage.local.set({ systemPromptMode: settings.systemPromptMode });
  }
  if (
    settings.toolPermissionsScriptingRevoked === true &&
    (raw as Record<string, unknown>).toolPermissionsScriptingRevoked !== true
  ) {
    void chrome.storage.local.set({
      toolPermissions: settings.toolPermissions,
      toolPermissionsScriptingRevoked: true,
    });
  }
  cachedSettings = settings;
  cachedAt = now;
  return settings;
};
