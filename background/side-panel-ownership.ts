export type SessionStorageReader = {
  get(keys: string[]): Promise<Record<string, unknown>>;
};

export type SidePanelOwnershipState = {
  sidePanelTabId: number | null;
};

export async function hydrateSidePanelOwnership(
  storage: SessionStorageReader,
  state: SidePanelOwnershipState,
): Promise<void> {
  try {
    const stored = await storage.get(['glideSidePanelTabId']);
    if (typeof stored.glideSidePanelTabId === 'number') state.sidePanelTabId = stored.glideSidePanelTabId;
  } catch {
    // storage.session may be unavailable in some environments
  }
}
