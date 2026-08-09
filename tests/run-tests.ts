#!/usr/bin/env node

/**
 * Main Test Runner
 * Runs validation, unit, and browser integration tests
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

async function runCommand(command: string, description: string) {
  log(`\n[RUN] ${description}...`, 'info');
  try {
    const { stdout, stderr } = await execAsync(command);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    log(`[OK] ${description} completed`, 'success');
    return true;
  } catch (error: any) {
    log(`[FAIL] ${description} failed`, 'error');
    console.error(error.stdout || error.stderr || error.message);
    return false;
  }
}

async function main() {
  log('========================================', 'info');
  log('            Glide - Test Suite          ', 'info');
  log('========================================', 'info');

  let allPassed = true;

  allPassed = (await runCommand('npm run lint', 'Lint')) && allPassed;
  allPassed = (await runCommand('node dist/tests/validate-extension.js', 'Extension Validation')) && allPassed;
  allPassed = (await runCommand('node dist/tests/unit/run-unit-tests.js', 'Unit Tests')) && allPassed;
  allPassed = (await runCommand('node dist/tests/e2e/run-e2e.js', 'E2E Tests')) && allPassed;

  log(`\n${'='.repeat(40)}`, 'info');
  if (allPassed) {
    log('[OK] All tests passed!', 'success');
    log('Extension is ready to use.', 'success');
    process.exit(0);
  }

  log('[FAIL] Some tests failed', 'error');
  log('Please fix the issues above.', 'error');
  process.exit(1);
}

main();
