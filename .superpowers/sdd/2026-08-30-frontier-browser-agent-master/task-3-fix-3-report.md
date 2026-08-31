# Task 3 fix 3 report — stale checkpoint invalidation on persistence failure

## Result

Resolved remaining Critical finding from `task-3-review.md` and supplied structured findings. Implementation commit: `3ed4162` (`fix: invalidate stale checkpoints on write failure`).

## Finding fixed

### Critical — checkpoint write failure left stale resumable state

Locations:
- `background/run-checkpoint-store.ts`
- `background/run-coordinator.ts`
- `background.ts`
- `tests/vitest/run-checkpoint-store.test.ts`

Fix:
- Any active-checkpoint write failure disables resume and best-effort removes both `glideActiveRunCheckpointV1` and `glideRunRecoveryContextV1`.
- Later persistence attempts while resume is disabled retry cleanup instead of repopulating recovery state.
- `RunCoordinator` reports first persistence failure per run through an injected failure handler.
- Background routes that handler, including action-journal `prepared`, `in_flight`, and `committed` persistence, through existing informational checkpoint warning. Warning remains deduplicated per active run; live execution continues.
- Recovery-context failures use same warning path and stale-key cleanup.

Coverage:
- Store regression seeds stale checkpoint and recovery keys, forces write failure, and asserts both keys are removed without throwing.
- Restart regression persists an earlier safe `model` checkpoint and matching recovery snapshot, proves it resolves to `resume`, then fails later action-phase persistence. Action remains dispatchable, commit continues, warning fires once, and a fresh store instance finds no checkpoint or recovery snapshot to auto-resume.

## Changed files

Implementation:
- `background.ts`
- `background/run-checkpoint-store.ts`
- `background/run-coordinator.ts`
- `tests/vitest/run-checkpoint-store.test.ts`

Evidence:
- `.superpowers/sdd/2026-08-30-frontier-browser-agent-master/task-3-report.md`
- `.superpowers/sdd/2026-08-30-frontier-browser-agent-master/task-3-fix-3-report.md`

No plan or spec files changed.

## Validation evidence

### TDD regression

Initial command:

`npm run test:vitest -- --run tests/vitest/run-checkpoint-store.test.ts`

Expected failure reproduced: 1 file, 2 failed / 5 passed. Failures showed stale `glideActiveRunCheckpointV1` survived and action-phase persistence produced no warning.

### Focused milestone tests

Command:

`npm run test:vitest -- --run tests/vitest/run-coordinator.test.ts tests/vitest/run-checkpoint-store.test.ts tests/vitest/action-journal.test.ts tests/vitest/run-recovery.test.ts tests/vitest/run-terminal-reason.test.ts tests/vitest/vision-inbox.test.ts tests/vitest/verification-state.test.ts`

Result: PASS — 7 files, 31 tests.

### Focused worker restart

Command:

`npm run build:all && node dist/tests/e2e/test-worker-recovery.js`

Result: PASS:
- `PASS safe checkpoint emitted run_resume_started`
- `PASS committed action with stale recovery history required confirmation with zero replay`
- `PASS ambiguous action required confirmation with zero replay`

### Static gate

Command: `npm run check`

Result: PASS.
- TypeScript: PASS.
- Biome: `Checked 180 files ... No fixes applied.`

### Required milestone gate

Command: `npm run test:frontier`

Result: PASS.
- Production `build:all`: PASS (`background.js 1023.7kb`, `panel.js 206.3kb`, `content.js 45.9kb`).
- Vitest: 15 files, 59 tests passed.
- Legacy unit: 336 passed.
- Extension validator: 33 passed.
- Main E2E: 16 checks passed.
- Frontier actions: click-once, find-element, checkbox-frame passed.
- Worker recovery: safe resume, committed-stale zero replay, and ambiguous zero replay passed.

### Repository checks

- `git diff --check a88b68c..3ed4162`: PASS, no output.
- Implementation diff: 4 files, 122 insertions, 27 deletions.
- Implementation commit: `3ed41628f49d630ef7230d353eba922942118e74`.

## Residual risks

If `chrome.storage.session` is externally unavailable for both write and removal, cleanup remains best-effort as required. Later persistence attempts retry removal while current worker keeps automatic resume disabled. No paid/live model used.

No open Critical, Important, or load-bearing spec findings remain from reviewed scope.
