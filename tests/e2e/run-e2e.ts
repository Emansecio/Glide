#!/usr/bin/env node

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
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Glide-e2e-'));

const timeoutMs = Number(process.env.E2E_TIMEOUT || 20000);
const slowMo = Number(process.env.E2E_SLOWMO || 0);
const headless = process.env.E2E_HEADLESS === 'true';
if (headless) {
  log('Extensions are not supported in headless mode; tests may fail.', 'warning');
}

type TestContext = {
  panel: import('playwright').Page;
  context: import('playwright').BrowserContext;
  worker: import('playwright').Worker;
};

import {
  dismissOpenModals,
  e2eTimeoutMs,
  getExtensionId,
  openHistoryPanel,
  openSettingsPanel,
  reloadHistoryList,
  resetPanelRunState,
  returnToChatView,
  sendRuntimeMessage,
  waitForPanelReady,
} from './test-helpers.js';

const tests: Array<{ name: string; fn: (ctx: TestContext) => Promise<void> }> = [];
const test = (name: string, fn: (ctx: TestContext) => Promise<void>) => tests.push({ name, fn });

async function seedAccessState(worker: import('playwright').Worker): Promise<void> {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      authState: {
        status: 'signed_in',
        email: 'qa@Glide.dev',
        accessToken: 'test-token',
      },
      entitlement: {
        active: true,
        plan: 'pro',
        renewsAt: '',
      },
    });
  });
}

test('Side panel loads and shows ready state', async ({ panel }) => {
  await panel.waitForSelector('text=Glide', { timeout: e2eTimeoutMs });
  await panel.waitForFunction(
    () => {
      const el = document.querySelector('#statusText');
      const text = el?.textContent?.trim() || '';
      return text.includes('Pronto') || text.includes('Ready');
    },
    { timeout: e2eTimeoutMs },
  );
});

test('Settings panel toggles custom endpoint field', async ({ panel }) => {
  await openSettingsPanel(panel);
  await panel.selectOption('#provider', 'codex');
  await panel.waitForSelector('#customEndpointGroup', { state: 'visible', timeout: e2eTimeoutMs });
  await returnToChatView(panel);
});

test('Tab selector lists integration test page', async ({ panel, context }) => {
  const testPagePath = path.join(repoRoot, 'tests/integration/test-page.html');
  const testPageUrl = `file://${testPagePath}`;
  const testPage = await context.newPage();
  await testPage.goto(testPageUrl);

  await panel.click('#tabSelectorBtn');
  await panel.waitForSelector('#tabSelector', { state: 'visible', timeout: e2eTimeoutMs });
  await panel.waitForSelector('.tab-item-title', { timeout: e2eTimeoutMs });
  const titles = await panel.$$eval('.tab-item-title', (nodes) => nodes.map((node) => (node.textContent || '').trim()));
  assert(
    titles.some((title) => title.includes('Integration Test Page')),
    'Expected integration test page in tab selector.',
  );
  await dismissOpenModals(panel);
});

test('Plan drawer renders checklist from plan_update', async ({ panel, worker }) => {
  await resetPanelRunState(panel);
  const runId = `run-e2e-${Date.now()}`;
  const now = Date.now();
  const plan = {
    steps: [
      { id: 'step-1', title: 'Open page', status: 'running' },
      { id: 'step-2', title: 'Extract data', status: 'pending' },
    ],
    createdAt: now,
    updatedAt: now,
  };

  await sendRuntimeMessage(worker, panel, {
    type: 'plan_update',
    runId,
    timestamp: now,
    plan,
  });

  await panel.waitForSelector('#planDrawer:not(.hidden)', { timeout: e2eTimeoutMs });
  await panel.waitForSelector('.plan-checklist-item', { timeout: e2eTimeoutMs });
  const stepTitles = await panel.$$eval('.plan-checklist-title', (nodes) =>
    nodes.map((node) => (node.textContent || '').trim()),
  );
  assert(stepTitles.includes('Open page'), 'Plan drawer should list the first step.');
});

test('History restores saved transcript', async ({ panel, worker }) => {
  const now = Date.now();
  const session = {
    id: `session-e2e-${now}`,
    startedAt: now,
    updatedAt: now,
    title: 'History Session',
    transcript: [
      { role: 'user', content: 'Saved user message' },
      { role: 'assistant', content: 'Saved assistant reply' },
    ],
  };

  await worker.evaluate((payload) => chrome.storage.local.set({ chatSessions: payload, saveHistory: true }), [session]);
  await reloadHistoryList(panel);
  await openHistoryPanel(panel);
  await panel.waitForSelector('.history-item', { timeout: e2eTimeoutMs });
  await panel.click('.history-item');
  await panel.waitForSelector('.message.user .message-content', { timeout: e2eTimeoutMs });
  const userText = await panel.$eval('.message.user .message-content', (el) => (el.textContent || '').trim());
  assert(userText.includes('Saved user message'), 'Loaded session should render the saved user message.');
});

test('Chat displays streaming message during assistant response', async ({ panel, worker }) => {
  await resetPanelRunState(panel);
  const runId = `run-stream-${Date.now()}`;
  const now = Date.now();

  await sendRuntimeMessage(worker, panel, {
    type: 'assistant_stream_start',
    runId,
    timestamp: now,
  });

  await panel.waitForSelector('.message.assistant.streaming', { state: 'attached', timeout: e2eTimeoutMs });

  await sendRuntimeMessage(worker, panel, {
    type: 'assistant_stream_delta',
    runId,
    timestamp: now + 1,
    content: 'Hello, I am responding',
  });

  await panel.waitForFunction(
    () => {
      const el = document.querySelector('.stream-main-text');
      return el && el.textContent && el.textContent.includes('Hello');
    },
    { timeout: e2eTimeoutMs },
  );
});

test('Thinking block is collapsed by default and expandable', async ({ panel, worker }) => {
  await resetPanelRunState(panel);
  const runId = `run-thinking-${Date.now()}`;
  const now = Date.now();

  await sendRuntimeMessage(worker, panel, {
    type: 'assistant_final',
    runId,
    timestamp: now,
    content: 'Here is my response.',
    thinking: 'Let me think about this carefully...',
  });

  await dismissOpenModals(panel);
  await panel.waitForSelector('.thinking-block.collapsed', { timeout: e2eTimeoutMs });
  await panel.evaluate(() => {
    const header = document.querySelector('.thinking-header') as HTMLButtonElement | null;
    header?.click();
  });
  await panel.waitForFunction(
    () => {
      const block = document.querySelector('.thinking-block');
      return Boolean(block && !block.classList.contains('collapsed'));
    },
    { timeout: e2eTimeoutMs },
  );
});

test('Tool calls appear in the activity log during streaming', async ({ panel, worker }) => {
  await resetPanelRunState(panel);
  const runId = `run-tool-section-${Date.now()}`;
  const now = Date.now();
  const toolId = 'tool-section-1';

  await sendRuntimeMessage(worker, panel, {
    type: 'assistant_stream_start',
    runId,
    timestamp: now,
  });

  await panel.waitForSelector('.message.assistant.streaming', { timeout: e2eTimeoutMs });

  await sendRuntimeMessage(worker, panel, {
    type: 'tool_execution_start',
    runId,
    timestamp: now + 1,
    tool: 'navigate',
    id: toolId,
    args: { url: 'https://example.com' },
  });

  await panel.waitForSelector(`.tool-tree-item[data-id="${toolId}"]`, {
    state: 'attached',
    timeout: e2eTimeoutMs,
  });

  await sendRuntimeMessage(worker, panel, {
    type: 'tool_execution_result',
    runId,
    timestamp: now + 2,
    tool: 'navigate',
    id: toolId,
    args: { url: 'https://example.com' },
    result: { success: true },
  });

  await panel.waitForSelector(`.tool-tree-item[data-id="${toolId}"].success`, {
    state: 'attached',
    timeout: e2eTimeoutMs,
  });
});

test('Tool failure metadata is handled without breaking activity logs', async ({ panel, worker }) => {
  await resetPanelRunState(panel);
  const runId = `run-tool-meta-${Date.now()}`;
  const now = Date.now();
  const toolId = 'tool-meta-1';

  await sendRuntimeMessage(worker, panel, {
    type: 'tool_execution_start',
    runId,
    timestamp: now,
    tool: 'click',
    id: toolId,
    args: { selector: '#missing-button' },
  });

  await panel.waitForSelector(`.tool-tree-item[data-id="${toolId}"].running`, {
    state: 'attached',
    timeout: e2eTimeoutMs,
  });

  await sendRuntimeMessage(worker, panel, {
    type: 'tool_execution_result',
    runId,
    timestamp: now + 1,
    tool: 'click',
    id: toolId,
    args: { selector: '#missing-button' },
    recoveryStage: 'screenshot',
    evidenceConfidence: 'low',
    failureClass: 'selector',
    result: {
      success: false,
      code: 'ELEMENT_NOT_FOUND',
      error: 'Element not found: #missing-button',
      nextHint: 'Call getContent({ mode: "structure" }) and retry with text selectors.',
      recoveryStage: 'screenshot',
      evidenceConfidence: 'low',
      failureClass: 'selector',
    },
  });

  await panel.waitForSelector(`.tool-tree-item[data-id="${toolId}"].error`, {
    state: 'attached',
    timeout: e2eTimeoutMs,
  });

  const statusText = await panel.$eval(`.tool-tree-item[data-id="${toolId}"] .tool-tree-meta`, (el) =>
    (el.textContent || '').trim(),
  );
  assert(statusText.includes('Erro'), 'Tool status should show error');

  await panel.waitForFunction(
    () => {
      const banner = document.querySelector('.error-banner .error-text');
      return Boolean(banner && banner.textContent?.includes('Element not found'));
    },
    { timeout: e2eTimeoutMs },
  );
});

test('Color scheme uses warm neutral background', async ({ panel }) => {
  const bgColor = await panel.$eval('body', (el) => getComputedStyle(el).backgroundColor);
  const rgbMatch = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!rgbMatch) {
    throw new Error(`Expected rgb background color, got ${bgColor}`);
  }
  const [, r, g, b] = rgbMatch.map(Number);
  const maxDiff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
  assert(maxDiff <= 10, `Background should stay warm-neutral, but channel spread was ${maxDiff}`);
  assert(r <= 20 && g <= 20 && b <= 20, `Expected dark warm background, got rgb(${r}, ${g}, ${b})`);
});

async function run() {
  log('╔════════════════════════════════════════╗', 'info');
  log('║          Glide - E2E Tests           ║', 'info');
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
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: timeoutMs }));
    await seedAccessState(worker);

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitForPanelReady(panel);

    let passed = 0;
    for (const t of tests) {
      try {
        await dismissOpenModals(panel);
        await t.fn({ panel, context, worker });
        passed += 1;
        log(`✓ ${t.name}`, 'success');
      } catch (error: any) {
        log(`✗ ${t.name}: ${error.message}`, 'error');
      } finally {
        await dismissOpenModals(panel).catch(() => {});
      }
    }

    log('\n' + '═'.repeat(40), 'info');
    if (passed === tests.length) {
      log('✓ All E2E tests passed!', 'success');
      process.exitCode = 0;
    } else {
      log(`✗ ${tests.length - passed} E2E tests failed`, 'error');
      process.exitCode = 1;
    }
  } catch (error: any) {
    log(`✗ E2E harness failed: ${error.message}`, 'error');
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
