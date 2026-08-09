#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';

let chromium: typeof import('playwright').chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm install');
  process.exit(1);
}

import { liveTestsEnabled, resolveLiveOllamaModel } from '../helpers/live-test-config.js';
import { getExtensionId, sendRuntimeMessage, waitForPanelReady } from './test-helpers.js';

const colors = {
  info: '\x1b[36m',
  success: '\x1b[32m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
} as const;

function log(message: string, type: keyof typeof colors = 'info') {
  console.log(`${colors[type]}${message}${colors.reset}`);
}

const repoRoot = path.resolve(process.cwd());
const extensionPath = path.join(repoRoot, 'dist');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Glide-live-e2e-'));
const timeoutMs = Number(process.env.E2E_TIMEOUT || 120000);
const headless = process.env.E2E_HEADLESS === 'true';

async function setupOllamaSettings(worker: import('playwright').Worker, endpoint: string, model: string) {
  await worker.evaluate(
    async (value) => {
      await chrome.storage.local.set({
        provider: 'ollama',
        apiKey: '',
        model: value.model,
        customEndpoint: value.endpoint,
        systemPrompt: 'You are a helpful assistant.',
        sendScreenshotsAsImages: false,
        screenshotQuality: 'medium',
        streamResponses: true,
        maxTokens: 256,
        contextLimit: 32000,
        timeout: 60000,
        enableScreenshots: false,
        toolPermissions: {
          read: true,
          interact: false,
          navigate: false,
          tabs: false,
          screenshots: false,
        },
        allowedDomains: '',
        visionBridge: false,
      });
    },
    { endpoint, model },
  );
}

async function run() {
  if (!liveTestsEnabled()) {
    log('SKIPPED: live model E2E (GLIDE_LIVE_TESTS!=1)', 'info');
    process.exitCode = 0;
    return;
  }

  let context: import('playwright').BrowserContext | undefined;
  try {
    const { endpoint, model } = await resolveLiveOllamaModel();
    if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
      throw new Error('Missing dist/manifest.json. Run npm run build first.');
    }

    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: { width: 1400, height: 900 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });

    const extensionId = await getExtensionId(context);
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: timeoutMs }));
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitForPanelReady(panel);
    await setupOllamaSettings(worker, endpoint, model);

    log('▶ Service worker can detect Ollama models', 'info');
    const models = await worker.evaluate(
      async (value) => {
        const response = await chrome.runtime.sendMessage({
          type: 'detect_provider_models',
          provider: 'ollama',
          apiKey: '',
          customEndpoint: value.endpoint,
        });
        return response;
      },
      { endpoint },
    );
    if (!models?.success || !Array.isArray(models.models) || models.models.length === 0) {
      throw new Error(`detect_provider_models failed: ${models?.error || 'no models'}`);
    }
    log(`✓ Detected ${models.models.length} Ollama model(s)`, 'success');

    log('▶ user_message produces assistant response', 'info');
    const prompt = 'Reply with exactly: GLIDE_OK';
    await sendRuntimeMessage(worker, panel, {
      type: 'user_message',
      message: prompt,
      conversationHistory: [{ role: 'user', content: prompt }],
      selectedTabs: [],
    });

    await panel.waitForFunction(
      () => {
        const assistant = document.querySelector('.message.assistant .message-content');
        const text = assistant?.textContent?.trim() || '';
        return text.includes('GLIDE_OK');
      },
      { timeout: timeoutMs },
    );

    const assistantText = await panel.locator('.message.assistant .message-content').last().textContent();
    if (!assistantText?.includes('GLIDE_OK')) {
      throw new Error(`Expected GLIDE_OK in assistant response, got: ${assistantText?.slice(0, 200)}`);
    }
    log('✓ Full pipeline returned GLIDE_OK', 'success');
    process.exitCode = 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(`✗ ${message}`, 'error');
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

run();
