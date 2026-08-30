const LOCAL_COMMAND_CODE_CONFIG = 'local/command-code.json';
const BOOTSTRAP_VERSION = 'command-code-v1';
const BOOTSTRAP_VERSION_KEY = 'glideCommandCodeBootstrapVersion';

/** Loads the user-provided local provider config once, without logging its key. */
export async function bootstrapLocalCommandCodeSettings(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(BOOTSTRAP_VERSION_KEY);
    if (stored?.[BOOTSTRAP_VERSION_KEY] === BOOTSTRAP_VERSION) return;

    const response = await fetch(chrome.runtime.getURL(LOCAL_COMMAND_CODE_CONFIG));
    if (!response.ok) return;
    const config = (await response.json()) as Record<string, unknown>;
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) return;

    const current = await chrome.storage.local.get(['provider', 'apiKey', 'apiKey_command-code']);
    const existingSlot =
      typeof current?.['apiKey_command-code'] === 'string' ? current['apiKey_command-code'].trim() : '';
    const patch: Record<string, unknown> = {
      [BOOTSTRAP_VERSION_KEY]: BOOTSTRAP_VERSION,
    };
    if (!existingSlot) {
      patch['apiKey_command-code'] = apiKey;
      // Only fill the active apiKey slot when Command Code is already selected.
      if (current?.provider === 'command-code' && !String(current?.apiKey || '').trim()) {
        patch.apiKey = apiKey;
      }
    }

    await chrome.storage.local.set(patch);
  } catch {
    // The local file is optional; a missing/invalid file must not break the extension.
  }
}
