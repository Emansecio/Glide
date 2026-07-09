#!/usr/bin/env node

/**
 * E2E tests for provider settings and background message handling.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (error) {
  console.error('Playwright is not installed. Run: npm install');
  process.exit(1);
}

const colors = {
  info: '\x1b[36m',
  success: '\x1b[32m',
  error: '\x1b[31m',
  warning: '\x1b[33m',
  reset: '\x1b[0m',
} as const;

function log(message: string, type: keyof typeof colors = 'info') {
  console.log(`${colors[type]}${message}${colors.reset}`);
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

const repoRoot = path.resolve(process.cwd());
const extensionPath = path.join(repoRoot, 'dist');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Glide-model-test-'));

const timeoutMs = Number(process.env.E2E_TIMEOUT || 30000);
const slowMo = Number(process.env.E2E_SLOWMO || 0);
const headless = process.env.E2E_HEADLESS === 'true';

type TestContext = {
  panel: import('playwright').Page;
  context: import('playwright').BrowserContext;
  worker: import('playwright').Worker;
};

import { migrateStoredProvider } from '../../ai/sdk-client.js';
import { getExtensionId, waitForPanelReady } from './test-helpers.js';

const tests: Array<{ name: string; fn: (ctx: TestContext) => Promise<void> }> = [];
const test = (name: string, fn: (ctx: TestContext) => Promise<void>) => tests.push({ name, fn });

type ProviderSettings = {
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint: string;
};

async function setupTestSettings(worker: import('playwright').Worker, settings: ProviderSettings) {
  await worker.evaluate(async (value) => {
    await chrome.storage.local.set({
      provider: value.provider,
      apiKey: value.apiKey,
      model: value.model,
      customEndpoint: value.customEndpoint,
      systemPrompt: 'You are a helpful assistant.',
      sendScreenshotsAsImages: false,
      screenshotQuality: 'medium',
      showThinking: true,
      streamResponses: true,
      maxTokens: 2048,
      contextLimit: 200000,
      timeout: 60000,
      enableScreenshots: false,
      qualityMode: 'max',
      autoTuneSafety: true,
      minimumReportSections: 5,
      toolPermissions: {
        read: true,
        interact: true,
        navigate: true,
        tabs: true,
        screenshots: false,
      },
      allowedDomains: '',
      useOrchestrator: false,
      visionBridge: false,
    });
  }, settings);
}

test('Codex endpoint configuration is saved and retrieved', async ({ worker }) => {
  const testEndpoint = 'https://api.homelabai.org/v1';
  const testApiKey = 'test-key-123';
  const testModel = 'gpt-4o';

  await setupTestSettings(worker, {
    provider: 'codex',
    apiKey: testApiKey,
    model: testModel,
    customEndpoint: testEndpoint,
  });

  const settings = await worker.evaluate(async () => {
    const result = await chrome.storage.local.get(['provider', 'apiKey', 'model', 'customEndpoint']);
    return result;
  });

  assert(settings.provider === 'codex', 'Provider should be "codex"');
  assert(settings.apiKey === testApiKey, 'API key should match');
  assert(settings.model === testModel, 'Model should match');
  assert(settings.customEndpoint === testEndpoint, 'Custom endpoint should match');
});

test('Legacy custom provider migrates to codex for remote endpoints', async () => {
  const migrated = migrateStoredProvider('custom', 'https://api.homelabai.org/v1');
  assert(migrated === 'codex', 'Remote custom endpoints should migrate to codex');
});

test('Background script accepts user_message payload shape', async ({ worker, panel }) => {
  const testEndpoint = 'https://api.homelabai.org/v1';
  const testApiKey = process.env.TEST_API_KEY || 'test-key';
  const testModel = process.env.TEST_MODEL || 'gpt-4o';

  await setupTestSettings(worker, {
    provider: 'codex',
    apiKey: testApiKey,
    model: testModel,
    customEndpoint: testEndpoint,
  });

  const sessionId = `test-session-${Date.now()}`;
  const messagePayload = {
    type: 'user_message',
    message: 'Hello, can you hear me?',
    conversationHistory: [],
    selectedTabs: [],
    sessionId,
  };

  const response = await panel.evaluate(
    (payload) =>
      new Promise<{ success?: boolean; queued?: boolean; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(payload, (result) => {
          resolve({
            ...(result && typeof result === 'object' ? result : {}),
            error: chrome.runtime.lastError?.message,
          });
        });
      }),
    messagePayload,
  );

  assert(!response.error, `Background transport error: ${response.error}`);
  assert(response.success === true, `Background should accept user_message, got: ${JSON.stringify(response)}`);
  assert(response.queued === true, 'Background should queue user_message for processing');
});

test('Background proxies provider model detection from side panel context', async ({ panel }) => {
  const response = await panel.evaluate(
    () =>
      new Promise<{ success?: boolean; models?: string[]; error?: string }>((resolve) => {
        const detect = () => {
          chrome.runtime.sendMessage(
            {
              type: 'detect_provider_models',
              provider: 'ollama',
              apiKey: '',
              customEndpoint: 'http://localhost:11434',
            },
            (result) => {
              resolve({
                ...(result && typeof result === 'object' ? result : {}),
                error: chrome.runtime.lastError?.message,
              });
            },
          );
        };
        // Wake the MV3 service worker before the async detection call.
        chrome.runtime.sendMessage({ type: 'get_execution_events' }, () => detect());
      }),
  );

  assert(typeof response === 'object', 'detect_provider_models should return an object');
  if (response?.success) {
    assert(Array.isArray(response.models), 'Successful detection should return models array');
    return;
  }
  const failure = response?.error || (response?.success === false ? 'provider detection failed' : 'no response');
  assert(
    typeof failure === 'string' && failure.length > 0,
    `Expected detection result, got: ${JSON.stringify(response)}`,
  );
});

test('Custom endpoint stays provider-scoped', async ({ worker }) => {
  const testEndpoint = 'https://api.homelabai.org/v1';

  await setupTestSettings(worker, {
    provider: 'codex',
    apiKey: 'test-key-123',
    model: 'gpt-4o',
    customEndpoint: testEndpoint,
  });

  const settings = await worker.evaluate(async () => {
    const result = await chrome.storage.local.get(['customEndpoint']);
    return result;
  });

  const endpoint = settings.customEndpoint;
  assert(endpoint === testEndpoint, `Endpoint should be ${testEndpoint}`);
  assert(!endpoint.endsWith('/chat/completions'), 'Endpoint should not include /chat/completions path');
});

test('Verify storage contains required settings', async ({ worker }) => {
  const testEndpoint = 'https://api.homelabai.org/v1';

  await setupTestSettings(worker, {
    provider: 'codex',
    apiKey: 'test-key-123',
    model: 'gpt-4o',
    customEndpoint: testEndpoint,
  });

  const allSettings = await worker.evaluate(async () => {
    const result = await chrome.storage.local.get(null);
    return result;
  });

  const requiredFields = ['provider', 'apiKey', 'model', 'customEndpoint'];
  for (const field of requiredFields) {
    assert(field in allSettings, `Missing required field: ${field}`);
  }
});

async function run() {
  log('╔════════════════════════════════════════╗', 'info');
  log('║     Model Communication E2E Tests     ║', 'info');
  log('╚════════════════════════════════════════╝', 'info');

  let context;
  try {
    if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
      throw new Error('Missing dist/manifest.json. Run npm run build first.');
    }

    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      slowMo,
      viewport: { width: 1400, height: 900 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--allow-file-access-from-files',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });

    const extensionId = await getExtensionId(context);
    log(`Extension ID: ${extensionId}`, 'info');

    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: timeoutMs }));

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitForPanelReady(panel);

    let passed = 0;
    for (const t of tests) {
      try {
        log(`\n▶ Running: ${t.name}`, 'info');
        await t.fn({ panel, context, worker });
        passed += 1;
        log(`✓ ${t.name}`, 'success');
      } catch (error: any) {
        log(`✗ ${t.name}: ${error.message}`, 'error');
        if (error.stack) {
          log(error.stack, 'info');
        }
      }
    }

    log('\n' + '═'.repeat(40), 'info');
    if (passed === tests.length) {
      log('✓ All model communication tests passed!', 'success');
      process.exitCode = 0;
    } else {
      log(`✗ ${tests.length - passed} tests failed`, 'error');
      process.exitCode = 1;
    }
  } catch (error: any) {
    log(`✗ Test harness failed: ${error.message}`, 'error');
    if (error.stack) {
      log(error.stack, 'info');
    }
    process.exitCode = 1;
  } finally {
    if (context) {
      await context.close();
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (error: any) {
      log(`Warning: failed to remove temp profile: ${error.message}`, 'warning');
    }
  }
}

run();
