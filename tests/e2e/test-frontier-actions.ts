#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
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

async function sendManualTool(panel: Page, tabId: number, tool: string, args: Record<string, unknown>) {
  return panel.evaluate(
    async ({ targetTabId, toolName, toolArgs }) =>
      chrome.runtime.sendMessage({
        type: 'execute_tool',
        tool: toolName,
        args: { ...toolArgs, tabId: targetTabId, _strictTabId: true },
        sessionId: `frontier-actions-${Date.now()}`,
      }),
    { targetTabId: tabId, toolName: tool, toolArgs: args },
  );
}

async function clickOnce(context: BrowserContext, worker: Worker, panel: Page, baseUrl: string) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/action-lab.html`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  assert(typeof tabId === 'number', 'Fixture tab not found.');
  await waitForBridge(worker, tabId);

  for (const selector of ['#action-button', '#action-checkbox', '#action-submit']) {
    const result = (await sendBridge(panel, tabId, 'click', { selector, waitForDialog: false })) as {
      success?: boolean;
      error?: string;
    };
    assert(result?.success, `click ${selector} failed: ${result?.error || JSON.stringify(result)}`);
  }

  const state = await page.evaluate(() =>
    (window as unknown as {
      __actionLab: { click: number; checkboxClick: number; change: number; checkbox: boolean; submit: number };
    }).__actionLab,
  );
  assert(state.click === 1, `button click count expected 1, got ${state.click}`);
  assert(state.checkboxClick === 1, `checkbox click count expected 1, got ${state.checkboxClick}`);
  assert(state.change === 1, `checkbox change count expected 1, got ${state.change}`);
  assert(state.checkbox === true, `checkbox expected checked, got ${state.checkbox}`);
  assert(state.submit === 1, `submit count expected 1, got ${state.submit}`);
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

async function checkboxFrame(context: BrowserContext, worker: Worker, panel: Page, baseUrl: string) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/frame-lab.html`);
  await page.waitForSelector('#child-frame');
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  assert(typeof tabId === 'number', 'Fixture tab not found.');
  await waitForBridge(worker, tabId);

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

  const explicitResponse = (await sendManualTool(panel, tabId, 'fillForm', {
    frameUrl: 'child-frame.html',
    fields: [{ selector: '#shared-checkbox', checked: true }],
  })) as { result?: { success?: boolean; error?: string } };
  const explicit = (explicitResponse.result || explicitResponse) as { success?: boolean; error?: string };
  assert(explicit.success, `explicit child fill failed: ${explicit.error || JSON.stringify(explicitResponse)}`);
  const topChecked = await page.locator('#shared-checkbox').isChecked();
  const childChecked = await page.frameLocator('#child-frame').locator('#shared-checkbox').isChecked();
  assert(topChecked === false, 'top checkbox mutated during child-targeted fill');
  assert(childChecked === true, 'child checkbox was not checked');
  await page.close();
}

const cases = { 'click-once': clickOnce, 'find-element': findElement, 'checkbox-frame': checkboxFrame } as const;
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
  await cases[requestedCase as keyof typeof cases](context, worker, panel, fixture.baseUrl);
  console.log(`PASS frontier action case: ${requestedCase}`);
} finally {
  await context?.close();
  await fixture.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
