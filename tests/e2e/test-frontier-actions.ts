#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, type Page, type Worker, chromium } from 'playwright';
import { emitFrontierTrace } from '../evals/frontier-trace.js';
import { startFixtureServer } from './fixture-server.js';

const requestedCase = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : '';
const extensionPath = path.resolve(process.cwd(), 'dist');
const timeout = Number(process.env.E2E_TIMEOUT || 20_000);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForBridge(worker: Worker, tabId: number, frameId?: number): Promise<void> {
  await worker.evaluate(
    async ({ targetTabId, targetFrameId, timeoutMs }) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        try {
          const message = { type: 'glide_bridge', op: 'ping', payload: {} };
          const response =
            typeof targetFrameId === 'number'
              ? await chrome.tabs.sendMessage(targetTabId, message, { frameId: targetFrameId })
              : await chrome.tabs.sendMessage(targetTabId, message);
          if (response?.success) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Content bridge did not become ready.');
    },
    { targetTabId: tabId, targetFrameId: frameId, timeoutMs: timeout },
  );
}

async function sendBridge(panel: Page, tabId: number, op: string, payload: Record<string, unknown>) {
  return panel.evaluate(
    async ({ targetTabId, bridgeOp, bridgePayload }) =>
      chrome.tabs.sendMessage(targetTabId, { type: 'glide_bridge', op: bridgeOp, payload: bridgePayload }),
    { targetTabId: tabId, bridgeOp: op, bridgePayload: payload },
  );
}

async function sendManualTool(
  panel: Page,
  tabId: number,
  tool: string,
  args: Record<string, unknown>,
  sessionId = `frontier-actions-${Date.now()}`,
) {
  return panel.evaluate(
    async ({ targetTabId, toolName, toolArgs, targetSessionId }) =>
      chrome.runtime.sendMessage({
        type: 'execute_tool',
        tool: toolName,
        args: { ...toolArgs, tabId: targetTabId, _strictTabId: true },
        sessionId: targetSessionId,
      }),
    { targetTabId: tabId, toolName: tool, toolArgs: args, targetSessionId: sessionId },
  );
}

async function readSessionExecutionEvent(panel: Page, sessionId: string) {
  const response = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get_execution_events' }))) as {
    events?: Array<{
      id: string;
      actionId?: string;
      frameId?: number;
      contextRevision?: number;
      sessionId?: string;
      success?: boolean;
    }>;
  };
  return response.events?.filter((event) => event.sessionId === sessionId).at(-1);
}

async function clickOnce(context: BrowserContext, worker: Worker, panel: Page, baseUrl: string) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/action-lab.html`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  assert(typeof tabId === 'number', 'Fixture tab not found.');
  await waitForBridge(worker, tabId);

  const isEval = process.env.GLIDE_FRONTIER_EVAL_CASE === 'click-once';
  if (isEval) {
    const sessionId = 'frontier-eval-click-once';
    const response = (await sendManualTool(
      panel,
      tabId,
      'click',
      { selector: '#action-button', waitForDialog: false },
      sessionId,
    )) as { success?: boolean; result?: { success?: boolean } };
    assert(response.success && response.result?.success, `eval click failed: ${JSON.stringify(response)}`);
    const event = await readSessionExecutionEvent(panel, sessionId);
    assert(event?.actionId, `eval click execution event missing actionId: ${JSON.stringify(event)}`);
    const clickCount = await page.evaluate(() => (window as any).__actionLab.click as number);
    emitFrontierTrace('click-once', {
      events: [{ id: event.id, actionId: event.actionId, kind: 'mutation', frameId: event.frameId ?? 0 }],
      mutations:
        clickCount === 1
          ? [{ actionId: event.actionId, requestedFrameId: 0, actualFrameId: event.frameId ?? 0, handleState: 'fresh' }]
          : [],
      actionAttempts: [{ actionId: event.actionId, state: 'committed' }],
      contextRevisions: [event.contextRevision ?? 0],
      terminalReason: response.success ? 'completed' : 'failed',
      expectedTerminalReason: 'completed',
    });
  } else {
    for (const selector of ['#action-button', '#action-checkbox', '#action-submit']) {
      const result = (await sendBridge(panel, tabId, 'click', { selector, waitForDialog: false })) as {
        success?: boolean;
        error?: string;
      };
      assert(result?.success, `click ${selector} failed: ${result?.error || JSON.stringify(result)}`);
    }
  }

  const state = await page.evaluate(
    () =>
      (
        window as unknown as {
          __actionLab: { click: number; checkboxClick: number; change: number; checkbox: boolean; submit: number };
        }
      ).__actionLab,
  );
  assert(state.click === 1, `button click count expected 1, got ${state.click}`);
  if (!isEval) {
    assert(state.checkboxClick === 1, `checkbox click count expected 1, got ${state.checkboxClick}`);
    assert(state.change === 1, `checkbox change count expected 1, got ${state.change}`);
    assert(state.checkbox === true, `checkbox expected checked, got ${state.checkbox}`);
    assert(state.submit === 1, `submit count expected 1, got ${state.submit}`);
  }
  await page.close();
}

async function findElement(context: BrowserContext, worker: Worker, panel: Page, baseUrl: string) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/action-lab.html`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  assert(typeof tabId === 'number', 'Fixture tab not found.');
  await waitForBridge(worker, tabId);
  const result = (await sendBridge(panel, tabId, 'findElement', {
    query: 'Run action',
    fuzzy: false,
  })) as { success?: boolean; candidates?: Array<{ selector?: string }> };
  assert(result?.success, `findElement failed: ${JSON.stringify(result)}`);
  assert(result.candidates?.[0]?.selector === '#action-button', `unexpected first selector: ${JSON.stringify(result)}`);
  const count = await page.locator(result.candidates[0].selector || '').count();
  assert(count === 1, `selector must be unique, matched ${count}`);
  await page.close();
}

async function postcondition(context: BrowserContext, worker: Worker, panel: Page, baseUrl: string) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/action-lab.html`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  assert(typeof tabId === 'number', 'Fixture tab not found.');
  await waitForBridge(worker, tabId);
  const result = (await sendBridge(panel, tabId, 'click', {
    selector: '#action-checkbox',
    waitForDialog: false,
    postcondition: { kind: 'checked', selector: '#action-checkbox', value: true },
  })) as { success?: boolean; verified?: boolean; error?: string };
  assert(result.success, `postcondition click failed: ${result.error || JSON.stringify(result)}`);
  assert(result.verified === true, `postcondition not verified: ${JSON.stringify(result)}`);
  const state = await page.evaluate(() => (window as any).__actionLab);
  assert(state.checkboxClick === 1, `postcondition replayed click: ${state.checkboxClick}`);
  await page.close();
}

async function checkboxFrame(context: BrowserContext, worker: Worker, panel: Page, baseUrl: string) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/frame-lab.html`);
  await page.waitForSelector('#child-frame');
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  assert(typeof tabId === 'number', 'Fixture tab not found.');
  await waitForBridge(worker, tabId);

  const isEval = process.env.GLIDE_FRONTIER_EVAL_CASE === 'form-frame';
  if (!isEval) {
    const ambiguousResponse = (await sendManualTool(panel, tabId, 'fillForm', {
      fields: [{ selector: '#shared-checkbox', checked: true }],
    })) as { result?: { success?: boolean; code?: string; results?: Array<{ code?: string }> } };
    const ambiguous = (ambiguousResponse.result || ambiguousResponse) as {
      success?: boolean;
      code?: string;
      results?: Array<{ code?: string }>;
    };
    assert(ambiguous.success === false, `ambiguous fill must fail: ${JSON.stringify(ambiguousResponse)}`);
    assert(
      ambiguous.code === 'FRAME_AMBIGUOUS' || ambiguous.results?.[0]?.code === 'FRAME_AMBIGUOUS',
      `expected FRAME_AMBIGUOUS: ${JSON.stringify(ambiguous)}`,
    );
  }

  const childFrameId = await worker.evaluate(async (targetTabId) => {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: targetTabId });
    return (frames || []).find((frame) => frame.url.includes('/child-frame.html'))?.frameId;
  }, tabId);
  assert(typeof childFrameId === 'number', 'child frame id not found');
  const sessionId = 'frontier-eval-form-frame';
  const explicitResponse = (await sendManualTool(
    panel,
    tabId,
    'fillForm',
    {
      frameUrl: 'child-frame.html',
      fields: [{ selector: '#shared-checkbox', checked: true }],
    },
    isEval ? sessionId : undefined,
  )) as { success?: boolean; result?: { success?: boolean; error?: string } };
  const explicit = (explicitResponse.result || explicitResponse) as { success?: boolean; error?: string };
  assert(explicit.success, `explicit child fill failed: ${explicit.error || JSON.stringify(explicitResponse)}`);
  const topChecked = await page.locator('#shared-checkbox').isChecked();
  const childChecked = await page.frameLocator('#child-frame').locator('#shared-checkbox').isChecked();
  assert(topChecked === false, 'top checkbox mutated during child-targeted fill');
  assert(childChecked === true, 'child checkbox was not checked');
  if (isEval) {
    const event = await readSessionExecutionEvent(panel, sessionId);
    assert(event?.actionId, `eval form execution event missing actionId: ${JSON.stringify(event)}`);
    emitFrontierTrace('form-frame', {
      events: [{ id: event.id, actionId: event.actionId, kind: 'mutation', frameId: event.frameId }],
      mutations:
        childChecked && !topChecked
          ? [
              {
                actionId: event.actionId,
                requestedFrameId: childFrameId,
                actualFrameId: childFrameId,
                handleState: 'fresh',
              },
            ]
          : [],
      actionAttempts: [{ actionId: event.actionId, state: 'committed' }],
      contextRevisions: [event.contextRevision ?? 0],
      terminalReason: explicitResponse.success ? 'completed' : 'failed',
      expectedTerminalReason: 'completed',
    });
  }
  await page.close();
}

const cases = {
  'click-once': clickOnce,
  'find-element': findElement,
  'checkbox-frame': checkboxFrame,
  postcondition,
} as const;
if (!(requestedCase in cases)) {
  console.error(`Unknown or missing --case. Expected one of: ${Object.keys(cases).join(', ')}`);
  process.exit(2);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glide-frontier-actions-'));
const fixture = await startFixtureServer();
let context: BrowserContext | undefined;
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
  const publicFixtureUrl = fixture.baseUrl.replace('127.0.0.1', 'localtest.me');
  await cases[requestedCase as keyof typeof cases](context, worker, panel, publicFixtureUrl);
  console.log(`PASS frontier action case: ${requestedCase}`);
} finally {
  await context?.close();
  await fixture.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
