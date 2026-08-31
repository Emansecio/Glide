# Task 3 fix 2 report — run durability recovery snapshot advancement

## Result

Resolved remaining Critical finding from `task-3-review.md`. Implementation commit: `f4eae30` (`fix: advance safe run recovery snapshots`).

## Finding fixed

### Critical — safe resume used stale run-start history

Locations:
- `background.ts`
- `background/run-checkpoint-store.ts`
- `background/run-coordinator.ts`
- `background/run-recovery.ts`
- `tests/e2e/test-worker-recovery.ts`
- `tests/vitest/run-checkpoint-store.test.ts`
- `tests/vitest/run-coordinator.test.ts`
- `tests/vitest/run-recovery.test.ts`

Fix:
- Run-local recovery history is marked dirty whenever orchestration appends tool turns, retry/continuation turns, visual-delivery turns, or accepts compaction output.
- Before next safe model checkpoint, sanitized replay history is persisted with an advanced revision; coordinator checkpoint then persists matching revision.
- Terminal/compacted history is refreshed before committing checkpoint persistence.
- Recovery snapshot records `lastCommittedActionId`. A checkpoint containing a committed effect cannot auto-resume until recovery history records same action ID. Worker death between browser commit and replay-history persistence therefore pauses for confirmation instead of replaying effect.
- Oversized or failed recovery snapshots disable resume and clear stored active recovery state best-effort while live run continues with existing informational warning.

Coverage:
- Coordinator rejects non-advancing context revisions.
- Store preserves committed-action marker with sanitized paired tool history.
- Recovery decision requires confirmation for committed action missing from snapshot and resumes only when marker/revision match.
- Worker-restart fixture seeds committed mutative action with stale history, restarts MV3 worker, asserts `run_resume_required`, and asserts zero `tool_execution_start` replay.

## Validation evidence

### Focused

`npm run test:vitest -- --run tests/vitest/run-coordinator.test.ts tests/vitest/run-checkpoint-store.test.ts tests/vitest/run-recovery.test.ts tests/vitest/action-journal.test.ts`

PASS — 4 files, 19 tests.

`npm run build:all && node dist/tests/e2e/test-worker-recovery.js`

PASS:
- `PASS safe checkpoint emitted run_resume_started`
- `PASS committed action with stale recovery history required confirmation with zero replay`
- `PASS ambiguous action required confirmation with zero replay`

### Static gate

`npm run check`

PASS:
- TypeScript: PASS.
- Biome: `Checked 180 files ... No fixes applied.`

### Required milestone gate

`npm run test:frontier`

PASS:
- production `build:all`: PASS (`background.js 1023.1kb`, `panel.js 206.3kb`, `content.js 45.9kb`);
- Vitest: 15 files, 58 tests passed;
- legacy unit: 336 passed;
- validator: 33 passed;
- main E2E: 16 checks passed;
- frontier actions: click-once, find-element, checkbox-frame passed;
- worker recovery: safe resume, committed-stale zero replay, and ambiguous zero replay passed.

## Scope and residual risk

No plan/spec files changed. No paid/live model used. Recovery payload remains bounded and sanitized. If `chrome.storage.session` is externally unavailable for both write and cleanup, live run still continues with automatic resume disabled in current worker; browser storage failure itself remains platform-controlled.
