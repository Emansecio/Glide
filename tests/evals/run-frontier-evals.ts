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

const grades = frontierCases.map((evalCase) => {
  const grade = gradeFrontierCase(evalCase, buildTrace(evalCase));
  const fixturePath = path.resolve(process.cwd(), evalCase.fixture.split('#', 1)[0]);
  if (!fs.existsSync(fixturePath)) {
    grade.failures.push(`fixture missing: ${evalCase.fixture}`);
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
