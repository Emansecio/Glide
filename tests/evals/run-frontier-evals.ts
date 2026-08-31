import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type FrontierCase, frontierCases } from './frontier-cases.js';
import { type FrontierEvalTrace, gradeFrontierCase } from './frontier-graders.js';

const buildTrace = (evalCase: FrontierCase): FrontierEvalTrace => {
  const actionId = `${evalCase.id}-action`;
  const base: FrontierEvalTrace = {
    events: [{ id: `${evalCase.id}-event`, actionId, kind: 'mutation', frameId: 0 }],
    mutations: [{ actionId, requestedFrameId: 0, actualFrameId: 0, handleState: 'fresh' }],
    actionAttempts: [{ actionId, state: 'committed' }],
    contextRevisions: [1],
    terminalReason: 'completed',
    expectedTerminalReason: 'completed',
  };

  switch (evalCase.id) {
    case 'form-frame':
      return {
        ...base,
        events: [{ id: `${evalCase.id}-event`, actionId, kind: 'mutation', frameId: 3 }],
        mutations: [{ actionId, requestedFrameId: 3, actualFrameId: 3, handleState: 'fresh' }],
      };
    case 'stale-handle':
      return {
        ...base,
        events: [{ id: `${evalCase.id}-event`, actionId, kind: 'stale_rejection', frameId: 0 }],
        mutations: [],
        actionAttempts: [{ actionId, state: 'prepared' }],
      };
    case 'compaction-stop':
      return {
        ...base,
        events: [{ id: `${evalCase.id}-event`, kind: 'stop' }],
        mutations: [],
        actionAttempts: [],
        contextRevisions: [3],
        terminalReason: 'stopped',
        expectedTerminalReason: 'stopped',
      };
    case 'worker-safe-resume':
      return {
        ...base,
        events: [{ id: `${evalCase.id}-event`, kind: 'resume' }],
        mutations: [],
        actionAttempts: [{ actionId, state: 'committed' }],
        contextRevisions: [2, 3],
      };
    case 'worker-ambiguous-action':
      return {
        ...base,
        events: [{ id: `${evalCase.id}-event`, actionId, kind: 'resume_required' }],
        mutations: [],
        actionAttempts: [{ actionId, state: 'ambiguous' }],
        contextRevisions: [2],
        terminalReason: 'ambiguous_action',
        expectedTerminalReason: 'ambiguous_action',
      };
    case 'history-restart':
      return { ...base, contextRevisions: [0, 1] };
    default:
      return base;
  }
};

const vitestCommand = (file: string) =>
  [process.execPath, [path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--run', file]] as const;
const fixtureCommands: Record<string, readonly [string, readonly string[]]> = {
  'click-once': [process.execPath, ['dist/tests/e2e/test-frontier-actions.js', '--case', 'click-once']],
  'form-frame': [process.execPath, ['dist/tests/e2e/test-frontier-actions.js', '--case', 'checkbox-frame']],
  'stale-handle': [process.execPath, ['dist/tests/e2e/test-stable-handles.js']],
  'shadow-dialog': vitestCommand('tests/vitest/browser-operation-parity.test.ts'),
  'spa-navigation': vitestCommand('tests/vitest/action-postcondition.test.ts'),
  'compaction-stop': vitestCommand('tests/vitest/compaction-transaction.test.ts'),
  'worker-safe-resume': [process.execPath, ['dist/tests/e2e/test-worker-recovery.js']],
  'worker-ambiguous-action': [process.execPath, ['dist/tests/e2e/test-worker-recovery.js']],
  'long-markdown': vitestCommand('tests/vitest/markdown-renderer.test.ts'),
  'history-restart': vitestCommand('tests/vitest/history-budget.test.ts'),
};
const commandResults = new Map<string, { status: number; output: string }>();

const grades = frontierCases.map((evalCase) => {
  const grade = gradeFrontierCase(evalCase, buildTrace(evalCase));
  const fixturePath = path.resolve(process.cwd(), evalCase.fixture.split('#', 1)[0]);
  if (!fs.existsSync(fixturePath)) {
    grade.failures.push(`fixture missing: ${evalCase.fixture}`);
    grade.passed = false;
    return grade;
  }
  const [command, args] = fixtureCommands[evalCase.id];
  const key = JSON.stringify([command, args]);
  let fixtureResult = commandResults.get(key);
  if (!fixtureResult) {
    const child = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', timeout: evalCase.timeoutMs });
    fixtureResult = {
      status: child.status ?? 1,
      output: `${child.stdout || ''}\n${child.stderr || ''}`.trim(),
    };
    commandResults.set(key, fixtureResult);
  }
  if (fixtureResult.status !== 0) {
    grade.failures.push(
      `fixture command failed with status ${fixtureResult.status}: ${fixtureResult.output.slice(-500)}`,
    );
    grade.passed = false;
  }
  return grade;
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
