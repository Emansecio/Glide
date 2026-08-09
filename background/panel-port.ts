import { PANEL_PORT_NAME } from './runtime-push.js';

type PanelPortRecord = {
  port: chrome.runtime.Port;
  connectedAt: number;
};

const panelPorts = new Set<chrome.runtime.Port>();
const panelPortRecords: PanelPortRecord[] = [];

function removePanelPort(port: chrome.runtime.Port): void {
  panelPorts.delete(port);
  const idx = panelPortRecords.findIndex((record) => record.port === port);
  if (idx >= 0) panelPortRecords.splice(idx, 1);
}

/** Incremented on each side-panel ownership claim — late onClosed must not clear a newer owner. */
let sidePanelClaimGeneration = 0;

export function bindPanelPortListener(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT_NAME) return;
    panelPorts.add(port);
    panelPortRecords.push({ port, connectedAt: Date.now() });
    port.onDisconnect.addListener(() => {
      removePanelPort(port);
    });
  });
}

export function hasConnectedPanelPorts(): boolean {
  return panelPorts.size > 0;
}

export function bumpSidePanelClaimGeneration(): number {
  sidePanelClaimGeneration += 1;
  return sidePanelClaimGeneration;
}

export function getSidePanelClaimGeneration(): number {
  return sidePanelClaimGeneration;
}

/** Broadcast push payload to every connected panel port. Returns true only when at least one post succeeds. */
export function postToPanelPorts(message: unknown): boolean {
  if (panelPorts.size === 0) return false;
  let delivered = 0;
  for (const port of [...panelPorts]) {
    try {
      port.postMessage(message);
      delivered += 1;
    } catch {
      removePanelPort(port);
    }
  }
  return delivered > 0;
}

/** Test-only reset — unit tests mock chrome.runtime.connect without real ports. */
export function resetPanelPortsForTests(): void {
  panelPorts.clear();
  panelPortRecords.length = 0;
  sidePanelClaimGeneration = 0;
}

export function resetSidePanelClaimGenerationForTests(): void {
  sidePanelClaimGeneration = 0;
}
