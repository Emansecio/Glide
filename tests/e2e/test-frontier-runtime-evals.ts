#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium } from 'playwright';
import { emitFrontierTrace } from '../evals/frontier-trace.js';
import { getExtensionId, waitForPanelReady } from './test-helpers.js';

const extensionPath = path.resolve(process.cwd(), 'dist');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glide-frontier-runtime-evals-'));
const LONG_MARKER = 'FRONTIER_LONG_MARKDOWN';
const STOP_MARKER = 'FRONTIER_COMPACTION_STOP';
const longMarkdown = `# Frontier report\n\n${`${LONG_MARKER} evidence row\n\n`.repeat(250)}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type ModelFixture = {
  endpoint: string;
  close(): Promise<void>;
  diagnostics(): string[];
  waitForCompactionRequest(): Promise<void>;
};

async function startModelFixture(): Promise<ModelFixture> {
  let stopMainAnswered = false;
  const requests: string[] = [];
  let resolveCompaction!: () => void;
  const compactionRequested = new Promise<void>((resolve) => {
    resolveCompaction = resolve;
  });
  const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
      });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let stream = false;
      try {
        stream = JSON.parse(raw).stream === true;
      } catch {}
      requests.push(
        `${request.url}:${stream ? 'stream' : 'json'}:${raw.includes(LONG_MARKER) ? 'long' : raw.includes(STOP_MARKER) ? 'stop' : `other:${raw.slice(0, 300)}`}`,
      );
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'access-control-allow-origin': '*' });
        response.end();
        return;
      }
      if (stopMainAnswered && raw.includes('context summarization assistant')) {
        resolveCompaction();
        setTimeout(() => {
          if (response.writableEnded || response.destroyed) return;
          respond('SUMMARY_ARRIVED_AFTER_STOP');
        }, 3_000);
        return;
      }
      let content = 'fixture response';
      if (raw.includes(LONG_MARKER)) content = longMarkdown;
      if (raw.includes(STOP_MARKER)) {
        stopMainAnswered = true;
        content = 'Compaction stop fixture response.';
      }
      respond(content);

      function respond(content: string) {
        if (stream) {
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'close',
            'access-control-allow-origin': '*',
          });
          response.write(
            `data: ${JSON.stringify({
              id: 'frontier-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixture-model',
              choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              id: 'frontier-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixture-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            })}\n\n`,
          );
          response.end('data: [DONE]\n\n');
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        });
        response.end(
          JSON.stringify({
            id: 'frontier-fixture',
            object: 'chat.completion',
            created: 1,
            model: 'fixture-model',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Model fixture did not expose port.');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    diagnostics: () => [...requests],
    waitForCompactionRequest: () => compactionRequested,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let context: BrowserContext | undefined;
let modelFixture: ModelFixture | undefined;
try {
  modelFixture = await startModelFixture();
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
  const extensionId = await getExtensionId(context);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`, { waitUntil: 'domcontentloaded' });
  await waitForPanelReady(panel);
  await panel.evaluate(async (endpoint) => {
    (window as any).__frontierRuntimeMessages = [];
    await chrome.storage.local.set({
      provider: 'ollama',
      model: 'fixture-model',
      customEndpoint: endpoint,
      systemPrompt: 'Return fixture output.',
      systemPromptMode: 'custom',
      streamResponses: false,
      maxTokens: 4096,
      contextLimit: 16_000,
      timeout: 10_000,
      deferCompaction: false,
      enableScreenshots: false,
      visionBridge: false,
      toolPermissions: { read: true, interact: false, navigate: false, tabs: false, screenshots: false },
    });
    const ui = (window as any).sidePanelUI;
    const handleRuntimeMessage = ui.handleRuntimeMessage;
    ui.handleRuntimeMessage = function recordFrontierRuntimeMessage(message: any) {
      (window as any).__frontierRuntimeMessages.push(message);
      return handleRuntimeMessage.call(this, message);
    };
    ui.historyPersistence = 'full';
    await ui.startNewSession();
  }, modelFixture.endpoint);

  await panel.evaluate(async (marker) => {
    await chrome.storage.local.set({ streamResponses: false, contextLimit: 16_000, deferCompaction: false });
    const ui = (window as any).sidePanelUI;
    ui.elements.userInput.value = marker;
    await ui.sendMessage();
  }, LONG_MARKER);
  try {
    await panel.waitForFunction(
      (marker) => {
        const ui = (window as any).sidePanelUI;
        return (
          ui.activeRunId === null &&
          ui.contextRevision >= 1 &&
          ui.displayHistory.some((message: any) => String(message.content).includes(marker))
        );
      },
      LONG_MARKER,
      { timeout: 30_000 },
    );
  } catch (error) {
    const state = await panel.evaluate(() => {
      const ui = (window as any).sidePanelUI;
      return {
        activeRunId: ui.activeRunId,
        contextRevision: ui.contextRevision,
        displayCount: ui.displayHistory.length,
        messages: (window as any).__frontierRuntimeMessages,
        sessionId: ui.sessionId,
        status: document.querySelector('#statusText')?.textContent,
        errors: Array.from(document.querySelectorAll('.error-banner')).map((node) => node.textContent),
        input: (document.querySelector('#userInput') as HTMLTextAreaElement | null)?.value,
      };
    });
    throw new Error(
      `long Markdown runtime timeout: ${JSON.stringify({ state, requests: modelFixture.diagnostics() })}; ${String(error)}`,
    );
  }
  const longState = await panel.evaluate(async (marker) => {
    const ui = (window as any).sidePanelUI;
    await ui.flushPendingHistoryPersist();
    const messages = (window as any).__frontierRuntimeMessages as any[];
    const commit = messages.find((message) => message.type === 'context_commit' && message.sessionId === ui.sessionId);
    const final = messages.find((message) => message.type === 'assistant_final' && message.sessionId === ui.sessionId);
    const rendered = Array.from(document.querySelectorAll('.message.assistant .message-content')).find((node) =>
      node.textContent?.includes(marker),
    );
    return {
      sessionId: ui.sessionId,
      commit,
      final,
      renderedTextLength: rendered?.textContent?.length || 0,
    };
  }, LONG_MARKER);
  assert(longState.commit?.revision === 1, `long Markdown context commit missing: ${JSON.stringify(longState)}`);
  assert(longState.final?.finishReason === 'completed', `long Markdown terminal missing: ${JSON.stringify(longState)}`);
  assert(longState.renderedTextLength > 5_000, `long Markdown not rendered: ${longState.renderedTextLength}`);
  emitFrontierTrace('long-markdown', {
    events: [
      {
        source: 'runtime_message',
        id: `${longState.commit.runId}:context_commit`,
        kind: 'context_commit',
      },
    ],
    mutations: [],
    actionAttempts: [],
    contextRevisions: [{ source: 'runtime_message', revision: longState.commit.revision }],
    terminal: { source: 'runtime_message', reason: longState.final.finishReason },
  });

  await panel.reload({ waitUntil: 'domcontentloaded' });
  await waitForPanelReady(panel);
  const historyState = await panel.evaluate(
    async ({ sessionId, marker }) => {
      const ui = (window as any).sidePanelUI;
      const payload = await ui.readSessionPayload(sessionId);
      await ui.loadSession(payload);
      return {
        stored: Boolean(payload?.transcript?.some((message: any) => JSON.stringify(message.content).includes(marker))),
        rendered: ui.displayHistory.some((message: any) => JSON.stringify(message.content).includes(marker)),
        storedMessages: payload?.transcript?.length || 0,
      };
    },
    { sessionId: longState.sessionId, marker: LONG_MARKER },
  );
  assert(historyState.stored && historyState.rendered, `history reload lost report: ${JSON.stringify(historyState)}`);
  emitFrontierTrace('history-restart', {
    events: [
      {
        source: 'storage_state',
        id: `${longState.sessionId}:history:${historyState.storedMessages}`,
        kind: 'history_reload',
      },
    ],
    mutations: [],
    actionAttempts: [],
    contextRevisions: [{ source: 'runtime_message', revision: longState.commit.revision }],
    terminal: { source: 'runtime_message', reason: longState.final.finishReason },
  });

  await panel.evaluate(async () => {
    (window as any).__frontierRuntimeMessages = [];
    const ui = (window as any).sidePanelUI;
    const handleRuntimeMessage = ui.handleRuntimeMessage;
    ui.handleRuntimeMessage = function recordFrontierRuntimeMessage(message: any) {
      (window as any).__frontierRuntimeMessages.push(message);
      return handleRuntimeMessage.call(this, message);
    };
    await ui.startNewSession();
  });
  const stopPrompt = STOP_MARKER;
  await panel.evaluate(async (message) => {
    await chrome.storage.local.set({ streamResponses: false, contextLimit: 16_000, deferCompaction: false });
    const ui = (window as any).sidePanelUI;
    ui.contextHistory = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `fixture-history-${index} ${'context '.repeat(1_000)}`,
    }));
    ui.elements.userInput.value = message;
    await ui.sendMessage();
  }, stopPrompt);
  try {
    await Promise.race([
      modelFixture.waitForCompactionRequest(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Compaction request did not start.')), 20_000),
      ),
    ]);
  } catch (error) {
    const state = await panel.evaluate(() => ({
      messageTypes: ((window as any).__frontierRuntimeMessages as any[]).map((message) => message.type),
      contextLength: (window as any).sidePanelUI.contextHistory.length,
    }));
    throw new Error(`${String(error)} ${JSON.stringify({ state, requests: modelFixture.diagnostics() })}`);
  }
  const stopResponse = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'stop_run' }));
  assert(stopResponse?.success === true, `stop_run failed: ${JSON.stringify(stopResponse)}`);
  await panel.waitForFunction(
    () => (window as any).__frontierRuntimeMessages.some((message: any) => message.type === 'run_stopped'),
    { timeout: 10_000 },
  );
  await panel.waitForTimeout(3_500);
  const stopState = await panel.evaluate(() => {
    const messages = (window as any).__frontierRuntimeMessages as any[];
    const stopped = messages.find((message) => message.type === 'run_stopped');
    return {
      stopped,
      lateCommits: messages.filter((message) => message.type === 'context_commit' && message.runId === stopped?.runId)
        .length,
    };
  });
  assert(
    stopState.stopped?.details?.terminalReason === 'stopped',
    `run_stopped evidence missing: ${JSON.stringify(stopState)}`,
  );
  assert(stopState.lateCommits === 0, `stopped run committed context ${stopState.lateCommits} time(s)`);
  emitFrontierTrace('compaction-stop', {
    events: [
      {
        source: 'runtime_message',
        id: `${stopState.stopped.runId}:run_stopped`,
        kind: 'run_stopped',
      },
    ],
    mutations: [],
    actionAttempts: [],
    contextRevisions: [{ source: 'runtime_message', revision: stopState.stopped.details.contextRevision }],
    terminal: { source: 'runtime_message', reason: stopState.stopped.details.terminalReason },
  });
  console.log('PASS production runtime frontier eval fixtures');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await modelFixture?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
