export const SETTINGS_STORAGE_KEYS = ['provider', 'apiKey', 'model', 'customEndpoint', 'systemPrompt'] as const;

export const SETTINGS_LOAD_KEYS = SETTINGS_STORAGE_KEYS;

export async function readSettings(keys: readonly string[] = SETTINGS_LOAD_KEYS) {
  return chrome.storage.local.get([...keys]);
}

export async function writeSettings(payload: Record<string, unknown>) {
  await chrome.storage.local.set(payload);
}
