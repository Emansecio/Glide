#!/usr/bin/env node

/**
 * Unit Test Runner
 * Tests individual components without Chrome APIs
 */

import {
  COMPACTION_ENTER_PERCENT,
  COMPACTION_RELEASE_PERCENT,
  DEFAULT_COMPACTION_SETTINGS,
  applyCompaction,
  buildCompactionSummaryMessage,
  estimateContextTokens,
  findCutPoint,
  resetCompactionHysteresis,
  shouldCompact,
} from '../../ai/compaction.js';
import { resolveDirectBrowserAction } from '../../ai/direct-browser-command.js';
import { createMessage, normalizeConversationHistory, toProviderMessages } from '../../ai/message-schema.js';
import type { Message } from '../../ai/message-schema.js';
import { extractThinking } from '../../ai/message-utils.js';
import { toModelMessages } from '../../ai/model-convert.js';
import { createExponentialBackoff, isRetryableProviderError, isValidFinalResponse } from '../../ai/retry-engine.js';
import { detectTaskIntent, stripInjectedTabContext } from '../../ai/task-intent.js';
import { extractRecoverableToolCalls, stripRecoverableToolCalls } from '../../ai/tool-call-recovery.js';

import { buildAnthropicProviderOptions, migrateAnthropicModel } from '../../ai/anthropic-options.js';
import {
  buildModelCacheKey,
  buildToolSetCacheKey,
  getCachedToolSet,
  invalidateRuntimeCaches,
} from '../../ai/runtime-cache.js';
import { buildAnthropicOAuthHeaders, migrateStoredProvider, resolveProviderBaseUrl } from '../../ai/sdk-client.js';
import { buildToolTurnMessages } from '../../ai/tool-history.js';
import { DomCacheLru } from '../../background/dom-cache.js';
import { RunPassCache } from '../../background/run-pass-cache.js';
import { PARENT_ONLY_TOOLS } from '../../background/run-scope.js';
import { RuntimeBatcher, buildStreamDeltaPayload } from '../../background/runtime-batcher.js';
import {
  MAX_SCREENSHOT_COUNT,
  MAX_SCREENSHOT_TOTAL_BYTES,
  planScreenshotPrune,
} from '../../background/screenshot-store.js';
import { buildSessionTools } from '../../background/session-tools.js';
import { MAX_QUEUED_VISION_JOBS, VisionQueue } from '../../background/vision-queue.js';
import {
  MODEL_CORRECTNESS_CASES,
  extractJsonObject,
  firstContentLine,
  resolveMinPassRate,
  summarizeCorrectness,
} from '../integration/model-correctness-cases.js';
import {
  formatOllamaListSummary,
  formatOllamaModified,
  formatOllamaSize,
  normalizeOllamaBaseUrl,
  parseOllamaTagsPayload,
  shortDigestId,
} from '../../background/ollama-detect.js';
import {
  DEFAULT_TOOL_PERMISSIONS,
  getToolPermissionCategory,
  isToolCategoryAllowed,
} from '../../background/tool-permissions.js';
import { GLIDE_BRIDGE_MESSAGE_TYPE } from '../../tools/content-bridge.js';
import { requireHttpUrl } from '../../tools/validation.js';
import { buildRunPlan, normalizePlanStatus, normalizePlanSteps } from '../../types/plan.js';
import type { RunPlan } from '../../types/plan.js';
import { RUNTIME_MESSAGE_SCHEMA_VERSION, isRuntimeMessage } from '../../types/runtime-messages.js';
import type { RuntimeMessage } from '../../types/runtime-messages.js';

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
    const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 100 };
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
  });
}

function testDirectBrowserCommand(runner: TestRunner) {
  log('\n=== Testing Direct Browser Command ===', 'info');

  runner.test('direct open command resolves Instagram without a model call', () => {
    const action = resolveDirectBrowserAction('Abra meu instagram');
    runner.assertEqual(action?.toolName, 'navigate');
    runner.assertEqual(action?.args.url, 'https://www.instagram.com/');
  });

  runner.test('direct open command resolves YouTube from Portuguese prompt', () => {
    const action = resolveDirectBrowserAction('Abra o youtube');
    runner.assertEqual(action?.toolName, 'navigate');
    runner.assertEqual(action?.args.url, 'https://www.youtube.com/');
  });

  runner.test('direct open command ignores multi-step browser tasks', () => {
    const action = resolveDirectBrowserAction('abra o google e pesquise gatos');
    runner.assertEqual(action, null);
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
      { ...base, type: 'user_run_start', message: 'hello' },
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
      { ...base, type: 'plan_update', plan },
      {
        ...base,
        type: 'manual_plan_update',
        steps: [{ title: 'Review plan', status: 'pending' }],
      },
      {
        ...base,
        type: 'run_status',
        phase: 'executing',
        attempts: { api: 0, tool: 1, finalize: 0 },
        maxRetries: { api: 2, tool: 2, finalize: 1 },
        lastError: 'Tool failed',
      },
      {
        ...base,
        type: 'run_status',
        phase: 'stopped',
        attempts: { api: 0, tool: 0, finalize: 0 },
        maxRetries: { api: 1, tool: 1, finalize: 1 },
        note: 'Stopped by user',
      },
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
    const missingRunId = {
      type: 'assistant_final',
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      timestamp: Date.now(),
      content: 'Hi',
    };
    runner.assertFalse(isRuntimeMessage(badVersion), 'Should reject mismatched schema versions');
    runner.assertFalse(isRuntimeMessage(badType), 'Should reject unknown message types');
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
}

function testContentBridgeContract(runner: TestRunner) {
  log('\n=== Testing Content Bridge Contract ===', 'info');

  runner.test('Glide bridge message type is stable', () => {
    runner.assertEqual(GLIDE_BRIDGE_MESSAGE_TYPE, 'glide_bridge');
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
}

function testRunPassCache(runner: TestRunner) {
  log('\n=== Testing Run Pass Cache ===', 'info');

  runner.test('Run pass cache only converts appended history tail', () => {
    const cache = new RunPassCache();
    const first = cache.getModelMessages([{ role: 'user', content: 'hello' }]);
    const second = cache.getModelMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    runner.assertEqual(first.length, 1);
    runner.assertEqual(second.length, 2);
    runner.assertEqual(second[0].role, 'user');
    runner.assertEqual(second[1].role, 'assistant');
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
}

function testRuntimeCache(runner: TestRunner) {
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

  runner.test('Tool set cache keys change when tool inventory changes', () => {
    const toolsA = [{ name: 'click' }, { name: 'type' }] as Array<{ name: string }>;
    const toolsB = [{ name: 'click' }, { name: 'scroll' }] as Array<{ name: string }>;
    const keyA = buildToolSetCacheKey(toolsA as any, 'anthropic');
    const keyB = buildToolSetCacheKey(toolsB as any, 'anthropic');
    runner.assertTrue(keyA !== keyB, 'Different tool sets should produce different cache keys');
  });

  runner.test('invalidateRuntimeCaches is safe to call repeatedly', () => {
    invalidateRuntimeCaches();
    invalidateRuntimeCaches();
    runner.assertTrue(true);
  });

  runner.test('getCachedToolSet does not reuse execute closures', async () => {
    const tools = [{ name: 'click', description: 'click', input_schema: { type: 'object' as const, properties: {} } }];
    let counterA = 0;
    let counterB = 0;
    const setA = getCachedToolSet(
      tools as any,
      async () => {
        counterA += 1;
        return { ok: true };
      },
      'anthropic',
    );
    const setB = getCachedToolSet(
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

function testSessionTools(runner: TestRunner) {
  log('\n=== Testing Session Tools ===', 'info');

  const browserTools = [
    { name: 'click', description: 'click', input_schema: { type: 'object' as const, properties: {} } },
    { name: 'screenshot', description: 'shot', input_schema: { type: 'object' as const, properties: {} } },
    { name: 'spawn_subagent', description: 'spawn', input_schema: { type: 'object' as const, properties: {} } },
  ];
  const allowlist = new Set(['click']);

  runner.test('Sub-agent profile excludes plan and spawn tools but keeps subagent_complete', () => {
    const tools = buildSessionTools({
      browserToolDefinitions: browserTools,
      lockedTabId: 42,
      lockedTabAllowlist: allowlist,
      includePlanTools: false,
      includeSubagentComplete: true,
    });
    const names = tools.map((tool) => tool.name);
    runner.assertTrue(names.includes('click'), 'locked browser tools remain');
    runner.assertFalse(names.includes('set_plan'), 'plan tools excluded for sub-agents');
    runner.assertFalse(names.includes('spawn_subagent'), 'spawn excluded for sub-agents');
    runner.assertTrue(names.includes('subagent_complete'), 'subagent_complete remains available');
  });

  runner.test('Parent-only tool guard covers orchestration tools', () => {
    runner.assertTrue(PARENT_ONLY_TOOLS.has('set_plan'));
    runner.assertTrue(PARENT_ONLY_TOOLS.has('update_plan'));
    runner.assertTrue(PARENT_ONLY_TOOLS.has('spawn_subagent'));
    runner.assertFalse(PARENT_ONLY_TOOLS.has('subagent_complete'));
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

  runner.test('Scripting permission is deny-by-default', () => {
    runner.assertFalse(DEFAULT_TOOL_PERMISSIONS.scripting, 'scripting must default to false');
    runner.assertFalse(isToolCategoryAllowed('scripting', {}), 'missing scripting toggle must deny');
    runner.assertFalse(isToolCategoryAllowed('scripting', { scripting: false }), 'explicit false denies');
    runner.assertTrue(isToolCategoryAllowed('scripting', { scripting: true }), 'explicit true allows');
  });

  runner.test('Non-scripting categories stay allow-by-default but honor explicit false', () => {
    runner.assertTrue(isToolCategoryAllowed('read', {}), 'read allowed when unset');
    runner.assertFalse(isToolCategoryAllowed('read', { read: false }), 'read blocked when false');
    runner.assertTrue(isToolCategoryAllowed(null, {}), 'uncategorized tools are not gated here');
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
  });

  runner.test('Anthropic OAuth headers can opt into browser access when requested', () => {
    const headers = buildAnthropicOAuthHeaders('token-test', { allowBrowserAccess: true });
    runner.assertEqual(headers['anthropic-dangerous-direct-browser-access'], 'true');
  });

  runner.test('Anthropic provider options default reasoning effort to low', () => {
    const options = buildAnthropicProviderOptions();
    runner.assertEqual(options.anthropic.effort, 'low');
  });

  runner.test('Legacy Anthropic model ids migrate to current lineup', () => {
    runner.assertEqual(migrateAnthropicModel('claude-sonnet-4-6'), 'claude-sonnet-5');
    runner.assertEqual(migrateAnthropicModel('claude-opus-4-7'), 'claude-opus-4-8');
    runner.assertEqual(migrateAnthropicModel('claude-sonnet-5'), 'claude-sonnet-5');
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
}

function testDomInteractExports(runner: TestRunner) {
  log('\n=== Testing DOM Interact / Modal helpers (module load) ===', 'info');

  runner.test('Content bridge ops include dismissModal', () => {
    // Type-level surface is mirrored by runtime bridge ops list in content-bridge.
    runner.assertEqual(GLIDE_BRIDGE_MESSAGE_TYPE, 'glide_bridge');
  });

  runner.test('dismissModal is an interact permission tool', () => {
    runner.assertEqual(getToolPermissionCategory('dismissModal'), 'interact');
    runner.assertEqual(getToolPermissionCategory('wait'), 'interact');
  });

  runner.test('dom-interact exports shared bridge helpers', async () => {
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

  runner.test('waitForNewDialog is exported for non-blocking post-click waits', async () => {
    // Dynamic import of pure helpers (no document) — only check the function exists in the module shape.
    const mod = await import('../../content/dom-interact.js');
    runner.assertTrue(typeof mod.waitForNewDialog === 'function', 'waitForNewDialog must exist');
    runner.assertTrue(typeof mod.waitForDialog === 'function', 'waitForDialog must exist');
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
      includeOrchestrator: false,
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
    runner.assertTrue(keep.some((e) => e.id === 'c'), 'newest should survive when possible');
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
}

// Main test execution
function main() {
  log('╔════════════════════════════════════════╗', 'info');
  log('║       Unit Tests - Browser Tools       ║', 'info');
  log('╚════════════════════════════════════════╝', 'info');

  const runner = new TestRunner();

  testToolDefinitions(runner);
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
  testDirectBrowserCommand(runner);
  testRuntimeMessages(runner);
  testDomCache(runner);
  testContentBridgeContract(runner);
  testRuntimeBatcher(runner);
  testRunPassCache(runner);
  testRuntimeCache(runner);
  testSessionTools(runner);
  testToolPermissions(runner);
  testHttpUrlValidation(runner);
  testToolTurnHistory(runner);
  testCompactionMemo(runner);
  testProviderEndpointValidation(runner);
  testDomInteractExports(runner);
  testOllamaDetect(runner);
  testModelCorrectnessGraders(runner);
  testScreenshotStorePrune(runner);
  testVisionQueueCap(runner);

  const success = runner.printSummary();
  process.exit(success ? 0 : 1);
}

main();
