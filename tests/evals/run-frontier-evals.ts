import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frontierCases } from './frontier-cases.js';
import { gradeFrontierCase } from './frontier-graders.js';
import { parseFrontierTraceOutput } from './frontier-trace.js';

type FixtureGroup = {
  caseIds: string[];
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
};

const fixtureGroups: FixtureGroup[] = [
  {
    caseIds: ['click-once'],
    command: process.execPath,
    args: ['dist/tests/e2e/test-frontier-actions.js', '--case', 'click-once'],
    env: { GLIDE_FRONTIER_EVAL_CASE: 'click-once' },
    timeoutMs: 30_000,
  },
  {
    caseIds: ['form-frame'],
    command: process.execPath,
    args: ['dist/tests/e2e/test-frontier-actions.js', '--case', 'checkbox-frame'],
    env: { GLIDE_FRONTIER_EVAL_CASE: 'form-frame' },
    timeoutMs: 30_000,
  },
  {
    caseIds: ['stale-handle'],
    command: process.execPath,
    args: ['dist/tests/e2e/test-stable-handles.js'],
    env: { GLIDE_FRONTIER_EVAL_CASE: 'stale-handle' },
    timeoutMs: 30_000,
  },
  {
    caseIds: ['shadow-dialog'],
    command: process.execPath,
    args: ['dist/tests/e2e/test-frontier-actions.js', '--case', 'shadow-dialog'],
    timeoutMs: 30_000,
  },
  {
    caseIds: ['spa-navigation'],
    command: process.execPath,
    args: ['dist/tests/e2e/test-frontier-actions.js', '--case', 'spa-navigation'],
    timeoutMs: 30_000,
  },
  {
    caseIds: ['compaction-stop', 'long-markdown', 'history-restart'],
    command: process.execPath,
    args: ['dist/tests/e2e/test-frontier-runtime-evals.js'],
    timeoutMs: 60_000,
  },
  {
    caseIds: ['worker-safe-resume'],
    command: process.execPath,
    args: ['dist/tests/e2e/test-worker-recovery.js', '--case', 'worker-safe-resume'],
    env: { GLIDE_FRONTIER_EVAL_CASE: 'worker-safe-resume' },
    timeoutMs: 90_000,
  },
  {
    caseIds: ['worker-ambiguous-action'],
    command: process.execPath,
    args: ['dist/tests/e2e/test-worker-recovery.js', '--case', 'worker-ambiguous-action'],
    env: { GLIDE_FRONTIER_EVAL_CASE: 'worker-ambiguous-action' },
    timeoutMs: 90_000,
  },
];

const traces = new Map<string, ReturnType<typeof parseFrontierTraceOutput>>();
const commandFailures = new Map<string, string>();
for (const group of fixtureGroups) {
  const child = spawnSync(group.command, group.args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: group.timeoutMs,
    env: { ...process.env, ...group.env },
  });
  const output = `${child.stdout || ''}\n${child.stderr || ''}`.trim();
  if (child.status !== 0) {
    const failure = `fixture command failed with status ${child.status ?? 1}: ${output.slice(-1_000)}`;
    group.caseIds.forEach((caseId) => commandFailures.set(caseId, failure));
    continue;
  }
  for (const caseId of group.caseIds) {
    try {
      traces.set(caseId, parseFrontierTraceOutput(output, caseId));
    } catch (error) {
      commandFailures.set(caseId, error instanceof Error ? error.message : String(error));
    }
  }
}

const grades = frontierCases.map((evalCase) => {
  const fixturePath = path.resolve(process.cwd(), evalCase.fixture.split('#', 1)[0]);
  if (!fs.existsSync(fixturePath)) {
    return { caseId: evalCase.id, passed: false, failures: [`fixture missing: ${evalCase.fixture}`], metrics: {} };
  }
  const commandFailure = commandFailures.get(evalCase.id);
  if (commandFailure) {
    return { caseId: evalCase.id, passed: false, failures: [commandFailure], metrics: {} };
  }
  const trace = traces.get(evalCase.id);
  if (!trace) {
    return { caseId: evalCase.id, passed: false, failures: ['fixture trace missing'], metrics: {} };
  }
  return gradeFrontierCase(evalCase, trace);
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
