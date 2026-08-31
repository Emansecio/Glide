import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frontierCases } from './frontier-cases.js';
import { gradeFrontierCase } from './frontier-graders.js';
import { parseFrontierTraceOutput } from './frontier-trace.js';

const vitestCommand = (file: string, testName: string) =>
  [
    process.execPath,
    [
      path.resolve('node_modules/vitest/vitest.mjs'),
      'run',
      '--run',
      file,
      '--testNamePattern',
      testName,
      '--reporter',
      'verbose',
    ],
  ] as const;
const fixtureCommands: Record<string, readonly [string, readonly string[]]> = {
  'click-once': [process.execPath, ['dist/tests/e2e/test-frontier-actions.js', '--case', 'click-once']],
  'form-frame': [process.execPath, ['dist/tests/e2e/test-frontier-actions.js', '--case', 'checkbox-frame']],
  'stale-handle': [process.execPath, ['dist/tests/e2e/test-stable-handles.js']],
  'shadow-dialog': vitestCommand('tests/vitest/stable-element-handle.test.ts', 'emits shadow-dialog eval trace'),
  'spa-navigation': vitestCommand('tests/vitest/action-postcondition.test.ts', 'emits spa-navigation eval trace'),
  'compaction-stop': vitestCommand('tests/vitest/compaction-transaction.test.ts', 'emits compaction-stop eval trace'),
  'worker-safe-resume': [process.execPath, ['dist/tests/e2e/test-worker-recovery.js']],
  'worker-ambiguous-action': [process.execPath, ['dist/tests/e2e/test-worker-recovery.js']],
  'long-markdown': vitestCommand('tests/vitest/markdown-renderer.test.ts', 'emits long-markdown eval trace'),
  'history-restart': vitestCommand('tests/vitest/history-budget.test.ts', 'emits history-restart eval trace'),
};

const grades = frontierCases.map((evalCase) => {
  const fixturePath = path.resolve(process.cwd(), evalCase.fixture.split('#', 1)[0]);
  if (!fs.existsSync(fixturePath)) {
    return {
      caseId: evalCase.id,
      passed: false,
      failures: [`fixture missing: ${evalCase.fixture}`],
      metrics: {},
    };
  }

  const [command, args] = fixtureCommands[evalCase.id];
  const child = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: evalCase.timeoutMs,
    env: { ...process.env, GLIDE_FRONTIER_EVAL_CASE: evalCase.id },
  });
  const output = `${child.stdout || ''}\n${child.stderr || ''}`.trim();
  if (child.status !== 0) {
    return {
      caseId: evalCase.id,
      passed: false,
      failures: [`fixture command failed with status ${child.status ?? 1}: ${output.slice(-500)}`],
      metrics: {},
    };
  }

  try {
    return gradeFrontierCase(evalCase, parseFrontierTraceOutput(output, evalCase.id));
  } catch (error) {
    return {
      caseId: evalCase.id,
      passed: false,
      failures: [error instanceof Error ? error.message : String(error)],
      metrics: {},
    };
  }
});
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glide-frontier-evals-'));
const outputPath = path.join(outputDir, 'summary.json');
const summary = {
  passed: grades.every((grade) => grade.passed),
  caseCount: grades.length,
  passedCount: grades.filter((grade) => grade.passed).length,
  grades,
};
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

for (const grade of grades) {
  console.log(
    `${grade.passed ? 'PASS' : 'FAIL'} ${grade.caseId}${grade.failures.length ? `: ${grade.failures.join(', ')}` : ''}`,
  );
}
console.log(`Frontier eval summary: ${outputPath}`);
if (!summary.passed) process.exitCode = 1;
