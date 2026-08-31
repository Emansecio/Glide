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
  const acted = await panel.evaluate(
    async ({ tabId, handle }) => {
      return chrome.tabs.sendMessage(
        tabId,
        { type: 'glide_bridge', op: 'click', payload: { selector: handle.selector, handle, waitForDialog: false } },
        { frameId: 0 },
      );
    },
    { tabId, handle },
  );
  if (acted?.code !== 'STALE_ELEMENT_HANDLE') {
    throw new Error(`expected stale element handle rejection: ${JSON.stringify(acted)}`);
  }
  const state = await page.evaluate(() => (window as any).__actionLab.click);
  if (state !== 0) throw new Error(`stale handle mutated page: ${state}`);
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
  console.log('PASS stable element handles');
} finally {
  await context?.close();
  await fixture.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
