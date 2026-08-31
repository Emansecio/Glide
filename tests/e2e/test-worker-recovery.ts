#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { type BrowserContext, type Page, type Worker, chromium } from 'playwright';
import { emitFrontierTrace } from '../evals/frontier-trace.js';
import { getExtensionId, waitForPanelReady } from './test-helpers.js';

const root = path.resolve(process.cwd());
const extensionPath = path.join(root, 'dist');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glide-worker-recovery-'));

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

async function currentWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
}

type WorkerTarget = { targetId: string; url: string };

async function restartWorker(context: BrowserContext, panel: Page, workerTarget: WorkerTarget): Promise<WorkerTarget> {
  const browser = context.browser();
  if (!browser) throw new Error('Persistent Chromium browser handle unavailable.');
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Target.closeTarget', { targetId: workerTarget.targetId });
  await panel.waitForTimeout(250);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'run_status_query' }).catch(() => null));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    const target = targets.targetInfos.find((info) => info.type === 'service_worker' && info.url === workerTarget.url);
    if (target) {
      await cdp.detach();
      return { targetId: target.targetId, url: target.url };
    }
    await panel.waitForTimeout(100);
  }
  await cdp.detach();
  throw new Error('Service worker did not restart after run_status_query.');
}

async function seedCheckpoint(
  panel: Page,
  phase: 'model' | 'committing' | 'action_in_flight',
  runId: string,
  tool = 'click',
) {
  await panel.evaluate(
    async ({ checkpointPhase, id, actionTool }) => {
      const now = Date.now();
      const inFlightAction =
        checkpointPhase === 'action_in_flight'
          ? {
              actionId: `${id}:action:1`,
              runId: id,
              tool: actionTool,
              argsDigest: 'fixture-digest',
              state: 'in_flight',
              startedAt: now - 50,
            }
          : undefined;
      await chrome.storage.session.set({
        glideActiveRunCheckpointV1: {
          version: 1,
          runId: id,
          sessionId: 'worker-recovery-session',
          turnId: `${id}:turn`,
          phase: checkpointPhase,
          contextRevision: 0,
          selectedTabIds: [],
          request: { message: 'fixture recovery request' },
          ...(checkpointPhase === 'committing' ? { lastCommittedActionId: `${id}:action:1` } : {}),
          ...(inFlightAction ? { inFlightAction } : {}),
          startedAt: now - 100,
          updatedAt: now,
        },
        glideRunRecoveryContextV1: {
          version: 1,
          runId: id,
          sessionId: 'worker-recovery-session',
          contextRevision: 0,
          messages: [{ role: 'user', content: 'fixture recovery request' }],
        },
      });
    },
    { checkpointPhase: phase, id: runId, actionTool: tool },
  );
}

let context: BrowserContext | null = null;
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1200, height: 800 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
  const extensionId = await getExtensionId(context);
  const worker = await currentWorker(context);
  const browser = context.browser();
  if (!browser) throw new Error('Persistent Chromium browser handle unavailable.');
  const initialCdp = await browser.newBrowserCDPSession();
  const initialTargets = (await initialCdp.send('Target.getTargets')) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  };
  const initialTarget = initialTargets.targetInfos.find(
    (info) => info.type === 'service_worker' && info.url === worker.url(),
  );
  await initialCdp.detach();
  if (!initialTarget) throw new Error('Initial service worker target not found.');
  let workerTarget: WorkerTarget = { targetId: initialTarget.targetId, url: initialTarget.url };
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`, { waitUntil: 'domcontentloaded' });
  await waitForPanelReady(panel);
  await panel.evaluate(() => {
    (window as unknown as { __workerRecoveryMessages: unknown[] }).__workerRecoveryMessages = [];
    chrome.runtime.onMessage.addListener((message) => {
      (window as unknown as { __workerRecoveryMessages: unknown[] }).__workerRecoveryMessages.push(message);
    });
  });

  await seedCheckpoint(panel, 'model', 'safe-run');
  workerTarget = await restartWorker(context, panel, workerTarget);
  await panel.waitForFunction(
    () =>
      (window as unknown as { __workerRecoveryMessages: Array<{ type?: string }> }).__workerRecoveryMessages.some(
        (message) => message.type === 'run_resume_started',
      ),
    { timeout: 20_000 },
  );
  const safeMessages = await panel.evaluate(
    () => (window as unknown as { __workerRecoveryMessages: Array<{ type?: string }> }).__workerRecoveryMessages,
  );
  if (process.env.GLIDE_FRONTIER_EVAL_CASE === 'worker-safe-resume') {
    const resume = safeMessages.find((message) => message.type === 'run_resume_started');
    emitFrontierTrace('worker-safe-resume', {
      events: resume ? [{ id: 'safe-run:run_resume_started', kind: String(resume.type) }] : [],
      mutations: [],
      actionAttempts: [],
      contextRevisions: [0],
      terminalReason: resume ? 'completed' : 'failed',
      expectedTerminalReason: 'completed',
    });
  }
  console.log('PASS safe checkpoint emitted run_resume_started');

  await panel.evaluate(() => {
    (window as unknown as { __workerRecoveryMessages: unknown[] }).__workerRecoveryMessages = [];
  });
  await seedCheckpoint(panel, 'committing', 'committed-stale-run');
  workerTarget = await restartWorker(context, panel, workerTarget);
  await panel.waitForFunction(
    () =>
      (window as unknown as { __workerRecoveryMessages: Array<{ type?: string }> }).__workerRecoveryMessages.some(
        (message) => message.type === 'run_resume_required',
      ),
    { timeout: 20_000 },
  );
  const committedMessages = await panel.evaluate(
    () => (window as unknown as { __workerRecoveryMessages: Array<{ type?: string }> }).__workerRecoveryMessages,
  );
  assert(
    !committedMessages.some((message) => message.type === 'tool_execution_start'),
    'Committed action with stale recovery history replayed browser tool.',
  );
  console.log('PASS committed action with stale recovery history required confirmation with zero replay');

  await panel.evaluate(() => {
    (window as unknown as { __workerRecoveryMessages: unknown[] }).__workerRecoveryMessages = [];
  });
  await seedCheckpoint(panel, 'action_in_flight', 'ambiguous-run');
  workerTarget = await restartWorker(context, panel, workerTarget);
  await panel.waitForFunction(
    () =>
      (window as unknown as { __workerRecoveryMessages: Array<{ type?: string }> }).__workerRecoveryMessages.some(
        (message) => message.type === 'run_resume_required',
      ),
    { timeout: 20_000 },
  );
  const messages = await panel.evaluate(
    () => (window as unknown as { __workerRecoveryMessages: Array<{ type?: string }> }).__workerRecoveryMessages,
  );
  assert(
    !messages.some((message) => message.type === 'tool_execution_start'),
    'Ambiguous checkpoint replayed browser tool.',
  );
  if (process.env.GLIDE_FRONTIER_EVAL_CASE === 'worker-ambiguous-action') {
    const required = messages.find((message) => message.type === 'run_resume_required');
    const actionId = 'ambiguous-run:action:1';
    emitFrontierTrace('worker-ambiguous-action', {
      events: required ? [{ id: `${actionId}:run_resume_required`, actionId, kind: String(required.type) }] : [],
      mutations: [],
      actionAttempts: [{ actionId, state: 'ambiguous' }],
      contextRevisions: [0],
      terminalReason: required ? 'ambiguous_action' : 'failed',
      expectedTerminalReason: 'ambiguous_action',
    });
  }
  console.log('PASS ambiguous action required confirmation with zero replay');

  for (const action of [
    { runId: 'ambiguous-post-run', tool: 'httpRequest' },
    { runId: 'ambiguous-download-run', tool: 'captureDownload' },
  ]) {
    await panel.evaluate(() => {
      (window as unknown as { __workerRecoveryMessages: unknown[] }).__workerRecoveryMessages = [];
    });
    await seedCheckpoint(panel, 'action_in_flight', action.runId, action.tool);
    workerTarget = await restartWorker(context, panel, workerTarget);
    await panel.waitForFunction(
      (expectedTool) =>
        (
          window as unknown as { __workerRecoveryMessages: Array<{ type?: string; action?: { tool?: string } }> }
        ).__workerRecoveryMessages.some(
          (message) => message.type === 'run_resume_required' && message.action?.tool === expectedTool,
        ),
      action.tool,
      { timeout: 20_000 },
    );
    const actionMessages = await panel.evaluate(
      () => (window as unknown as { __workerRecoveryMessages: Array<{ type?: string }> }).__workerRecoveryMessages,
    );
    assert(
      !actionMessages.some((message) => message.type === 'tool_execution_start'),
      `${action.tool} ambiguous checkpoint replayed after restart.`,
    );
    console.log(`PASS ${action.tool} timeout checkpoint required confirmation with zero restart replay`);
  }
  void workerTarget;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
