import { migrateAnthropicModel } from '../ai/anthropic-options.js';
import { invalidateRuntimeCaches } from '../ai/runtime-cache.js';
import { migrateStoredProvider } from '../ai/sdk-client.js';
import { SETTINGS_STORAGE_KEYS } from '../sidepanel/ui/settings-keys.js';

const RUNTIME_SETTINGS_KEYS = SETTINGS_STORAGE_KEYS;
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
    settings.autoFindElementOnFailure = settings.qualityMode !== 'speed';
  }
  if (!settings.toolPermissions) {
    settings.toolPermissions = {
      read: true,
      interact: true,
      navigate: true,
      tabs: true,
      screenshots: true,
      scripting: false,
    };
  } else if (settings.toolPermissions.scripting === undefined) {
    // Migrate older stored settings: scripting is deny-by-default.
    settings.toolPermissions.scripting = false;
  }
  if (settings.allowedDomains === undefined) settings.allowedDomains = '';
  if (settings.autoRecoveryMode === undefined) settings.autoRecoveryMode = 'balanced';
  if (settings.screenshotOnFailure === undefined) settings.screenshotOnFailure = true;
  if (settings.screenshotRetention === undefined) settings.screenshotRetention = 'ephemeral';
  if (settings.qualityMode === undefined) settings.qualityMode = 'balanced';
  if (settings.autoTuneSafety === undefined) settings.autoTuneSafety = true;
  if (settings.minimumReportSections === undefined) settings.minimumReportSections = 5;
  if (settings.deferCompaction === undefined) settings.deferCompaction = false;

  const migrated = migrateStoredProvider(settings.provider, settings.customEndpoint);
  // Force a safe default for first-run / empty configs (Ollama local focus)
  settings.provider = migrated || 'ollama';
  if (settings.provider === 'anthropic' && typeof settings.model === 'string') {
    settings.model = migrateAnthropicModel(settings.model);
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
    }
  });
};

export const loadCachedRuntimeSettings = async (): Promise<Record<string, any>> => {
  const now = Date.now();
  if (cachedSettings && now - cachedAt < CACHE_TTL_MS) {
    return cachedSettings as Record<string, any>;
  }

  const raw = await chrome.storage.local.get(RUNTIME_SETTINGS_KEYS);
  const settings = normalizeRuntimeSettings(raw as Record<string, unknown>);
  cachedSettings = settings;
  cachedAt = now;
  return settings;
};
