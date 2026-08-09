#!/usr/bin/env node

/**
 * Live model correctness suite.
 *
 * Probes the configured Ollama (or OpenAI-compatible) model with graded prompts
 * and fails when the pass rate is below GLIDE_CORRECTNESS_MIN_PASS (default 0.8).
 *
 * Usage:
 *   npm run test:live:correctness
 *   # or
 *   GLIDE_LIVE_TESTS=1 node dist/tests/integration/test-model-correctness.js
 *
 * Env:
 *   GLIDE_LIVE_TESTS=1              required gate
 *   TEST_OLLAMA_ENDPOINT            default http://localhost:11434
 *   TEST_OLLAMA_MODEL               optional pin (else first available)
 *   TEST_LIVE_TIMEOUT_MS            per-case timeout (default 60000)
 *   GLIDE_CORRECTNESS_MIN_PASS      0..1 (default 0.8)
 */

import { generateText } from 'ai';
import { resolveLanguageModel } from '../../ai/sdk-client.js';
import { liveTestsEnabled, resolveLiveOllamaModel } from '../helpers/live-test-config.js';
import {
  type CaseResult,
  MODEL_CORRECTNESS_CASES,
  resolveMinPassRate,
  summarizeCorrectness,
} from './model-correctness-cases.js';

const colors = {
  info: '\x1b[36m',
  success: '\x1b[32m',
  error: '\x1b[31m',
  warn: '\x1b[33m',
  reset: '\x1b[0m',
} as const;

function log(message: string, type: keyof typeof colors = 'info') {
  console.log(`${colors[type]}${message}${colors.reset}`);
}

async function runCase(
  languageModel: ReturnType<typeof resolveLanguageModel>,
  testCase: (typeof MODEL_CORRECTNESS_CASES)[number],
  timeoutMs: number,
): Promise<CaseResult> {
  const started = Date.now();
  try {
    const result = await generateText({
      model: languageModel,
      maxOutputTokens: testCase.maxOutputTokens ?? 64,
      system: testCase.system,
      messages: [{ role: 'user', content: testCase.prompt }],
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    const text = String(result.text || '');
    const reason = testCase.grade(text);
    return {
      id: testCase.id,
      name: testCase.name,
      pass: reason === null,
      reason: reason || undefined,
      latencyMs: Date.now() - started,
      responsePreview: text.replace(/\s+/g, ' ').trim().slice(0, 160),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: testCase.id,
      name: testCase.name,
      pass: false,
      reason: `request failed: ${message.slice(0, 200)}`,
      latencyMs: Date.now() - started,
      responsePreview: '',
    };
  }
}

async function run() {
  if (!liveTestsEnabled()) {
    log('SKIPPED: model correctness suite (set GLIDE_LIVE_TESTS=1)', 'info');
    process.exitCode = 0;
    return;
  }

  try {
    const { endpoint, model } = await resolveLiveOllamaModel();
    const timeoutMs = Number(process.env.TEST_LIVE_TIMEOUT_MS || 60000);
    const minPass = resolveMinPassRate();
    log(`Model correctness suite → ${model} @ ${endpoint}`, 'info');
    log(`Cases: ${MODEL_CORRECTNESS_CASES.length} · min pass rate: ${(minPass * 100).toFixed(0)}%`, 'info');

    const languageModel = resolveLanguageModel({
      provider: 'ollama',
      apiKey: '',
      model,
      customEndpoint: endpoint,
    });

    const results: CaseResult[] = [];
    for (const testCase of MODEL_CORRECTNESS_CASES) {
      log(`▶ ${testCase.id}: ${testCase.name}`, 'info');
      const outcome = await runCase(languageModel, testCase, timeoutMs);
      results.push(outcome);
      if (outcome.pass) {
        log(`  ✓ ${outcome.name} (${outcome.latencyMs}ms) → ${outcome.responsePreview || '(empty)'}`, 'success');
      } else {
        log(`  ✗ ${outcome.name} (${outcome.latencyMs}ms) — ${outcome.reason}`, 'error');
        if (outcome.responsePreview) {
          log(`    response: ${outcome.responsePreview}`, 'warn');
        }
      }
    }

    const report = summarizeCorrectness(results, { model, endpoint });
    log('', 'info');
    log('=== Model Correctness Report ===', 'info');
    log(`Model:     ${report.model}`, 'info');
    log(`Endpoint:  ${report.endpoint}`, 'info');
    log(`Passed:    ${report.passed}/${report.total} (${(report.passRate * 100).toFixed(0)}%)`, 'info');
    log(`Failed:    ${report.failed}`, report.failed ? 'error' : 'info');

    if (report.passRate + 1e-9 < minPass) {
      throw new Error(
        `Pass rate ${(report.passRate * 100).toFixed(0)}% is below minimum ${(minPass * 100).toFixed(0)}%`,
      );
    }

    log('✓ Model correctness suite passed', 'success');
    process.exitCode = 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('SKIPPED:')) {
      log(message, 'info');
      process.exitCode = 0;
      return;
    }
    log(`✗ ${message}`, 'error');
    process.exitCode = 1;
  }
}

run();
