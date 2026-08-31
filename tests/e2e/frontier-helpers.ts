import type { Page } from 'playwright';

export async function sendManualTool(panel: Page, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return panel.evaluate(
    async ({ toolName, toolArgs }) => {
      const sessionId =
        (window as { sidePanelUI?: { sessionId?: string } }).sidePanelUI?.sessionId || `frontier-e2e-${Date.now()}`;
      return chrome.runtime.sendMessage({
        type: 'execute_tool',
        tool: toolName,
        args: toolArgs,
        sessionId,
      });
    },
    { toolName: tool, toolArgs: args },
  );
}

export async function sendBridge(
  panel: Page,
  op: string,
  payload: Record<string, unknown>,
  frameId?: number,
): Promise<unknown> {
  return panel.evaluate(
    async ({ bridgeOp, bridgePayload, targetFrameId }) => {
      const storageKey = 'glideSidePanelTabId';
      const stored = await chrome.storage.session.get([storageKey]);
      let tabId = typeof stored[storageKey] === 'number' ? stored[storageKey] : undefined;
      if (typeof tabId !== 'number') {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = activeTab?.id;
      }
      if (typeof tabId !== 'number') {
        throw new Error('No target tab available for bridge request.');
      }

      const message = { type: 'glide_bridge', op: bridgeOp, payload: bridgePayload };
      return typeof targetFrameId === 'number'
        ? chrome.tabs.sendMessage(tabId, message, { frameId: targetFrameId })
        : chrome.tabs.sendMessage(tabId, message);
    },
    { bridgeOp: op, bridgePayload: payload, targetFrameId: frameId },
  );
}
