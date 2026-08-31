#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { emitFrontierTrace } from '../evals/frontier-trace.js';
import { startFixtureServer } from './fixture-server.js';

const extensionPath = path.resolve(process.cwd(), 'dist');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glide-stable-handles-'));
const fixture = await startFixtureServer();
let context;
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel/panel.html`);
  const page = await context.newPage();
  await page.goto(`${fixture.baseUrl.replace('127.0.0.1', 'localtest.me')}/action-lab.html`);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
  if (typeof tabId !== 'number') throw new Error('Fixture tab not found.');
  await page.waitForTimeout(300);

  const found = await panel.evaluate(
    async ({ tabId }) => {
      return chrome.tabs.sendMessage(
        tabId,
        { type: 'glide_bridge', op: 'findElement', payload: { query: 'Run action', fuzzy: false } },
        { frameId: 0 },
      );
    },
    { tabId },
  );
  const handle = found?.candidates?.[0]?.handle;
  if (!handle) throw new Error(`findElement did not return handle: ${JSON.stringify(found)}`);

  await page.locator('#action-button').evaluate((button) => {
    button.outerHTML = '<button id="action-button">Replacement</button>';
  });
  const actedResponse = await panel.evaluate(
    async ({ tabId, handle }) =>
      chrome.runtime.sendMessage({
        type: 'execute_tool',
        tool: 'click',
        args: { selector: handle.selector, handle, tabId, _strictTabId: true, waitForDialog: false },
        sessionId: 'stable-handle-production-path',
      }),
    { tabId, handle },
  );
  const acted = actedResponse?.result || actedResponse;
  if (acted?.code !== 'STALE_ELEMENT_HANDLE') {
    throw new Error(`expected stale element handle rejection: ${JSON.stringify(actedResponse)}`);
  }
  const state = await page.evaluate(() => (window as any).__actionLab.click);
  if (state !== 0) throw new Error(`stale handle mutated page: ${state}`);

  await panel.evaluate(async () => {
    await chrome.storage.local.set({ useContentBridge: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  const disabledResponse = await panel.evaluate(
    async ({ tabId, handle }) =>
      chrome.runtime.sendMessage({
        type: 'execute_tool',
        tool: 'click',
        args: { selector: handle.selector, handle, tabId, _strictTabId: true, waitForDialog: false },
        sessionId: 'stable-handle-bridge-disabled',
      }),
    { tabId, handle },
  );
  const disabled = disabledResponse?.result || disabledResponse;
  if (disabled?.code !== 'BRIDGE_UNAVAILABLE') {
    throw new Error(`bridge-disabled handle did not fail closed: ${JSON.stringify(disabledResponse)}`);
  }
  if ((await page.evaluate(() => (window as any).__actionLab.click)) !== 0) {
    throw new Error('bridge-disabled handle mutated replacement target');
  }
  await panel.evaluate(async () => {
    await chrome.storage.local.set({ useContentBridge: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  if (process.env.GLIDE_FRONTIER_EVAL_CASE === 'stale-handle') {
    const actionId = `${handle.snapshotId}:${handle.ref}`;
    emitFrontierTrace('stale-handle', {
      events: [{ id: `${actionId}:${acted.code}`, actionId, kind: acted.code, frameId: 0 }],
      mutations: [],
      actionAttempts: [{ actionId, state: 'prepared' }],
      contextRevisions: [Number(handle.domRevision ?? 0)],
      terminalReason: acted.code === 'STALE_ELEMENT_HANDLE' ? 'completed' : 'failed',
      expectedTerminalReason: 'completed',
    });
  }
  const framePage = await context.newPage();
  await framePage.goto(`${fixture.baseUrl.replace('127.0.0.1', 'localtest.me')}/frame-lab.html`);
  await framePage.waitForSelector('#child-frame');
  const frameTabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, framePage.url());
  if (typeof frameTabId !== 'number') throw new Error('Frame fixture tab not found.');
  const childFrameId = await worker.evaluate(async (targetTabId) => {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: targetTabId });
    return frames?.find((frame) => frame.url.includes('/child-frame.html'))?.frameId;
  }, frameTabId);
  if (typeof childFrameId !== 'number') throw new Error('Child frame id not found.');
  await framePage.waitForTimeout(300);
  const childFound = await panel.evaluate(
    async ({ tabId, frameId }) =>
      chrome.tabs.sendMessage(
        tabId,
        { type: 'glide_bridge', op: 'findElement', payload: { query: 'Child checkbox', fuzzy: false } },
        { frameId },
      ),
    { tabId: frameTabId, frameId: childFrameId },
  );
  const childHandle = childFound?.candidates?.[0]?.handle;
  if (!childHandle) throw new Error(`Child handle missing: ${JSON.stringify(childFound)}`);

  for (const frameTarget of [{ frameUrl: 'child-frame.html' }, { frameSelector: '#child-frame' }]) {
    const response = await panel.evaluate(
      async ({ tabId, handle, target }) =>
        chrome.runtime.sendMessage({
          type: 'execute_tool',
          tool: 'click',
          args: {
            selector: handle.selector,
            handle,
            tabId,
            _strictTabId: true,
            waitForDialog: false,
            ...target,
          },
          sessionId: 'stable-handle-explicit-frame',
        }),
      { tabId: frameTabId, handle: childHandle, target: frameTarget },
    );
    if (!response?.result?.success) {
      throw new Error(`handle explicit frame failed: ${JSON.stringify(response)}`);
    }
  }
  const topChecked = await framePage.locator('#shared-checkbox').isChecked();
  const childState = await framePage
    .frameLocator('#child-frame')
    .locator('body')
    .evaluate(() => (window as any).__frameLab);
  if (topChecked || childState.change !== 2 || childState.checkbox !== false) {
    throw new Error(`handle frame routing mutated wrong target: ${JSON.stringify({ topChecked, childState })}`);
  }
  await framePage.close();

  console.log('PASS stable element handles');
} finally {
  await context?.close();
  await fixture.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
