import type { BrowserContext, Page, Worker } from 'playwright';
import { RUNTIME_MESSAGE_SCHEMA_VERSION } from '../../types/runtime-messages.js';

const timeoutMs = Number(process.env.E2E_TIMEOUT || 30000);

export const e2eTimeoutMs = timeoutMs;

export async function getExtensionId(context: BrowserContext): Promise<string> {
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: timeoutMs });
  }
  const url = new URL(worker.url());
  return url.host;
}

export async function waitForPanelReady(panel: Page): Promise<void> {
  await panel.waitForFunction(
    () => {
      const ui = (window as { sidePanelUI?: { elements?: { statusText?: HTMLElement } } }).sidePanelUI;
      const status = ui?.elements?.statusText?.textContent?.trim();
      return Boolean(ui && status);
    },
    { timeout: timeoutMs },
  );
}

export async function resetPanelRunState(panel: Page): Promise<void> {
  await panel.evaluate(() => {
    const ui = (window as { sidePanelUI?: Record<string, unknown> }).sidePanelUI;
    if (!ui) return;
    const activeRunId = ui.activeRunId as string | null;
    if (activeRunId && ui.completedRunIds instanceof Set) {
      ui.completedRunIds.add(activeRunId);
    }
    ui.activeRunId = null;
    const abort = ui.abortActiveStreaming as (() => void) | undefined;
    abort?.call(ui);
  });
}

export async function sendRuntimeMessage(worker: Worker, panel: Page, message: Record<string, unknown>): Promise<void> {
  const sessionId = await panel.evaluate(
    () => (window as { sidePanelUI?: { sessionId?: string } }).sidePanelUI?.sessionId || '',
  );
  const payload = {
    ...message,
    sessionId: typeof message.sessionId === 'string' ? message.sessionId : sessionId,
    schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
  };
  await worker.evaluate((value) => chrome.runtime.sendMessage(value), payload);
}

export async function openSidebar(panel: Page): Promise<void> {
  const isClosed = await panel.locator('#sidebar').evaluate((el) => el.classList.contains('closed'));
  if (isClosed) {
    await panel.click('#openSidebarBtn');
    await panel.waitForSelector('#sidebar:not(.closed)', { timeout: timeoutMs });
  }
}

export async function dismissOpenModals(panel: Page): Promise<void> {
  // Close any open modal (e.g. OAuth help) via Escape / close control.
  const oauthOpen = await panel
    .locator('#oauthHelpModal')
    .evaluate((el) => el && !el.classList.contains('hidden'))
    .catch(() => false);
  if (oauthOpen) {
    await panel
      .locator('#closeOauthHelpBtn, #closeOauthHelpBtnOk')
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});
    await panel
      .waitForFunction(() => document.getElementById('oauthHelpModal')?.classList.contains('hidden') === true, {
        timeout: timeoutMs,
      })
      .catch(() => {});
  }
}

export async function reloadHistoryList(panel: Page): Promise<void> {
  await panel.evaluate(async () => {
    const ui = (window as { sidePanelUI?: Record<string, unknown> }).sidePanelUI;
    if (!ui) return;
    ui._cachedChatSessionsIndex = undefined;
    ui.historyListDirty = true;
    const load = ui.loadHistoryList as (() => Promise<void>) | undefined;
    await load?.call(ui);
  });
}

export async function openSettingsPanel(panel: Page): Promise<void> {
  await dismissOpenModals(panel);
  await openSidebar(panel);
  await panel.click('#navSettingsBtn');
  await panel.waitForSelector('#settingsPanel', { state: 'visible', timeout: timeoutMs });
}

export async function openHistoryPanel(panel: Page): Promise<void> {
  await dismissOpenModals(panel);
  await openSidebar(panel);
  await panel.click('#navHistoryBtn');
  await panel.waitForSelector('#historyPanel', { state: 'visible', timeout: timeoutMs });
}

export async function returnToChatView(panel: Page): Promise<void> {
  await dismissOpenModals(panel);
  await openSidebar(panel);
  await panel.click('#navChatBtn');
  await panel.waitForSelector('#chatInterface', { state: 'visible', timeout: timeoutMs });
}
