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

test('UI exposes language and modal accessibility semantics', async ({ panel }) => {
  assert((await panel.getAttribute('html', 'lang')) === 'pt-BR', 'Panel language should be pt-BR.');
  for (const selector of ['#openSidebarBtn', '#activityToggleBtn', '#fileBtn', '#planClearBtn']) {
    const label = await panel.getAttribute(selector, 'aria-label');
    assert(Boolean(label), `${selector} should expose an aria-label.`);
  }

  await openSettingsPanel(panel);
  await panel.selectOption('#provider', 'anthropic');
  await panel.waitForSelector('#oauthHelpBtn:not(.hidden)', { timeout: e2eTimeoutMs });
  await panel.click('#oauthHelpBtn');
  await panel.waitForSelector('#oauthHelpModal:not(.hidden)', { timeout: e2eTimeoutMs });
  assert((await panel.getAttribute('#oauthHelpModal', 'role')) === 'dialog', 'OAuth help should be a dialog.');
  assert(
    (await panel.getAttribute('#oauthHelpModal', 'aria-labelledby')) === 'oauthHelpTitle',
    'OAuth help should label its dialog title.',
  );
  assert(
    (await panel.evaluate(() => document.activeElement?.id)) === 'closeOauthHelpBtn',
    'Opening the dialog should move focus to its close control.',
  );
  await panel.keyboard.press('Escape');
  await panel.waitForSelector('#oauthHelpModal.hidden', { timeout: e2eTimeoutMs });
  await returnToChatView(panel);
});

test('Production content bundle routes bridge ping to the bridge listener', async ({ context }) => {
  const page = await context.newPage();
  await page.setContent('<!doctype html><html><body>Bridge probe</body></html>');
  await page.evaluate(() => {
    const listeners: Array<(message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean> = [];
    Object.defineProperty(window, '__glideProbeListeners', { value: listeners });
    const chromeObject = (window as unknown as { chrome: Record<string, unknown> }).chrome;
    chromeObject.runtime = {
      onMessage: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) },
      sendMessage: () => Promise.resolve(),
    };
  });
  await page.addScriptTag({ path: path.join(extensionPath, 'content.js') });

  const response = await page.evaluate(async () => {
    const listeners = (
      window as unknown as {
        __glideProbeListeners: Array<
          (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean
        >;
      }
    ).__glideProbeListeners;
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => reject(new Error('Bridge ping did not respond.')), 1000);
      const sendResponse = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      for (const listener of listeners) {
        listener({ type: 'glide_bridge', op: 'ping', payload: {} }, {}, sendResponse);
      }
    });
  });

  assert(
    Boolean(response && typeof response === 'object' && (response as { bridge?: boolean }).bridge),
    `Expected bridge ping response, got ${JSON.stringify(response)}`,
  );
  await page.close();
});

test('Settings panel toggles custom endpoint field', async ({ panel }) => {
  await openSettingsPanel(panel);
  await panel.selectOption('#provider', 'codex');
  await panel.waitForSelector('#customEndpointGroup', { state: 'visible', timeout: e2eTimeoutMs });
  await returnToChatView(panel);
});

test('Tab-scoped panel does not expose a global tab selector', async ({ panel, context }) => {
  const testPagePath = path.join(repoRoot, 'tests/integration/test-page.html');
  const testPageUrl = `file://${testPagePath}`;
  const testPage = await context.newPage();
  await testPage.goto(testPageUrl);

  assert((await panel.$('#tabSelectorBtn')) === null, 'Global tab selector button must remain absent.');
  assert((await panel.$('#tabSelector')) === null, 'Global tab selector modal must remain absent.');
  await panel.waitForSelector('#composer', { state: 'visible', timeout: e2eTimeoutMs });
  await testPage.close();
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

test('Plan checklist renders sized checkboxes and marks completed steps', async ({ panel, worker }) => {
  await resetPanelRunState(panel);
  const now = Date.now();
  await sendRuntimeMessage(worker, panel, {
    type: 'plan_update',
    runId: `run-e2e-${now}`,
    timestamp: now,
    plan: {
      steps: [
        { id: 'p1', title: 'Abrir a busca', status: 'done' },
        { id: 'p2', title: 'Extrair resultados', status: 'pending' },
      ],
      createdAt: now,
      updatedAt: now,
    },
  });

  await panel.waitForSelector('.plan-checklist-item', { timeout: e2eTimeoutMs });

  // O checkbox é um <button> com um <svg> sem width/height: sem CSS explícito ele
  // não tinha tamanho algum (ou herdava o default gigante do SVG).
  const box = await panel.$eval('.plan-checklist-checkbox', (el) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  assert(box.width >= 10 && box.width <= 26, `Checkbox width should be a real control, got ${box.width}px.`);
  assert(box.height >= 10 && box.height <= 26, `Checkbox height should be a real control, got ${box.height}px.`);

  // Etapa concluída precisa ser distinguível da pendente (o CSS antigo mirava
  // `.done`, mas o render emite `.completed` — nada mudava visualmente).
  const doneState = await panel.evaluate(() => {
    const item = document.querySelector('.plan-checklist-item.completed');
    const checkbox = item?.querySelector('.plan-checklist-checkbox');
    const title = item?.querySelector('.plan-checklist-title');
    return {
      hasItem: Boolean(item),
      checked: Boolean(checkbox?.classList.contains('checked')),
      lineThrough: title ? getComputedStyle(title).textDecorationLine.includes('line-through') : false,
      filled: checkbox ? getComputedStyle(checkbox).backgroundColor : '',
    };
  });
  assert(doneState.hasItem, 'A done step should render with the completed class.');
  assert(doneState.checked, 'A done step checkbox should render as checked.');
  assert(doneState.lineThrough, 'A completed step title should be struck through.');
  assert(
    doneState.filled !== 'rgba(0, 0, 0, 0)' && doneState.filled !== 'transparent',
    `A checked checkbox should be filled, got ${doneState.filled}.`,
  );
});

test('Model update_plan cannot revert an acknowledged manual completion', async ({ panel }) => {
  await resetPanelRunState(panel);
  const sessionId = `manual-plan-${Date.now()}`;
  const send = (payload: Record<string, unknown>) =>
    panel.evaluate((message) => chrome.runtime.sendMessage(message), { ...payload, sessionId });

  const created = (await send({
    type: 'execute_tool',
    tool: 'set_plan',
    args: { steps: [{ title: 'Etapa manual' }, { title: 'Etapa seguinte' }] },
  })) as any;
  const plan = created?.result?.plan;
  assert(created?.success === true && plan?.planId && plan?.version === 1, 'Manual fixture should create plan v1.');

  const acknowledged = (await send({
    type: 'manual_plan_update',
    planId: plan.planId,
    version: plan.version,
    stepId: plan.steps[0].id,
    status: 'done',
  })) as any;
  assert(acknowledged?.accepted === true, 'Panel completion should be acknowledged.');
  assert(
    acknowledged?.plan?.steps?.[0]?.statusProvenance === 'manual',
    'Acknowledged completion should carry manual provenance.',
  );

  const modelUpdate = (await send({
    type: 'execute_tool',
    tool: 'update_plan',
    args: { step_index: 0, status: 'pending' },
  })) as any;
  assert(modelUpdate?.success === true, 'Protected model update should return a conclusive result.');
  assert(modelUpdate?.result?.protectedByManualState === true, 'Model conflict should report manual protection.');
  assert(modelUpdate?.result?.plan?.steps?.[0]?.status === 'done', 'Model must not revert manual done to pending.');
});

test('run_warning renders as an advisory banner, run_error as an alert', async ({ panel, worker }) => {
  await resetPanelRunState(panel);
  const runId = `run-e2e-${Date.now()}`;

  // Todo run de automação começa com um run_warning ("Automação na aba atual…").
  // Isso NÃO pode aparecer como erro vermelho.
  await sendRuntimeMessage(worker, panel, {
    type: 'run_warning',
    runId,
    timestamp: Date.now(),
    message: 'Automação na aba atual (42: Página de teste).',
  });
  await panel.waitForSelector('.run-incomplete-banner', { timeout: e2eTimeoutMs });
  const errorBannersAfterWarning = await panel.$$eval('.error-banner', (nodes) => nodes.length);
  assert(errorBannersAfterWarning === 0, 'A warning must not render in the error banner.');

  const warningRole = await panel.$eval('.run-incomplete-banner', (node) => node.getAttribute('role'));
  assert(warningRole === 'status', `Warning banner should be role=status, got ${warningRole}.`);

  // Erro de credencial: banner de alerta + botão que abre as Configurações.
  await sendRuntimeMessage(worker, panel, {
    type: 'run_error',
    runId,
    timestamp: Date.now(),
    message: 'Conecte sua conta do Claude para começar.',
    details: { action: 'open_settings' },
  });
  await panel.waitForSelector('.error-banner[role="alert"]', { timeout: e2eTimeoutMs });
  await panel.waitForSelector('.error-banner .banner-action', { timeout: e2eTimeoutMs });

  // Aviso e erro coexistem na pilha, sem se sobrepor.
  const stacked = await panel.$$eval('#bannerStack > *', (nodes) => nodes.length);
  assert(stacked >= 2, `Both banners should stack, got ${stacked}.`);

  await panel.click('.error-banner .banner-action');
  await panel.waitForSelector('#settingsPanel:not(.hidden)', { timeout: e2eTimeoutMs });
});

test('Exhausted browser recovery is visible, terminal, and recorded in the transcript', async ({ panel, worker }) => {
  await resetPanelRunState(panel);
  await returnToChatView(panel);
  const runId = `run-browser-failure-${Date.now()}`;
  const failureMessage =
    'Não consegui concluir a automação: "click" falhou após a tentativa de recuperação — Element not found: #save';

  await panel.evaluate(() => {
    (window as any).sidePanelUI.setComposerBusy(true);
  });
  await sendRuntimeMessage(worker, panel, {
    type: 'run_error',
    runId,
    timestamp: Date.now(),
    message: failureMessage,
    details: {
      code: 'BROWSER_RECOVERY_EXHAUSTED',
      tool: 'click',
      toolCode: 'ELEMENT_NOT_FOUND',
      recordInTranscript: true,
      transcriptMessage: failureMessage,
    },
  });

  await panel.waitForSelector('.error-banner[role="alert"]', { timeout: e2eTimeoutMs });
  await panel.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.message.assistant .message-content')).some((node) =>
        node.textContent?.includes('Element not found: #save'),
      ),
    { timeout: e2eTimeoutMs },
  );
  const terminalState = await panel.evaluate(() => ({
    sendHidden: document.getElementById('sendBtn')?.classList.contains('hidden'),
    stopHidden: document.getElementById('stopBtn')?.classList.contains('hidden'),
    ariaBusy: document.getElementById('composer')?.getAttribute('aria-busy'),
  }));
  assert(terminalState.sendHidden === false, 'Send should be visible after terminal failure.');
  assert(terminalState.stopHidden === true, 'Stop should be hidden after terminal failure.');
  assert(terminalState.ariaBusy === 'false', 'Composer should no longer be busy after terminal failure.');
});

test('Composer exposes a stop control only while a run is active', async ({ panel }) => {
  await resetPanelRunState(panel);

  const initial = await panel.evaluate(() => ({
    sendHidden: document.getElementById('sendBtn')?.classList.contains('hidden'),
    stopHidden: document.getElementById('stopBtn')?.classList.contains('hidden'),
  }));
  assert(initial.sendHidden === false, 'Send button should be visible when idle.');
  assert(initial.stopHidden === true, 'Stop button should be hidden when idle.');

  const busy = await panel.evaluate(() => {
    const ui = (window as any).sidePanelUI;
    ui.setComposerBusy(true);
    return {
      sendHidden: document.getElementById('sendBtn')?.classList.contains('hidden'),
      stopHidden: document.getElementById('stopBtn')?.classList.contains('hidden'),
      ariaBusy: document.getElementById('composer')?.getAttribute('aria-busy'),
      running: document.getElementById('composer')?.classList.contains('running'),
    };
  });
  assert(busy.sendHidden === true, 'Send button should hide while busy.');
  assert(busy.stopHidden === false, 'Stop button should appear while busy.');
  assert(busy.ariaBusy === 'true', 'Composer should expose aria-busy while running.');
  assert(busy.running === true, 'Composer should carry the running class while busy.');

  const idle = await panel.evaluate(() => {
    const ui = (window as any).sidePanelUI;
    ui.setComposerBusy(false);
    return {
      sendDisabled: document.getElementById('sendBtn')?.hasAttribute('disabled'),
      stopHidden: document.getElementById('stopBtn')?.classList.contains('hidden'),
      ariaBusy: document.getElementById('composer')?.getAttribute('aria-busy'),
    };
  });
  assert(idle.sendDisabled === false, 'Send button must be re-enabled when the run ends.');
  assert(idle.stopHidden === true, 'Stop button should hide when the run ends.');
  assert(idle.ariaBusy === 'false', 'aria-busy should be cleared when the run ends.');
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

  await worker.evaluate(
    (payload) => {
      const session = payload[0] as {
        id: string;
        startedAt: number;
        updatedAt: number;
        title: string;
        messageCount?: number;
        transcript: unknown[];
      };
      const indexEntry = {
        id: session.id,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        title: session.title,
        messageCount: session.messageCount ?? session.transcript.length,
        storageBytes: JSON.stringify(session).length,
      };
      return chrome.storage.local.set({
        chatSessionsIndex: [indexEntry],
        [`chatSession:${session.id}`]: session,
      });
    },
    [session],
  );
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
  await returnToChatView(panel);
  await panel.click('#activityToggleBtn');
  await panel.waitForSelector('#activityPanel:not(.hidden)', { timeout: e2eTimeoutMs });
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
  assert(r >= 220 && g >= 220 && b >= 220, `Expected light warm background, got rgb(${r}, ${g}, ${b})`);
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
