#!/usr/bin/env node
/**
 * Interactive test for the agent loop
 * Requires API key to be configured in the extension
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';

const repoRoot = process.cwd();
const extensionPath = path.join(repoRoot, 'dist');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Glide-test-'));

async function main() {
  console.log('🚀 Starting Glide agent test...');
  console.log('📁 Extension path:', extensionPath);
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // Must be false for extensions
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
    ],
    viewport: { width: 1400, height: 900 },
  });

  // Wait for extension to load
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    console.log('⏳ Waiting for service worker...');
    worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
  }
  
  const extensionId = new URL(worker.url()).host;
  console.log('✅ Extension loaded:', extensionId);

  // Open side panel
  const panelUrl = `chrome-extension://${extensionId}/sidepanel/panel.html`;
  const panel = await context.newPage();
  await panel.goto(panelUrl);
  console.log('✅ Side panel opened');

  // Wait for panel to be ready
  await panel.waitForSelector('#statusText', { timeout: 10000 });
  const status = await panel.textContent('#statusText');
  console.log('📊 Status:', status);

  // Listen for console messages
  panel.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('❌ Panel error:', msg.text());
    }
  });

  // Open a test page
  const testPage = await context.newPage();
  await testPage.goto('https://example.com');
  console.log('✅ Test page opened: example.com');

  console.log('\n📝 Extension is ready for manual testing!');
  console.log('👉 The browser window will stay open for you to test.');
  console.log('👉 Press Ctrl+C to close when done.\n');

  // Keep browser open
  await new Promise(() => {});
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
