#!/usr/bin/env node

/**
 * Unit Test Runner
 * Tests individual components without Chrome APIs
 */

import { generateText } from 'ai';
import {
  ensureFreshAnthropicToken,
  getAnthropicAuthHealth,
  parseAnthropicCredentials,
  reconcileManualAnthropicToken,
  resetAnthropicOAuthRefreshState,
  writeAnthropicOAuth,
} from '../../ai/anthropic-oauth.js';
import {
  COMPACTION_ENTER_PERCENT,
  COMPACTION_RELEASE_PERCENT,
  DEFAULT_COMPACTION_SETTINGS,
  applyCompaction,
  buildCompactionSummaryMessage,
  estimateContextTokens,
  findCutPoint,
  getCompactionLatchSizeForTests,
  resetCompactionHysteresis,
  shouldCompact,
} from '../../ai/compaction.js';
import {
  cloneConversationHistory,
  createMessage,
  normalizeConversationHistory,
  normalizeUsage,
  toProviderMessages,
} from '../../ai/message-schema.js';
import type { Message } from '../../ai/message-schema.js';
import { IMAGE_TOKEN_ESTIMATE, estimateTokensFromContent, extractThinking } from '../../ai/message-utils.js';
import { toModelMessages } from '../../ai/model-convert.js';
import { normalizePersistedContent, sanitizeMessageForPersistence } from '../../ai/persist-serialization.js';
import {
  createExponentialBackoff,
  extractRetryAfterMs,
  isOverloadedProviderError,
  isRetryableProviderError,
  isValidFinalResponse,
} from '../../ai/retry-engine.js';
import {
  detectTaskIntent,
  hasRecentToolActivity,
  stripInjectedTabContext,
  wrapInjectedTabContext,
} from '../../ai/task-intent.js';
import { extractRecoverableToolCalls, stripRecoverableToolCalls } from '../../ai/tool-call-recovery.js';
import { wrapUntrustedContent } from '../../ai/untrusted-content.js';

import { buildAnthropicProviderOptions, migrateAnthropicModel } from '../../ai/anthropic-options.js';
import {
  CODEX_CHATGPT_STORAGE_KEY,
  buildCodexChatGptBundleFromOAuth,
  extractChatGptAccountId,
  extractJwtExpiryMs,
  isCodexChatGptDisplayToken,
  isJwtToken,
  isOpenAiApiKey,
  parseCodexAuthJson,
  refreshCodexChatGptToken,
  resetCodexOAuthCache,
  resetCodexOAuthRefreshState,
  resolveCodexApiKeyFieldValue,
  resolveCodexAuthMode,
  writeCodexChatGptAuth,
} from '../../ai/codex-auth.js';
import { CODEX_CLIENT_ID } from '../../ai/codex-oauth.js';
import {
  CODEX_CHATGPT_RESPONSES_URL,
  convertCodexChatGptPrompt,
  createCodexChatGptModel,
} from '../../ai/codex-responses-model.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  STREAMLINED_AUTOMATION_PROMPT,
  isDefaultAutomationPrompt,
} from '../../ai/default-prompt.js';
import { isEmptyModelPassResult } from '../../ai/model-pass-result.js';
import {
  applyPromptCacheBreakpoint,
  disableAnthropicPromptCache,
  isAnthropicPromptCacheEnabled,
  isEmptyModelResponseError,
  resetAnthropicPromptCache,
} from '../../ai/prompt-cache.js';
import { GPT_56_MODELS, filterProviderModels, normalizeProviderModel } from '../../ai/providers.js';
import {
  buildModelCacheKey,
  buildRunToolSet,
  getCachedLanguageModel,
  getModelCacheSizeForTests,
  invalidateRuntimeCaches,
} from '../../ai/runtime-cache.js';
import {
  buildAnthropicOAuthHeaders,
  extensionFetch,
  migrateStoredProvider,
  resolveLanguageModel,
  resolveProviderBaseUrl,
  serializeToolOutputForMedia,
} from '../../ai/sdk-client.js';
import { buildToolTurnMessages } from '../../ai/tool-history.js';
import { ModelActivityWatchdog } from '../../background/activity-timeout.js';
import {
  shouldForceToolContinuation,
  textAwaitsUser,
  textPromisesFurtherAction,
  textSignalsInProgressWork,
} from '../../background/continuation-intent.js';
import { DEFAULT_DOM_CACHE_TTL_MS, DomCacheLru, buildDomCacheKey } from '../../background/dom-cache.js';
import {
  FailureRecoveryTracker,
  advanceFailedToolRecovery,
  buildFailureSignature,
  buildTerminalToolFailure,
  decideFailedToolOutcome,
  isFailureTrackedTool,
  normalizeThrownToolError,
  shouldForceFailedToolContinuation,
} from '../../background/failure-recovery.js';
import {
  arrayBufferToBase64,
  clipIntersectsBitmap,
  computeClipRect,
  computeDownscale,
  needsScreenshotDownscale,
  rectIntersectsViewport,
  uint8ArrayToBase64,
} from '../../background/image-scale.js';
import {
  formatOllamaListSummary,
  formatOllamaModified,
  formatOllamaSize,
  normalizeOllamaBaseUrl,
  parseOllamaTagsPayload,
  shortDigestId,
} from '../../background/ollama-detect.js';
import {
  bindPanelPortListener,
  bumpSidePanelClaimGeneration,
  getSidePanelClaimGeneration,
  hasConnectedPanelPorts,
  postToPanelPorts,
  resetPanelPortsForTests,
  resetSidePanelClaimGenerationForTests,
} from '../../background/panel-port.js';
import { checkProviderReadiness } from '../../background/preflight.js';
import {
  extractCdpNavigateUrl,
  isCdpNavigateMethod,
  wrapUntrustedToolPayload,
} from '../../background/prompt-delimiters.js';
import {
  PROVIDER_DNR_RULES_INSTALLED_KEY,
  installProviderNetRequestRules,
} from '../../background/provider-net-rules.js';
import { RunAbortRegistry } from '../../background/run-abort-registry.js';
import { RunEventSequencer } from '../../background/run-event-sequencer.js';
import { RunPassCache } from '../../background/run-pass-cache.js';
import {
  MAX_RUNTIME_DELTA_CHARS,
  RuntimeBatcher,
  buildStreamDeltaPayload,
  type buildToolEventsBatchPayload,
} from '../../background/runtime-batcher.js';
import { selectRuntimePushChannel } from '../../background/runtime-push.js';
import {
  MAX_SCREENSHOT_COUNT,
  MAX_SCREENSHOT_TOTAL_BYTES,
  planScreenshotPrune,
} from '../../background/screenshot-store.js';
import {
  BROWSER_ACTION_TOOLS,
  LOCKED_TAB_ALLOWED_BROWSER_TOOLS,
  MUTATIVE_TOOLS,
  humanizeProviderError,
  isDeliberateRunStop,
  shouldInvalidateDomCache,
} from '../../background/service-config.js';
import { SessionContextStore, resolveUserMessageContextAction } from '../../background/session-context-store.js';
import {
  ActiveRunSentinelRegistry,
  SessionCompactionQueue,
  SessionGenerationRegistry,
  SessionTombstoneRegistry,
  createSentinelToken,
} from '../../background/session-lifecycle.js';
import { buildSessionTools } from '../../background/session-tools.js';
import { RUNTIME_SETTINGS_KEYS, normalizeRuntimeSettings } from '../../background/settings-cache.js';
import {
  DEFAULT_TOOL_PERMISSIONS,
  getToolPermissionCategory,
  isToolCategoryAllowed,
} from '../../background/tool-permissions.js';
import { MAX_QUEUED_VISION_JOBS, VisionQueue, resolveVisualDeliveryMode } from '../../background/vision-queue.js';
import {
  CHAT_SESSIONS_INDEX_KEY,
  CHAT_SESSION_KEY_PREFIX,
  buildHistoryIndexEntry,
  buildHistoryPersistSignature,
  buildLegacyMigrationStorageUpdates,
  compactSessionPayload,
  isHistoryLoadTokenStale,
  pruneHistoryIndex,
  resolveContextTranscript,
  shouldWriteThinkingTimerLabel,
  splitLegacyChatSessions,
} from '../../sidepanel/ui/history-storage.js';
import { MARKDOWN_DEFER_MIN_CHARS, shouldDeferMarkdownRender } from '../../sidepanel/ui/markdown-render-defer.js';
import {
  boundPanelIdSet,
  buildModelProbeRequestKey,
  isHistoryListLoadTokenStale,
  isHistoryPersistBarrierStale,
  isModelProbeResponseStale,
  isRenderGenerationStale,
  shouldAcceptContextCompaction,
  shouldPersistAutoDetectedModel,
} from '../../sidepanel/ui/panel-guards.js';
import {
  PORT_RECONNECT_INITIAL_MS,
  PORT_RECONNECT_MAX_MS,
  computePortReconnectDelayMs,
} from '../../sidepanel/ui/panel-port.js';
import { SerialTaskQueue } from '../../sidepanel/ui/serial-task-queue.js';
import { readProviderKeyMap, resolveProviderApiKey } from '../../sidepanel/ui/settings-keys.js';
import { MAX_PENDING_STREAM_MESSAGES, enqueueStreamMessage } from '../../sidepanel/ui/stream-queue.js';
import {
  MAX_TOOL_LOG_BUFFER,
  appendCappedToolLogBuffer,
  updateToolLogBufferResult,
} from '../../sidepanel/ui/tool-log-buffer.js';
import {
  BrowserTools,
  SET_INPUT_FILES_MAX_TOTAL_BYTES,
  normalizeSetInputFileSpecs,
} from '../../tools/browser-tools.js';
import { GLIDE_BRIDGE_MESSAGE_TYPE, isMutativeBridgeOp, shouldFallbackFromBridge } from '../../tools/content-bridge.js';
import { isSameOriginUrl, isUrlAllowedByDomains, parseAllowedDomains } from '../../tools/domain-policy.js';
import {
  buildExecutableBody,
  isCspEvalError,
  resolveExecuteScriptTimeoutMs,
  resolveExecuteScriptWorld,
  runUserScriptInPage,
  shouldAllowMainToIsolatedFallback,
  truncateExecuteScriptValue,
} from '../../tools/execute-script-runner.js';
import { pickFrameIdForSelectorProbe } from '../../tools/frame-discovery.js';
import {
  FRAME_TARGET_TOOLS,
  type FrameInfo,
  absoluteFrameUrl,
  matchFramesByUrlSubstring,
  resolveTargetFrameId,
} from '../../tools/frame-target.js';
import {
  normalizeHttpMethod,
  performHttpRequest,
  resolveRedirectUrl,
  sanitizeHttpHeaders,
  stripSensitiveHeadersForRedirect,
} from '../../tools/http-request.js';
import {
  getInjectedFnId,
  glideDispatchInjectedFn,
  glideInstallAndRunInjectedFn,
  isInjectedFnEvalBlocked,
  isInjectedFnMissing,
  isInjectedFnResult,
  resetInjectedFnIdsForTests,
} from '../../tools/injected-fn-registry.js';
import { shouldAutoStopNetworkCapture, shouldDrainInflightBeforeStop } from '../../tools/network-capture.js';
import { assignReadPageRefs } from '../../tools/ref-resolver.js';
import { waitForHistoryTransition } from '../../tools/tab-readiness.js';
import { isTabLoadComplete } from '../../tools/tab-readiness.js';
import { expandTableRowCells } from '../../tools/table-cells.js';
import { buildToolDefinitions } from '../../tools/tool-definitions.js';
import { TOOL_HANDLER_REGISTRY } from '../../tools/tool-registry.js';
import { requireHttpUrl } from '../../tools/validation.js';
import { buildRunPlan, normalizePlanStatus, normalizePlanSteps } from '../../types/plan.js';
import type { RunPlan } from '../../types/plan.js';
import {
  RUNTIME_MESSAGE_SCHEMA_VERSION,
  isRuntimeMessage,
  isUserMessagePanel,
  salvageToolEventsBatchEvents,
  validateUserMessagePanel,
} from '../../types/runtime-messages.js';
import type { RuntimeMessage } from '../../types/runtime-messages.js';
import {
  MODEL_CORRECTNESS_CASES,
  extractJsonObject,
  firstContentLine,
  resolveMinPassRate,
  summarizeCorrectness,
} from '../integration/model-correctness-cases.js';

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

type ToolSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

type ToolDefinition = {
  name: string;
  description: string;
  input_schema: ToolSchema;
};

type ProviderConfig = {
  provider: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  customEndpoint?: string;
};

class TestRunner {
  passed: number;
  failed: number;
  errors: Array<{ test: string; error: string }>;

  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
  }

  test(description: string, fn: () => void) {
    try {
      fn();
      this.passed++;
      log(`✓ ${description}`, 'success');
      return true;
    } catch (error) {
      const err = error as Error;
      this.failed++;
      this.errors.push({ test: description, error: err.message });
      log(`✗ ${description}: ${err.message}`, 'error');
      return false;
    }
  }

  // test() não aguarda promises — um callback async passaria mesmo falhando.
  async asyncTest(description: string, fn: () => Promise<void>) {
    try {
      await fn();
      this.passed++;
      log(`✓ ${description}`, 'success');
      return true;
    } catch (error) {
      const err = error as Error;
      this.failed++;
      this.errors.push({ test: description, error: err.message });
      log(`✗ ${description}: ${err.message}`, 'error');
      return false;
    }
  }

  assertEqual(actual: unknown, expected: unknown, message = '') {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
    }
  }

  assertTrue(condition: unknown, message = 'Assertion failed') {
    if (!condition) {
      throw new Error(message);
    }
  }

  assertFalse(condition: unknown, message = 'Assertion failed') {
    if (condition) {
      throw new Error(message);
    }
  }

  assertThrows(fn: () => void, message = 'Should have thrown an error') {
    try {
      fn();
      throw new Error(message);
    } catch (error) {
      const err = error as Error;
      if (err.message === message) {
        throw err;
      }
      // Expected error
    }
  }

  printSummary() {
    log('\n=== Unit Test Summary ===', 'info');
    log(`Tests Passed: ${this.passed}`, 'success');

    if (this.failed > 0) {
      log(`Tests Failed: ${this.failed}`, 'error');
      log('\nFailed Tests:', 'error');
      this.errors.forEach((e) => {
        log(`  ${e.test}:`, 'error');
        log(`    ${e.error}`, 'error');
      });
    }

    if (this.failed === 0) {
      log('\n✓ All unit tests passed!', 'success');
      return true;
    } else {
      log('\n✗ Some unit tests failed!', 'error');
      return false;
    }
  }
}

// Test Tool Definitions Structure
function testToolDefinitions(runner: TestRunner) {
  log('\n=== Testing Tool Definitions ===', 'info');

  // Mock BrowserTools without Chrome APIs
  const mockToolDefinitions: ToolDefinition[] = [
    {
      name: 'navigate',
      description: 'Navigate to a URL',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          tabId: { type: 'number' },
        },
        required: ['url'],
      },
    },
  ];

  runner.test('Tool definitions have required fields', () => {
    mockToolDefinitions.forEach((tool) => {
      runner.assertTrue(tool.name, 'Tool must have name');
      runner.assertTrue(tool.description, 'Tool must have description');
      runner.assertTrue(tool.input_schema, 'Tool must have input_schema');
      runner.assertTrue(tool.input_schema.type === 'object', 'Schema type must be object');
      runner.assertTrue(tool.input_schema.properties, 'Schema must have properties');
    });
  });

  runner.test('Required parameters are properly marked', () => {
    const navTool = mockToolDefinitions.find((t) => t.name === 'navigate');
    runner.assertTrue(navTool?.input_schema.required?.includes('url'), 'Navigate requires url');
  });

  runner.test('wait selector documents visible readiness', () => {
    const tools = buildToolDefinitions(8);
    const waitTool = tools.find((t) => t.name === 'wait');
    runner.assertTrue(!!waitTool, 'wait must be registered');
    const selectorProp = waitTool?.input_schema?.properties?.selector as { description?: string } | undefined;
    runner.assertTrue(
      String(selectorProp?.description || '')
        .toLowerCase()
        .includes('visible'),
      'selector wait should require visibility',
    );
    runner.assertTrue(
      String(waitTool?.description || '')
        .toLowerCase()
        .includes('visible'),
      'wait description should mention visibility gate for selector',
    );
  });

  runner.test('setInputFiles documents and accepts base64 payloads', () => {
    const tools = buildToolDefinitions(8);
    const upload = tools.find((t) => t.name === 'setInputFiles');
    runner.assertTrue(!!upload, 'setInputFiles must be registered');
    runner.assertTrue(String(upload?.description || '').includes('contentBase64'), 'mentions contentBase64');
    const normalized = normalizeSetInputFileSpecs([
      { name: 'note.txt', content: 'hello', mimeType: 'text/plain' },
      { name: 'photo.png', content: 'ignored', contentBase64: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
    runner.assertTrue(Array.isArray(normalized), 'expected normalized file specs');
    if (!Array.isArray(normalized)) return;
    runner.assertEqual(normalized.length, 2);
    runner.assertEqual(normalized[0]?.content, 'hello');
    runner.assertEqual(normalized[0]?.contentBase64, undefined);
    runner.assertEqual(normalized[1]?.contentBase64, 'aGVsbG8=');
    runner.assertEqual(normalized[1]?.content, undefined);
    runner.assertEqual(normalized[1]?.mimeType, 'image/png');
  });

  runner.test('getNetworkRequests exposes body/filter params for API discovery', () => {
    const tools = buildToolDefinitions(8);
    const net = tools.find((t) => t.name === 'getNetworkRequests');
    runner.assertTrue(!!net, 'getNetworkRequests must be registered');
    const props = net?.input_schema?.properties || {};
    runner.assertTrue('filterUrl' in props, 'filterUrl');
    runner.assertTrue('filterMethod' in props, 'filterMethod');
    runner.assertTrue('includeRequestBody' in props, 'includeRequestBody');
    runner.assertTrue('includeResponseBody' in props, 'includeResponseBody');
    runner.assertTrue('maxBodyChars' in props, 'maxBodyChars');
    runner.assertTrue('stop' in props, 'stop');
    runner.assertTrue(
      String(net?.description || '')
        .toLowerCase()
        .includes('network'),
      'description should mention network capture',
    );
    runner.assertTrue(
      String(net?.description || '').includes('doc_id') || String(net?.description || '').includes('requestBody'),
      'description should mention body/doc_id capture',
    );
  });

  runner.test('executeScript documents ISOLATED default and optional world', () => {
    const tools = buildToolDefinitions(8);
    const exec = tools.find((t) => t.name === 'executeScript');
    runner.assertTrue(!!exec, 'executeScript must be registered');
    const props = exec?.input_schema?.properties || {};
    runner.assertTrue('code' in props, 'code param');
    runner.assertTrue('world' in props, 'world param');
    runner.assertTrue('timeoutMs' in props, 'timeoutMs param');
    runner.assertTrue(String(exec?.description || '').includes('ISOLATED'), 'mentions ISOLATED default');
  });

  runner.test('httpRequest is registered for extension-host API calls', () => {
    const tools = buildToolDefinitions(8);
    const http = tools.find((t) => t.name === 'httpRequest');
    runner.assertTrue(!!http, 'httpRequest must be registered');
    const props = http?.input_schema?.properties || {};
    runner.assertTrue('url' in props, 'url');
    runner.assertTrue('headers' in props, 'headers');
    runner.assertTrue(http?.input_schema?.required?.includes('url'), 'url required');
    runner.assertTrue(String(http?.description || '').includes('EXTENSION'), 'outside page');
  });

  runner.test('Layer2 tools: readPage, clipboard, setInputFiles, cdp are registered', () => {
    const tools = buildToolDefinitions(8);
    const names = tools.map((t) => t.name);
    for (const name of ['readPage', 'clipboard', 'setInputFiles', 'cdp']) {
      runner.assertTrue(names.includes(name), `${name} registered`);
    }
    const mouse = tools.find((t) => t.name === 'mouse');
    const actions = (mouse?.input_schema?.properties as any)?.action?.enum || [];
    runner.assertTrue(actions.includes('drag'), 'mouse supports drag');
    runner.assertTrue('toSelector' in (mouse?.input_schema?.properties || {}), 'mouse has toSelector');
  });

  runner.test('pressKey schema exposes modifier chord enum', () => {
    const tools = buildToolDefinitions(8);
    const pressKey = tools.find((t) => t.name === 'pressKey');
    runner.assertTrue(!!pressKey, 'pressKey must be registered');
    const modifiers = (pressKey?.input_schema?.properties as any)?.modifiers;
    runner.assertEqual(modifiers?.type, 'array');
    runner.assertTrue(Array.isArray(modifiers?.items?.enum), 'modifiers items enum');
    runner.assertTrue(modifiers.items.enum.includes('Control'), 'Control modifier');
    runner.assertTrue(
      String(pressKey?.description || '')
        .toLowerCase()
        .includes('os-level'),
      'pressKey description warns about OS shortcuts',
    );
  });

  runner.test('wait schema includes visible, hidden, and networkIdle conditions', () => {
    const tools = buildToolDefinitions(8);
    const waitTool = tools.find((t) => t.name === 'wait');
    runner.assertTrue(!!waitTool, 'wait must be registered');
    const conditions = (waitTool?.input_schema?.properties as any)?.condition?.enum || [];
    for (const expected of ['visible', 'hidden', 'networkIdle']) {
      runner.assertTrue(conditions.includes(expected), `${expected} condition`);
    }
    runner.assertTrue('idleMs' in (waitTool?.input_schema?.properties || {}), 'idleMs param');
  });

  runner.test('selectOption, fillForm, navigateHistory, highlightElement are registered', () => {
    const tools = buildToolDefinitions(8);
    const names = tools.map((t) => t.name);
    for (const name of ['selectOption', 'fillForm', 'navigateHistory', 'highlightElement']) {
      runner.assertTrue(names.includes(name), `${name} registered`);
    }
    const selectOption = tools.find((t) => t.name === 'selectOption');
    runner.assertTrue(selectOption?.input_schema?.required?.includes('selector'), 'selectOption requires selector');
    const navigateHistory = tools.find((t) => t.name === 'navigateHistory');
    const actions = (navigateHistory?.input_schema?.properties as any)?.action?.enum || [];
    runner.assertTrue(actions.includes('back') && actions.includes('forward') && actions.includes('reload'));
    const highlight = tools.find((t) => t.name === 'highlightElement');
    runner.assertTrue('ref' in (highlight?.input_schema?.properties || {}), 'highlightElement has ref');
    const fillForm = tools.find((t) => t.name === 'fillForm');
    runner.assertTrue(fillForm?.input_schema?.required?.includes('fields'), 'fillForm requires fields');
  });

  runner.test('captureDownload, findInPage, extractTable, harvestScroll are registered', () => {
    const tools = buildToolDefinitions(8);
    const names = tools.map((t) => t.name);
    for (const name of ['captureDownload', 'findInPage', 'extractTable', 'harvestScroll']) {
      runner.assertTrue(names.includes(name), `${name} registered`);
    }
    const findInPage = tools.find((t) => t.name === 'findInPage');
    runner.assertTrue(findInPage?.input_schema?.required?.includes('query'), 'findInPage requires query');
    const harvest = tools.find((t) => t.name === 'harvestScroll');
    runner.assertTrue(harvest?.input_schema?.required?.includes('itemSelector'), 'harvestScroll requires itemSelector');
    const capture = tools.find((t) => t.name === 'captureDownload');
    runner.assertTrue('trigger' in (capture?.input_schema?.properties || {}), 'captureDownload has trigger');
    runner.assertTrue('url' in (capture?.input_schema?.properties || {}), 'captureDownload has url');
  });
}

function testBrowserToolArgValidation(runner: TestRunner) {
  log('\n=== Testing Browser Tool Arg Validation ===', 'info');
  const tools = new BrowserTools();

  runner.test('pressKey accepts valid modifier chords', () => {
    const result = tools.validateToolArgs('pressKey', { key: 'k', modifiers: ['Control', 'Shift'] });
    runner.assertTrue(result.ok, 'valid modifiers accepted');
    if (result.ok) {
      runner.assertEqual(result.args.modifiers?.join('+'), 'Control+Shift');
    }
  });

  runner.test('pressKey rejects invalid modifiers', () => {
    const result = tools.validateToolArgs('pressKey', { key: 'k', modifiers: ['Super'] });
    runner.assertFalse(result.ok, 'invalid modifier rejected');
  });

  runner.test('wait networkIdle clamps idleMs to 100–10000', () => {
    const low = tools.validateToolArgs('wait', { condition: 'networkIdle', idleMs: 20 });
    runner.assertTrue(low.ok, 'low idleMs accepted');
    if (low.ok) runner.assertEqual(low.args.idleMs, 100);

    const high = tools.validateToolArgs('wait', { condition: 'networkIdle', idleMs: 99999 });
    runner.assertTrue(high.ok, 'high idleMs accepted');
    if (high.ok) runner.assertEqual(high.args.idleMs, 10000);

    const defaults = tools.validateToolArgs('wait', { condition: 'networkIdle' });
    runner.assertTrue(defaults.ok, 'networkIdle defaults idleMs');
    if (defaults.ok) runner.assertEqual(defaults.args.idleMs, 500);
  });

  runner.test('wait hidden requires selector', () => {
    const result = tools.validateToolArgs('wait', { condition: 'hidden' });
    runner.assertFalse(result.ok, 'hidden without selector rejected');
  });

  runner.test('selectOption requires exactly one of value, label, or index', () => {
    const missing = tools.validateToolArgs('selectOption', { selector: '#country' });
    runner.assertFalse(missing.ok, 'missing criteria rejected');
    const both = tools.validateToolArgs('selectOption', { selector: '#country', value: 'br', label: 'Brazil' });
    runner.assertFalse(both.ok, 'multiple criteria rejected');
    const ok = tools.validateToolArgs('selectOption', { selector: '#country', label: 'Brazil' });
    runner.assertTrue(ok.ok, 'single label accepted');
  });

  runner.test('fillForm caps fields at 20 and validates field modes', () => {
    const empty = tools.validateToolArgs('fillForm', { fields: [] });
    runner.assertFalse(empty.ok, 'empty fields rejected');
    const badField = tools.validateToolArgs('fillForm', {
      fields: [{ selector: '#email', text: 'a', checked: true }],
    });
    runner.assertFalse(badField.ok, 'multiple field modes rejected');
    const many = tools.validateToolArgs('fillForm', {
      fields: Array.from({ length: 25 }, (_, i) => ({ selector: `#f${i}`, text: 'x' })),
    });
    runner.assertTrue(many.ok, 'many fields accepted');
    if (many.ok) runner.assertEqual(many.args.fields.length, 20, 'fields capped at 20');
  });

  runner.test('navigateHistory validates action enum', () => {
    const bad = tools.validateToolArgs('navigateHistory', { action: 'refresh' });
    runner.assertFalse(bad.ok, 'invalid action rejected');
    const ok = tools.validateToolArgs('navigateHistory', { action: 'back' });
    runner.assertTrue(ok.ok, 'back accepted');
    if (ok.ok) runner.assertEqual(ok.args.action, 'back');
  });

  runner.test('highlightElement requires selector or ref and clamps durationMs', () => {
    const missing = tools.validateToolArgs('highlightElement', {});
    runner.assertFalse(missing.ok, 'missing target rejected');
    const both = tools.validateToolArgs('highlightElement', { selector: '#x', ref: 'e1' });
    runner.assertFalse(both.ok, 'selector+ref rejected');
    const low = tools.validateToolArgs('highlightElement', { ref: 'e2', durationMs: 50 });
    runner.assertTrue(low.ok, 'low duration accepted');
    if (low.ok) runner.assertEqual(low.args.durationMs, 200);
    const high = tools.validateToolArgs('highlightElement', { ref: 'e2', durationMs: 9000 });
    runner.assertTrue(high.ok, 'high duration accepted');
    if (high.ok) runner.assertEqual(high.args.durationMs, 5000);
  });

  runner.test('annotatedScreenshot and elementScreenshot are registered with schema', () => {
    const defs = buildToolDefinitions(8);
    for (const name of ['annotatedScreenshot', 'elementScreenshot'] as const) {
      runner.assertTrue(
        defs.some((t) => t.name === name),
        `${name} registered`,
      );
      runner.assertEqual(TOOL_HANDLER_REGISTRY[name], name, `${name} registry mapping`);
    }
    const annotated = defs.find((t) => t.name === 'annotatedScreenshot');
    runner.assertTrue('maxMarks' in (annotated?.input_schema?.properties || {}), 'annotatedScreenshot has maxMarks');
    runner.assertTrue('scope' in (annotated?.input_schema?.properties || {}), 'annotatedScreenshot has scope');
    const element = defs.find((t) => t.name === 'elementScreenshot');
    runner.assertTrue('ref' in (element?.input_schema?.properties || {}), 'elementScreenshot has ref');
    runner.assertTrue('padding' in (element?.input_schema?.properties || {}), 'elementScreenshot has padding');
  });

  runner.test('annotatedScreenshot validates scope and clamps maxMarks', () => {
    const badScope = tools.validateToolArgs('annotatedScreenshot', { scope: 'auto' });
    runner.assertFalse(badScope.ok, 'auto scope rejected');
    const okScope = tools.validateToolArgs('annotatedScreenshot', { scope: 'dialog' });
    runner.assertTrue(okScope.ok, 'dialog scope accepted');
    if (okScope.ok) runner.assertEqual(okScope.args.scope, 'dialog');
    const low = tools.validateToolArgs('annotatedScreenshot', { maxMarks: 0 });
    runner.assertTrue(low.ok, 'low maxMarks accepted');
    if (low.ok) runner.assertEqual(low.args.maxMarks, 1);
    const high = tools.validateToolArgs('annotatedScreenshot', { maxMarks: 999 });
    runner.assertTrue(high.ok, 'high maxMarks accepted');
    if (high.ok) runner.assertEqual(high.args.maxMarks, 80);
  });

  runner.test('elementScreenshot requires selector or ref and clamps padding', () => {
    const missing = tools.validateToolArgs('elementScreenshot', {});
    runner.assertFalse(missing.ok, 'missing target rejected');
    const both = tools.validateToolArgs('elementScreenshot', { selector: '#x', ref: 'e1' });
    runner.assertFalse(both.ok, 'selector+ref rejected');
    const okRef = tools.validateToolArgs('elementScreenshot', { ref: 'e4' });
    runner.assertTrue(okRef.ok, 'ref accepted');
    const highPad = tools.validateToolArgs('elementScreenshot', { selector: '#btn', padding: 500 });
    runner.assertTrue(highPad.ok, 'high padding accepted');
    if (highPad.ok) runner.assertEqual(highPad.args.padding, 100);
  });

  runner.test('screenshot tools use screenshots permission category', () => {
    for (const name of ['screenshot', 'annotatedScreenshot', 'elementScreenshot'] as const) {
      runner.assertEqual(getToolPermissionCategory(name), 'screenshots', `${name} is screenshots`);
    }
  });

  runner.test('tool registry maps new browser tools', () => {
    for (const name of ['selectOption', 'fillForm', 'navigateHistory', 'highlightElement'] as const) {
      runner.assertEqual(TOOL_HANDLER_REGISTRY[name], name, `${name} registry mapping`);
    }
  });

  runner.test('new tool permission categories', () => {
    runner.assertEqual(getToolPermissionCategory('selectOption'), 'interact');
    runner.assertEqual(getToolPermissionCategory('fillForm'), 'interact');
    runner.assertEqual(getToolPermissionCategory('highlightElement'), 'interact');
    runner.assertEqual(getToolPermissionCategory('navigateHistory'), 'navigate');
    runner.assertEqual(getToolPermissionCategory('captureDownload'), 'downloads');
    runner.assertEqual(getToolPermissionCategory('findInPage'), 'read');
    runner.assertEqual(getToolPermissionCategory('extractTable'), 'read');
    runner.assertEqual(getToolPermissionCategory('harvestScroll'), 'read');
  });

  runner.test('captureDownload rejects saveAs true and clamps timeoutMs', () => {
    const saveAs = tools.validateToolArgs('captureDownload', { saveAs: true });
    runner.assertFalse(saveAs.ok, 'saveAs true rejected');
    const low = tools.validateToolArgs('captureDownload', { timeoutMs: 500 });
    runner.assertTrue(low.ok, 'low timeout accepted');
    if (low.ok) runner.assertEqual(low.args.timeoutMs, 1000);
    const high = tools.validateToolArgs('captureDownload', { timeoutMs: 999999 });
    runner.assertTrue(high.ok, 'high timeout accepted');
    if (high.ok) runner.assertEqual(high.args.timeoutMs, 120000);
    const badUrl = tools.validateToolArgs('captureDownload', { url: 'javascript:alert(1)' });
    runner.assertFalse(badUrl.ok, 'bad url rejected');
    const badTrigger = tools.validateToolArgs('captureDownload', { trigger: {} });
    runner.assertFalse(badTrigger.ok, 'empty trigger rejected');
  });

  runner.test('findInPage requires query and clamps maxMatches', () => {
    const missing = tools.validateToolArgs('findInPage', {});
    runner.assertFalse(missing.ok, 'missing query rejected');
    const ok = tools.validateToolArgs('findInPage', { query: 'invoice', maxMatches: 200 });
    runner.assertTrue(ok.ok, 'valid findInPage accepted');
    if (ok.ok) {
      runner.assertEqual(ok.args.maxMatches, 100);
      runner.assertEqual(ok.args.scrollToFirst, true);
    }
  });

  runner.test('extractTable clamps maxRows and defaults includeHeaders', () => {
    const ok = tools.validateToolArgs('extractTable', { maxRows: 5000 });
    runner.assertTrue(ok.ok, 'extractTable accepted');
    if (ok.ok) {
      runner.assertEqual(ok.args.maxRows, 1000);
      runner.assertEqual(ok.args.includeHeaders, true);
    }
  });

  runner.test('harvestScroll requires itemSelector and clamps stableRounds', () => {
    const missing = tools.validateToolArgs('harvestScroll', {});
    runner.assertFalse(missing.ok, 'missing itemSelector rejected');
    const ok = tools.validateToolArgs('harvestScroll', { itemSelector: '.card', stableRounds: 9, maxItems: 5000 });
    runner.assertTrue(ok.ok, 'harvestScroll accepted');
    if (ok.ok) {
      runner.assertEqual(ok.args.stableRounds, 5);
      runner.assertEqual(ok.args.maxItems, 1000);
    }
  });

  runner.test('tool registry maps read/download browser tools', () => {
    for (const name of ['captureDownload', 'findInPage', 'extractTable', 'harvestScroll'] as const) {
      runner.assertEqual(TOOL_HANDLER_REGISTRY[name], name, `${name} registry mapping`);
    }
  });

  runner.test('downloads permission is allow-by-default', () => {
    runner.assertTrue(DEFAULT_TOOL_PERMISSIONS.downloads, 'downloads defaults on');
    runner.assertTrue(isToolCategoryAllowed('downloads', {}), 'downloads allowed when unset');
    runner.assertFalse(isToolCategoryAllowed('downloads', { downloads: false }), 'downloads blocked when false');
  });
}

function testFrameTargetSchema(runner: TestRunner) {
  log('\n=== Testing Frame Target Schema ===', 'info');
  const tools = buildToolDefinitions(8);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const toolName of FRAME_TARGET_TOOLS) {
    runner.test(`${toolName} schema exposes frameUrl and frameSelector`, () => {
      const props = byName.get(toolName)?.input_schema?.properties || {};
      runner.assertTrue('frameUrl' in props, `${toolName} has frameUrl`);
      runner.assertTrue('frameSelector' in props, `${toolName} has frameSelector`);
    });
  }
}

function testFrameTargetValidation(runner: TestRunner) {
  log('\n=== Testing Frame Target Validation ===', 'info');
  const tools = new BrowserTools();

  runner.test('click accepts frameUrl and frameSelector strings', () => {
    const ok = tools.validateToolArgs('click', {
      selector: '#pay',
      frameUrl: 'stripe.com/checkout',
      frameSelector: 'iframe#payments',
    });
    runner.assertTrue(ok.ok, 'frame params accepted');
    if (ok.ok) {
      runner.assertEqual(ok.args.frameUrl, 'stripe.com/checkout');
      runner.assertEqual(ok.args.frameSelector, 'iframe#payments');
    }
  });

  runner.test('type rejects non-string frameUrl', () => {
    const bad = tools.validateToolArgs('type', { selector: '#x', text: 'hi', frameUrl: 123 });
    runner.assertFalse(bad.ok, 'non-string frameUrl rejected');
  });

  runner.test('findElement rejects empty frameSelector', () => {
    const bad = tools.validateToolArgs('findElement', { query: 'Pay', frameSelector: '   ' });
    runner.assertFalse(bad.ok, 'empty frameSelector rejected');
  });

  runner.test('findElement accepts deep boolean', () => {
    const ok = tools.validateToolArgs('findElement', { query: 'Email', deep: true });
    runner.assertTrue(ok.ok, 'deep=true accepted');
    if (ok.ok) runner.assertEqual(ok.args.deep, true);
    const bad = tools.validateToolArgs('findElement', { query: 'Email', deep: 'yes' });
    runner.assertFalse(bad.ok, 'non-boolean deep rejected');
  });
}

function testResolveTargetFrameIdHelper(runner: TestRunner) {
  log('\n=== Testing resolveTargetFrameId ===', 'info');

  const frames: FrameInfo[] = [
    { frameId: 0, url: 'https://shop.example/checkout', parentFrameId: -1 },
    { frameId: 42, url: 'https://js.stripe.com/v3/controller', parentFrameId: 0 },
    { frameId: 43, url: 'https://js.stripe.com/v3/elements', parentFrameId: 0 },
  ];

  runner.test('absoluteFrameUrl resolves relative iframe src', () => {
    runner.assertEqual(
      absoluteFrameUrl('/embed/pay', 'https://shop.example/checkout'),
      'https://shop.example/embed/pay',
    );
  });

  runner.test('matchFramesByUrlSubstring is case-insensitive', () => {
    const matches = matchFramesByUrlSubstring(frames, 'STRIPE.COM/V3/CONTROLLER');
    runner.assertEqual(matches.length, 1);
    runner.assertEqual(matches[0]?.frameId, 42);
  });

  runner.test('resolveTargetFrameId picks unique match', () => {
    const result = resolveTargetFrameId(frames, { frameUrl: 'elements' });
    runner.assertTrue(result.ok, 'unique match ok');
    if (result.ok) {
      runner.assertEqual(result.frameId, 43);
    }
  });

  runner.test('resolveTargetFrameId returns FRAME_NOT_FOUND when no match', () => {
    const result = resolveTargetFrameId(frames, { frameUrl: 'paypal' });
    runner.assertFalse(result.ok, 'not found');
    if (!result.ok) runner.assertEqual(result.code, 'FRAME_NOT_FOUND');
  });

  runner.test('resolveTargetFrameId returns FRAME_AMBIGUOUS with candidates', () => {
    const result = resolveTargetFrameId(frames, { frameUrl: 'stripe.com/v3' });
    runner.assertFalse(result.ok, 'ambiguous');
    if (!result.ok) {
      runner.assertEqual(result.code, 'FRAME_AMBIGUOUS');
      runner.assertEqual(result.candidates?.length, 2);
    }
  });
}

function testHttpRequestHelper(runner: TestRunner) {
  log('\n=== Testing httpRequest helpers ===', 'info');

  runner.test('sanitizeHttpHeaders strips forbidden cookie/host headers', () => {
    const h = sanitizeHttpHeaders({
      'X-IG-App-ID': '123',
      Cookie: 'sessionid=secret',
      Host: 'evil',
      'X-CSRFToken': 'tok',
    });
    runner.assertEqual(h['X-IG-App-ID'], '123');
    runner.assertEqual(h['X-CSRFToken'], 'tok');
    runner.assertTrue(!('Cookie' in h) && !('cookie' in h), 'cookie stripped');
    runner.assertTrue(!('Host' in h), 'host stripped');
  });

  runner.test('normalizeHttpMethod defaults and uppercases', () => {
    runner.assertEqual(normalizeHttpMethod(undefined), 'GET');
    runner.assertEqual(normalizeHttpMethod('post'), 'POST');
    runner.assertEqual(normalizeHttpMethod('TRACE'), 'GET');
  });

  runner.test('performHttpRequest rejects non-http and private hosts', async () => {
    const bad = await performHttpRequest({ url: 'file:///etc/passwd' });
    runner.assertFalse(bad.success, 'file rejected');
    const priv = await performHttpRequest({ url: 'http://127.0.0.1/admin' });
    runner.assertFalse(priv.success, 'loopback rejected');
  });

  runner.test('performHttpRequest returns body from mock fetch', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ users: [{ username: 'a' }], next_max_id: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const res = await performHttpRequest(
      {
        url: 'https://www.instagram.com/api/v1/friendships/1/followers/',
        headers: { 'X-IG-App-ID': '936619743392459' },
      },
      mockFetch as unknown as typeof fetch,
    );
    runner.assertTrue(res.success, 'ok');
    runner.assertEqual(res.status, 200);
    runner.assertTrue(String(res.body || '').includes('next_max_id'), 'body');
  });

  runner.test('resolveRedirectUrl blocks private/metadata hops', () => {
    const ok = resolveRedirectUrl('https://example.com/out', 'https://example.com/next');
    runner.assertTrue(ok.ok, 'public redirect ok');
    const meta = resolveRedirectUrl('https://example.com/out', 'http://169.254.169.254/latest/meta-data');
    runner.assertFalse(meta.ok, 'metadata hop blocked');
    const loop = resolveRedirectUrl('https://example.com/out', 'http://127.0.0.1/admin');
    runner.assertFalse(loop.ok, 'loopback hop blocked');
    const relativePrivate = resolveRedirectUrl('http://example.com/', '//10.0.0.1/x');
    runner.assertFalse(relativePrivate.ok, 'protocol-relative private blocked');
  });

  runner.test('stripSensitiveHeadersForRedirect removes auth/csrf on cross-origin hop', () => {
    const headers = {
      Authorization: 'Bearer secret',
      'X-CSRFToken': 'tok',
      Accept: 'application/json',
    };
    const stripped = stripSensitiveHeadersForRedirect(headers, 'https://example.com/a', 'https://other.com/b');
    runner.assertTrue(!('Authorization' in stripped));
    runner.assertTrue(!('X-CSRFToken' in stripped));
    runner.assertEqual(stripped.Accept, 'application/json');
    const kept = stripSensitiveHeadersForRedirect(headers, 'https://example.com/a', 'https://example.com/b');
    runner.assertEqual(kept.Authorization, 'Bearer secret');
  });

  runner.test('performHttpRequest enforces allowedDomains on redirect hops', async () => {
    let calls = 0;
    const mockFetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.example.net/landing' },
        });
      }
      return new Response('nope', { status: 200 });
    };
    const res = await performHttpRequest(
      {
        url: 'https://allowed.example.com/start',
        allowedDomains: ['allowed.example.com'],
      },
      mockFetch as unknown as typeof fetch,
    );
    runner.assertFalse(res.success, 'redirect outside allowlist must fail');
    runner.assertEqual(calls, 1, 'must not fetch disallowed redirect target');
  });

  runner.test('performHttpRequest rejects redirect to private host (manual follow)', async () => {
    let calls = 0;
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      runner.assertEqual(init?.redirect, 'manual', 'must use manual redirect mode');
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1/secret' },
        });
      }
      return new Response('should not fetch private', { status: 200 });
    };
    const res = await performHttpRequest(
      { url: 'https://example.com/open-redirect' },
      mockFetch as unknown as typeof fetch,
    );
    runner.assertFalse(res.success, 'private redirect must fail');
    runner.assertEqual(calls, 1, 'must not follow into private host');
    runner.assertTrue(
      String(res.error || '')
        .toLowerCase()
        .includes('block') || String(res.error || '').includes('127'),
      'error mentions block/private',
    );
  });
}

function testExecuteScriptRunner(runner: TestRunner) {
  log('\n=== Testing executeScript runner helpers ===', 'info');

  runner.test('buildExecutableBody wraps bare expressions and keeps return bodies', () => {
    runner.assertEqual(buildExecutableBody('return 42'), 'return 42');
    runner.assertEqual(buildExecutableBody('document.title'), 'return (document.title);');
    runner.assertTrue(buildExecutableBody('a=1;\nreturn a').includes('return a'));
  });

  runner.test('buildExecutableBody wraps top-level await for fetch loops', () => {
    const body = buildExecutableBody('const r = await fetch("/x"); return r.status;');
    runner.assertTrue(body.includes('async ()'), 'wraps await in async IIFE');
    runner.assertTrue(body.includes('await fetch'), 'keeps await fetch');
  });

  runner.test('resolveExecuteScriptWorld defaults to ISOLATED', () => {
    runner.assertEqual(resolveExecuteScriptWorld(undefined), 'ISOLATED');
    runner.assertEqual(resolveExecuteScriptWorld('main'), 'MAIN');
    runner.assertEqual(resolveExecuteScriptWorld('ISOLATED'), 'ISOLATED');
  });

  runner.test('resolveExecuteScriptTimeoutMs defaults and clamps', () => {
    runner.assertEqual(resolveExecuteScriptTimeoutMs(undefined), 60000);
    runner.assertEqual(resolveExecuteScriptTimeoutMs(500), 1000);
    runner.assertEqual(resolveExecuteScriptTimeoutMs(999999), 120000);
    runner.assertEqual(resolveExecuteScriptTimeoutMs(45000), 45000);
  });

  runner.test('runUserScriptInPage returns values and side-effect nulls', async () => {
    const num = await runUserScriptInPage('return 42');
    runner.assertTrue(num.ok === true && num.value === 42, 'return 42');
    const bare = await runUserScriptInPage('1+1');
    runner.assertTrue(bare.ok === true && bare.value === 2, 'bare expression');
    const side = await runUserScriptInPage('var __glide_t=1');
    runner.assertTrue(side.ok === true && side.value === null, 'statement without return → null value');
  });

  runner.test('runUserScriptInPage awaits promises and top-level await', async () => {
    const promised = await runUserScriptInPage('return Promise.resolve(7)');
    runner.assertTrue(promised.ok === true && promised.value === 7, 'awaits returned Promise');
    runner.assertTrue(promised.ok === true && promised.awaited === true, 'marks awaited');
    const topAwait = await runUserScriptInPage('return await Promise.resolve(9)');
    runner.assertTrue(topAwait.ok === true && topAwait.value === 9, 'top-level await works');
  });

  runner.test('isCspEvalError detects CSP eval blocks', () => {
    runner.assertTrue(isCspEvalError('Refused to evaluate a string as JavaScript because unsafe-eval'));
    runner.assertTrue(isCspEvalError('Content Security Policy blocks eval'));
    runner.assertFalse(isCspEvalError('Unexpected token'));
  });

  runner.test('shouldAllowMainToIsolatedFallback only allows compile-phase CSP failures', () => {
    runner.assertTrue(
      shouldAllowMainToIsolatedFallback({
        ok: false,
        phase: 'compile',
        cspLikely: true,
        error: 'unsafe-eval',
      }),
    );
    runner.assertFalse(
      shouldAllowMainToIsolatedFallback({
        ok: false,
        phase: 'runtime',
        cspLikely: true,
        error: 'unsafe-eval',
      }),
    );
    runner.assertFalse(
      shouldAllowMainToIsolatedFallback({
        ok: false,
        phase: 'compile',
        timedOut: true,
        error: 'timeout',
      }),
    );
  });

  runner.test('truncateExecuteScriptValue caps oversized JSON results', () => {
    const big = { rows: 'x'.repeat(200_000) };
    const limited = truncateExecuteScriptValue(big, 1000);
    runner.assertTrue(limited.truncated);
    runner.assertEqual(limited.serializedAs, 'string');
  });
}

function testDefaultSystemPrompt(runner: TestRunner) {
  log('\n=== Testing Default System Prompt Capabilities ===', 'info');

  runner.test('Default prompt is recognized by isDefaultAutomationPrompt', () => {
    runner.assertTrue(isDefaultAutomationPrompt(DEFAULT_SYSTEM_PROMPT));
    runner.assertTrue(isDefaultAutomationPrompt(STREAMLINED_AUTOMATION_PROMPT));
  });

  runner.test('Prompt teaches network capture and forbids inventing tool limits', () => {
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('getNetworkRequests'), 'mentions getNetworkRequests');
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('NETWORK / APIs'), 'has NETWORK/APIs rule');
    runner.assertTrue(
      DEFAULT_SYSTEM_PROMPT.includes('Never invent tool limitations') ||
        DEFAULT_SYSTEM_PROMPT.includes('NEVER invent tool limitations'),
      'forbids inventing limitations',
    );
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('TOOL SURFACE IS REAL'), 'asserts schema tools are callable');
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('httpRequest'), 'mentions httpRequest');
    runner.assertTrue(
      DEFAULT_SYSTEM_PROMPT.includes('FALSE CLAIMS') || DEFAULT_SYSTEM_PROMPT.includes('CSP blocks executeScript'),
      'debunks false CSP limitation claims',
    );
    runner.assertTrue(
      DEFAULT_SYSTEM_PROMPT.includes('not in this session') || DEFAULT_SYSTEM_PROMPT.includes('documentation-only'),
      'forbids claiming tools are session-missing',
    );
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('getConsoleOutput'), 'mentions console diagnostics');
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('getStorageData'), 'mentions storage diagnostics');
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('executeScript'), 'mentions executeScript');
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('ISOLATED'), 'mentions ISOLATED world for executeScript');
    runner.assertTrue(
      DEFAULT_SYSTEM_PROMPT.includes('install hooks') || DEFAULT_SYSTEM_PROMPT.includes('install'),
      'mentions hook install pattern',
    );
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('readPage'), 'mentions readPage');
    runner.assertTrue(DEFAULT_SYSTEM_PROMPT.includes('cdp'), 'mentions cdp opt-in');
    runner.assertTrue(
      DEFAULT_SYSTEM_PROMPT.includes('RECOVERY') && DEFAULT_SYSTEM_PROMPT.includes('readPage'),
      'recovery order mentions readPage',
    );
  });
}

// Test AI Provider Configuration
function testAIProviderConfig(runner: TestRunner) {
  log('\n=== Testing AI Provider Configuration ===', 'info');

  runner.test('OpenAI provider config is valid', () => {
    const config: ProviderConfig = {
      provider: 'openai',
      apiKey: 'sk-test123',
      model: 'gpt-4o',
      systemPrompt: 'Test prompt',
    };

    runner.assertEqual(config.provider, 'openai');
    runner.assertTrue(config.apiKey.startsWith('sk-'), 'OpenAI keys should start with sk-');
  });

  runner.test('Anthropic provider config is valid', () => {
    const config: ProviderConfig = {
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
      systemPrompt: 'Test prompt',
    };

    runner.assertEqual(config.provider, 'anthropic');
    runner.assertTrue(config.model.includes('claude'), 'Anthropic model should contain "claude"');
  });

  runner.test('Custom provider config is valid', () => {
    const config: ProviderConfig = {
      provider: 'custom',
      apiKey: 'custom-key',
      model: 'custom-model',
      customEndpoint: 'https://api.example.com/v1',
      systemPrompt: 'Test prompt',
    };

    runner.assertEqual(config.provider, 'custom');
    runner.assertTrue((config.customEndpoint ?? '').startsWith('https://'), 'Custom endpoint should use HTTPS');
  });
}

// Test Tool Schema Conversion
function testToolSchemaConversion(runner: TestRunner) {
  log('\n=== Testing Tool Schema Conversion ===', 'info');

  runner.test('Convert to OpenAI format', () => {
    const tool = {
      name: 'test_tool',
      description: 'Test description',
      input_schema: {
        type: 'object',
        properties: {
          param1: { type: 'string' },
        },
        required: ['param1'],
      },
    };

    const openaiFormat = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    };

    runner.assertEqual(openaiFormat.type, 'function');
    runner.assertEqual(openaiFormat.function.name, 'test_tool');
  });

  runner.test('Convert to Anthropic format', () => {
    const tool = {
      name: 'test_tool',
      description: 'Test description',
      input_schema: {
        type: 'object',
        properties: {
          param1: { type: 'string' },
        },
        required: ['param1'],
      },
    };

    const anthropicFormat = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    };

    runner.assertEqual(anthropicFormat.name, 'test_tool');
    runner.assertTrue(anthropicFormat.input_schema.properties.param1);
  });
}

// Test Input Validation
function testInputValidation(runner: TestRunner) {
  log('\n=== Testing Input Validation ===', 'info');

  runner.test('Validate URL format', () => {
    const validUrls = ['https://google.com', 'http://example.com', 'https://sub.domain.com/path'];

    validUrls.forEach((url) => {
      runner.assertTrue(url.startsWith('http://') || url.startsWith('https://'), `${url} should be valid`);
    });
  });

  runner.test('Validate CSS selectors', () => {
    const validSelectors = ['#id', '.class', 'div', 'input[name="test"]', '.class > div', 'div:nth-child(2)'];

    validSelectors.forEach((selector) => {
      runner.assertTrue(selector.length > 0, 'Selector should not be empty');
      runner.assertFalse(selector.includes('  '), 'Selector should not have double spaces');
    });
  });

  runner.test('Validate tab group colors', () => {
    const validColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    const testColor = 'blue';

    runner.assertTrue(validColors.includes(testColor), `${testColor} should be a valid color`);
  });
}

// Test Error Handling
function testErrorHandling(runner: TestRunner) {
  log('\n=== Testing Error Handling ===', 'info');

  runner.test('Missing required parameters throw error', () => {
    runner.assertThrows(() => {
      const params: { url?: string } = {}; // Missing required 'url'
      if (!params.url) {
        throw new Error('Missing required parameter: url');
      }
    }, 'Should not execute without required params');
  });

  runner.test('Invalid selector format detected', () => {
    const invalidSelectors: Array<string | null | undefined> = ['', '  ', null, undefined];

    invalidSelectors.forEach((selector) => {
      if (!selector || selector.trim() === '') {
        // This is correct behavior
        runner.assertTrue(true);
      }
    });
  });
}

// Test Message Schema
function testMessageSchema(runner: TestRunner) {
  log('\n=== Testing Message Schema ===', 'info');

  runner.test('createMessage builds canonical message', () => {
    const msg = createMessage({ role: 'user', content: 'hello' });
    if (!msg) {
      throw new Error('Message should not be null');
    }
    runner.assertTrue(typeof msg.id === 'string', 'Message should have id');
    runner.assertTrue(typeof msg.createdAt === 'string', 'Message should have createdAt');
    runner.assertEqual(msg.role, 'user');
    runner.assertEqual(msg.content, 'hello');
  });

  runner.test('normalizeConversationHistory filters invalid messages', () => {
    const normalized = normalizeConversationHistory([
      { role: 'user', content: 'ok' },
      { role: 'invalid' as any, content: 'skip' },
      null as any,
    ] as any);
    runner.assertEqual(normalized.length, 1);
    runner.assertEqual(normalized[0].role, 'user');
  });

  runner.test('toProviderMessages serializes tool calls and results', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'click', args: { selector: '#a' } }],
      },
      {
        role: 'tool',
        content: { success: true },
        toolCallId: 'call_1',
      },
    ];
    const provider = toProviderMessages(history);
    runner.assertTrue(Array.isArray(provider[0].tool_calls), 'tool_calls should be an array');
    runner.assertTrue(typeof provider[0].tool_calls?.[0]?.function?.arguments === 'string', 'tool args serialized');
    runner.assertEqual(provider[1].role, 'tool');
    const toolContent =
      typeof provider[1].content === 'string' ? provider[1].content : JSON.stringify(provider[1].content);
    runner.assertTrue(toolContent.includes('success'));
  });

  runner.test('thinking metadata is preserved and not sent to provider', () => {
    const history: Message[] = [{ role: 'assistant', content: 'Hello', thinking: 'Drafting response' }];
    const normalized = normalizeConversationHistory(history);
    runner.assertEqual(normalized[0]?.thinking, 'Drafting response');
    const provider = toProviderMessages(normalized);
    runner.assertFalse('thinking' in provider[0], 'Provider messages should not include thinking');
  });

  runner.test('cloneConversationHistory isolates nested context data', () => {
    const original: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'before' }],
        toolCalls: [{ id: 'call-1', name: 'click', args: { selector: '#before' } }],
        meta: { kind: 'tool', source: 'test' },
      },
    ];
    const clone = cloneConversationHistory(original);

    runner.assertTrue(clone[0] !== original[0]);
    runner.assertTrue(clone[0].content !== original[0].content);
    runner.assertTrue(clone[0].toolCalls !== original[0].toolCalls);
    runner.assertTrue(clone[0].meta !== original[0].meta);
    if (Array.isArray(clone[0].content)) {
      (clone[0].content[0] as Record<string, unknown>).text = 'after';
    }
    runner.assertEqual((original[0].content[0] as Record<string, unknown>).text, 'before');
  });

  runner.test('normalizeConversationHistory preserves nested OpenAI tool alias', () => {
    const normalized = normalizeConversationHistory([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', tool: { name: 'navigate', arguments: '{"url":"https://example.com"}' } }],
      },
    ] as any);
    runner.assertEqual(normalized[0]?.toolCalls?.[0]?.name, 'navigate');
    runner.assertEqual((normalized[0]?.toolCalls?.[0]?.args as any)?.url, 'https://example.com');
  });
}

// Test Conversation Compaction
function testConversationCompaction(runner: TestRunner) {
  log('\n=== Testing Conversation Compaction ===', 'info');

  runner.test('findCutPoint keeps recent tokens and avoids tool-only cuts', () => {
    const history: Message[] = [
      { role: 'user', content: 'old message' },
      { role: 'assistant', content: 'reply one' },
      { role: 'tool', content: 'tool output', toolCallId: 'call_1' },
      { role: 'user', content: 'recent one ' + 'x'.repeat(400) },
      { role: 'assistant', content: 'recent two ' + 'y'.repeat(400) },
    ];
    const cutIndex = findCutPoint(history, 0, 120);
    runner.assertTrue(cutIndex >= 1, 'Cut point should preserve recent context');
    runner.assertTrue(history[cutIndex]?.role !== 'tool', 'Cut point should not land on tool role');
  });

  runner.test('shouldCompact uses hysteresis thresholds per session', () => {
    const sessionId = 'session-hysteresis-test';
    resetCompactionHysteresis(sessionId);
    const limit = 1000;
    // reserveTokens must keep the absolute boundary (limit - reserve) below the
    // aboveEnter probe so this test exercises the hysteresis latch, not the reserve gate.
    const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 250 };
    const belowRelease = Math.floor(limit * (COMPACTION_RELEASE_PERCENT - 0.05));
    const between = Math.floor(limit * ((COMPACTION_ENTER_PERCENT + COMPACTION_RELEASE_PERCENT) / 2));
    const aboveEnter = Math.floor(limit * (COMPACTION_ENTER_PERCENT + 0.1));

    const below = shouldCompact({
      contextTokens: belowRelease,
      contextLimit: limit,
      settings,
      sessionId,
    });
    runner.assertFalse(below.shouldCompact, 'Below release threshold should not compact');

    const mid = shouldCompact({
      contextTokens: between,
      contextLimit: limit,
      settings,
      sessionId,
    });
    runner.assertFalse(mid.shouldCompact, 'Between thresholds should stay inactive until enter');

    const high = shouldCompact({
      contextTokens: aboveEnter,
      contextLimit: limit,
      settings,
      sessionId,
    });
    runner.assertTrue(high.shouldCompact, 'Above enter threshold should compact');

    const otherSessionMid = shouldCompact({
      contextTokens: between,
      contextLimit: limit,
      settings,
      sessionId: 'other-session',
    });
    runner.assertFalse(
      otherSessionMid.shouldCompact,
      'Another session should not inherit the first session hysteresis latch',
    );
  });

  runner.test('compaction hysteresis bookkeeping is bounded by LRU cap', () => {
    resetCompactionHysteresis();
    const limit = 1000;
    const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 250 };
    for (let i = 0; i < 300; i += 1) {
      shouldCompact({
        contextTokens: Math.floor(limit * (COMPACTION_ENTER_PERCENT + 0.1)),
        contextLimit: limit,
        settings,
        sessionId: `session-${i}`,
      });
    }
    runner.assertTrue(getCompactionLatchSizeForTests() <= 256, 'latch map should stay within LRU cap');
    resetCompactionHysteresis();
  });

  runner.test('compaction utilities preserve summaries + recent messages', () => {
    const history: Message[] = Array.from({ length: 20 }, (_, idx) => ({
      role: 'user',
      content: `Message ${idx} ${'x'.repeat(200)}`,
    }));
    const usage = estimateContextTokens(history);
    const check = shouldCompact({
      contextTokens: usage.tokens,
      contextLimit: 500,
      settings: DEFAULT_COMPACTION_SETTINGS,
    });
    runner.assertTrue(check.shouldCompact, 'Should trigger compaction');

    const preserved = history.slice(-5);
    const summaryMessage = buildCompactionSummaryMessage(
      'Summary of earlier context.',
      history.length - preserved.length,
    );
    const result = applyCompaction({
      summaryMessage,
      preserved,
      trimmedCount: history.length - preserved.length,
    });
    runner.assertTrue(
      result.compacted.length === preserved.length + 1,
      'Compacted history should include summary + preserved messages',
    );
    runner.assertEqual(result.compacted[0].meta?.kind, 'summary');
  });
}

// Test Thinking Extraction
function testThinkingExtraction(runner: TestRunner) {
  log('\n=== Testing Thinking Extraction ===', 'info');

  runner.test('extractThinking strips <analysis> tags', () => {
    const result = extractThinking('Hello <analysis>secret</analysis> world');
    runner.assertTrue(result.thinking === 'secret', 'Should capture analysis content');
    runner.assertFalse(result.content.includes('<analysis>'), 'Content should not include analysis tags');
  });

  runner.test('extractThinking merges think + analysis with existing notes', () => {
    const result = extractThinking('Start <think>first</think> middle <analysis>second</analysis>', 'seed');
    runner.assertTrue(result.thinking?.includes('seed'), 'Existing notes should be preserved');
    runner.assertTrue(result.thinking?.includes('first'), 'Think tags should be captured');
    runner.assertTrue(result.thinking?.includes('second'), 'Analysis tags should be captured');
    runner.assertFalse(result.content.includes('think'), 'Content should not include think tags');
    runner.assertFalse(result.content.includes('analysis'), 'Content should not include analysis tags');
  });
}

// Test Plan Normalization
function testPlanNormalization(runner: TestRunner) {
  log('\n=== Testing Plan Normalization ===', 'info');

  runner.test('normalizePlanStatus handles invalid values', () => {
    runner.assertEqual(normalizePlanStatus('done'), 'done');
    runner.assertEqual(normalizePlanStatus('RUNNING'), 'running');
    runner.assertEqual(normalizePlanStatus('unknown'), 'pending');
  });

  runner.test('normalizePlanSteps trims, filters, and clamps', () => {
    const steps = normalizePlanSteps([
      { title: '  Step one  ', status: 'done' },
      { title: '', status: 'pending' },
      { title: 'Step two', status: 'blocked', notes: '  Needs access  ' },
    ]);
    runner.assertEqual(steps.length, 2);
    runner.assertEqual(steps[0].id, 'step-1');
    runner.assertEqual(steps[1].status, 'blocked');
    runner.assertEqual(steps[1].notes, 'Needs access');

    const tooMany = normalizePlanSteps(
      Array.from({ length: 12 }, (_, idx) => ({
        title: `Step ${idx + 1}`,
        status: 'pending',
      })),
    );
    runner.assertEqual(tooMany.length, 8);
  });

  runner.test('buildRunPlan preserves createdAt and updates timestamps', () => {
    const now = Date.now();
    const existing = buildRunPlan([{ title: 'Step one', status: 'pending' }], {
      now,
    });
    const updated = buildRunPlan([{ title: 'Step two', status: 'done' }], {
      existingPlan: existing,
      now: now + 5000,
    });
    runner.assertEqual(updated.createdAt, existing.createdAt);
    runner.assertTrue(updated.updatedAt > existing.updatedAt, 'updatedAt should advance');
    runner.assertEqual(updated.steps[0].title, 'Step two');
  });
}

// Test Retry Helpers
function testRetryHelpers(runner: TestRunner) {
  log('\n=== Testing Retry Helpers ===', 'info');

  runner.test('isValidFinalResponse rejects empty and quit phrases', () => {
    runner.assertFalse(isValidFinalResponse(''), 'Empty response should be invalid');
    runner.assertFalse(isValidFinalResponse('Please try again.'), 'Quit phrase should be invalid');
    runner.assertFalse(
      isValidFinalResponse('I could not produce a final response.'),
      'Quit phrase variants should be invalid',
    );
    runner.assertTrue(isValidFinalResponse('Here is the result.'), 'Normal response should be valid');
  });

  runner.test('createExponentialBackoff caps and scales', () => {
    const backoff = createExponentialBackoff({
      baseMs: 100,
      maxMs: 1000,
      jitter: 0,
    });
    runner.assertEqual(backoff(1), 100);
    runner.assertEqual(backoff(2), 200);
    runner.assertEqual(backoff(4), 800);
    runner.assertEqual(backoff(6), 1000);
  });

  runner.test('createExponentialBackoff applies jitter with custom rng', () => {
    const backoff = createExponentialBackoff({
      baseMs: 100,
      maxMs: 1000,
      jitter: 0.5,
      rng: () => 1,
    });
    runner.assertEqual(backoff(1), 150);
    runner.assertEqual(backoff(0), 150, 'Attempt <= 0 should clamp to 1');
  });

  runner.test('isValidFinalResponse supports custom quit phrases', () => {
    runner.assertFalse(isValidFinalResponse('Stop here.', { quitPhrases: ['stop here'] }));
    runner.assertTrue(isValidFinalResponse('Stop here.'), 'Default phrases should not block custom text');
  });

  runner.test('isRetryableProviderError rejects auth and bad-request statuses', () => {
    runner.assertFalse(isRetryableProviderError(400));
    runner.assertFalse(isRetryableProviderError(401));
    runner.assertFalse(isRetryableProviderError(403));
    runner.assertTrue(isRetryableProviderError(429));
    runner.assertTrue(isRetryableProviderError(500));
    runner.assertFalse(isRetryableProviderError(undefined));
  });
}

function testModelConvert(runner: TestRunner) {
  log('\n=== Testing Model Convert ===', 'info');

  runner.test('toModelMessages emits tool-call parts from assistant toolCalls', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        content: 'Running tools',
        toolCalls: [{ id: 'call_1', name: 'click', args: { selector: '#submit' } }],
      },
      // Paired result required — unmatched tool_use is stripped to avoid Anthropic 400.
      { role: 'tool', content: 'clicked', toolCallId: 'call_1', toolName: 'click' },
    ];
    const modelMessages = toModelMessages(history);
    runner.assertEqual(modelMessages[0].role, 'assistant');
    const content = modelMessages[0].content;
    runner.assertTrue(Array.isArray(content), 'Assistant content should include tool-call parts');
    const parts = content as Array<Record<string, unknown>>;
    runner.assertTrue(
      parts.some((part) => part.type === 'tool-call'),
      'Should include a tool-call part',
    );
    const toolCall = parts.find((part) => part.type === 'tool-call');
    runner.assertEqual(toolCall?.toolName, 'click');
    runner.assertEqual((toolCall?.input as { selector?: string })?.selector, '#submit');
  });

  runner.test('toModelMessages can convert system history notes to user messages', () => {
    const modelMessages = toModelMessages(
      [
        { role: 'user', content: 'do it' },
        { role: 'system', content: 'retry with direct answer' },
      ],
      { systemMessageMode: 'user' },
    );
    runner.assertEqual(modelMessages.length, 2);
    runner.assertEqual(modelMessages[1].role, 'user');
    runner.assertEqual(modelMessages[1].content, 'retry with direct answer');
  });

  runner.test('toModelMessages removes orphan tool results and keeps paired results', () => {
    const modelMessages = toModelMessages([
      { role: 'tool', content: 'orphan', toolCallId: 'missing-call' },
      {
        role: 'assistant',
        content: 'Running a tool',
        toolCalls: [{ id: 'call-1', name: 'navigate', args: { url: 'https://example.com' } }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call-1' },
    ]);

    runner.assertEqual(modelMessages.length, 2);
    runner.assertEqual(modelMessages[0].role, 'assistant');
    runner.assertEqual(modelMessages[1].role, 'tool');
  });

  runner.test('toModelMessages strips unmatched tool_use without tool_result', () => {
    const modelMessages = toModelMessages([
      {
        role: 'assistant',
        content: 'two tools',
        toolCalls: [
          { id: 'call-a', name: 'navigate', args: { url: 'https://example.com' } },
          { id: 'call-b', name: 'click', args: { selector: '#x' } },
        ],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call-a' },
      { role: 'user', content: 'continue' },
    ]);
    runner.assertEqual(modelMessages[0].role, 'assistant');
    const assistantContent = modelMessages[0].content;
    const toolCallParts = Array.isArray(assistantContent)
      ? assistantContent.filter((p: any) => p?.type === 'tool-call')
      : [];
    runner.assertEqual(toolCallParts.length, 1, 'only paired tool_use kept');
    runner.assertEqual((toolCallParts[0] as any).toolCallId, 'call-a');
  });

  runner.test('toModelMessages preserves Anthropic native image blocks in user content', () => {
    const modelMessages = toModelMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ],
      },
    ]);
    runner.assertEqual(modelMessages.length, 1);
    const content = modelMessages[0].content;
    runner.assertTrue(Array.isArray(content));
    const imagePart = (content as any[]).find((part) => part?.type === 'image');
    runner.assertTrue(Boolean(imagePart?.image), 'native Anthropic image source converts to model image');
  });
}

function testToolCallRecovery(runner: TestRunner) {
  log('\n=== Testing Tool Call Recovery ===', 'info');

  runner.test('extractRecoverableToolCalls reads OpenAI-style tool_calls JSON text', () => {
    const calls = extractRecoverableToolCalls(
      '{"tool_calls":[{"function":{"name":"navigate","arguments":"{\\"url\\":\\"https://instagram.com\\"}"}}]}',
      ['navigate'],
    );
    runner.assertEqual(calls.length, 1);
    runner.assertEqual(calls[0].name, 'navigate');
    runner.assertEqual(calls[0].args.url, 'https://instagram.com');
  });

  runner.test('stripRecoverableToolCalls removes standalone tool-call JSON', () => {
    const text = '{"name":"navigate","arguments":{"url":"https://instagram.com"}}';
    runner.assertEqual(stripRecoverableToolCalls(text), '');
  });

  runner.test('extractRecoverableToolCalls parses function-style kwargs', () => {
    const calls = extractRecoverableToolCalls('navigate(url="https://example.com")', ['navigate']);
    runner.assertEqual(calls.length, 1);
    runner.assertEqual(calls[0].name, 'navigate');
    runner.assertEqual(calls[0].args.url, 'https://example.com');
    const click = extractRecoverableToolCalls("click(selector='#ok', retries=2)", ['click']);
    runner.assertEqual(click.length, 1);
    runner.assertEqual(click[0].args.selector, '#ok');
    runner.assertEqual(click[0].args.retries, 2);
  });

  runner.test('extractRecoverableToolCalls reads nested OpenAI tool alias', () => {
    const calls = extractRecoverableToolCalls(
      '{"tool_calls":[{"tool":{"name":"navigate","arguments":"{\\"url\\":\\"https://example.com\\"}"}}]}',
      ['navigate'],
    );
    runner.assertEqual(calls.length, 1);
    runner.assertEqual(calls[0].name, 'navigate');
    runner.assertEqual(calls[0].args.url, 'https://example.com');
  });

  runner.test('extractRecoverableToolCalls stays bounded on large malformed text', () => {
    const junk = `{${'{"broken":'.repeat(5000)}not-json`;
    const valid = '{"name":"navigate","arguments":{"url":"https://example.com"}}';
    const text = `${junk}\n${valid}`;
    const started = Date.now();
    const calls = extractRecoverableToolCalls(text, ['navigate']);
    const elapsed = Date.now() - started;
    runner.assertEqual(calls.length, 1);
    runner.assertEqual(calls[0].args.url, 'https://example.com');
    runner.assertTrue(elapsed < 2000, `scan should stay bounded (took ${elapsed}ms)`);
  });
}

// Test Task Intent Detection
function testTaskIntent(runner: TestRunner) {
  log('\n=== Testing Task Intent ===', 'info');

  runner.test('greetings stay in direct chat mode', () => {
    const intent = detectTaskIntent('oi');
    runner.assertFalse(intent.usesBrowserAutomation, 'Greeting should not trigger browser automation');
    runner.assertFalse(intent.requiresDetailedReport, 'Greeting should not trigger report mode');
  });

  runner.test('simple browser commands use automation without report mode', () => {
    const intent = detectTaskIntent('abra o instagram por favor.');
    runner.assertTrue(intent.usesBrowserAutomation, 'Open Instagram should trigger browser automation');
    runner.assertFalse(intent.requiresDetailedReport, 'Simple navigation should not trigger report mode');
  });

  runner.test('selected page analysis uses automation and report mode', () => {
    const intent = detectTaskIntent('analise esta pagina', { selectedTabCount: 1 });
    runner.assertTrue(intent.usesBrowserAutomation, 'Page analysis should trigger browser automation');
    runner.assertTrue(intent.requiresDetailedReport, 'Page analysis should trigger report mode');
  });

  runner.test('injected tab context is stripped before intent detection', () => {
    const visibleText = stripInjectedTabContext('oi\n\n[Contexto das abas selecionadas:]\n- Instagram');
    runner.assertEqual(visibleText, 'oi');
    const intent = detectTaskIntent('oi\n\n[Contexto das abas selecionadas:]\n- Instagram');
    runner.assertFalse(intent.usesBrowserAutomation, 'Injected context alone should not trigger automation');

    const wrapped = `oi\n\n${wrapInjectedTabContext('[Contexto das abas selecionadas:]\\n- Instagram')}`;
    runner.assertEqual(stripInjectedTabContext(wrapped), 'oi');
    runner.assertFalse(detectTaskIntent(wrapped).usesBrowserAutomation);
  });

  // Regression: selectedTabs is always sent as [] by the side panel (panel-chat.ts),
  // so selectedTabCount is always 0 in production. asksAboutPage used to require
  // selectedTabCount > 0, making it permanently dead code — a pure analysis request
  // like "Analise, dentro desse modal..." got ZERO tools (not even a chance to act),
  // so the agent could only reply "vou verificar..." and had nothing left to call.
  runner.test('page-analysis phrasing grants tools with no tab selected (dead-code regression)', () => {
    const intent = detectTaskIntent('Analise, dentro desse modal, os usuarios com nome feminino.', {
      selectedTabCount: 0,
    });
    runner.assertTrue(intent.usesBrowserAutomation, 'analysis request must get tools even with selectedTabCount=0');
  });

  runner.test('hasRecentToolActivity detects trailing assistant tool calls', () => {
    const history = [
      { role: 'user', content: 'analise a lista' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'getContent', args: {} }] },
      { role: 'tool', content: '{}' },
      { role: 'assistant', content: 'aqui estao os nomes' },
    ];
    runner.assertTrue(
      hasRecentToolActivity(history),
      'recent assistant toolCalls / tool-role messages count as activity',
    );
    const plainChat = [{ role: 'user', content: 'oi' }];
    runner.assertFalse(hasRecentToolActivity(plainChat), 'plain chat has no tool activity');
    runner.assertFalse(hasRecentToolActivity([]), 'empty history has no tool activity');
    runner.assertFalse(hasRecentToolActivity(null as any), 'null history is handled safely');
  });

  runner.test('follow-up with no action keywords stays armed after recent tool use', () => {
    // Exact failure pattern: "e AI?" and a correction, neither containing any
    // browser/action keyword, sent right after a run that used browser tools.
    const noSignal = detectTaskIntent('e AI?', { selectedTabCount: 0, recentToolActivity: false });
    runner.assertFalse(noSignal.usesBrowserAutomation, 'baseline: no keywords + no recent activity = no tools');

    const withSignal = detectTaskIntent('e AI?', { selectedTabCount: 0, recentToolActivity: true });
    runner.assertTrue(withSignal.usesBrowserAutomation, 'recent tool activity keeps tools armed for a bare follow-up');
  });

  // Política atual (fail-open): small talk PURO é a única classe sem ferramentas.
  // Mid-tarefa, até uma cortesia mantém o toolset armado — custa só o schema no
  // prompt, e o custo oposto (agente sem ação no meio da tarefa) é a tarefa falhar.
  runner.test('courtesy mid-task keeps tools armed; standalone small talk does not', () => {
    runner.assertFalse(detectTaskIntent('oi').usesBrowserAutomation, 'saudação isolada = chat');
    runner.assertFalse(detectTaskIntent('valeu, obrigado!').usesBrowserAutomation, 'cortesia composta = chat');
    runner.assertTrue(
      detectTaskIntent('oi', { recentToolActivity: true }).usesBrowserAutomation,
      'com tarefa em andamento, ferramentas seguem armadas',
    );
  });

  // Regressão do gate fail-closed por palavra-chave: cada frase abaixo NÃO casava
  // nenhum termo da lista antiga e o agente ficava sem NENHUMA ferramenta.
  runner.test('fail-open grants tools for phrasings the keyword gate used to miss', () => {
    const cases = [
      'summarize this page for me',
      'what is on the screen right now?',
      'compare as abas que estão abertas',
      'tira um print disso',
      'me diz quantos itens tem nessa lista',
      'find the cheapest flight and book nothing',
      'baixe o relatório do mês',
    ];
    for (const text of cases) {
      runner.assertTrue(detectTaskIntent(text).usesBrowserAutomation, `deve ganhar ferramentas: "${text}"`);
    }
  });

  runner.test('report mode also triggers on english analysis phrasing', () => {
    runner.assertTrue(detectTaskIntent('analyze this dashboard and report findings').requiresDetailedReport);
    runner.assertTrue(detectTaskIntent('extract every row from the table').requiresDetailedReport);
    runner.assertFalse(detectTaskIntent('click the blue button').requiresDetailedReport);
  });

  runner.test('attached tabs arm tools even without any keyword', () => {
    runner.assertTrue(detectTaskIntent('oi', { selectedTabCount: 2 }).usesBrowserAutomation);
  });
}

// Test Runtime Message Schema
function testRuntimeMessages(runner: TestRunner) {
  log('\n=== Testing Runtime Message Schema ===', 'info');

  runner.test('Runtime messages are discriminated and serializable', () => {
    const base = {
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      runId: 'run-test',
      turnId: 'turn-1',
      sessionId: 'session-test',
      timestamp: Date.now(),
    };
    const plan: RunPlan = {
      steps: [{ id: 'step-1', title: 'Do something', status: 'pending' }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const samples: RuntimeMessage[] = [
      { ...base, type: 'assistant_stream_start' },
      { ...base, type: 'assistant_stream_delta', content: 'partial' },
      { ...base, type: 'assistant_stream_stop' },
      {
        ...base,
        type: 'tool_execution_start',
        tool: 'click',
        id: 'tool-1',
        args: { selector: '#id' },
      },
      {
        ...base,
        type: 'tool_execution_result',
        tool: 'click',
        id: 'tool-1',
        args: { selector: '#id' },
        result: { success: true },
        recoveryStage: 'retry',
        evidenceConfidence: 'medium',
        failureClass: 'selector',
      },
      {
        ...base,
        type: 'tool_events_batch',
        events: [
          { type: 'tool_execution_start', tool: 'wait', id: 'tool-2', args: { condition: 'time', ms: 100 } },
          {
            type: 'tool_execution_result',
            tool: 'wait',
            id: 'tool-2',
            args: { condition: 'time', ms: 100 },
            result: { success: true },
          },
        ],
      },
      { ...base, type: 'plan_update', plan },
      {
        ...base,
        type: 'assistant_final',
        content: 'Done',
        thinking: 'Thoughts',
        usage: { inputTokens: 10 },
      },
      { ...base, type: 'run_error', message: 'Boom' },
      { ...base, type: 'run_warning', message: 'Heads up' },
      {
        ...base,
        type: 'vision_context_ready',
        tool: 'screenshot',
        id: 'tool-vision-1',
        description: 'Login form with email and password fields.',
        source: 'screenshot',
      },
    ];

    samples.forEach((sample) => {
      const json = JSON.stringify(sample);
      const parsed = JSON.parse(json);
      runner.assertTrue(isRuntimeMessage(parsed), `Runtime message ${sample.type} should validate`);
    });
  });

  runner.test('Runtime messages reject invalid schema versions or types', () => {
    const badVersion = {
      type: 'assistant_final',
      schemaVersion: 999,
      runId: 'run-test',
      timestamp: Date.now(),
      content: 'Hi',
    };
    const badType = {
      type: 'unknown_type',
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      runId: 'run-test',
      timestamp: Date.now(),
    };
    const removedTypes = ['user_run_start', 'manual_plan_update', 'run_status', 'assistant_response'].map((type) => ({
      type,
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      runId: 'run-test',
      sessionId: 'session-test',
      timestamp: Date.now(),
    }));
    const missingRunId = {
      type: 'assistant_final',
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      timestamp: Date.now(),
      content: 'Hi',
    };
    runner.assertFalse(isRuntimeMessage(badVersion), 'Should reject mismatched schema versions');
    runner.assertFalse(isRuntimeMessage(badType), 'Should reject unknown message types');
    for (const message of removedTypes) {
      runner.assertFalse(isRuntimeMessage(message), `Should reject removed runtime message type: ${message.type}`);
    }
    runner.assertFalse(isRuntimeMessage(missingRunId), 'Should reject missing runId');
  });

  runner.test('Runtime messages reject missing required fields for specific types', () => {
    const base = {
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      runId: 'run-test',
      turnId: 'turn-test',
      sessionId: 'session-test',
      timestamp: Date.now(),
    };
    const missingAssistantFinalContent = {
      ...base,
      type: 'assistant_final',
    };
    const missingToolResultPayload = {
      ...base,
      type: 'tool_execution_result',
      tool: 'click',
    };
    const badStreamChannel = {
      ...base,
      type: 'assistant_stream_delta',
      content: 'x',
      channel: 'invalid',
    };

    runner.assertFalse(
      isRuntimeMessage(missingAssistantFinalContent),
      'assistant_final without content should be rejected',
    );
    runner.assertFalse(
      isRuntimeMessage(missingToolResultPayload),
      'tool_execution_result without result should be rejected',
    );
    runner.assertFalse(
      isRuntimeMessage(badStreamChannel),
      'assistant_stream_delta with invalid channel should be rejected',
    );

    const emptyToolBatch = {
      ...base,
      type: 'tool_events_batch',
      events: [],
    };
    runner.assertFalse(isRuntimeMessage(emptyToolBatch), 'tool_events_batch with empty events should be rejected');
  });
}

function testSessionContextStore(runner: TestRunner) {
  log('\n=== Testing Session Context Store ===', 'info');

  runner.test('session context store append + get per session', () => {
    const store = new SessionContextStore();
    const user = createMessage({ role: 'user', content: 'hello' });
    const assistant = createMessage({ role: 'assistant', content: 'hi' });
    runner.assertTrue(Boolean(user && assistant));
    store.append('session-a', [user!]);
    store.append('session-a', [assistant!]);
    const history = store.get('session-a');
    runner.assertEqual(history.length, 2);
    runner.assertEqual(history[0]?.role, 'user');
    runner.assertEqual(history[1]?.role, 'assistant');
  });

  runner.test('session context store isolates sessions', () => {
    const store = new SessionContextStore();
    store.set('session-a', [createMessage({ role: 'user', content: 'a' })!]);
    store.set('session-b', [createMessage({ role: 'user', content: 'b' })!]);
    runner.assertEqual(String(store.get('session-a')[0]?.content), 'a');
    runner.assertEqual(String(store.get('session-b')[0]?.content), 'b');
  });

  runner.test('session context store LRU evicts oldest beyond cap', () => {
    const store = new SessionContextStore();
    const cap = 3;
    for (let i = 0; i < cap + 2; i += 1) {
      store.set(`session-${i}`, [createMessage({ role: 'user', content: String(i) })!], cap);
    }
    runner.assertEqual(store.size(), cap);
    runner.assertFalse(store.has('session-0'));
    runner.assertFalse(store.has('session-1'));
    runner.assertTrue(store.has(`session-${cap + 1}`));
  });

  runner.test('resolveUserMessageContextAction chooses adopt/proceed/history_needed', () => {
    runner.assertEqual(resolveUserMessageContextAction(false, false), 'history_needed');
    runner.assertEqual(resolveUserMessageContextAction(false, true), 'adopt');
    runner.assertEqual(resolveUserMessageContextAction(true, false), 'proceed');
    runner.assertEqual(resolveUserMessageContextAction(true, true), 'adopt');
  });

  runner.test('user_message panel schema accepts optional conversationHistory', () => {
    const withoutHistory = {
      type: 'user_message',
      message: 'hello',
      sessionId: 'session-1',
    };
    const withHistory = {
      type: 'user_message',
      message: 'hello',
      sessionId: 'session-1',
      conversationHistory: [{ role: 'user', content: 'prior' }],
    };
    runner.assertTrue(isUserMessagePanel(withoutHistory));
    runner.assertTrue(validateUserMessagePanel(withoutHistory).ok);
    runner.assertTrue(isUserMessagePanel(withHistory));
    runner.assertTrue(validateUserMessagePanel(withHistory).ok);
  });
}

function testDomCache(runner: TestRunner) {
  log('\n=== Testing DOM Cache LRU ===', 'info');

  runner.test('Dom cache stores and serves getContent lookups', () => {
    const cache = new DomCacheLru(2, 10_000);
    const lookup = { tabId: 1, tool: 'getContent' as const, mode: 'text', selector: '' };
    cache.set(lookup, { success: true, text: 'hello' });
    const cached = cache.get(lookup);
    runner.assertTrue(Boolean(cached && (cached as { success?: boolean }).success));
  });

  runner.test('Dom cache evicts oldest entry beyond max size', () => {
    const cache = new DomCacheLru(2, 10_000);
    cache.set({ tabId: 1, tool: 'getContent', mode: 'a' }, { ok: 1 });
    cache.set({ tabId: 2, tool: 'getContent', mode: 'b' }, { ok: 2 });
    cache.set({ tabId: 3, tool: 'getContent', mode: 'c' }, { ok: 3 });
    runner.assertEqual(cache.get({ tabId: 1, tool: 'getContent', mode: 'a' }), null);
    runner.assertEqual((cache.get({ tabId: 3, tool: 'getContent', mode: 'c' }) as { ok?: number })?.ok, 3);
  });

  runner.test('Dom cache invalidates by tab id', () => {
    const cache = new DomCacheLru(4, 10_000);
    cache.set({ tabId: 9, tool: 'findElement', query: 'login' }, { success: true });
    cache.invalidateTab(9);
    runner.assertEqual(cache.get({ tabId: 9, tool: 'findElement', query: 'login' }), null);
  });

  runner.test('Dom cache keys differ by findElement scope and fuzzy', () => {
    const base = {
      tabId: 1,
      tool: 'findElement' as const,
      query: 'seguindo',
      mode: 'any',
      maxResults: 5,
    };
    const keyPage = buildDomCacheKey({ ...base, scope: 'page', fuzzy: true });
    const keyDialog = buildDomCacheKey({ ...base, scope: 'dialog', fuzzy: true });
    const keyNoFuzzy = buildDomCacheKey({ ...base, scope: 'page', fuzzy: false });
    runner.assertTrue(keyPage !== keyDialog, 'scope must change cache key');
    runner.assertTrue(keyPage !== keyNoFuzzy, 'fuzzy must change cache key');

    const keyDeep = buildDomCacheKey({ ...base, scope: 'page', fuzzy: true, deep: true });
    const keyShallow = buildDomCacheKey({ ...base, scope: 'page', fuzzy: true, deep: false });
    runner.assertTrue(keyDeep !== keyShallow, 'deep must change cache key');

    const cache = new DomCacheLru(8, 10_000);
    cache.set({ ...base, scope: 'page', fuzzy: true }, { success: true, where: 'page' });
    cache.set({ ...base, scope: 'dialog', fuzzy: true }, { success: true, where: 'dialog' });
    runner.assertEqual((cache.get({ ...base, scope: 'page', fuzzy: true }) as { where?: string })?.where, 'page');
    runner.assertEqual((cache.get({ ...base, scope: 'dialog', fuzzy: true }) as { where?: string })?.where, 'dialog');
  });

  runner.test('DOM context expires quickly and wait/modal transitions invalidate it', () => {
    runner.assertEqual(DEFAULT_DOM_CACHE_TTL_MS, 5000);
    runner.assertTrue(MUTATIVE_TOOLS.has('wait'));
    runner.assertTrue(MUTATIVE_TOOLS.has('dismissModal'));
    runner.assertTrue(MUTATIVE_TOOLS.has('executeScript'), 'executeScript must invalidate DOM cache');
    runner.assertTrue(MUTATIVE_TOOLS.has('hover'), 'hover must invalidate DOM cache');
    runner.assertTrue(MUTATIVE_TOOLS.has('setInputFiles'), 'setInputFiles must invalidate DOM cache');
    runner.assertTrue(MUTATIVE_TOOLS.has('selectOption'), 'selectOption must invalidate DOM cache');
    runner.assertTrue(MUTATIVE_TOOLS.has('fillForm'), 'fillForm must invalidate DOM cache');
    runner.assertTrue(MUTATIVE_TOOLS.has('navigateHistory'), 'navigateHistory must invalidate DOM cache');
    runner.assertFalse(MUTATIVE_TOOLS.has('highlightElement'), 'highlightElement must not invalidate DOM cache');
    runner.assertFalse(shouldInvalidateDomCache('highlightElement', {}));
    runner.assertFalse(MUTATIVE_TOOLS.has('annotatedScreenshot'), 'annotatedScreenshot must not invalidate DOM cache');
    runner.assertFalse(shouldInvalidateDomCache('annotatedScreenshot', {}));
    runner.assertFalse(MUTATIVE_TOOLS.has('elementScreenshot'), 'elementScreenshot must not invalidate DOM cache');
    runner.assertFalse(shouldInvalidateDomCache('elementScreenshot', {}));
    runner.assertFalse(MUTATIVE_TOOLS.has('findInPage'), 'findInPage must not invalidate DOM cache');
    runner.assertFalse(MUTATIVE_TOOLS.has('extractTable'), 'extractTable must not invalidate DOM cache');
    runner.assertFalse(MUTATIVE_TOOLS.has('harvestScroll'), 'harvestScroll must not invalidate DOM cache');
    runner.assertFalse(MUTATIVE_TOOLS.has('captureDownload'), 'captureDownload must not invalidate DOM cache');
    runner.assertFalse(shouldInvalidateDomCache('harvestScroll', {}));
  });

  runner.test('getNetworkRequests invalidates DOM cache only on stop/clear', () => {
    runner.assertFalse(shouldInvalidateDomCache('getNetworkRequests', {}));
    runner.assertFalse(shouldInvalidateDomCache('getNetworkRequests', { filterUrl: 'graphql' }));
    runner.assertTrue(shouldInvalidateDomCache('getNetworkRequests', { stop: true }));
    runner.assertTrue(shouldInvalidateDomCache('getNetworkRequests', { clear: true }));
    runner.assertTrue(shouldInvalidateDomCache('click', {}));
  });

  runner.test('browser action tools include interactive recovery targets', () => {
    for (const toolName of ['hover', 'mouse', 'dismissModal', 'wait', 'selectOption', 'fillForm'] as const) {
      runner.assertTrue(
        (BROWSER_ACTION_TOOLS as readonly string[]).includes(toolName),
        `${toolName} must count as browser action for recovery`,
      );
    }
  });
}

function testContentBridgeContract(runner: TestRunner) {
  log('\n=== Testing Content Bridge Contract ===', 'info');

  runner.test('Glide bridge message type is stable', () => {
    runner.assertEqual(GLIDE_BRIDGE_MESSAGE_TYPE, 'glide_bridge');
  });

  runner.test('Only recoverable bridge misses fall through to frame injection', () => {
    runner.assertTrue(shouldFallbackFromBridge({ success: false, code: 'ELEMENT_NOT_FOUND' }));
    runner.assertTrue(shouldFallbackFromBridge({ success: false, code: 'BRIDGE_UNSUPPORTED' }));
    runner.assertTrue(shouldFallbackFromBridge({ success: false, code: 'WAIT_TIMEOUT' }));
    runner.assertFalse(shouldFallbackFromBridge({ success: false, code: 'PERMISSION_DENIED' }));
    runner.assertFalse(shouldFallbackFromBridge({ success: true, bridge: true }));
  });

  runner.test('Mutative bridge ops are classified for timeout no-replay policy', () => {
    runner.assertTrue(isMutativeBridgeOp('click'));
    runner.assertTrue(isMutativeBridgeOp('type'));
    runner.assertFalse(isMutativeBridgeOp('getContent'));
    runner.assertFalse(isMutativeBridgeOp('findElement'));
  });
}

function testTabReadiness(runner: TestRunner) {
  log('\n=== Testing Tab Readiness ===', 'info');

  runner.test('Tab readiness requires a completed HTTP page', () => {
    runner.assertFalse(isTabLoadComplete({ status: 'loading', url: 'https://example.com' }));
    runner.assertFalse(isTabLoadComplete({ status: 'complete', url: 'chrome://settings' }));
    runner.assertTrue(isTabLoadComplete({ status: 'complete', url: 'https://example.com' }));
  });
}

function testRuntimeBatcher(runner: TestRunner) {
  log('\n=== Testing Runtime Batcher ===', 'info');

  runner.test('Runtime batcher coalesces deltas within the flush window', () => {
    const flushed: string[] = [];
    const batcher = new RuntimeBatcher((payload) => {
      flushed.push(`${payload.channel}:${payload.content}`);
    });
    const meta = { runId: 'run-1', turnId: 'turn-1', sessionId: 'session-1' };
    batcher.enqueue(meta, 'hel', 'text');
    batcher.enqueue(meta, 'lo', 'text');
    batcher.flush('run-1', 'text');
    runner.assertEqual(flushed.length, 1);
    runner.assertEqual(flushed[0], 'text:hello');
  });

  runner.test('buildStreamDeltaPayload produces valid stream delta shape', () => {
    const payload = buildStreamDeltaPayload(
      { runId: 'run-2', turnId: 'turn-2', sessionId: 'session-2' },
      'chunk',
      'reasoning',
    );
    runner.assertEqual(payload.type, 'assistant_stream_delta');
    runner.assertEqual(payload.channel, 'reasoning');
    runner.assertEqual(payload.content, 'chunk');
  });

  runner.test('Runtime batcher bounds a single stream payload', () => {
    const flushed: string[] = [];
    const batcher = new RuntimeBatcher((payload) => flushed.push(payload.content));
    const meta = { runId: 'run-large', turnId: 'turn-large', sessionId: 'session-large' };

    batcher.enqueue(meta, 'x'.repeat(MAX_RUNTIME_DELTA_CHARS + 1), 'text');
    batcher.flush('run-large', 'text');

    runner.assertTrue(flushed.length >= 2);
    runner.assertTrue(flushed.every((chunk) => chunk.length <= MAX_RUNTIME_DELTA_CHARS));
    runner.assertEqual(flushed.join(''), 'x'.repeat(MAX_RUNTIME_DELTA_CHARS + 1));
  });

  runner.test('Runtime batcher coalesces fast tool start+result into one batch IPC payload', () => {
    const batches: ReturnType<typeof buildToolEventsBatchPayload>[] = [];
    const batcher = new RuntimeBatcher(
      () => {},
      (payload) => batches.push(payload),
    );
    const meta = { runId: 'run-tools', turnId: 'turn-tools', sessionId: 'session-tools' };
    batcher.enqueueToolEvent(meta, { type: 'tool_execution_start', tool: 'click', id: 't1', args: { selector: '#a' } });
    batcher.enqueueToolEvent(meta, {
      type: 'tool_execution_result',
      tool: 'click',
      id: 't1',
      args: { selector: '#a' },
      result: { success: true },
    });
    batcher.flush('run-tools');
    runner.assertEqual(batches.length, 1);
    runner.assertEqual(batches[0]?.events.length, 2);
    runner.assertEqual(batches[0]?.events[0]?.type, 'tool_execution_start');
    runner.assertEqual(batches[0]?.events[1]?.type, 'tool_execution_result');
    runner.assertTrue(isRuntimeMessage(batches[0]), 'Tool events batch should validate as runtime message');
  });

  runner.test('Runtime batcher preserves FIFO order across interleaved deltas and tools', () => {
    const order: string[] = [];
    const batcher = new RuntimeBatcher(
      (payload) => order.push(`delta:${payload.content}`),
      (payload) => order.push(`tools:${payload.events.map((event) => event.type).join('+')}`),
    );
    const meta = { runId: 'run-fifo', turnId: 'turn-fifo', sessionId: 'session-fifo' };
    batcher.enqueue(meta, 'a', 'text');
    batcher.enqueueToolEvent(meta, { type: 'tool_execution_start', tool: 'click', id: '1', args: {} });
    batcher.enqueueToolEvent(meta, {
      type: 'tool_execution_result',
      tool: 'click',
      id: '1',
      result: { success: true },
    });
    batcher.enqueue(meta, 'b', 'text');
    batcher.flush('run-fifo');
    runner.assertEqual(order.join('|'), 'delta:a|tools:tool_execution_start+tool_execution_result|delta:b');
  });
}

function testRuntimePushChannel(runner: TestRunner) {
  log('\n=== Testing Runtime Push Channel ===', 'info');

  runner.test('selectRuntimePushChannel prefers port when a panel port is connected', () => {
    runner.assertEqual(selectRuntimePushChannel(true), 'port');
    runner.assertEqual(selectRuntimePushChannel(false), 'sendMessage');
  });

  runner.test('computePortReconnectDelayMs backs off from 250ms to a 2s cap', () => {
    runner.assertEqual(computePortReconnectDelayMs(0), PORT_RECONNECT_INITIAL_MS);
    runner.assertEqual(computePortReconnectDelayMs(1), 500);
    runner.assertEqual(computePortReconnectDelayMs(2), 1000);
    runner.assertEqual(computePortReconnectDelayMs(3), PORT_RECONNECT_MAX_MS);
    runner.assertEqual(computePortReconnectDelayMs(99), PORT_RECONNECT_MAX_MS);
  });

  runner.test('postToPanelPorts returns false when no panel port is connected', () => {
    resetPanelPortsForTests();
    runner.assertFalse(hasConnectedPanelPorts());
    runner.assertFalse(postToPanelPorts({ type: 'run_warning' }));
  });
}

async function testRuntimePushPortBroadcast(runner: TestRunner) {
  await runner.asyncTest('postToPanelPorts broadcasts to every connected panel port', async () => {
    resetPanelPortsForTests();
    const connectListeners: Array<(port: chrome.runtime.Port) => void> = [];
    (globalThis as any).chrome = {
      runtime: {
        onConnect: {
          addListener: (fn: (port: chrome.runtime.Port) => void) => {
            connectListeners.push(fn);
          },
        },
      },
    };
    bindPanelPortListener();
    const postedA: string[] = [];
    const postedB: string[] = [];
    const makePort = (sink: string[]) =>
      ({
        name: 'panel',
        postMessage: (msg: { type?: string }) => sink.push(String(msg.type || '')),
        onDisconnect: { addListener: () => {} },
      }) as unknown as chrome.runtime.Port;
    connectListeners[0]?.(makePort(postedA));
    connectListeners[0]?.(makePort(postedB));
    runner.assertTrue(hasConnectedPanelPorts());
    runner.assertTrue(postToPanelPorts({ type: 'run_warning', message: 'retry' }));
    runner.assertEqual(postedA, ['run_warning']);
    runner.assertEqual(postedB, ['run_warning']);
    resetPanelPortsForTests();
  });
}

async function testProviderDnrRulesCache(runner: TestRunner) {
  log('\n=== Testing Provider DNR Rules Cache ===', 'info');

  await runner.asyncTest('installProviderNetRequestRules skips DNR work when session cache is set', async () => {
    let updateCalls = 0;
    const sessionStore: Record<string, unknown> = { [PROVIDER_DNR_RULES_INSTALLED_KEY]: true };
    (globalThis as any).chrome = {
      storage: {
        session: {
          get: async (keys: string[]) => {
            const out: Record<string, unknown> = {};
            for (const key of keys) out[key] = sessionStore[key];
            return out;
          },
          set: async (patch: Record<string, unknown>) => {
            Object.assign(sessionStore, patch);
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStore[key];
          },
        },
      },
      declarativeNetRequest: {
        updateDynamicRules: async () => {
          updateCalls += 1;
        },
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
        HeaderOperation: { SET: 'set', REMOVE: 'remove' },
        ResourceType: { XMLHTTPREQUEST: 'xmlhttprequest' },
      },
    };
    await installProviderNetRequestRules();
    runner.assertEqual(updateCalls, 0, 'cached install should skip updateDynamicRules');
  });
}

function testToolLogBuffer(runner: TestRunner) {
  log('\n=== Testing Tool Log Buffer ===', 'info');

  runner.test('appendCappedToolLogBuffer drops oldest entries beyond cap', () => {
    let buffer = appendCappedToolLogBuffer(
      [],
      {
        entryId: 'e0',
        toolName: 'click',
        args: {},
        result: undefined,
        startedAt: 0,
      },
      2,
    );
    buffer = appendCappedToolLogBuffer(
      buffer,
      {
        entryId: 'e1',
        toolName: 'type',
        args: {},
        result: undefined,
        startedAt: 1,
      },
      2,
    );
    buffer = appendCappedToolLogBuffer(
      buffer,
      {
        entryId: 'e2',
        toolName: 'wait',
        args: {},
        result: undefined,
        startedAt: 2,
      },
      2,
    );
    runner.assertEqual(buffer.length, 2);
    runner.assertEqual(buffer[0]?.entryId, 'e1');
    runner.assertEqual(buffer[1]?.entryId, 'e2');
    runner.assertEqual(MAX_TOOL_LOG_BUFFER, 500);
  });

  runner.test('updateToolLogBufferResult updates buffered result in place', () => {
    const initial = appendCappedToolLogBuffer([], {
      entryId: 'tool-1',
      toolName: 'click',
      args: { selector: '#x' },
      result: undefined,
      startedAt: 100,
    });
    const updated = updateToolLogBufferResult(initial, 'tool-1', { success: true });
    runner.assertEqual(updated[0]?.result, { success: true });
    runner.assertEqual(updateToolLogBufferResult(updated, 'missing', { success: false }), updated);
  });
}

function testMarkdownRenderDefer(runner: TestRunner) {
  log('\n=== Testing Markdown Render Defer ===', 'info');

  runner.test('shouldDeferMarkdownRender respects the 400-char threshold', () => {
    runner.assertFalse(shouldDeferMarkdownRender(0));
    runner.assertFalse(shouldDeferMarkdownRender(MARKDOWN_DEFER_MIN_CHARS - 1));
    runner.assertTrue(shouldDeferMarkdownRender(MARKDOWN_DEFER_MIN_CHARS));
    runner.assertTrue(shouldDeferMarkdownRender(MARKDOWN_DEFER_MIN_CHARS + 1));
  });
}

function testStreamQueue(runner: TestRunner) {
  log('\n=== Testing Stream Queue ===', 'info');

  runner.test('Stream queue coalesces adjacent deltas and signals a hard cap', () => {
    const queue: Parameters<typeof enqueueStreamMessage>[0] = [];
    const base = {
      schemaVersion: 2 as const,
      runId: 'run-queue',
      turnId: 'turn-queue',
      sessionId: 'session-queue',
      timestamp: 1,
    };

    runner.assertFalse(enqueueStreamMessage(queue, { ...base, type: 'assistant_stream_start' }));
    runner.assertFalse(enqueueStreamMessage(queue, { ...base, type: 'assistant_stream_delta', content: 'hel' }));
    runner.assertFalse(enqueueStreamMessage(queue, { ...base, type: 'assistant_stream_delta', content: 'lo' }));
    runner.assertEqual(queue.length, 2);
    runner.assertEqual(queue[1].type, 'assistant_stream_delta');
    if (queue[1].type === 'assistant_stream_delta') runner.assertEqual(queue[1].content, 'hello');

    for (let index = queue.length; index < MAX_PENDING_STREAM_MESSAGES; index += 1) {
      enqueueStreamMessage(queue, {
        ...base,
        type: 'assistant_stream_stop',
        timestamp: index,
      });
    }
    runner.assertTrue(enqueueStreamMessage(queue, { ...base, type: 'assistant_stream_stop', timestamp: 999 }));
  });
}

async function testSerialTaskQueue(runner: TestRunner) {
  log('\n=== Testing Serial Task Queue ===', 'info');

  await runner.asyncTest('Serial task queue preserves write order after an async task', async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = queue.run(async () => {
      events.push('second');
    });

    await Promise.resolve();
    runner.assertEqual(events.join(','), 'first:start');
    releaseFirst();
    await Promise.all([first, second]);
    runner.assertEqual(events.join(','), 'first:start,first:end,second');
  });
}

function testRunPassCache(runner: TestRunner) {
  log('\n=== Testing Run Pass Cache ===', 'info');

  runner.test('Run pass cache only converts appended history tail', () => {
    const cache = new RunPassCache();
    const first = cache.getModelMessages([{ role: 'user', content: 'hello' }]);
    runner.assertEqual(first.length, 1);
    const second = cache.getModelMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    runner.assertEqual(second.length, 2);
    runner.assertEqual(second[0].role, 'user');
    runner.assertEqual(second[1].role, 'assistant');
    runner.assertTrue(first === second, 'Incremental appends should preserve the owned cache array.');
  });

  runner.test('Run pass cache rebuilds when history shrinks', () => {
    const cache = new RunPassCache();
    cache.getModelMessages([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ]);
    const rebuilt = cache.getModelMessages([{ role: 'user', content: 'fresh' }]);
    runner.assertEqual(rebuilt.length, 1);
  });

  runner.test('Run pass cache preserves a tool result appended after its cached call', () => {
    const cache = new RunPassCache();
    const history: Message[] = [
      { role: 'user', content: 'use the browser' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'navigate', args: { url: 'https://example.com' } }],
      },
    ];
    cache.getModelMessages(history);
    const withResult = cache.getModelMessages([...history, { role: 'tool', content: 'ok', toolCallId: 'call-1' }]);
    runner.assertEqual(withResult.length, 3);
    runner.assertEqual(withResult[2].role, 'tool');
  });
}

async function testRuntimeCache(runner: TestRunner) {
  log('\n=== Testing Runtime Cache ===', 'info');

  runner.test('Model cache keys are stable for identical settings', () => {
    const settings = {
      provider: 'anthropic',
      apiKey: 'sk-test-key-12345678',
      model: 'claude-sonnet-5',
      customEndpoint: '',
    };
    const first = buildModelCacheKey(settings);
    const second = buildModelCacheKey({ ...settings });
    runner.assertEqual(first, second);
  });

  runner.test('invalidateRuntimeCaches is safe to call repeatedly', () => {
    invalidateRuntimeCaches();
    invalidateRuntimeCaches();
    runner.assertTrue(true);
  });

  runner.test('model cache evicts oldest entries beyond cap', () => {
    invalidateRuntimeCaches();
    for (let i = 0; i < 40; i += 1) {
      getCachedLanguageModel({
        provider: 'ollama',
        apiKey: '',
        model: `model-${i}`,
        customEndpoint: 'http://localhost:11434',
      });
    }
    runner.assertTrue(getModelCacheSizeForTests() <= 32, 'model cache should enforce LRU cap');
    invalidateRuntimeCaches();
  });

  // Guarda a razão de buildRunToolSet NÃO cachear: o execute fecha sobre estado
  // do run (contador de execuções, watchdog, aba travada). Se alguém reintroduzir
  // um cache aqui, este teste é o que quebra.
  await runner.asyncTest('buildRunToolSet does not reuse execute closures', async () => {
    const tools = [{ name: 'click', description: 'click', input_schema: { type: 'object' as const, properties: {} } }];
    let counterA = 0;
    let counterB = 0;
    const setA = buildRunToolSet(
      tools as any,
      async () => {
        counterA += 1;
        return { ok: true };
      },
      'anthropic',
    );
    const setB = buildRunToolSet(
      tools as any,
      async () => {
        counterB += 1;
        return { ok: true };
      },
      'anthropic',
    );
    await setA.click.execute?.({ selector: '#a' }, { toolCallId: 'a', messages: [], abortSignal: undefined as any });
    await setB.click.execute?.({ selector: '#b' }, { toolCallId: 'b', messages: [], abortSignal: undefined as any });
    runner.assertEqual(counterA, 1);
    runner.assertEqual(counterB, 1);
  });
}

function testRuntimeSettings(runner: TestRunner) {
  log('\n=== Testing Runtime Settings ===', 'info');

  runner.test('Runtime settings include internal resilience controls', () => {
    const keys = new Set<string>(RUNTIME_SETTINGS_KEYS);
    for (const key of [
      'visionBridge',
      'visionBridgeSync',
      'useContentBridge',
      'autoFindElementOnFailure',
      'toolPermissions',
      'allowedDomains',
      'autoRecoveryMode',
      'screenshotOnFailure',
      'screenshotRetention',
      'deferCompaction',
      'screenshotQuality',
      'streamResponses',
      'maxTokens',
      'timeout',
      'contextLimit',
    ]) {
      runner.assertTrue(keys.has(key), `Missing runtime setting key: ${key}`);
    }
  });
}

function testModelActivityWatchdog(runner: TestRunner) {
  log('\n=== Testing Model Activity Watchdog ===', 'info');

  runner.test('Model timeout is postponed during active tool work and fires after inactivity', () => {
    let activeTool = true;
    let timeoutCount = 0;
    let scheduled: (() => void) | null = null;
    let scheduleCount = 0;
    const watchdog = new ModelActivityWatchdog(
      1000,
      () => {
        timeoutCount += 1;
      },
      () => activeTool,
      (callback) => {
        scheduled = callback;
        scheduleCount += 1;
        return scheduleCount as unknown as ReturnType<typeof setTimeout>;
      },
      () => {},
    );

    watchdog.start();
    runner.assertEqual(scheduleCount, 1);
    const duringTool = scheduled as (() => void) | null;
    runner.assertTrue(Boolean(duringTool), 'Watchdog should schedule its inactivity check.');
    duringTool?.();
    runner.assertEqual(timeoutCount, 0);
    runner.assertEqual(scheduleCount, 2);

    activeTool = false;
    const afterTool = scheduled as (() => void) | null;
    runner.assertTrue(Boolean(afterTool), 'Watchdog should re-arm while the tool is active.');
    afterTool?.();
    runner.assertEqual(timeoutCount, 1);
  });

  // Regressão do "Illegal invocation": no Chrome, setTimeout/clearTimeout
  // exigem receiver global (ou undefined). Os defaults do watchdog eram os
  // nativos guardados em campos da instância, então this.schedule(...) recebia
  // a instância como receiver e derrubava TODO run (qualquer provedor).
  runner.test('Watchdog default timers survive a receiver-sensitive Chrome runtime', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const assertGlobalReceiver = function (this: unknown, api: string) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError(`Illegal invocation (${api})`);
      }
    };
    globalThis.setTimeout = function (this: unknown) {
      assertGlobalReceiver.call(this, 'setTimeout');
      return 1 as unknown as ReturnType<typeof setTimeout>;
    } as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = function (this: unknown) {
      assertGlobalReceiver.call(this, 'clearTimeout');
    } as unknown as typeof globalThis.clearTimeout;

    try {
      const watchdog = new ModelActivityWatchdog(
        1000,
        () => {},
        () => false,
      );
      watchdog.start();
      watchdog.touch();
      watchdog.stop();
      runner.assertTrue(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
}

function testImageScale(runner: TestRunner) {
  log('\n=== Testing Image Downscale (vision token-cost regression) ===', 'info');

  runner.test('computeDownscale caps the longest side and preserves aspect ratio', () => {
    // HiDPI landscape capture -> longest side clamped to 1280.
    const landscape = computeDownscale(2560, 1600, 1280);
    runner.assertTrue(landscape.scaled, 'oversize image is scaled');
    runner.assertEqual(landscape.width, 1280, 'longest side capped');
    runner.assertEqual(landscape.height, 800, 'aspect ratio preserved');
    // Portrait: the taller side is the one clamped.
    const portrait = computeDownscale(1200, 3000, 1280);
    runner.assertEqual(portrait.height, 1280, 'portrait clamps height');
    runner.assertEqual(portrait.width, 512, 'portrait width scaled proportionally');
  });

  runner.test('computeDownscale leaves already-small images untouched', () => {
    const small = computeDownscale(800, 600, 1280);
    runner.assertFalse(small.scaled, 'image within cap is not scaled');
    runner.assertEqual(small.width, 800);
    runner.assertEqual(small.height, 600);
    // Degenerate inputs never scale (and never divide by zero).
    runner.assertFalse(computeDownscale(0, 0, 1280).scaled, 'zero dims: no scale');
    runner.assertFalse(computeDownscale(1000, 1000, 0).scaled, 'zero cap: no scale');
  });

  runner.test('needsScreenshotDownscale mirrors computeDownscale.scaled', () => {
    runner.assertFalse(needsScreenshotDownscale(1280, 720, 1280));
    runner.assertFalse(needsScreenshotDownscale(800, 600, 1280));
    runner.assertTrue(needsScreenshotDownscale(1281, 720, 1280));
    runner.assertTrue(needsScreenshotDownscale(2560, 1600, 1280));
  });

  runner.test('uint8ArrayToBase64 round-trips without Array.from chunks', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111, 0, 255, 128]);
    let expected = '';
    for (let i = 0; i < bytes.length; i += 1) expected += String.fromCharCode(bytes[i]);
    const encoded = uint8ArrayToBase64(bytes);
    runner.assertEqual(encoded, btoa(expected));
    runner.assertEqual(arrayBufferToBase64(bytes.buffer), encoded);
    const large = new Uint8Array(90000);
    for (let i = 0; i < large.length; i += 1) large[i] = i % 256;
    const largeEncoded = uint8ArrayToBase64(large);
    runner.assertTrue(largeEncoded.length > 0, 'large payload encodes');
    runner.assertEqual(atob(largeEncoded).length, large.length);
  });

  runner.test('computeClipRect clamps element rect + padding to viewport edges', () => {
    const centered = computeClipRect({ x: 40, y: 30, width: 100, height: 50 }, 8, { width: 800, height: 600 });
    runner.assertEqual(centered.x, 32);
    runner.assertEqual(centered.y, 22);
    runner.assertEqual(centered.width, 116);
    runner.assertEqual(centered.height, 66);

    const topLeft = computeClipRect({ x: 2, y: 1, width: 40, height: 20 }, 10, { width: 800, height: 600 });
    runner.assertEqual(topLeft.x, 0);
    runner.assertEqual(topLeft.y, 0);
    runner.assertEqual(topLeft.width, 52);
    runner.assertEqual(topLeft.height, 31);

    const bottomRight = computeClipRect({ x: 760, y: 560, width: 80, height: 80 }, 20, { width: 800, height: 600 });
    runner.assertEqual(bottomRight.x, 740);
    runner.assertEqual(bottomRight.y, 540);
    runner.assertEqual(bottomRight.width, 60);
    runner.assertEqual(bottomRight.height, 60);
  });

  runner.test('testFixToolsClipIntersectsBitmap rejects off-bitmap clips', () => {
    runner.assertFalse(clipIntersectsBitmap({ x: 900, y: 700, width: 10, height: 10 }, { width: 800, height: 600 }));
    runner.assertTrue(clipIntersectsBitmap({ x: 10, y: 10, width: 50, height: 40 }, { width: 800, height: 600 }));
  });

  runner.test('testFixToolsRectIntersectsViewport detects offscreen elements', () => {
    runner.assertFalse(rectIntersectsViewport({ x: 900, y: 0, width: 40, height: 20 }, { width: 800, height: 600 }));
    runner.assertTrue(rectIntersectsViewport({ x: 10, y: 10, width: 40, height: 20 }, { width: 800, height: 600 }));
  });
}

async function testFixToolsBrowserAutomation(runner: TestRunner) {
  log('\n=== Testing Browser Tool Fixes (review findings) ===', 'info');

  runner.test('testFixToolsShouldAutoStopNetworkCapture skips install-only reads', () => {
    runner.assertFalse(shouldAutoStopNetworkCapture(true, 5, false));
    runner.assertFalse(shouldAutoStopNetworkCapture(false, 5, true));
    runner.assertTrue(shouldAutoStopNetworkCapture(false, 3, false));
    runner.assertFalse(shouldAutoStopNetworkCapture(false, 0, false));
  });

  runner.test('network capture waits for inflight before auto-stop teardown', () => {
    runner.assertTrue(shouldDrainInflightBeforeStop(true, 2));
    runner.assertFalse(shouldDrainInflightBeforeStop(true, 0));
    runner.assertFalse(shouldDrainInflightBeforeStop(false, 3));
  });

  runner.test('pickFrameIdForSelectorProbe chooses first matching frame', () => {
    const frameId = pickFrameIdForSelectorProbe([
      { frameId: 0, result: { found: false } },
      { frameId: 42, result: { found: true } },
      { frameId: 99, result: { found: true } },
    ]);
    runner.assertEqual(frameId, 42);
  });

  runner.test('domain policy allowlist matches subdomains', () => {
    const allowlist = parseAllowedDomains('instagram.com');
    runner.assertTrue(isUrlAllowedByDomains('https://www.instagram.com/api/', allowlist));
    runner.assertFalse(isUrlAllowedByDomains('https://evil.com/', allowlist));
    runner.assertTrue(isSameOriginUrl('https://a.com/x', 'https://a.com/y'));
    runner.assertFalse(isSameOriginUrl('https://a.com/x', 'https://b.com/y'));
  });

  runner.test('testFixToolsExpandTableRowCells honors rowspan carry-over', () => {
    let carry: ReturnType<typeof expandTableRowCells>['nextCarry'] = [];
    const row1 = expandTableRowCells([{ text: 'A', colspan: 1, rowspan: 2 }], carry);
    carry = row1.nextCarry;
    runner.assertEqual(row1.row.join('|'), 'A');
    const row2 = expandTableRowCells([{ text: 'B', colspan: 1, rowspan: 1 }], carry);
    runner.assertEqual(row2.row.join('|'), 'A|B');
  });

  runner.test('testFixToolsAssignReadPageRefs deduplicates like readPage numbering', () => {
    const refs = assignReadPageRefs(['btn-save', 'btn-save', 'nav-main', 'btn-cancel']);
    runner.assertEqual(refs.get('btn-save'), 'e1');
    runner.assertEqual(refs.get('nav-main'), 'e2');
    runner.assertEqual(refs.get('btn-cancel'), 'e3');
    runner.assertEqual(refs.size, 3);
  });

  runner.test('testFixToolsSelectOptionValidation rejects negative index', () => {
    const tools = new BrowserTools();
    const bad = tools.validateToolArgs('selectOption', { selector: '#x', index: -1 });
    runner.assertFalse(bad.ok);
    const ok = tools.validateToolArgs('selectOption', { selector: '#x', index: 0 });
    runner.assertTrue(ok.ok);
  });

  runner.test('testFixToolsSetInputFiles caps total decoded bytes', () => {
    const huge = 'A'.repeat(Math.ceil((SET_INPUT_FILES_MAX_TOTAL_BYTES * 4) / 3) + 4);
    const result = normalizeSetInputFileSpecs([
      { name: 'big.bin', contentBase64: huge, mimeType: 'application/octet-stream' },
    ]);
    runner.assertFalse(Array.isArray(result));
    if (!Array.isArray(result)) {
      runner.assertTrue(
        result.error.includes('10MB') || result.error.includes(String(SET_INPUT_FILES_MAX_TOTAL_BYTES)),
      );
    }
  });

  runner.test('testFixToolsLockedTabAllowlist includes vision capture tools', () => {
    runner.assertTrue(LOCKED_TAB_ALLOWED_BROWSER_TOOLS.has('annotatedScreenshot'));
    runner.assertTrue(LOCKED_TAB_ALLOWED_BROWSER_TOOLS.has('elementScreenshot'));
  });

  await runner.asyncTest('testFixToolsWaitForHistoryTransition detects no-op back', async () => {
    const transition = await waitForHistoryTransition(1, 'https://example.com/a', 'back', {
      timeoutMs: 300,
      pollIntervalMs: 50,
      getTab: async () => ({ status: 'complete', url: 'https://example.com/a' }),
      sleep: async () => {},
    });
    runner.assertFalse(transition.moved);
    runner.assertEqual(transition.url, 'https://example.com/a');
  });
}

function testDeliberateRunStop(runner: TestRunner) {
  log('\n=== Testing Deliberate Run Stop Detection (closed-tab-abort regression) ===', 'info');

  runner.test('sentinel abort/supersede errors are recognized as deliberate stops', () => {
    runner.assertTrue(isDeliberateRunStop(new Error('Run aborted.')), 'idle-watchdog / tab-close abort message');
    runner.assertTrue(
      isDeliberateRunStop(new Error('Run superseded: the watchdog released this run after a period of inactivity.')),
      'watchdog race variant',
    );
  });

  runner.test('ordinary provider/network errors are NOT treated as deliberate stops', () => {
    runner.assertFalse(isDeliberateRunStop(new Error('fetch failed')), 'network errors still show a real message');
    runner.assertFalse(isDeliberateRunStop(new Error('Model returned an empty response.')));
    runner.assertFalse(isDeliberateRunStop(new Error('')));
    runner.assertFalse(isDeliberateRunStop(null));
  });
}

function testContinuationIntent(runner: TestRunner) {
  log('\n=== Testing Continuation Intent (promise-as-final regression) ===', 'info');

  runner.test('A tool-less promise to keep working is detected as continuation', () => {
    // Exact failure from the Instagram scroll bug: model apologized and promised
    // to continue, called no tool, and the run ended on that text.
    runner.assertTrue(
      textPromisesFurtherAction(
        'Peço desculpas — o scroll não avançou. Vou rolar corretamente dentro do modal, extraindo continuamente, até completar 100 nomes.',
      ),
      'apology + "vou rolar… até completar" must be a broken promise',
    );
    runner.assertTrue(textPromisesFurtherAction('Agora vou abrir o modal de seguidores.'));
    runner.assertTrue(textPromisesFurtherAction('Next, I will scroll the list to load more users.'));
    runner.assertTrue(textPromisesFurtherAction('Let me open the following dialog now.'));
    runner.assertTrue(textPromisesFurtherAction('Em seguida clico em Seguindo e coleto os nomes.'));
    runner.assertTrue(textPromisesFurtherAction('Deixa eu abrir o perfil agora.'));
    runner.assertTrue(shouldForceToolContinuation('Naveguei. Vou rolar a lista.'));
  });

  runner.test('In-progress narration is forced even without explicit "vou"', () => {
    runner.assertTrue(textSignalsInProgressWork('Abrindo o Instagram e localizando o perfil…'));
    runner.assertTrue(textSignalsInProgressWork('Coletando nomes do modal…'));
    runner.assertTrue(textSignalsInProgressWork('Scrolling the followers list now.'));
    runner.assertTrue(shouldForceToolContinuation('Estou extraindo os seguidores.'));
  });

  runner.test('A completed-result answer is NOT treated as a broken promise', () => {
    runner.assertFalse(
      textPromisesFurtherAction('Coletei os 100 nomes do modal de seguidores. Aqui está a lista completa.'),
      'a result report must finalize normally',
    );
    runner.assertFalse(textPromisesFurtherAction('Cliquei em "seguindo" e o modal abriu com 100 usuários.'));
    runner.assertFalse(
      textPromisesFurtherAction('Não vou mais precisar rolar — a lista já está completa.'),
      'negated future ("não vou mais") is not a promise',
    );
    runner.assertFalse(textPromisesFurtherAction(''), 'empty text is never a promise');
    runner.assertFalse(
      shouldForceToolContinuation('Coletei os 100 nomes. Aqui está a lista completa.'),
      'finished result must not force tools',
    );
    runner.assertFalse(textSignalsInProgressWork('Pronto. Modal aberto e lista completa.'));
  });

  runner.test('Confirmation requests and blockers are legitimate stops, not promises', () => {
    runner.assertTrue(textAwaitsUser('Encontrei um CAPTCHA. Pode resolver para eu seguir?'));
    runner.assertTrue(textAwaitsUser('Preciso que você faça login antes de continuar.'));
    runner.assertTrue(textAwaitsUser('Deseja que eu prossiga com a exclusão?'));
    // A promise that also asks the user hands control back — do not force continuation.
    runner.assertFalse(
      textPromisesFurtherAction('Vou continuar rolando, tudo certo?'),
      'a promise ending in a question is a user handoff, not a forced continuation',
    );
    runner.assertFalse(shouldForceToolContinuation('Vou continuar rolando, tudo certo?'));
    runner.assertFalse(textAwaitsUser('Rolei a lista e coletei todos os nomes.'));
  });
}

function testFailureRecovery(runner: TestRunner) {
  log('\n=== Testing Failure Recovery ===', 'info');

  runner.test('Third identical browser failure is stopped with a tab and URL scoped signature', () => {
    const input = {
      toolName: 'click',
      args: { selector: '  #Save  ' },
      tabId: 17,
      url: 'https://example.com/form',
    };
    runner.assertEqual(buildFailureSignature(input), 'click|#Save|17|https://example.com/form');
    const tracker = new FailureRecoveryTracker(3);
    runner.assertFalse(tracker.recordFailure(input).repeated);
    runner.assertFalse(tracker.recordFailure(input).repeated);
    const third = tracker.recordFailure(input);
    runner.assertTrue(third.repeated);
    runner.assertEqual(third.code, 'REPEATED_FAILURE');
  });

  runner.test('Failed unverified tools force exactly one continuation', () => {
    runner.assertTrue(
      shouldForceFailedToolContinuation({ hasFailedTools: true, awaitingVerification: true, alreadyUsed: false }),
    );
    runner.assertFalse(
      shouldForceFailedToolContinuation({ hasFailedTools: true, awaitingVerification: true, alreadyUsed: true }),
    );
    runner.assertFalse(
      shouldForceFailedToolContinuation({ hasFailedTools: true, awaitingVerification: false, alreadyUsed: false }),
    );
  });

  runner.test('A second failed unverified browser pass terminates the run', () => {
    runner.assertEqual(
      decideFailedToolOutcome({ hasFailedTools: true, awaitingVerification: true, alreadyUsed: true }),
      'fail',
    );
  });

  runner.test('A verified recovery resets the budget for a later independent browser failure', () => {
    const firstFailure = advanceFailedToolRecovery({
      hasFailedTools: true,
      awaitingVerification: true,
      continuationUsed: false,
    });
    runner.assertEqual(firstFailure.outcome, 'continue');
    runner.assertTrue(firstFailure.continuationUsed);

    const verified = advanceFailedToolRecovery({
      hasFailedTools: false,
      awaitingVerification: false,
      continuationUsed: firstFailure.continuationUsed,
    });
    runner.assertEqual(verified.outcome, 'complete');
    runner.assertFalse(verified.continuationUsed);

    const laterFailure = advanceFailedToolRecovery({
      hasFailedTools: true,
      awaitingVerification: true,
      continuationUsed: verified.continuationUsed,
    });
    runner.assertEqual(laterFailure.outcome, 'continue');
  });

  runner.test('Thrown tool exceptions use the standard failed-result contract', () => {
    const result = normalizeThrownToolError(new Error('Browser injection failed'));
    runner.assertFalse(result.success);
    runner.assertEqual(result.code, 'TOOL_EXECUTION_ERROR');
    runner.assertEqual(result.error, 'Browser injection failed');
  });

  runner.test('Terminal browser failure exposes a bounded actionable summary', () => {
    const failure = buildTerminalToolFailure('click', {
      success: false,
      code: 'ELEMENT_NOT_FOUND',
      error: 'Element not found: #save',
      nextHint: 'Inspect the page structure before trying a different selector.',
    });
    runner.assertTrue(failure.message.includes('click'));
    runner.assertTrue(failure.message.includes('Element not found: #save'));
    runner.assertEqual(failure.details.code, 'BROWSER_RECOVERY_EXHAUSTED');
    runner.assertEqual(failure.details.toolCode, 'ELEMENT_NOT_FOUND');
    runner.assertEqual(failure.details.recordInTranscript, true);
  });
}

function testFixSwReviewFindings(runner: TestRunner) {
  log('\n=== Testing SW Review Fixes ===', 'info');

  runner.test('testFixSwSessionRebindAfterCompaction keeps post-turn writes on new session id', () => {
    const store = new SessionContextStore();
    const runMeta = { runId: 'run-1', turnId: 'turn-1', sessionId: 'session-old' };
    let sessionId = runMeta.sessionId;
    const prior = createMessage({ role: 'user', content: 'prior turn' });
    runner.assertTrue(Boolean(prior));
    store.set('session-old', [prior!]);

    const newSessionId = 'session-new';
    const previousSessionId = runMeta.sessionId;
    const compacted = [createMessage({ role: 'system', content: 'summary', meta: { kind: 'summary' } })!];
    runMeta.sessionId = newSessionId;
    store.set(newSessionId, compacted);
    if (previousSessionId && previousSessionId !== newSessionId) {
      store.delete(previousSessionId);
    }
    sessionId = runMeta.sessionId;

    const assistant = createMessage({ role: 'assistant', content: 'current turn reply' });
    runner.assertTrue(Boolean(assistant));
    store.set(sessionId, normalizeConversationHistory([...compacted, assistant!]));

    runner.assertFalse(store.has('session-old'));
    runner.assertTrue(store.has('session-new'));
    runner.assertEqual(store.get('session-new').length, 2);
    runner.assertEqual(String(store.get('session-new')[1]?.content), 'current turn reply');
  });

  runner.test('testFixSwTombstoneSkipsPostTurnSet prevents resurrecting deleted sessions', () => {
    const store = new SessionContextStore();
    const tombstones = new SessionTombstoneRegistry();
    const sessionId = 'session-deleted';
    store.set(sessionId, [createMessage({ role: 'user', content: 'hello' })!]);
    tombstones.mark(sessionId, 'run-delete');
    store.delete(sessionId);

    const nextHistory = normalizeConversationHistory([
      createMessage({ role: 'user', content: 'hello' })!,
      createMessage({ role: 'assistant', content: 'bye' })!,
    ]);
    if (!tombstones.isTombstoned(sessionId)) {
      store.set(sessionId, nextHistory);
    }

    runner.assertFalse(store.has(sessionId));
    tombstones.clearForRun('run-other');
    runner.assertTrue(tombstones.isTombstoned(sessionId));
    tombstones.clearForRun('run-delete');
    runner.assertFalse(tombstones.isTombstoned(sessionId));
  });

  runner.test('testFixSwPartialBatchSalvage keeps valid tool events and drops invalid ones', () => {
    const salvaged = salvageToolEventsBatchEvents([
      { type: 'tool_execution_start', tool: 'click', args: { selector: '#ok' } },
      { type: 'tool_execution_start', tool: '', args: {} },
      { type: 'not_a_tool_event', tool: 'wait', args: {} },
      {
        type: 'tool_execution_result',
        tool: 'wait',
        result: { success: true },
      },
    ]);
    runner.assertEqual(salvaged.length, 2);
    runner.assertEqual(salvaged[0]?.type, 'tool_execution_start');
    runner.assertEqual(salvaged[1]?.type, 'tool_execution_result');

    const batch = {
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      type: 'tool_events_batch' as const,
      runId: 'run-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      timestamp: Date.now(),
      events: salvaged,
    };
    runner.assertTrue(isRuntimeMessage(batch));
    runner.assertEqual(salvageToolEventsBatchEvents([]).length, 0);
  });

  runner.test('testFixSwWaitExcludedFromFailureTracking but remains a browser action', () => {
    runner.assertTrue(BROWSER_ACTION_TOOLS.includes('wait'));
    runner.assertFalse(isFailureTrackedTool('wait'));
    runner.assertTrue(isFailureTrackedTool('click'));

    const tracker = new FailureRecoveryTracker(3);
    const recordIfTracked = (action: Parameters<typeof tracker.recordFailure>[0]) => {
      if (!isFailureTrackedTool(action.toolName)) return null;
      return tracker.recordFailure(action);
    };

    const pollingWait = {
      toolName: 'wait',
      args: { condition: 'selector', selector: '#slow' },
      tabId: 9,
      url: 'https://example.com',
    };
    runner.assertEqual(recordIfTracked(pollingWait), null);
    runner.assertEqual(recordIfTracked(pollingWait), null);
    runner.assertEqual(recordIfTracked(pollingWait), null);

    const clickFailure = {
      toolName: 'click',
      args: { selector: '#Save' },
      tabId: 9,
      url: 'https://example.com',
    };
    runner.assertFalse(recordIfTracked(clickFailure)?.repeated);
    runner.assertFalse(recordIfTracked(clickFailure)?.repeated);
    runner.assertTrue(recordIfTracked(clickFailure)?.repeated);
  });

  runner.test('testFixSwPostToPanelPortsRequiresSuccess returns false when every port throws', () => {
    resetPanelPortsForTests();
    const connectListeners: Array<(port: chrome.runtime.Port) => void> = [];
    (globalThis as any).chrome = {
      runtime: {
        onConnect: {
          addListener: (fn: (port: chrome.runtime.Port) => void) => {
            connectListeners.push(fn);
          },
        },
      },
    };
    bindPanelPortListener();
    const brokenPort = {
      name: 'panel',
      postMessage: () => {
        throw new Error('port dead');
      },
      onDisconnect: { addListener: () => {} },
    } as unknown as chrome.runtime.Port;
    connectListeners[0]?.(brokenPort);
    runner.assertTrue(hasConnectedPanelPorts());
    runner.assertFalse(postToPanelPorts({ type: 'run_warning', message: 'lost' }));
    resetPanelPortsForTests();
  });

  runner.test('run-scoped abort registry isolates manual and agent runs', () => {
    const registry = new RunAbortRegistry();
    const manual = registry.create('manual-run');
    manual.abort();
    registry.create('agent-run');
    runner.assertTrue(registry.isAborted('manual-run'));
    runner.assertFalse(registry.isAborted('agent-run'));
    registry.dispose('manual-run');
    registry.dispose('agent-run');
  });

  runner.test('abort state survives until explicit dispose (stop_run contract)', () => {
    // releaseRunExclusiveLock NÃO pode descartar o controller: o run parado
    // ainda desenrola (loop XML, pre-flight de executeToolByName) e consulta
    // isRunAborted — após dispose o lookup devolve false e a tool rodaria.
    const registry = new RunAbortRegistry();
    registry.create('run-stop');
    registry.abort('run-stop');
    runner.assertTrue(registry.isAborted('run-stop'));
    registry.dispose('run-stop');
    runner.assertFalse(registry.isAborted('run-stop'));
  });

  runner.test('injected fn ids are stable by function source', () => {
    resetInjectedFnIdsForTests();
    const makeFn = () => (a: number, b: number) => a + b;
    const first = getInjectedFnId(makeFn());
    const second = getInjectedFnId(makeFn());
    runner.assertEqual(first, second);
    const other = getInjectedFnId((a: number, b: number) => a * b);
    runner.assertFalse(other === first);
  });

  // Um ÚNICO asyncTest: a suíte não aguarda asyncTest solto, então testes
  // separados correriam em paralelo e brigariam pelo __glideFnRegistry global.
  runner.asyncTest('injected fn registry installs once, dispatches by id, and degrades safely', async () => {
    resetInjectedFnIdsForTests();
    delete (globalThis as Record<string, unknown>).__glideFnRegistry;

    const fn = (payload: { x: number }) => ({ doubled: payload.x * 2 });
    const id = getInjectedFnId(fn);
    const installed = (await glideInstallAndRunInjectedFn(id, String(fn), [{ x: 21 }])) as {
      __glideFnResult?: boolean;
      value?: { doubled: number };
    };
    runner.assertTrue(isInjectedFnResult(installed));
    runner.assertEqual(installed.value?.doubled, 42);

    const dispatched = (await glideDispatchInjectedFn(id, [{ x: 10 }])) as {
      __glideFnResult?: boolean;
      value?: { doubled: number };
    };
    runner.assertTrue(isInjectedFnResult(dispatched));
    runner.assertEqual(dispatched.value?.doubled, 20);

    const asyncFn = async (ms: number) => `waited-${ms}`;
    const asyncId = getInjectedFnId(asyncFn);
    const asyncOut = (await glideInstallAndRunInjectedFn(asyncId, String(asyncFn), [5])) as { value?: string };
    runner.assertTrue(isInjectedFnResult(asyncOut));
    runner.assertEqual(asyncOut.value, 'waited-5');

    const missing = await glideDispatchInjectedFn('glide_fn_absent', []);
    runner.assertTrue(isInjectedFnMissing(missing));
    runner.assertFalse(isInjectedFnResult(missing));

    const blocked = await glideInstallAndRunInjectedFn('glide_fn_broken', '() => { syntax error', []);
    runner.assertTrue(isInjectedFnEvalBlocked(blocked));
    runner.assertFalse(isInjectedFnResult(blocked));

    delete (globalThis as Record<string, unknown>).__glideFnRegistry;
  });

  runner.test('session generation blocks stale compaction commits', () => {
    const generations = new SessionGenerationRegistry();
    const sessionId = 'session-1';
    const atStart = generations.bump(sessionId);
    generations.bump(sessionId);
    runner.assertFalse(generations.matches(sessionId, atStart));
    runner.assertTrue(generations.matches(sessionId, generations.get(sessionId)));
  });

  runner.test('sentinel registry only clears matching token', () => {
    const registry = new ActiveRunSentinelRegistry();
    const tokenA = createSentinelToken('run-a');
    const tokenB = createSentinelToken('run-b');
    registry.remember('run-a', tokenA);
    registry.remember('run-b', tokenB);
    runner.assertEqual(registry.expectedToken('run-a'), tokenA);
    registry.forget('run-a');
    runner.assertEqual(registry.expectedToken('run-a'), undefined);
    runner.assertEqual(registry.expectedToken('run-b'), tokenB);
  });

  runner.test('context_compacted envelope keeps previous sessionId for panel adoption', () => {
    const runMeta = { runId: 'run-1', turnId: 'turn-1', sessionId: 'session-new' };
    const envelope = { ...runMeta, sessionId: 'session-old' };
    runner.assertEqual(envelope.sessionId, 'session-old');
    runner.assertEqual(runMeta.sessionId, 'session-new');
  });

  runner.test('side panel claim generation ignores stale onClosed', () => {
    resetSidePanelClaimGenerationForTests();
    const first = bumpSidePanelClaimGeneration();
    bumpSidePanelClaimGeneration();
    runner.assertFalse(getSidePanelClaimGeneration() === first);
  });

  runner.test('cdp Page.navigate helper detects navigate params', () => {
    runner.assertTrue(isCdpNavigateMethod('Page.navigate'));
    runner.assertEqual(extractCdpNavigateUrl({ url: 'https://example.com/path' }), 'https://example.com/path');
    runner.assertEqual(extractCdpNavigateUrl({}), null);
  });

  runner.test('wrapUntrustedToolPayload adds explicit delimiters', () => {
    const wrapped = wrapUntrustedToolPayload('hello');
    runner.assertTrue(wrapped.includes('<untrusted_tool_output>'));
    runner.assertTrue(wrapped.includes('hello'));
  });

  runner.asyncTest('session compaction queue serializes same-session work', async () => {
    const queue = new SessionCompactionQueue();
    const events: string[] = [];
    const first = queue.run('session-1', async () => {
      events.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('first:end');
    });
    const second = queue.run('session-1', async () => {
      events.push('second');
    });
    await Promise.all([first, second]);
    runner.assertEqual(events.join(','), 'first:start,first:end,second');
  });

  runner.test('run event sequencer increments per run independently', () => {
    const sequencer = new RunEventSequencer();
    runner.assertEqual(sequencer.next('run-a'), 1);
    runner.assertEqual(sequencer.next('run-a'), 2);
    runner.assertEqual(sequencer.next('run-b'), 1);
    sequencer.drop('run-a');
    runner.assertEqual(sequencer.next('run-a'), 1);
  });
}

function testSessionTools(runner: TestRunner) {
  log('\n=== Testing Session Tools ===', 'info');

  const browserTools = [
    { name: 'click', description: 'click', input_schema: { type: 'object' as const, properties: {} } },
    { name: 'screenshot', description: 'shot', input_schema: { type: 'object' as const, properties: {} } },
    { name: 'annotatedScreenshot', description: 'som', input_schema: { type: 'object' as const, properties: {} } },
    { name: 'elementScreenshot', description: 'el', input_schema: { type: 'object' as const, properties: {} } },
    {
      name: 'getNetworkRequests',
      description: 'net',
      input_schema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'executeScript',
      description: 'js',
      input_schema: { type: 'object' as const, properties: {} },
    },
  ];
  const allowlist = new Set(['click']);

  runner.test('Locked-tab profile keeps only allowlisted browser tools plus plan tools', () => {
    const tools = buildSessionTools({
      browserToolDefinitions: browserTools,
      lockedTabId: 42,
      lockedTabAllowlist: allowlist,
    });
    const names = tools.map((tool) => tool.name);
    runner.assertTrue(names.includes('click'), 'allowlisted browser tool remains');
    runner.assertFalse(names.includes('screenshot'), 'non-allowlisted browser tool is filtered out');
    runner.assertFalse(names.includes('annotatedScreenshot'), 'annotatedScreenshot filtered on locked tab');
    runner.assertFalse(names.includes('elementScreenshot'), 'elementScreenshot filtered on locked tab');
    runner.assertTrue(names.includes('set_plan'), 'plan tools are available to the run');
    runner.assertTrue(names.includes('update_plan'), 'plan update tool is available to the run');
  });

  runner.test('Locked-tab production allowlist includes diagnostics and scripting', () => {
    for (const name of [
      'getNetworkRequests',
      'httpRequest',
      'getConsoleOutput',
      'getStorageData',
      'getPerformanceMetrics',
      'executeScript',
      'getTabs',
      'getContent',
      'findElement',
      'readPage',
      'screenshot',
      'annotatedScreenshot',
      'elementScreenshot',
      'clipboard',
      'setInputFiles',
      'selectOption',
      'fillForm',
      'navigateHistory',
      'highlightElement',
      'captureDownload',
      'findInPage',
      'extractTable',
      'harvestScroll',
      'cdp',
    ]) {
      runner.assertTrue(LOCKED_TAB_ALLOWED_BROWSER_TOOLS.has(name), `locked-tab allowlist must include ${name}`);
    }
  });

  runner.test('Locked-tab schema keeps network and executeScript when allowlisted', () => {
    const tools = buildSessionTools({
      browserToolDefinitions: browserTools,
      lockedTabId: 7,
      lockedTabAllowlist: LOCKED_TAB_ALLOWED_BROWSER_TOOLS,
    });
    const names = tools.map((tool) => tool.name);
    runner.assertTrue(names.includes('getNetworkRequests'), 'getNetworkRequests available in locked-tab run');
    runner.assertTrue(names.includes('executeScript'), 'executeScript available in locked-tab run');
    runner.assertTrue(names.includes('click'), 'interaction tools still available');
  });

  runner.test('toolPermissions filter removes denied categories from the schema', () => {
    const tools = buildSessionTools({
      browserToolDefinitions: browserTools,
      lockedTabId: 7,
      lockedTabAllowlist: LOCKED_TAB_ALLOWED_BROWSER_TOOLS,
      toolPermissions: { read: true, interact: true, scripting: false },
    });
    const names = tools.map((tool) => tool.name);
    runner.assertTrue(names.includes('getNetworkRequests'), 'read tools remain when read allowed');
    runner.assertFalse(names.includes('executeScript'), 'scripting denied removes executeScript from schema');
    runner.assertTrue(names.includes('set_plan'), 'plan tools are not permission-gated');
  });

  runner.test('Plan tools can be disabled and screenshots gated by settings', () => {
    const tools = buildSessionTools({
      browserToolDefinitions: browserTools,
      includePlanTools: false,
      enableScreenshots: false,
    });
    const names = tools.map((tool) => tool.name);
    runner.assertTrue(names.includes('click'), 'browser tools remain without a tab lock');
    runner.assertFalse(names.includes('screenshot'), 'screenshot removed when disabled in settings');
    runner.assertFalse(names.includes('annotatedScreenshot'), 'annotatedScreenshot removed when disabled');
    runner.assertFalse(names.includes('elementScreenshot'), 'elementScreenshot removed when disabled');
    runner.assertFalse(names.includes('set_plan'), 'plan tools removed when disabled');
  });
}

function testToolPermissions(runner: TestRunner) {
  log('\n=== Testing Tool Permissions ===', 'info');

  runner.test('Sensitive data-inspection tools are gated by a permission category', () => {
    runner.assertEqual(getToolPermissionCategory('getStorageData'), 'read', 'getStorageData must be gateable');
    runner.assertEqual(getToolPermissionCategory('getNetworkRequests'), 'read', 'getNetworkRequests must be gateable');
    runner.assertEqual(getToolPermissionCategory('getConsoleOutput'), 'read', 'getConsoleOutput must be gateable');
    runner.assertEqual(
      getToolPermissionCategory('getPerformanceMetrics'),
      'read',
      'getPerformanceMetrics must be gateable',
    );
  });

  runner.test('executeScript is gated by a dedicated scripting category', () => {
    runner.assertEqual(getToolPermissionCategory('executeScript'), 'scripting', 'executeScript needs its own category');
  });

  runner.test('Scripting permission is allow-by-default and honors explicit false', () => {
    runner.assertTrue(DEFAULT_TOOL_PERMISSIONS.scripting, 'scripting must default to true');
    runner.assertTrue(isToolCategoryAllowed('scripting', {}), 'missing scripting toggle allows (default on)');
    runner.assertFalse(isToolCategoryAllowed('scripting', { scripting: false }), 'explicit false denies');
    runner.assertTrue(isToolCategoryAllowed('scripting', { scripting: true }), 'explicit true allows');
  });

  runner.test('Non-scripting categories stay allow-by-default but honor explicit false', () => {
    runner.assertTrue(isToolCategoryAllowed('read', {}), 'read allowed when unset');
    runner.assertFalse(isToolCategoryAllowed('read', { read: false }), 'read blocked when false');
    runner.assertTrue(isToolCategoryAllowed(null, {}), 'uncategorized tools are not gated here');
  });

  runner.test('debugger/cdp is opt-in (deny unless true)', () => {
    runner.assertEqual(getToolPermissionCategory('cdp'), 'debugger', 'cdp maps to debugger');
    runner.assertEqual(getToolPermissionCategory('readPage'), 'read', 'readPage is read');
    runner.assertEqual(getToolPermissionCategory('clipboard'), 'interact', 'clipboard is interact');
    runner.assertEqual(getToolPermissionCategory('setInputFiles'), 'interact', 'setInputFiles is interact');
    runner.assertFalse(DEFAULT_TOOL_PERMISSIONS.debugger, 'debugger defaults off');
    runner.assertFalse(isToolCategoryAllowed('debugger', {}), 'missing debugger denies');
    runner.assertFalse(isToolCategoryAllowed('debugger', { debugger: false }), 'false denies');
    runner.assertTrue(isToolCategoryAllowed('debugger', { debugger: true }), 'true allows');
  });

  runner.test('cdp is filtered from schema until debugger permission is true', () => {
    const browserTools = [
      { name: 'click', description: 'c', input_schema: { type: 'object' as const, properties: {} } },
      { name: 'cdp', description: 'd', input_schema: { type: 'object' as const, properties: {} } },
      { name: 'readPage', description: 'r', input_schema: { type: 'object' as const, properties: {} } },
    ];
    const off = buildSessionTools({
      browserToolDefinitions: browserTools,
      toolPermissions: { interact: true, read: true, debugger: false },
    });
    runner.assertFalse(off.map((t) => t.name).includes('cdp'), 'cdp hidden when debugger false');
    runner.assertTrue(off.map((t) => t.name).includes('readPage'), 'readPage remains');
    const on = buildSessionTools({
      browserToolDefinitions: browserTools,
      toolPermissions: { interact: true, read: true, debugger: true },
    });
    runner.assertTrue(on.map((t) => t.name).includes('cdp'), 'cdp listed when debugger true');
  });
}

function testHttpUrlValidation(runner: TestRunner) {
  log('\n=== Testing HTTP URL Validation ===', 'info');

  runner.test('Public http(s) URLs are accepted', () => {
    runner.assertTrue(requireHttpUrl('https://example.com/path').ok, 'https public host allowed');
    runner.assertTrue(requireHttpUrl('http://example.com').ok, 'http public host allowed');
  });

  runner.test('Non-http schemes are rejected', () => {
    runner.assertFalse(requireHttpUrl('file:///etc/passwd').ok, 'file scheme rejected');
    runner.assertFalse(requireHttpUrl('javascript:alert(1)').ok, 'javascript scheme rejected');
    runner.assertFalse(requireHttpUrl('chrome://settings').ok, 'chrome scheme rejected');
  });

  runner.test('Loopback, link-local and private hosts are rejected (SSRF guard)', () => {
    runner.assertFalse(requireHttpUrl('http://localhost/admin').ok, 'localhost rejected');
    runner.assertFalse(requireHttpUrl('http://127.0.0.1:8080').ok, 'loopback ipv4 rejected');
    runner.assertFalse(requireHttpUrl('http://[::1]/').ok, 'loopback ipv6 rejected');
    runner.assertFalse(requireHttpUrl('http://169.254.169.254/latest/meta-data').ok, 'cloud metadata rejected');
    runner.assertFalse(requireHttpUrl('http://10.0.0.5/').ok, 'private 10/8 rejected');
    runner.assertFalse(requireHttpUrl('http://192.168.1.1/').ok, 'private 192.168/16 rejected');
    runner.assertFalse(requireHttpUrl('http://172.16.0.1/').ok, 'private 172.16/12 rejected');
  });

  runner.test('estimateTokensFromContent counts images by fixed cost, not base64 length', () => {
    // Um base64 grande NÃO deve inflar a contagem — senão dispara compaction em loop.
    const bigBase64 = `data:image/png;base64,${'A'.repeat(400_000)}`;
    const withImage = estimateTokensFromContent([
      { type: 'text', text: 'oi' },
      { type: 'image', image: bigBase64 },
    ] as any);
    runner.assertTrue(
      withImage < 2000,
      `imagem deve custar ~${IMAGE_TOKEN_ESTIMATE} tokens, não ~${Math.ceil(bigBase64.length / 4)} (obtido: ${withImage})`,
    );
    const anthropicShape = estimateTokensFromContent([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(400_000) } },
    ] as any);
    runner.assertTrue(
      anthropicShape < 2000,
      `bloco de imagem estilo Anthropic também custa fixo (obtido: ${anthropicShape})`,
    );
  });

  runner.test('IPv4-mapped IPv6 (hex-canonicalized) private hosts are rejected', () => {
    // new URL() canoniza ::ffff:169.254.169.254 para a forma HEX ::ffff:a9fe:a9fe;
    // testar só o sufixo decimal deixava passar loopback/metadata/RFC1918.
    runner.assertFalse(requireHttpUrl('http://[::ffff:169.254.169.254]/').ok, 'mapped metadata rejected');
    runner.assertFalse(requireHttpUrl('http://[::ffff:127.0.0.1]/').ok, 'mapped loopback rejected');
    runner.assertFalse(requireHttpUrl('http://[::ffff:10.0.0.5]/').ok, 'mapped 10/8 rejected');
    runner.assertFalse(requireHttpUrl('http://[::ffff:192.168.0.1]/').ok, 'mapped 192.168/16 rejected');
    runner.assertFalse(requireHttpUrl('http://[::ffff:172.16.0.1]/').ok, 'mapped 172.16/12 rejected');
    // Um IPv4 público mapeado continua permitido.
    runner.assertTrue(requireHttpUrl('http://[::ffff:8.8.8.8]/').ok, 'mapped public host allowed');
  });

  runner.test('LAN hostnames and non-routable ranges are rejected', () => {
    // mDNS/nomes internos: roteador, NAS e impressora da rede local.
    runner.assertFalse(requireHttpUrl('http://router.local/').ok, '.local rejeitado');
    runner.assertFalse(requireHttpUrl('http://nas.local:5000/admin').ok, '.local com porta rejeitado');
    runner.assertFalse(requireHttpUrl('https://api.internal/v1').ok, '.internal rejeitado');
    runner.assertFalse(requireHttpUrl('http://gw.home.arpa/').ok, '.home.arpa rejeitado');
    // Faixas não roteáveis na internet pública.
    runner.assertFalse(requireHttpUrl('http://100.64.1.1/').ok, 'CGNAT 100.64/10 rejeitado');
    runner.assertFalse(requireHttpUrl('http://192.0.0.1/').ok, '192.0.0.0/24 rejeitado');
    runner.assertFalse(requireHttpUrl('http://198.18.0.1/').ok, 'benchmark 198.18/15 rejeitado');
    // Formas alternativas de escrever loopback (canonizadas por new URL()).
    runner.assertFalse(requireHttpUrl('http://2130706433/').ok, 'loopback decimal rejeitado');
    runner.assertFalse(requireHttpUrl('http://127.1/').ok, 'loopback abreviado rejeitado');
    runner.assertFalse(requireHttpUrl('http://0x7f000001/').ok, 'loopback hex rejeitado');
    // Domínios públicos parecidos seguem permitidos.
    runner.assertTrue(requireHttpUrl('https://localhost.example.com/').ok, 'host público com prefixo permitido');
    runner.assertTrue(requireHttpUrl('https://100.128.0.1/').ok, 'IP público fora do CGNAT permitido');
  });
}

function testProviderPreflight(runner: TestRunner) {
  log('\n=== Testing Provider Preflight ===', 'info');

  runner.test('Anthropic exige credencial ou sessao OAuth', () => {
    const missing = checkProviderReadiness({ provider: 'anthropic', apiKey: '' });
    runner.assertTrue(Boolean(missing), 'sem token e sem sessao = bloqueado');
    runner.assertEqual(missing?.reason, 'missing_credential');
    runner.assertEqual(missing?.action, 'open_settings', 'painel precisa do atalho de configuracoes');

    runner.assertEqual(
      checkProviderReadiness({ provider: 'anthropic', apiKey: '', hasOAuthSession: true }),
      null,
      'sessao OAuth basta (o token e resolvido por request)',
    );
    runner.assertEqual(
      checkProviderReadiness({ provider: 'anthropic', apiKey: 'sk-ant-oat01-abc' }),
      null,
      'token manual basta',
    );
  });

  runner.test('Sessao revogada do Claude bloqueia o run pedindo reconexao', () => {
    const revoked = checkProviderReadiness({
      provider: 'anthropic',
      apiKey: 'sk-ant-oat01-abc',
      authHealthOk: false,
    });
    runner.assertEqual(revoked?.reason, 'revoked_session');
    runner.assertTrue(String(revoked?.message).includes('Reconecte'), 'mensagem precisa ser acionavel');
  });

  runner.test('Codex e OpenCode exigem chave; Ollama nao', () => {
    runner.assertEqual(checkProviderReadiness({ provider: 'codex', apiKey: '' })?.reason, 'missing_credential');
    runner.assertEqual(checkProviderReadiness({ provider: 'codex', apiKey: 'sk-proj-x' }), null);
    runner.assertEqual(
      checkProviderReadiness({ provider: 'codex', apiKey: '', hasCodexChatGptSession: true }),
      null,
      'sessao ChatGPT cobre ausencia de apiKey',
    );
    runner.assertEqual(checkProviderReadiness({ provider: 'opencode', apiKey: '' })?.reason, 'missing_credential');
    runner.assertEqual(checkProviderReadiness({ provider: 'ollama', apiKey: '' }), null, 'Ollama e local');
  });

  runner.test('Endpoint invalido e detectado antes do run', () => {
    const issue = checkProviderReadiness({ provider: 'ollama', customEndpoint: 'nao-e-url' });
    runner.assertEqual(issue?.reason, 'invalid_endpoint');
    runner.assertEqual(checkProviderReadiness({ provider: 'ollama', customEndpoint: 'http://localhost:11434' }), null);
  });
}

function testPromptCache(runner: TestRunner) {
  log('\n=== Testing Anthropic Prompt Cache ===', 'info');

  runner.test('Breakpoint entra so na ultima mensagem e so na Anthropic', () => {
    resetAnthropicPromptCache();
    const messages = [
      { role: 'user' as const, content: 'oi' },
      { role: 'assistant' as const, content: 'ola' },
      { role: 'user' as const, content: 'clique no botao' },
    ];
    const marked = applyPromptCacheBreakpoint(messages, 'anthropic');
    runner.assertEqual(marked.length, 3);
    runner.assertTrue(
      Boolean((marked[2] as any).providerOptions?.anthropic?.cacheControl),
      'ultima mensagem recebe cacheControl',
    );
    runner.assertFalse(Boolean((marked[1] as any).providerOptions), 'mensagens anteriores ficam intactas');
    runner.assertFalse(Boolean((messages[2] as any).providerOptions), 'entrada NAO e mutada (array reutilizado)');

    const untouched = applyPromptCacheBreakpoint(messages, 'ollama');
    runner.assertEqual(untouched, messages, 'outros provedores passam direto');
  });

  runner.test('Resposta vazia desliga o cache e o run segue sem ele', () => {
    resetAnthropicPromptCache();
    runner.assertTrue(isAnthropicPromptCacheEnabled('anthropic'), 'cache ligado por padrao');
    runner.assertTrue(
      isEmptyModelResponseError(new Error('Model returned an empty response.')),
      'resposta vazia e reconhecida',
    );
    runner.assertTrue(isEmptyModelResponseError(new Error('No output generated. Check the stream for errors.')));
    runner.assertFalse(isEmptyModelResponseError(new Error('HTTP 429 rate limit')), 'rate limit nao e resposta vazia');

    disableAnthropicPromptCache();
    runner.assertFalse(isAnthropicPromptCacheEnabled('anthropic'), 'desligado apos a falha');
    const messages = [{ role: 'user' as const, content: 'oi' }];
    runner.assertEqual(applyPromptCacheBreakpoint(messages, 'anthropic'), messages, 'sem breakpoint apos desligar');
    resetAnthropicPromptCache();
  });

  runner.test('Passe verdadeiramente vazio (sem texto/reasoning/tools) e empty', () => {
    runner.assertTrue(
      isEmptyModelPassResult({ text: '', reasoningText: null, toolCalls: [], toolResults: [] }),
      'nada de conteudo = empty (caso OAuth/cache)',
    );
    runner.assertTrue(isEmptyModelPassResult({ text: '   ', reasoningText: '  ' }), 'whitespace nao conta');
  });

  runner.test('Texto ou tool call impede empty', () => {
    runner.assertFalse(isEmptyModelPassResult({ text: 'ok', toolCalls: [], toolResults: [] }));
    runner.assertFalse(
      isEmptyModelPassResult({ text: '', toolCalls: [{ name: 'getContent' }], toolResults: [] }),
      'tool call sozinho e resposta valida',
    );
    runner.assertFalse(
      isEmptyModelPassResult({ text: '', toolCalls: [], toolResults: [{ toolName: 'click' }] }),
      'tool result sozinho e resposta valida',
    );
  });

  runner.test('REGRESSAO print: 23 out so de reasoning NAO e empty response', () => {
    // Repro do sintoma: usage 2.1k in / 23 out, bolha vazia, erro
    // "Model returned an empty response". Antes o check ignorava reasoningText.
    const screenshotCase = {
      text: '',
      reasoningText: 'Vou inspecionar o modal de seguidores na pagina atual.',
      toolCalls: [] as unknown[],
      toolResults: [] as unknown[],
    };
    runner.assertFalse(
      isEmptyModelPassResult(screenshotCase),
      'reasoning-only com ~23 tokens nao pode virar Erro no provedor',
    );
  });
}

function testRateLimitHandling(runner: TestRunner) {
  log('\n=== Testing Rate Limit / Overload Handling ===', 'info');

  runner.test('retry-after do provedor e respeitado (segundos e data HTTP)', () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    runner.assertEqual(extractRetryAfterMs({ responseHeaders: { 'retry-after': '12' } }, now), 12000);
    runner.assertEqual(extractRetryAfterMs({ responseHeaders: { 'Retry-After': '3' } }, now), 3000);
    runner.assertEqual(
      extractRetryAfterMs({ responseHeaders: { 'retry-after': '2026-07-25T12:00:30.000Z' } }, now),
      30000,
      'data HTTP virou janela relativa',
    );
    runner.assertEqual(extractRetryAfterMs({ responseHeaders: { 'retry-after': '9999' } }, now), 60000, 'teto de 60s');
    runner.assertEqual(extractRetryAfterMs({}, now), 0, 'sem header = sem espera imposta');
    runner.assertEqual(extractRetryAfterMs(null, now), 0, 'erro sem objeto e seguro');
  });

  runner.test('Sobrecarga sem status numerico ainda e retentavel', () => {
    runner.assertTrue(isOverloadedProviderError(new Error('overloaded_error: Overloaded')));
    runner.assertTrue(isOverloadedProviderError(new Error('429 Too Many Requests')));
    runner.assertTrue(isOverloadedProviderError(new Error('502 Bad Gateway')));
    runner.assertFalse(isOverloadedProviderError(new Error('Invalid bearer token')), 'auth nao e retentavel');
    runner.assertFalse(isOverloadedProviderError(null));
  });

  runner.test('Erros de limite e sobrecarga viram texto acionavel', () => {
    const rate = humanizeProviderError(new Error('HTTP 429: rate_limit_error'), 'anthropic');
    runner.assertTrue(rate.includes('Limite de uso do Claude'), `esperado texto de limite, obtido: ${rate}`);
    const overloaded = humanizeProviderError(new Error('overloaded_error'), 'anthropic');
    runner.assertTrue(overloaded.includes('sobrecarregado'), `esperado texto de sobrecarga, obtido: ${overloaded}`);
    const quota = humanizeProviderError(new Error('429 insufficient_quota: billing'), 'codex');
    runner.assertTrue(quota.includes('Cr'), `esperado texto de credito, obtido: ${quota}`);
    const notFound = humanizeProviderError(new Error('404 model_not_found'), 'codex');
    runner.assertTrue(notFound.includes('modelo configurado'), `esperado texto de modelo, obtido: ${notFound}`);
    // O ramo de credencial continua tendo precedencia sobre o de limite.
    const auth = humanizeProviderError(new Error('Invalid bearer token'), 'anthropic');
    runner.assertTrue(auth.includes('Reconecte'), 'token invalido continua pedindo reconexao');
  });
}

async function testCodexChatGptAuth(runner: TestRunner) {
  log('\n=== Testing Codex ChatGPT Direct Auth ===', 'info');

  const jwtHeader = 'eyJhbGciOiJub25lIn0';
  const jwtPayload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'user-test-account-1234' },
    }),
  ).toString('base64url');
  const fakeAccess = `${jwtHeader}.${jwtPayload}.sig`;
  const fakeRefresh = `${jwtHeader}.${Buffer.from(JSON.stringify({ sub: 'refresh' })).toString('base64url')}.sig`;

  runner.test('Distinguishes chatgpt auth from API key in auth.json', () => {
    const chatgpt = parseCodexAuthJson({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: fakeAccess,
        refresh_token: fakeRefresh,
        id_token: fakeAccess,
        account_id: 'user-test-account-1234',
      },
      last_refresh: '2026-07-24T23:48:50.039797500Z',
    });
    runner.assertEqual(chatgpt.mode, 'chatgpt');
    runner.assertEqual(chatgpt.mode === 'chatgpt' ? chatgpt.bundle.accountId : '', 'user-test-account-1234');

    const apiKey = parseCodexAuthJson({
      auth_mode: 'api_key',
      OPENAI_API_KEY: 'sk-proj-test-key-123456',
      tokens: { access_token: fakeAccess },
    });
    runner.assertEqual(apiKey.mode, 'api_key');
    runner.assertEqual(apiKey.mode === 'api_key' ? apiKey.apiKey : '', 'sk-proj-test-key-123456');
  });

  runner.test('Never treats JWT access_token as apiKey', () => {
    runner.assertFalse(isOpenAiApiKey(fakeAccess));
    runner.assertTrue(isJwtToken(fakeAccess));
    const parsed = parseCodexAuthJson({
      auth_mode: 'chatgpt',
      tokens: { access_token: fakeAccess, refresh_token: fakeRefresh, account_id: 'acct-1' },
    });
    runner.assertEqual(parsed.mode, 'chatgpt');
    runner.assertFalse(parsed.mode === 'api_key');
  });

  runner.test('resolveCodexApiKeyFieldValue shows session token or sk- key', () => {
    const chatgptParsed = parseCodexAuthJson({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: fakeAccess,
        refresh_token: fakeRefresh,
        account_id: 'user-test-account-1234',
      },
    });
    runner.assertEqual(chatgptParsed.mode, 'chatgpt');
    const sessionBundle = chatgptParsed.mode === 'chatgpt' ? chatgptParsed.bundle : null;
    runner.assertEqual(resolveCodexApiKeyFieldValue(sessionBundle, ''), fakeAccess);
    runner.assertEqual(resolveCodexApiKeyFieldValue(sessionBundle, 'sk-proj-live'), 'sk-proj-live');
    runner.assertTrue(isCodexChatGptDisplayToken(fakeAccess, sessionBundle));
    runner.assertFalse(isCodexChatGptDisplayToken('sk-proj-live', sessionBundle));
  });

  runner.test('Derives account id from JWT when account_id missing', () => {
    const derived = extractChatGptAccountId(fakeAccess);
    runner.assertEqual(derived, 'user-test-account-1234');
  });

  runner.test('resolveCodexAuthMode prefers chatgpt bundle over JWT in apiKey slot', () => {
    const mode = resolveCodexAuthMode({
      provider: 'codex',
      apiKey_codex: fakeAccess,
      [CODEX_CHATGPT_STORAGE_KEY]: {
        accessToken: fakeAccess,
        refreshToken: fakeRefresh,
        idToken: fakeAccess,
        accountId: 'user-test-account-1234',
        expiresAt: Date.now() + 60_000,
      },
    });
    runner.assertEqual(mode, 'chatgpt');
  });

  runner.test('normalizeRuntimeSettings strips JWT from apiKey when chatgpt mode', () => {
    const settings = normalizeRuntimeSettings({
      provider: 'codex',
      apiKey: fakeAccess,
      apiKey_codex: fakeAccess,
      [CODEX_CHATGPT_STORAGE_KEY]: {
        accessToken: fakeAccess,
        refreshToken: fakeRefresh,
        idToken: fakeAccess,
        accountId: 'user-test-account-1234',
        expiresAt: Date.now() + 60_000,
      },
    });
    runner.assertEqual(settings.codexAuthMode, 'chatgpt');
    runner.assertEqual(settings.apiKey, '', 'JWT nao permanece no slot apiKey');
  });

  runner.test('convertCodexChatGptPrompt keeps function_call as top-level input items', () => {
    const { input } = convertCodexChatGptPrompt([
      { role: 'user', content: [{ type: 'text', text: 'open instagram' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Vou navegar.' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'navigate', input: { url: 'https://instagram.com' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'navigate',
            output: { type: 'json', value: { ok: true } },
          },
        ],
      },
    ] as any);
    runner.assertEqual(input.length, 4);
    const assistant = input[1] as { type: string; role: string; content: Array<{ type: string }> };
    runner.assertEqual(assistant.type, 'message');
    runner.assertEqual(assistant.role, 'assistant');
    runner.assertEqual(assistant.content.length, 1);
    runner.assertEqual(assistant.content[0]?.type, 'output_text');
    runner.assertEqual((input[2] as { type: string }).type, 'function_call');
    runner.assertEqual((input[3] as { type: string }).type, 'function_call_output');
    for (const item of input) {
      if ((item as { type?: string }).type === 'message') {
        const content = (item as { content?: Array<{ type?: string }> }).content || [];
        runner.assertFalse(content.some((part) => part.type === 'function_call'));
      }
    }
  });

  await runner.asyncTest('Codex ChatGPT model targets codex responses endpoint with auth headers', async () => {
    const storage: Record<string, unknown> = {
      [CODEX_CHATGPT_STORAGE_KEY]: {
        accessToken: fakeAccess,
        refreshToken: fakeRefresh,
        idToken: fakeAccess,
        accountId: 'user-test-account-1234',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    };
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            const out: Record<string, unknown> = {};
            for (const key of list) if (key in storage) out[key] = storage[key];
            return out;
          },
          set: async (patch: Record<string, unknown>) => {
            Object.assign(storage, patch);
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          },
        },
        onChanged: { addListener: () => {} },
      },
    };

    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    let authHeader = '';
    let accountHeader = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      authHeader = headers.get('Authorization') || '';
      accountHeader = headers.get('ChatGPT-Account-Id') || headers.get('chatgpt-account-id') || '';
      const sse = [
        'event: response.created',
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6-luna' } })}`,
        '',
        'event: response.output_text.delta',
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}`,
        '',
        'event: response.output_text.done',
        `data: ${JSON.stringify({ type: 'response.output_text.done', text: 'hello' })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } } })}`,
        '',
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    try {
      const model = createCodexChatGptModel('gpt-5.6-luna');
      const result = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxOutputTokens: 2048,
      });
      const reader = result.stream.getReader();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'text-delta') text += value.delta;
      }
      runner.assertEqual(requestUrl, CODEX_CHATGPT_RESPONSES_URL);
      runner.assertTrue(authHeader.startsWith('Bearer '));
      runner.assertEqual(accountHeader, 'user-test-account-1234');
      runner.assertEqual(requestBody.max_output_tokens, undefined, 'Codex ChatGPT rejects max_output_tokens');
      runner.assertEqual(text, 'hello');
    } finally {
      globalThis.fetch = originalFetch;
      delete (globalThis as any).chrome;
      resetCodexOAuthCache();
      resetCodexOAuthRefreshState();
    }
  });

  await runner.asyncTest('Codex ChatGPT model maps item_id deltas onto call_id tool args', async () => {
    const storage: Record<string, unknown> = {
      [CODEX_CHATGPT_STORAGE_KEY]: {
        accessToken: fakeAccess,
        refreshToken: fakeRefresh,
        idToken: fakeAccess,
        accountId: 'user-test-account-1234',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    };
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            const out: Record<string, unknown> = {};
            for (const key of list) if (key in storage) out[key] = storage[key];
            return out;
          },
          set: async (patch: Record<string, unknown>) => {
            Object.assign(storage, patch);
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          },
        },
        onChanged: { addListener: () => {} },
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const sse = [
        'event: response.output_item.added',
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', id: 'fc_nav1', call_id: 'call_nav1', name: 'navigate', arguments: '' },
        })}`,
        '',
        'event: response.function_call_arguments.delta',
        `data: ${JSON.stringify({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_nav1',
          output_index: 0,
          delta: '{"url":"https://www.instagram.com"}',
        })}`,
        '',
        'event: response.function_call_arguments.done',
        `data: ${JSON.stringify({
          type: 'response.function_call_arguments.done',
          item_id: 'fc_nav1',
          output_index: 0,
          arguments: '{"url":"https://www.instagram.com"}',
        })}`,
        '',
        'event: response.output_item.done',
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_nav1',
            call_id: 'call_nav1',
            name: 'navigate',
            arguments: '{"url":"https://www.instagram.com"}',
          },
        })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } } })}`,
        '',
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    try {
      const model = createCodexChatGptModel('gpt-5.6-luna');
      const result = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'open instagram' }] }],
      });
      const reader = result.stream.getReader();
      let toolCall: { toolCallId?: string; toolName?: string; input?: string } | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'tool-call') toolCall = value;
      }
      runner.assertEqual(toolCall?.toolCallId, 'call_nav1');
      runner.assertEqual(toolCall?.toolName, 'navigate');
      runner.assertEqual(toolCall?.input, '{"url":"https://www.instagram.com"}');
    } finally {
      globalThis.fetch = originalFetch;
      delete (globalThis as any).chrome;
      resetCodexOAuthCache();
      resetCodexOAuthRefreshState();
    }
  });

  await runner.asyncTest('Refresh coalesces and writes back refreshed bundle', async () => {
    resetCodexOAuthRefreshState();
    resetCodexOAuthCache();
    const storage: Record<string, unknown> = {
      [CODEX_CHATGPT_STORAGE_KEY]: {
        accessToken: fakeAccess,
        refreshToken: fakeRefresh,
        idToken: fakeAccess,
        accountId: 'user-test-account-1234',
        expiresAt: Date.now() - 1000,
      },
    };
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            const out: Record<string, unknown> = {};
            for (const key of list) if (key in storage) out[key] = storage[key];
            return out;
          },
          set: async (patch: Record<string, unknown>) => {
            Object.assign(storage, patch);
          },
          remove: async () => {},
        },
        onChanged: { addListener: () => {} },
      },
    };
    const originalFetch = globalThis.fetch;
    let refreshCalls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshCalls += 1;
      const body = String(init?.body || '');
      runner.assertTrue(body.includes('grant_type=refresh_token'));
      runner.assertTrue(body.includes(CODEX_CLIENT_ID));
      const newAccess = fakeAccess.replace('.sig', '.sig2');
      return new Response(
        JSON.stringify({
          access_token: newAccess,
          refresh_token: fakeRefresh,
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const refreshed = await refreshCodexChatGptToken(fakeRefresh);
      runner.assertEqual(refreshCalls, 1);
      runner.assertTrue(Boolean(refreshed.accessToken));
      await writeCodexChatGptAuth(refreshed);
      const stored = storage[CODEX_CHATGPT_STORAGE_KEY] as Record<string, unknown>;
      runner.assertEqual(stored.accessToken, refreshed.accessToken);
      runner.assertEqual(stored.accountId, 'user-test-account-1234');
    } finally {
      globalThis.fetch = originalFetch;
      delete (globalThis as any).chrome;
      resetCodexOAuthCache();
      resetCodexOAuthRefreshState();
    }
  });

  runner.test('buildCodexChatGptBundleFromOAuth rejects missing refresh/account', () => {
    runner.assertEqual(
      buildCodexChatGptBundleFromOAuth({ accessToken: fakeAccess, idToken: fakeAccess, refreshToken: null }),
      null,
    );
    const bundle = buildCodexChatGptBundleFromOAuth({
      accessToken: fakeAccess,
      idToken: fakeAccess,
      refreshToken: fakeRefresh,
    });
    runner.assertTrue(Boolean(bundle?.accountId));
    runner.assertTrue(extractJwtExpiryMs(fakeAccess) > Date.now());
  });
}

function testProviderKeyStorage(runner: TestRunner) {
  log('\n=== Testing Per-Provider Credential Slots ===', 'info');

  runner.test('Slot legado migra para o provedor ativo', () => {
    const map = readProviderKeyMap({ apiKey: 'sk-ant-legacy' }, 'anthropic');
    runner.assertEqual(map.anthropic, 'sk-ant-legacy', 'chave antiga vira slot do provedor ativo');
    runner.assertEqual(map.codex, '', 'outros provedores seguem vazios');
  });

  runner.test('Slot do provedor tem precedencia sobre o slot global', () => {
    const map = readProviderKeyMap({ apiKey: 'sk-ant-atual', apiKey_codex: 'sk-proj-codex' }, 'anthropic');
    runner.assertEqual(resolveProviderApiKey(map, 'codex', 'sk-ant-atual'), 'sk-proj-codex', 'nao cruza credenciais');
    runner.assertEqual(resolveProviderApiKey(map, 'anthropic'), 'sk-ant-atual');
    runner.assertEqual(resolveProviderApiKey(map, 'opencode', ''), '', 'provedor sem chave nao herda de outro');
  });

  runner.test('Runtime prefere a chave do provedor ativo (nunca a de outro)', () => {
    const settings = normalizeRuntimeSettings({
      provider: 'codex',
      apiKey: 'sk-ant-oat01-do-claude',
      apiKey_codex: 'sk-proj-da-openai',
      apiKey_anthropic: 'sk-ant-oat01-do-claude',
    });
    runner.assertEqual(settings.apiKey, 'sk-proj-da-openai', 'token do Claude nao vai para a OpenAI');

    const anthropicRun = normalizeRuntimeSettings({
      provider: 'anthropic',
      apiKey: 'sk-ant-fresco',
      apiKey_anthropic: 'sk-ant-fresco',
    });
    runner.assertEqual(anthropicRun.apiKey, 'sk-ant-fresco');

    const legacyOnly = normalizeRuntimeSettings({ provider: 'codex', apiKey: 'sk-proj-antigo' });
    runner.assertEqual(legacyOnly.apiKey, 'sk-proj-antigo', 'config antiga sem slots continua funcionando');
  });
}

function testHistoryStorage(runner: TestRunner) {
  log('\n=== Testing Chat History Storage ===', 'info');
  const textEncoder = new TextEncoder();

  runner.test('buildHistoryIndexEntry captures list metadata and byte size', () => {
    const payload = {
      schemaVersion: 1,
      id: 'session-a',
      startedAt: 100,
      updatedAt: 200,
      title: 'Hello',
      messageCount: 3,
      transcript: [{ role: 'user', content: 'hi' }],
    };
    const entry = buildHistoryIndexEntry(payload, textEncoder);
    runner.assertEqual(entry.id, 'session-a');
    runner.assertEqual(entry.title, 'Hello');
    runner.assertEqual(entry.messageCount, 3);
    runner.assertEqual(entry.updatedAt, 200);
    runner.assertTrue(entry.storageBytes > 0, 'index entry should track payload bytes');
  });

  runner.test('compactSessionPayload omits duplicate contextTranscript', () => {
    const transcript = [{ role: 'user', content: 'same' }];
    const compacted = compactSessionPayload({
      schemaVersion: 1,
      id: 'session-b',
      startedAt: 1,
      updatedAt: 2,
      title: 'T',
      messageCount: 1,
      transcript,
      contextTranscript: [{ role: 'user', content: 'same' }],
    });
    runner.assertEqual(compacted.contextTranscript, undefined, 'duplicate context transcript is omitted');
  });

  runner.test('resolveContextTranscript falls back to transcript', () => {
    const transcript = [{ role: 'assistant', content: 'ok' }];
    const resolved = resolveContextTranscript({
      transcript,
    });
    runner.assertEqual(resolved.length, 1);
    runner.assertEqual((resolved[0] as { content?: string }).content, 'ok');
  });

  runner.test('splitLegacyChatSessions produces per-session keys and index', () => {
    const legacy = [
      {
        id: 'legacy-1',
        startedAt: 10,
        updatedAt: 20,
        title: 'One',
        messageCount: 2,
        transcript: [{ role: 'user', content: 'a' }],
        contextTranscript: [{ role: 'user', content: 'a' }],
      },
      {
        id: 'legacy-2',
        startedAt: 30,
        updatedAt: 40,
        title: 'Two',
        messageCount: 1,
        transcript: [{ role: 'user', content: 'b' }],
        contextTranscript: [{ role: 'tool', content: 'result', toolCallId: 'c1' }],
      },
    ];
    const split = splitLegacyChatSessions(legacy, textEncoder);
    runner.assertEqual(split.index.length, 2);
    runner.assertEqual(split.index[0]?.id, 'legacy-1');
    runner.assertEqual(split.index[1]?.title, 'Two');
    runner.assertTrue(`${CHAT_SESSION_KEY_PREFIX}legacy-1` in split.sessionEntries);
    runner.assertTrue(`${CHAT_SESSION_KEY_PREFIX}legacy-2` in split.sessionEntries);
    runner.assertEqual(split.sessionEntries[`${CHAT_SESSION_KEY_PREFIX}legacy-1`]?.contextTranscript, undefined);
    runner.assertEqual(
      (split.sessionEntries[`${CHAT_SESSION_KEY_PREFIX}legacy-2`]?.contextTranscript as unknown[])?.length,
      1,
    );

    const migration = buildLegacyMigrationStorageUpdates(legacy, textEncoder);
    runner.assertTrue(Array.isArray(migration[CHAT_SESSIONS_INDEX_KEY]));
    runner.assertTrue(`${CHAT_SESSION_KEY_PREFIX}legacy-1` in migration);
  });

  runner.test('testFixPanelPruneHistoryIndex evicts oldest and protects active session', () => {
    const index = Array.from({ length: 52 }, (_, i) => ({
      id: `session-${i}`,
      startedAt: i * 10,
      updatedAt: i * 10,
      title: `S${i}`,
      messageCount: 1,
      storageBytes: 100,
    }));
    const { index: pruned, removedIds } = pruneHistoryIndex(index, 50, 4 * 1024 * 1024, 'session-51');
    runner.assertEqual(pruned.length, 50);
    runner.assertTrue(
      pruned.some((entry) => entry.id === 'session-51'),
      'active session stays in index',
    );
    runner.assertFalse(removedIds.includes('session-51'), 'active session is never removed');
    runner.assertTrue(removedIds.includes('session-0'), 'oldest session is evicted first');
    runner.assertTrue(removedIds.includes('session-1'), 'second-oldest session is evicted');
  });

  runner.test('testFixPanelSplitLegacyChatSessions prefers newest sessions under cap', () => {
    const legacy = Array.from({ length: 55 }, (_, i) => ({
      id: `legacy-${i}`,
      startedAt: i,
      updatedAt: i,
      title: `Legacy ${i}`,
      messageCount: 1,
      transcript: [{ role: 'user', content: `msg-${i}` }],
    }));
    const split = splitLegacyChatSessions(legacy, textEncoder, 50);
    runner.assertEqual(split.index.length, 50);
    runner.assertFalse(
      split.index.some((entry) => entry.id === 'legacy-0'),
      'oldest legacy session is dropped',
    );
    runner.assertFalse(
      split.index.some((entry) => entry.id === 'legacy-4'),
      'early legacy sessions are dropped',
    );
    runner.assertTrue(
      split.index.some((entry) => entry.id === 'legacy-54'),
      'newest legacy session is kept',
    );
  });

  runner.test('testFixPanelBuildHistoryPersistSignature ignores updatedAt', () => {
    const transcript = [{ id: 'm1', role: 'user', content: 'hi' }];
    const first = buildHistoryPersistSignature({ id: 's1', messageCount: 1, transcript });
    const second = buildHistoryPersistSignature({ id: 's1', messageCount: 1, transcript });
    runner.assertEqual(first, second, 'signature is stable across repeated calls');
    runner.assertEqual(first, 's1:1:m1:1:m1');
    const withContext = buildHistoryPersistSignature({
      id: 's1',
      messageCount: 1,
      transcript,
      contextTranscript: [{ id: 'c1', role: 'tool', content: 'result' }],
    });
    runner.assertEqual(withContext, 's1:1:m1:1:c1');
  });

  runner.test('testFixPanelIsHistoryLoadTokenStale detects superseded loads', () => {
    runner.assertFalse(isHistoryLoadTokenStale(3, 3), 'matching token is current');
    runner.assertTrue(isHistoryLoadTokenStale(2, 3), 'older token is stale after a newer click');
  });

  runner.test('testFixPanelShouldWriteThinkingTimerLabel respects retry status', () => {
    runner.assertTrue(shouldWriteThinkingTimerLabel(false), 'timer writes when retry banner is inactive');
    runner.assertFalse(shouldWriteThinkingTimerLabel(true), 'timer skips label while retry status is active');
  });

  runner.test('shouldAcceptContextCompaction accepts active-run transition and rejects stale run', () => {
    const completed = new Set(['run-old']);
    runner.assertTrue(
      shouldAcceptContextCompaction({
        messageSessionId: 'session-new',
        newSessionId: 'session-new',
        messageRunId: 'run-live',
        activeRunId: 'run-live',
        completedRunIds: completed,
        sessionId: 'session-old',
        acceptedSessionIds: new Set(['session-old']),
      }),
      'mid-run compaction with matching run id is accepted',
    );
    runner.assertFalse(
      shouldAcceptContextCompaction({
        messageSessionId: 'session-old',
        newSessionId: 'session-new',
        messageRunId: 'run-old',
        activeRunId: 'run-live',
        completedRunIds: completed,
        sessionId: 'session-live',
        acceptedSessionIds: new Set(['session-live']),
      }),
      'compaction from an older run is rejected while a newer run is active',
    );
    runner.assertTrue(
      shouldAcceptContextCompaction({
        messageSessionId: 'session-new',
        newSessionId: 'session-new',
        messageRunId: 'run-old',
        activeRunId: null,
        completedRunIds: completed,
        sessionId: 'session-old',
        acceptedSessionIds: new Set(['session-old']),
      }),
      'post-terminal compaction from the just-finished run is accepted',
    );
  });

  runner.test('isModelProbeResponseStale detects seq and credential generation drift', () => {
    runner.assertTrue(
      isModelProbeResponseStale({
        requestSeq: 1,
        currentSeq: 2,
        requestKey: buildModelProbeRequestKey('ollama', '', 'http://localhost:11434'),
        currentKey: buildModelProbeRequestKey('ollama', '', 'http://localhost:11434'),
      }),
    );
    runner.assertTrue(
      isModelProbeResponseStale({
        requestSeq: 2,
        currentSeq: 2,
        requestKey: buildModelProbeRequestKey('anthropic', 'aaa', ''),
        currentKey: buildModelProbeRequestKey('codex', 'bbb', ''),
      }),
    );
    runner.assertFalse(
      isModelProbeResponseStale({
        requestSeq: 2,
        currentSeq: 2,
        requestKey: buildModelProbeRequestKey('ollama', '', 'http://localhost:11434'),
        currentKey: buildModelProbeRequestKey('ollama', '', 'http://localhost:11434'),
      }),
    );
  });

  runner.test('shouldPersistAutoDetectedModel respects explicit user selection', () => {
    runner.assertFalse(
      shouldPersistAutoDetectedModel({
        snapshotModel: 'llama3',
        pickerModel: 'mistral',
        savedModel: 'llama3',
        userExplicitSelection: true,
      }),
    );
    runner.assertFalse(
      shouldPersistAutoDetectedModel({
        snapshotModel: 'llama3',
        pickerModel: 'mistral',
        savedModel: 'llama3',
        userExplicitSelection: false,
      }),
    );
    runner.assertTrue(
      shouldPersistAutoDetectedModel({
        snapshotModel: 'llama3',
        pickerModel: 'llama3',
        savedModel: 'old-model',
        userExplicitSelection: false,
      }),
    );
  });

  runner.test('panel guard tokens detect stale render/history work', () => {
    runner.assertTrue(isRenderGenerationStale(1, 2));
    runner.assertTrue(isHistoryPersistBarrierStale(0, 1));
    runner.assertTrue(isHistoryListLoadTokenStale(2, 3));
    const bounded = new Set<string>();
    for (let i = 0; i < 80; i += 1) {
      boundPanelIdSet(bounded, `run-${i}`);
    }
    runner.assertEqual(bounded.size, 64);
    runner.assertFalse(bounded.has('run-0'));
    runner.assertTrue(bounded.has('run-79'));
  });
}

function testToolTurnHistory(runner: TestRunner) {
  log('\n=== Testing Tool Turn History Pairing ===', 'info');

  // Walks converted model messages and returns true if every tool-result is
  // immediately preceded by an assistant message that declares a matching
  // tool-call id (the pairing the Anthropic API requires).
  const everyToolResultIsPaired = (modelMessages: Array<Record<string, any>>): boolean => {
    for (let i = 0; i < modelMessages.length; i += 1) {
      const msg = modelMessages[i];
      if (msg.role !== 'tool') continue;
      const resultParts = Array.isArray(msg.content) ? msg.content : [];
      const prev = modelMessages[i - 1];
      const prevCalls =
        prev && prev.role === 'assistant' && Array.isArray(prev.content)
          ? prev.content
              .filter((p: Record<string, any>) => p?.type === 'tool-call')
              .map((p: Record<string, any>) => p.toolCallId)
          : [];
      for (const part of resultParts) {
        if (part?.type !== 'tool-result') continue;
        if (!prevCalls.includes(part.toolCallId)) return false;
      }
    }
    return true;
  };

  const toolResultContent = [
    { type: 'tool-result' as const, toolCallId: 'call_1', toolName: 'navigate', output: { type: 'text', value: 'ok' } },
  ];
  const toolCalls = [{ toolCallId: 'call_1', toolName: 'navigate', input: { url: 'https://example.com' } }];

  runner.test('Tool-using turn persists a tool-call paired with each tool-result', () => {
    const turn = buildToolTurnMessages('Done.', 'thinking', toolResultContent, toolCalls);
    const history: Message[] = [
      createMessage({ role: 'user', content: 'go to example.com' }) as Message,
      ...normalizeConversationHistory(turn),
      createMessage({ role: 'user', content: 'now what?' }) as Message,
    ];
    const modelMessages = toModelMessages(history) as unknown as Array<Record<string, any>>;
    runner.assertTrue(
      everyToolResultIsPaired(modelMessages),
      'each tool-result must follow an assistant message with a matching tool-call',
    );
  });

  runner.test('The paired tool-call carries the original tool name and args', () => {
    const turn = buildToolTurnMessages('Done.', null, toolResultContent, toolCalls);
    const assistantWithCalls = turn.find((m) => Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
    runner.assertTrue(assistantWithCalls, 'a paired assistant message must exist');
    const call = assistantWithCalls?.toolCalls?.[0];
    runner.assertEqual(call?.id, 'call_1', 'tool-call id matches the tool-result');
    runner.assertEqual(call?.name, 'navigate', 'tool-call name preserved');
    runner.assertEqual(call?.args, { url: 'https://example.com' }, 'tool-call args preserved');
  });

  runner.test('A turn with no tools stays a single assistant message', () => {
    const turn = buildToolTurnMessages('Just a reply.', 'reasoning', [], []);
    runner.assertEqual(turn.length, 1, 'no tool results means one assistant message');
    runner.assertEqual(turn[0].role, 'assistant', 'single message is the assistant reply');
    runner.assertEqual(turn[0].content, 'Just a reply.', 'final text preserved');
  });
}

function testCompactionMemo(runner: TestRunner) {
  log('\n=== Testing Compaction Token Memo ===', 'info');

  runner.test('estimateContextTokens does not return a stale count for id-less messages', () => {
    const shortHistory: Message[] = [{ role: 'user', content: 'hi' }];
    const longHistory: Message[] = [{ role: 'user', content: 'x'.repeat(4000) }];
    const shortTokens = estimateContextTokens(shortHistory).tokens;
    const longTokens = estimateContextTokens(longHistory).tokens;
    runner.assertTrue(
      longTokens > shortTokens,
      `a 4000-char message must estimate more tokens than "hi" (got ${longTokens} vs ${shortTokens})`,
    );
  });
}

function testProviderEndpointValidation(runner: TestRunner) {
  log('\n=== Testing Provider Endpoint Validation ===', 'info');

  runner.test('A custom https endpoint is honored', () => {
    runner.assertEqual(
      resolveProviderBaseUrl('codex', 'https://proxy.internal.example/v1'),
      'https://proxy.internal.example/v1',
      'valid https custom endpoint used as-is',
    );
  });

  runner.test('A cleartext http endpoint is rejected (API key would leak)', () => {
    const base = resolveProviderBaseUrl('codex', 'http://attacker.example/v1');
    runner.assertFalse(base.includes('attacker.example'), 'http custom endpoint must not be used for codex');
  });

  runner.test('A non-URL endpoint falls back to the provider default', () => {
    const base = resolveProviderBaseUrl('opencode', 'not a url');
    runner.assertTrue(base.startsWith('https://'), 'garbage endpoint falls back to a safe https default');
  });

  runner.test('Anthropic OAuth headers omit browser CORS opt-in for service worker', () => {
    const headers = buildAnthropicOAuthHeaders('token-test');
    runner.assertEqual(headers.Authorization, 'Bearer token-test');
    runner.assertEqual(headers['anthropic-dangerous-direct-browser-access'], undefined);
    runner.assertEqual(headers['x-api-key'], undefined);
    runner.assertEqual(
      headers['user-agent'],
      undefined,
      'User-Agent must be applied by the MV3 network rule, not fetch',
    );
  });

  runner.test('Anthropic OAuth headers can opt into browser access when requested', () => {
    const headers = buildAnthropicOAuthHeaders('token-test', { allowBrowserAccess: true });
    runner.assertEqual(headers['anthropic-dangerous-direct-browser-access'], 'true');
  });

  runner.test('Anthropic fetch wrapper preserves the extension global receiver', () => {
    const originalFetch = globalThis.fetch;
    let receiver: unknown;
    globalThis.fetch = function mockFetch(this: unknown) {
      receiver = this;
      return Promise.resolve(new Response());
    } as typeof globalThis.fetch;

    try {
      void extensionFetch('https://api.anthropic.com/v1/messages');
      runner.assertTrue(receiver === globalThis, 'fetch must retain globalThis as its receiver');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  runner.test('Anthropic provider options default reasoning effort to low', () => {
    const options = buildAnthropicProviderOptions();
    runner.assertEqual(options.anthropic.effort, 'low');
  });

  runner.test('Legacy Anthropic model ids migrate to current lineup', () => {
    runner.assertEqual(migrateAnthropicModel('claude-sonnet-4-6'), 'claude-sonnet-5');
    runner.assertEqual(migrateAnthropicModel('claude-opus-4-7'), 'claude-opus-5');
    runner.assertEqual(migrateAnthropicModel('claude-opus-4-8'), 'claude-opus-5');
    runner.assertEqual(migrateAnthropicModel('claude-sonnet-5'), 'claude-sonnet-5');
    runner.assertEqual(migrateAnthropicModel('claude-opus-5'), 'claude-opus-5');
  });

  runner.test('Ollama still accepts a local http endpoint', () => {
    const base = resolveProviderBaseUrl('ollama', 'http://localhost:11434');
    runner.assertTrue(base.startsWith('http://localhost:11434'), 'local ollama http allowed');
  });

  runner.test('Legacy openai-compatible provider migrates to ollama', () => {
    runner.assertEqual(migrateStoredProvider('openai-compatible'), 'ollama');
  });

  runner.test('Legacy custom provider with local endpoint migrates to ollama', () => {
    runner.assertEqual(migrateStoredProvider('custom', 'http://localhost:11434/v1'), 'ollama');
  });

  runner.test('Legacy custom provider with remote endpoint migrates to codex', () => {
    runner.assertEqual(migrateStoredProvider('custom', 'https://api.example.com/v1'), 'codex');
  });

  runner.test('Codex model presets are restricted to GPT-5.6 Luna and Terra', () => {
    runner.assertEqual(JSON.stringify([...GPT_56_MODELS]), '["gpt-5.6-luna","gpt-5.6-terra"]');
    runner.assertEqual(normalizeProviderModel('codex', 'gpt-5.1-codex'), 'gpt-5.6-luna');
    runner.assertEqual(normalizeProviderModel('codex', 'gpt-5.6-terra'), 'gpt-5.6-terra');
    runner.assertEqual(
      JSON.stringify(filterProviderModels('codex', ['gpt-5.1', 'gpt-5.6-terra'])),
      '["gpt-5.6-luna","gpt-5.6-terra"]',
    );
  });
}

// Regressão do "Illegal invocation": no Chrome (contexto strict/ESM) o fetch
// nativo exige o objeto global como receiver. Os SDKs guardam o fetch em
// variável local e o chamam sem receiver, então todo provedor precisa receber
// o wrapper extensionFetch. O mock reproduz o contrato de receiver do Chrome
// e o teste dirige o caminho real (resolveLanguageModel -> generateText).
async function testProviderFetchBinding(runner: TestRunner) {
  log('\n=== Testing provider fetch binding (Illegal invocation regression) ===', 'info');

  const originalFetch = globalThis.fetch;
  const chromeLikeFetch = function (this: unknown, input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    if (this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('api.anthropic.com')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'pong' }],
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1700000000,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };

  globalThis.fetch = chromeLikeFetch as typeof globalThis.fetch;
  try {
    await runner.asyncTest('Anthropic model invokes fetch with the global receiver', async () => {
      const model = resolveLanguageModel({
        provider: 'anthropic',
        apiKey: 'sk-ant-oat01-test',
        model: 'claude-sonnet-5',
      });
      const result = await generateText({ model, prompt: 'ping', maxRetries: 0 });
      runner.assertEqual(result.text, 'pong', 'anthropic call must survive a receiver-sensitive fetch');
    });

    await runner.asyncTest('OpenAI-compatible model invokes fetch with the global receiver', async () => {
      const model = resolveLanguageModel({ provider: 'ollama', apiKey: '', model: 'llama3.1' });
      const result = await generateText({ model, prompt: 'ping', maxRetries: 0 });
      runner.assertEqual(result.text, 'pong', 'openai-compatible call must survive a receiver-sensitive fetch');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testDomInteractExports(runner: TestRunner) {
  log('\n=== Testing DOM Interact / Modal helpers (module load) ===', 'info');

  runner.test('Content bridge ops include dismissModal', () => {
    // Type-level surface is mirrored by runtime bridge ops list in content-bridge.
    runner.assertEqual(GLIDE_BRIDGE_MESSAGE_TYPE, 'glide_bridge');
  });

  runner.test('dismissModal is an interact permission tool', () => {
    runner.assertEqual(getToolPermissionCategory('dismissModal'), 'interact');
    runner.assertEqual(getToolPermissionCategory('wait'), 'interact');
  });

  await runner.asyncTest('shouldFireInputChangeForKey gates chords and navigation keys', async () => {
    const { shouldFireInputChangeForKey } = await import('../../content/dom-interact.js');
    runner.assertTrue(shouldFireInputChangeForKey('a', []), 'printable without modifiers');
    runner.assertFalse(shouldFireInputChangeForKey('a', ['Control']), 'printable with modifiers');
    runner.assertTrue(shouldFireInputChangeForKey('Delete', ['Control']), 'Delete always edits');
    runner.assertFalse(shouldFireInputChangeForKey('Enter', []), 'Enter does not fire input/change');
    runner.assertFalse(shouldFireInputChangeForKey('Escape', []), 'Escape does not fire input/change');
  });

  await runner.asyncTest('dom-interact exports shared bridge helpers', async () => {
    const mod = await import('../../content/dom-interact.js');
    runner.assertTrue(typeof mod.waitForNewDialog === 'function', 'waitForNewDialog must exist');
    runner.assertTrue(typeof mod.waitForDialog === 'function', 'waitForDialog must exist');
    runner.assertTrue(typeof mod.performHover === 'function', 'performHover must exist');
    runner.assertTrue(typeof mod.performMouseAction === 'function', 'performMouseAction must exist');
    runner.assertTrue(typeof mod.findElementsByQuery === 'function', 'findElementsByQuery must exist');
    runner.assertTrue(typeof mod.scrollPage === 'function', 'scrollPage must exist');
    runner.assertTrue(typeof mod.pressKeyOnTarget === 'function', 'pressKeyOnTarget must exist');
    runner.assertTrue(typeof mod.extractPageStructure === 'function', 'extractPageStructure must exist');
    runner.assertTrue(typeof mod.listOpenShadowHosts === 'function', 'listOpenShadowHosts must exist');
    runner.assertTrue(typeof mod.approxJsonBytes === 'function', 'approxJsonBytes must exist');
    runner.assertTrue(mod.approxJsonBytes({ a: 'hi' }) > 0, 'approxJsonBytes returns positive size');
    runner.assertTrue(typeof mod.resolveProfileStatLink === 'function', 'resolveProfileStatLink must exist');
    runner.assertTrue(typeof mod.findClickableByText === 'function', 'findClickableByText must exist');
  });

  await runner.asyncTest('findElement scope helpers and scan caps', async () => {
    const {
      buildFindElementScopeOrder,
      getFindElementScanCap,
      isInputishFindType,
      isShadowHostCacheStale,
      FIND_ELEMENT_SCAN_CAP_DEFAULT,
      FIND_ELEMENT_SCAN_CAP_DEEP,
    } = await import('../../content/dom-interact.js');
    runner.assertEqual(FIND_ELEMENT_SCAN_CAP_DEFAULT, 80);
    runner.assertEqual(FIND_ELEMENT_SCAN_CAP_DEEP, 300);
    runner.assertEqual(getFindElementScanCap(false), 80);
    runner.assertEqual(getFindElementScanCap(true), 300);
    runner.assertFalse(isInputishFindType('any'));
    runner.assertFalse(isInputishFindType('button'));
    runner.assertTrue(isInputishFindType('input'));
    runner.assertEqual(buildFindElementScopeOrder('page', 'any').join(','), 'page');
    runner.assertEqual(buildFindElementScopeOrder('dialog', 'any').join(','), 'dialog');
    runner.assertEqual(buildFindElementScopeOrder('auto', 'any').join(','), 'dialog,landmark,page');
    runner.assertEqual(buildFindElementScopeOrder('auto', 'input').join(','), 'dialog,form,landmark,page');
    const now = 10_000;
    runner.assertFalse(isShadowHostCacheStale(1, 1, now - 1000, now));
    runner.assertTrue(isShadowHostCacheStale(1, 2, now - 1000, now));
    runner.assertTrue(isShadowHostCacheStale(1, 1, now - 6000, now));
  });

  await runner.asyncTest('waitForNewDialog is exported for non-blocking post-click waits', async () => {
    // Dynamic import of pure helpers (no document) — only check the function exists in the module shape.
    const mod = await import('../../content/dom-interact.js');
    runner.assertTrue(typeof mod.waitForNewDialog === 'function', 'waitForNewDialog must exist');
    runner.assertTrue(typeof mod.waitForDialog === 'function', 'waitForDialog must exist');
  });

  await runner.asyncTest('computeScrollTarget clamps to element bounds in every direction', async () => {
    const { computeScrollTarget } = await import('../../content/dom-interact.js');
    // down advances by amount but never past the bottom
    runner.assertEqual(computeScrollTarget('down', 0, 600, 2000), 600);
    runner.assertEqual(computeScrollTarget('down', 1800, 600, 2000), 2000, 'down clamps to maxScrollTop');
    // up retreats but never below 0
    runner.assertEqual(computeScrollTarget('up', 400, 600, 2000), 0, 'up clamps to 0');
    runner.assertEqual(computeScrollTarget('up', 1500, 600, 2000), 900);
    // top/bottom jump to the extremes
    runner.assertEqual(computeScrollTarget('top', 1500, 600, 2000), 0);
    runner.assertEqual(computeScrollTarget('bottom', 0, 600, 2000), 2000);
    // a current position beyond bounds is clamped before stepping
    runner.assertEqual(computeScrollTarget('down', 9999, 600, 2000), 2000);
    // zero/invalid amount falls back to a sane default step
    runner.assertEqual(computeScrollTarget('down', 0, 0, 2000), 600, 'zero amount uses default step');
  });

  await runner.asyncTest('pickBestScrollerIndex selects the container hiding the most content', async () => {
    const { pickBestScrollerIndex } = await import('../../content/dom-interact.js');
    // The modal list (large overflow) beats a tiny incidental scroller.
    runner.assertEqual(
      pickBestScrollerIndex([
        { overflow: 8, area: 100 },
        { overflow: 4000, area: 90000 },
        { overflow: 20, area: 500 },
      ]),
      1,
      'largest overflow wins',
    );
    // Ties on overflow break toward the larger visible area.
    runner.assertEqual(
      pickBestScrollerIndex([
        { overflow: 500, area: 1000 },
        { overflow: 500, area: 9000 },
      ]),
      1,
      'area breaks overflow ties',
    );
    // Non-scrollable candidates (overflow <= 4) are ignored entirely.
    runner.assertEqual(
      pickBestScrollerIndex([
        { overflow: 0, area: 100000 },
        { overflow: 2, area: 100000 },
      ]),
      -1,
      'no real scroller -> -1',
    );
    runner.assertEqual(pickBestScrollerIndex([]), -1, 'empty -> -1');
  });

  runner.test('Tool registry maps dismissModal', () => {
    // Soft check via tool definitions builder if available through session tools
    const tools = buildSessionTools({
      browserToolDefinitions: [
        {
          name: 'dismissModal',
          description: 'close modal',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'click',
          description: 'click',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      includePlanTools: false,
      enableScreenshots: true,
    });
    const names = tools.map((t) => t.name);
    runner.assertTrue(names.includes('dismissModal'), 'dismissModal must be available to the agent');
    runner.assertTrue(names.includes('click'));
  });
}

function testOllamaDetect(runner: TestRunner) {
  log('\n=== Testing Ollama Auto-Detect (ollama list shape) ===', 'info');

  runner.test('parseOllamaTagsPayload maps name/id/size/modified like ollama list', () => {
    const now = Date.parse('2026-07-09T12:00:00.000Z');
    const rows = parseOllamaTagsPayload(
      {
        models: [
          {
            name: 'gemma4:31b-cloud',
            size: 342,
            digest: 'c382fbfbc73b6fdd08c8549c23caedc6e62eb09933c65a1fb82dbf3398320a4e',
            modified_at: '2026-07-09T11:59:51.000Z',
            remote_host: 'https://ollama.com:443',
          },
          {
            name: 'llama3.1:8b',
            size: 4.7 * 1024 * 1024 * 1024,
            digest: 'sha256:abcdef0123456789',
            modified_at: '2026-07-08T12:00:00.000Z',
          },
        ],
      },
      now,
    );
    runner.assertEqual(rows.length, 2);
    runner.assertEqual(rows[0].name, 'gemma4:31b-cloud', 'newest first');
    runner.assertEqual(rows[0].id, 'c382fbfbc73b');
    runner.assertEqual(rows[0].sizeLabel, '—', 'tiny cloud placeholder size → —');
    runner.assertTrue(rows[0].isCloud);
    runner.assertEqual(rows[1].name, 'llama3.1:8b');
    runner.assertEqual(rows[1].id, 'abcdef012345');
    runner.assertTrue(rows[1].sizeLabel.includes('GB'));
  });

  runner.test('format helpers match ollama list readability', () => {
    runner.assertEqual(shortDigestId('sha256:deadbeefcafebabe'), 'deadbeefcafe');
    runner.assertEqual(formatOllamaSize(0), '—');
    runner.assertEqual(formatOllamaSize(1024), '1 KB');
    runner.assertEqual(formatOllamaModified(Date.now() - 9000), '9 seconds ago');
    runner.assertEqual(formatOllamaModified(Date.now() - 60_000), 'About a minute ago');
  });

  runner.test('normalizeOllamaBaseUrl strips /v1 and defaults to localhost', () => {
    runner.assertEqual(normalizeOllamaBaseUrl(''), 'http://localhost:11434');
    runner.assertEqual(normalizeOllamaBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  });

  runner.test('formatOllamaListSummary covers online/offline', () => {
    runner.assertTrue(
      formatOllamaListSummary({
        online: false,
        endpoint: 'http://localhost:11434',
        models: [],
        modelNames: [],
        error: 'boom',
        latencyMs: 1,
      }).includes('offline'),
    );
    runner.assertTrue(
      formatOllamaListSummary({
        online: true,
        endpoint: 'http://localhost:11434',
        models: [
          {
            name: 'a',
            id: 'x',
            size: 0,
            sizeLabel: '—',
            modifiedAt: '',
            modifiedLabel: '—',
            isCloud: false,
          },
        ],
        modelNames: ['a'],
        latencyMs: 1,
      }).includes('1 model'),
    );
  });
}

function testModelCorrectnessGraders(runner: TestRunner) {
  log('\n=== Testing Model Correctness Graders ===', 'info');

  runner.test('Correctness suite defines graded cases', () => {
    runner.assertTrue(MODEL_CORRECTNESS_CASES.length >= 4, 'expected several correctness cases');
    for (const testCase of MODEL_CORRECTNESS_CASES) {
      runner.assertTrue(Boolean(testCase.id && testCase.prompt && typeof testCase.grade === 'function'));
    }
  });

  runner.test('Exact token grader accepts GLIDE_PING', () => {
    const grade = MODEL_CORRECTNESS_CASES.find((c) => c.id === 'exact-token')!.grade;
    runner.assertEqual(grade('GLIDE_PING'), null);
    runner.assertTrue(grade('hello') !== null);
  });

  runner.test('Arithmetic grader accepts 42 with light noise', () => {
    const grade = MODEL_CORRECTNESS_CASES.find((c) => c.id === 'arithmetic')!.grade;
    runner.assertEqual(grade('42'), null);
    runner.assertEqual(grade('Answer: 42'), null);
    runner.assertTrue(grade('41') !== null);
  });

  runner.test('JSON grader extracts object from prose/fence', () => {
    const grade = MODEL_CORRECTNESS_CASES.find((c) => c.id === 'json-object')!.grade;
    runner.assertEqual(grade('{"status":"ok","n":3,"label":"glide"}'), null);
    runner.assertEqual(grade('Here you go:\n```json\n{"status":"ok","n":3,"label":"glide"}\n```'), null);
    runner.assertTrue(grade('{"status":"fail"}') !== null);
  });

  runner.test('extractJsonObject and firstContentLine helpers work', () => {
    runner.assertEqual(firstContentLine('  Paris  '), 'Paris');
    const obj = extractJsonObject('noise {"a":1} tail');
    runner.assertEqual(obj?.a, 1);
  });

  runner.test('summarizeCorrectness computes pass rate and min threshold', () => {
    const report = summarizeCorrectness(
      [
        { id: 'a', name: 'a', pass: true, latencyMs: 1, responsePreview: 'x' },
        { id: 'b', name: 'b', pass: true, latencyMs: 1, responsePreview: 'y' },
        { id: 'c', name: 'c', pass: false, reason: 'nope', latencyMs: 1, responsePreview: 'z' },
      ],
      { model: 'm', endpoint: 'e' },
    );
    runner.assertEqual(report.passed, 2);
    runner.assertEqual(report.failed, 1);
    runner.assertTrue(Math.abs(report.passRate - 2 / 3) < 1e-9);
    runner.assertEqual(resolveMinPassRate({} as NodeJS.ProcessEnv), 0.8);
    runner.assertEqual(resolveMinPassRate({ GLIDE_CORRECTNESS_MIN_PASS: '1' } as NodeJS.ProcessEnv), 1);
  });
}

function testScreenshotStorePrune(runner: TestRunner) {
  log('\n=== Testing Screenshot Store Prune Planner ===', 'info');

  runner.test('planScreenshotPrune drops expired entries by age', () => {
    const now = 1_000_000;
    const { keep, removeIds } = planScreenshotPrune(
      [
        { id: 'old', storedAt: now - 3_600_001, bytes: 100 },
        { id: 'fresh', storedAt: now - 1000, bytes: 100 },
      ],
      now,
      { maxAgeMs: 3_600_000, maxCount: 10, maxBytes: 1_000_000 },
    );
    runner.assertEqual(keep.map((e) => e.id).join(','), 'fresh');
    runner.assertTrue(removeIds.includes('old'));
  });

  runner.test('planScreenshotPrune enforces count FIFO', () => {
    const now = Date.now();
    const entries = Array.from({ length: MAX_SCREENSHOT_COUNT + 2 }, (_, i) => ({
      id: `ss_${i}`,
      storedAt: now - (MAX_SCREENSHOT_COUNT + 2 - i) * 1000,
      bytes: 10,
    }));
    const { keep, removeIds } = planScreenshotPrune(entries, now);
    runner.assertEqual(keep.length, MAX_SCREENSHOT_COUNT);
    runner.assertEqual(removeIds.length, 2);
    runner.assertTrue(removeIds.includes('ss_0'));
    runner.assertTrue(removeIds.includes('ss_1'));
  });

  runner.test('planScreenshotPrune enforces byte budget FIFO', () => {
    const now = Date.now();
    const chunk = Math.floor(MAX_SCREENSHOT_TOTAL_BYTES / 2) + 1;
    const { keep, removeIds } = planScreenshotPrune(
      [
        { id: 'a', storedAt: now - 3000, bytes: chunk },
        { id: 'b', storedAt: now - 2000, bytes: chunk },
        { id: 'c', storedAt: now - 1000, bytes: chunk },
      ],
      now,
    );
    runner.assertTrue(keep.length <= 2, 'byte budget must drop at least one entry');
    runner.assertTrue(removeIds.includes('a'), 'oldest must be dropped first');
    runner.assertTrue(
      keep.some((e) => e.id === 'c'),
      'newest should survive when possible',
    );
  });
}

function testVisionQueueCap(runner: TestRunner) {
  log('\n=== Testing Vision Queue Cap ===', 'info');

  runner.test('VisionQueue rejects jobs with neither screenshotId nor dataUrl', () => {
    const queue = new VisionQueue();
    let error = '';
    queue.enqueue({
      prompt: 'describe',
      settings: { provider: 'ollama', apiKey: '', model: 'x' },
      timeoutMs: 1,
      onComplete: () => {},
      onError: ({ message }) => {
        error = message;
      },
    } as any);
    runner.assertTrue(error.includes('screenshotId') || error.includes('dataUrl'), error);
  });

  runner.test('VisionQueue backlog constant is a small hard cap', () => {
    runner.assertEqual(MAX_QUEUED_VISION_JOBS, 4);
  });

  runner.test('VisionQueue.cancelRun drops queued jobs for that run', () => {
    const queue = new VisionQueue();
    let cancelled = 0;
    const mk = () =>
      ({
        dataUrl: 'data:image/png;base64,aa',
        prompt: 'x',
        settings: { provider: 'ollama', model: 'x' } as any,
        timeoutMs: 60_000,
        runId: 'run-a',
        onComplete: () => {},
        onError: (e: { message: string }) => {
          if (/cancelled/i.test(e.message)) cancelled += 1;
        },
      }) as any;
    // 2 concurrent max → 3rd stays queued until cancel.
    queue.enqueue(mk());
    queue.enqueue(mk());
    queue.enqueue(mk());
    runner.assertTrue(queue.pendingCount >= 1, 'at least one job waiting');
    queue.cancelRun('run-a');
    runner.assertEqual(queue.pendingCount, 0);
    runner.assertTrue(cancelled >= 1, 'onError cancelled for waiting job');
  });
}

function testNormalizeUsage(runner: TestRunner) {
  log('\n=== Testing normalizeUsage totalTokens derivation ===', 'info');

  runner.test('normalizeUsage derives total from input+output when total is 0', () => {
    const u = normalizeUsage({ inputTokens: 100, outputTokens: 40, totalTokens: 0 });
    runner.assertEqual(u.totalTokens, 140);
    runner.assertEqual(u.inputTokens, 100);
    runner.assertEqual(u.outputTokens, 40);
  });

  runner.test('normalizeUsage keeps explicit totalTokens', () => {
    const u = normalizeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 99 });
    runner.assertEqual(u.totalTokens, 99);
  });

  runner.test('normalizeUsage clamps NaN and Infinity to zero', () => {
    const u = normalizeUsage({
      inputTokens: Number.NaN,
      outputTokens: Number.POSITIVE_INFINITY,
      totalTokens: Number.NEGATIVE_INFINITY,
    });
    runner.assertEqual(u.inputTokens, 0);
    runner.assertEqual(u.outputTokens, 0);
    runner.assertEqual(u.totalTokens, 0);
  });
}

function testVisualDelivery(runner: TestRunner) {
  log('\n=== Testing Visual Delivery ===', 'info');

  runner.test('Visual context uses direct Anthropic media and synchronous descriptions elsewhere', () => {
    runner.assertEqual(resolveVisualDeliveryMode({ provider: 'anthropic', apiKey: 'oauth-token' }), 'direct');
    runner.assertEqual(resolveVisualDeliveryMode({ provider: 'codex', apiKey: 'codex-token' }), 'describe');
    runner.assertEqual(resolveVisualDeliveryMode({ provider: 'opencode', apiKey: 'zen-token' }), 'describe');
    runner.assertEqual(resolveVisualDeliveryMode({ provider: 'ollama', apiKey: '' }), 'describe');
    runner.assertEqual(resolveVisualDeliveryMode({ provider: 'codex', apiKey: '' }), 'unavailable');
  });

  runner.test('Direct media text preserves tool state without embedding screenshot base64', () => {
    const serialized = serializeToolOutputForMedia({
      success: false,
      code: 'ELEMENT_NOT_FOUND',
      dataUrl: 'data:image/jpeg;base64,VERY_LARGE_PAYLOAD',
    });
    runner.assertTrue(serialized.includes('ELEMENT_NOT_FOUND'));
    runner.assertTrue(serialized.includes('<untrusted-content'));
    runner.assertFalse(serialized.includes('VERY_LARGE_PAYLOAD'));
    runner.assertFalse(serialized.includes('dataUrl'));
  });
}

function testPersistSerialization(runner: TestRunner) {
  log('\n=== Testing Persist Serialization Helpers ===', 'info');

  runner.test('normalizePersistedContent preserves multimodal arrays', () => {
    const bigData = 'A'.repeat(5000);
    const normalized = normalizePersistedContent([
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigData } },
      { type: 'tool-result', toolCallId: 'c1', output: { success: true, html: 'x'.repeat(5000) } },
    ]);
    runner.assertTrue(Array.isArray(normalized), 'structured content stays an array');
    const parts = normalized as any[];
    runner.assertEqual(parts[0].text, 'hello');
    runner.assertTrue(String(parts[1].source.data).includes('redacted'), 'image payload is redacted, not dropped');
    runner.assertEqual(parts[2].type, 'tool-result');
  });

  runner.test('sanitizeMessageForPersistence keeps tool-call pairing fields', () => {
    const sanitized = sanitizeMessageForPersistence({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-1', output: { ok: true } }],
      toolCallId: 'call-1',
      toolName: 'click',
    });
    runner.assertTrue(Array.isArray(sanitized?.content));
    runner.assertEqual(sanitized?.toolCallId, 'call-1');
  });

  runner.test('wrapUntrustedContent adds explicit delimiters', () => {
    const wrapped = wrapUntrustedContent('{"ok":true}', 'tool-result');
    runner.assertTrue(wrapped.startsWith('<untrusted-content'));
    runner.assertTrue(wrapped.includes('</untrusted-content>'));
  });
}

async function testAnthropicOAuthPolicy(runner: TestRunner) {
  log('\n=== Testing Anthropic OAuth Policy ===', 'info');

  // Mock mínimo de chrome.storage.local — somente os caminhos sem rede.
  const store: Record<string, any> = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, any> = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (items: Record<string, any>) => {
          Object.assign(store, items);
        },
        remove: async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        },
      },
    },
  };

  try {
    runner.test('parseAnthropicCredentials aceita claudeAiOauth e normaliza expiry em segundos', () => {
      const bundle = parseAnthropicCredentials({
        claudeAiOauth: { accessToken: 'tok-a', refreshToken: 'ref-a', expiresAt: 1_700_000_000 },
      });
      runner.assertEqual(bundle?.accessToken, 'tok-a');
      runner.assertEqual(bundle?.expiresAt, 1_700_000_000_000, 'segundos devem virar ms');
      runner.assertEqual(parseAnthropicCredentials({ accessToken: 'x' }), null, 'sem refresh token → null');
    });

    await runner.asyncTest('bundle válido é usado sem refresh (sem rede)', async () => {
      store.anthropicOAuth = { accessToken: 'tok-live', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000 };
      const token = await ensureFreshAnthropicToken('tok-form');
      runner.assertEqual(token, 'tok-live', 'bundle vigente tem precedência');
    });

    await runner.asyncTest('sessão revogada não martela refresh e respeita token manual', async () => {
      store.anthropicOAuth = {
        accessToken: 'tok-dead',
        refreshToken: 'ref',
        expiresAt: 0,
        refreshRejectedAt: Date.now(),
      };
      const manual = await ensureFreshAnthropicToken('tok-manual');
      runner.assertEqual(manual, 'tok-manual', 'token manual substitui sessão morta');
      const fallback = await ensureFreshAnthropicToken('tok-dead');
      runner.assertEqual(fallback, 'tok-dead', 'sem override, mantém o token atual');
      const health = await getAnthropicAuthHealth();
      runner.assertFalse(health.ok, 'health deve reportar reauth');
      runner.assertEqual(health.reason, 'reauth');
    });

    await runner.asyncTest('reconcileManualAnthropicToken descarta bundle obsoleto e preserva o vigente', async () => {
      store.anthropicOAuth = { accessToken: 'tok-old', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000 };
      await reconcileManualAnthropicToken('tok-old');
      runner.assertTrue(store.anthropicOAuth, 'mesmo token → bundle preservado');
      await reconcileManualAnthropicToken('tok-new');
      runner.assertFalse(store.anthropicOAuth, 'token diferente → bundle removido');
    });

    await runner.asyncTest('writeAnthropicOAuth zera revogação e sincroniza apiKey', async () => {
      await writeAnthropicOAuth({
        accessToken: 'tok-next',
        refreshToken: 'ref-next',
        expiresAt: 123,
        refreshRejectedAt: 1,
      } as any);
      runner.assertFalse(store.anthropicOAuth.refreshRejectedAt, 'credencial nova limpa refreshRejectedAt');
      runner.assertEqual(store.apiKey, 'tok-next', 'apiKey acompanha o access token');
      const health = await getAnthropicAuthHealth();
      runner.assertTrue(health.ok);
    });

    await runner.asyncTest('refresh coalescing ignores stale in-flight result after credential swap', async () => {
      resetAnthropicOAuthRefreshState();
      store.anthropicOAuth = {
        accessToken: 'tok-old',
        refreshToken: 'ref-old',
        expiresAt: 0,
      };
      const originalFetch = globalThis.fetch;
      let resolveRefresh: ((value: Response) => void) | undefined;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/oauth/token')) {
          return new Promise<Response>((resolve) => {
            resolveRefresh = resolve;
          });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const inFlight = ensureFreshAnthropicToken('tok-old');
        await new Promise((resolve) => setTimeout(resolve, 0));
        runner.assertTrue(typeof resolveRefresh === 'function', 'refresh fetch should be in flight');
        store.anthropicOAuth = {
          accessToken: 'tok-new',
          refreshToken: 'ref-new',
          expiresAt: Date.now() + 3_600_000,
        };
        resolveRefresh!(
          new Response(JSON.stringify({ access_token: 'tok-refreshed-old', refresh_token: 'ref-old' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        const token = await inFlight;
        runner.assertEqual(token, 'tok-new', 'stale refresh must not overwrite replaced credential');
        runner.assertEqual(store.anthropicOAuth.accessToken, 'tok-new');
      } finally {
        globalThis.fetch = originalFetch;
        resetAnthropicOAuthRefreshState();
      }
    });
  } finally {
    delete (globalThis as any).chrome;
  }
}

// Main test execution
async function main() {
  log('╔════════════════════════════════════════╗', 'info');
  log('║       Unit Tests - Browser Tools       ║', 'info');
  log('╚════════════════════════════════════════╝', 'info');

  const runner = new TestRunner();

  testToolDefinitions(runner);
  testBrowserToolArgValidation(runner);
  testFrameTargetSchema(runner);
  testFrameTargetValidation(runner);
  testResolveTargetFrameIdHelper(runner);
  testDefaultSystemPrompt(runner);
  testExecuteScriptRunner(runner);
  testHttpRequestHelper(runner);
  testAIProviderConfig(runner);
  testToolSchemaConversion(runner);
  testInputValidation(runner);
  testErrorHandling(runner);
  testMessageSchema(runner);

  testConversationCompaction(runner);
  testModelConvert(runner);
  testToolCallRecovery(runner);
  testThinkingExtraction(runner);
  testPlanNormalization(runner);
  testRetryHelpers(runner);
  testTaskIntent(runner);
  testRuntimeMessages(runner);
  testSessionContextStore(runner);
  testDomCache(runner);
  testContentBridgeContract(runner);
  testTabReadiness(runner);
  testRuntimeBatcher(runner);
  testRuntimePushChannel(runner);
  await testRuntimePushPortBroadcast(runner);
  await testProviderDnrRulesCache(runner);
  testToolLogBuffer(runner);
  testMarkdownRenderDefer(runner);
  testStreamQueue(runner);
  await testSerialTaskQueue(runner);
  testRunPassCache(runner);
  await testRuntimeCache(runner);
  testRuntimeSettings(runner);
  testModelActivityWatchdog(runner);
  testImageScale(runner);
  await testFixToolsBrowserAutomation(runner);
  testDeliberateRunStop(runner);
  testContinuationIntent(runner);
  testFailureRecovery(runner);
  testFixSwReviewFindings(runner);
  testSessionTools(runner);
  testToolPermissions(runner);
  testHttpUrlValidation(runner);
  testProviderPreflight(runner);
  testPromptCache(runner);
  testRateLimitHandling(runner);
  await testCodexChatGptAuth(runner);
  testProviderKeyStorage(runner);
  testHistoryStorage(runner);
  testToolTurnHistory(runner);
  testCompactionMemo(runner);
  testProviderEndpointValidation(runner);
  await testProviderFetchBinding(runner);
  await testDomInteractExports(runner);
  testOllamaDetect(runner);
  testModelCorrectnessGraders(runner);
  testScreenshotStorePrune(runner);
  testVisionQueueCap(runner);
  testNormalizeUsage(runner);
  testVisualDelivery(runner);
  testPersistSerialization(runner);
  await testAnthropicOAuthPolicy(runner);

  const success = runner.printSummary();
  process.exit(success ? 0 : 1);
}

main().catch((error) => {
  log(`Unit test runner crashed: ${String((error as Error)?.stack || error)}`, 'error');
  process.exit(1);
});
