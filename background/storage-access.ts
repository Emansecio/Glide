export type SessionStorageArea = {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

export function getSessionStorageArea(): SessionStorageArea {
  return chrome.storage.session as unknown as SessionStorageArea;
}

/**
 * Restrict chrome.storage.local to extension pages and the service worker.
 * Content scripts inherit storage.local by default until this runs.
 */
export async function restrictLocalStorageToTrustedContexts(): Promise<void> {
  try {
    const storage = chrome.storage?.local as
      | { setAccessLevel?: (options: { accessLevel: string }) => Promise<void> }
      | undefined;
    if (typeof storage?.setAccessLevel !== 'function') return;
    await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chrome or test doubles without setAccessLevel.
  }
}
