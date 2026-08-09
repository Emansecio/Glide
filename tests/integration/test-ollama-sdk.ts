#!/usr/bin/env node

import { generateText } from 'ai';
import { resolveLanguageModel } from '../../ai/sdk-client.js';
import { liveTestsEnabled, resolveLiveOllamaModel, skipUnlessLive } from '../helpers/live-test-config.js';

const colors = {
  info: '\x1b[36m',
  success: '\x1b[32m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
} as const;

function log(message: string, type: keyof typeof colors = 'info') {
  console.log(`${colors[type]}${message}${colors.reset}`);
}

async function run() {
  if (!liveTestsEnabled()) {
    log('SKIPPED: live Ollama SDK tests (GLIDE_LIVE_TESTS!=1)', 'info');
    process.exitCode = 0;
    return;
  }

  try {
    skipUnlessLive('Ollama SDK integration');
    const { endpoint, model } = await resolveLiveOllamaModel();
    log(`Using Ollama model: ${model} @ ${endpoint}`, 'info');

    const languageModel = resolveLanguageModel({
      provider: 'ollama',
      apiKey: '',
      model,
      customEndpoint: endpoint,
    });

    const result = await generateText({
      model: languageModel,
      maxOutputTokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly: GLIDE_PING' }],
      abortSignal: AbortSignal.timeout(Number(process.env.TEST_LIVE_TIMEOUT_MS || 60000)),
    });

    const text = String(result.text || '').trim();
    if (!text.includes('GLIDE_PING')) {
      throw new Error(`Expected GLIDE_PING in response, got: ${text.slice(0, 200)}`);
    }

    log('✓ Ollama SDK generateText returned GLIDE_PING', 'success');
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
