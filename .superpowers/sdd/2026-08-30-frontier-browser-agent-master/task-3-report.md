# Task 3 report — Run durability and orchestration

## Result

Implemented milestone B durability/orchestration in isolated worktree without changing plan/spec files. Preserved vanilla TypeScript/CSS, tab-scoped panel behavior, public tool names, bridge-first/CDP opt-in behavior, per-run `buildRunToolSet` closures, stop/sentinel/tab-lock flows, and migration-compatible runtime fields.

Commit range: `5ff392a..eafe8a7` (base before milestone: `b1c83d2`).

## Commits

1. `5ff392a` — `feat: centralize run lifecycle transitions`
2. `7c23050` — `feat: persist safe active run checkpoints`
3. `1f8bcf0` — `feat: journal browser effects before dispatch`
4. `b0a7a9c` — `feat: resume safe runs after worker restart`
5. `7266580` — `feat: expose explicit run terminal reasons`
6. `e8e670e` — `feat: deliver asynchronous vision to model loop`
7. `798b2b1` — `feat: verify effects with scoped browser evidence`
8. `b151e00` — `chore: format run durability milestone`
9. `eafe8a7` — `fix: report bounded pending visual context`

## Behavior delivered

- Central `RunCoordinator` with explicit frozen transition table, terminal reasons, defensive state snapshots, action/context metadata, and invalid-transition failure.
- Versioned `glideActiveRunCheckpointV1` persistence in `chrome.storage.session`; bounded serialization; invalid/wrong-version/terminal cleanup; write failures disable resume without failing live run.
- Separate bounded recovery-context snapshot keyed by revision. It rejects image/base64, tool-message, and oversized histories rather than persisting prohibited bodies.
- Exactly-once mutative action journal with deterministic run sequence IDs, `prepared -> in_flight -> committed`, idempotent commit, persisted state before dispatch, serialized per-run mutative dispatch, and restored `in_flight -> ambiguous` behavior.
- Startup recovery decisions: safe model/committing checkpoints resume with new run ID plus `resumedFromRunId`; ambiguous effects emit `run_resume_required` and never replay; stale/unsafe checkpoints emit `run_interrupted`.
- Worker-restart Playwright gate integrated into canonical `test:e2e:run`/`test:frontier`.
- Additive runtime messages and `assistant_final.finishReason`; transcript metadata retains same finish reason; partial non-empty streaming output is retained on stop/failure/interruption/ambiguity.
- Panel states: `Aguardando você`, `Interrompida`, `Ação precisa de confirmação`, normal `Pronto`.
- Async `VisionInbox` delivers each description once after cache anchor; late terminal results are discarded; explicit visual requests wait a bounded second and report deterministic pending status if description is still unavailable.
- `VerificationState` replaces global boolean semantics with effect/observation evidence scoped by tab, frame, DOM revision, and navigation revision. `wait` is observation-only. Declared successful postconditions clear pending verification.

## Changed files

- `ai/message-schema.ts`
- `background.ts`
- `background/action-journal.ts`
- `background/context-transaction.ts`
- `background/run-checkpoint-store.ts`
- `background/run-coordinator.ts`
- `background/run-recovery.ts`
- `background/run-terminal-reason.ts`
- `background/run-types.ts`
- `background/service-config.ts`
- `background/storage-access.ts`
- `background/verification-state.ts`
- `background/vision-inbox.ts`
- `package.json`
- `scripts/build.mjs`
- `sidepanel/ui/panel-chat.ts`
- `sidepanel/ui/panel-core.ts`
- `sidepanel/ui/panel-status.ts`
- `tests/e2e/test-worker-recovery.ts`
- `tests/vitest/action-journal.test.ts`
- `tests/vitest/run-checkpoint-store.test.ts`
- `tests/vitest/run-coordinator.test.ts`
- `tests/vitest/run-recovery.test.ts`
- `tests/vitest/run-terminal-reason.test.ts`
- `tests/vitest/verification-state.test.ts`
- `tests/vitest/vision-inbox.test.ts`
- `types/runtime-messages.ts`

Diff summary: 27 files, 1,673 insertions, 88 deletions before this report.

## TDD evidence

### Red

Each new contract started missing and failed module resolution:

- `npm run test:vitest -- --run tests/vitest/run-coordinator.test.ts`
  - FAIL: `Cannot find module '../../background/run-coordinator.js'`
- `npm run test:vitest -- --run tests/vitest/run-checkpoint-store.test.ts`
  - FAIL: `Cannot find module '../../background/run-checkpoint-store.js'`
- `npm run test:vitest -- --run tests/vitest/action-journal.test.ts`
  - FAIL: `Cannot find module '../../background/action-journal.js'`
- `npm run test:vitest -- --run tests/vitest/run-recovery.test.ts`
  - FAIL: `Cannot find module '../../background/run-recovery.js'`
- `npm run test:vitest -- --run tests/vitest/run-terminal-reason.test.ts`
  - FAIL: `Cannot find module '../../background/run-terminal-reason.js'`
- `npm run test:vitest -- --run tests/vitest/vision-inbox.test.ts`
  - FAIL: `Cannot find module '../../background/vision-inbox.js'`
- `npm run test:vitest -- --run tests/vitest/verification-state.test.ts`
  - FAIL: `Cannot find module '../../background/verification-state.js'`

Intermediate failures also caught transition typing/semantics and production fixture issues:

- Coordinator first green attempt: 2 passed, 1 failed — `Invalid run transition: starting -> awaiting_user.`
- Typecheck then caught readonly transition inference: `Type 'readonly string[]' is not assignable to type 'readonly RunPhase[]'.`
- Worker fixture first termination attempt: `TypeError: self.close is not a function`; fixture moved to CDP target termination.
- First lint gate failed on 16 formatting/import findings; `npx biome check --write .` fixed 14 files, then `npm run check` passed.

### Green focused gates

- Coordinator: 3/3 passed; typecheck passed; production build passed.
- Checkpoint + coordinator: 7/7 passed; typecheck passed; production build passed.
- Journal + checkpoint + coordinator: 11/11 passed; typecheck passed; production build passed.
- Recovery + journal + checkpoint: 12/12 passed; typecheck passed.
- Worker recovery: `PASS safe checkpoint emitted run_resume_started`; `PASS ambiguous action required confirmation with zero replay`.
- Terminal reason: 3/3 passed; typecheck passed; production build passed.
- Vision inbox: 3/3 passed; typecheck passed; production build passed.
- Verification state: 4/4 passed; typecheck passed; production build passed.

## Final validation

### `npm run test:frontier` — PASS (final run at `eafe8a7`)

Exact summary:

- Production `build:all`: PASS
  - `dist/background.js 1016.3kb`
  - `dist/sidepanel/panel.js 206.3kb`
  - `dist/content.js 45.9kb`
- Vitest: `Test Files 15 passed (15)`; `Tests 53 passed (53)`
- Legacy unit: `Tests Passed: 336`; `All unit tests passed!`
- Extension validator: `Tests Passed: 33`; `[OK] Extension validation passed!`
- Main E2E: 16 checks passed; `All E2E tests passed!`
- Frontier action fixtures:
  - `PASS frontier action case: click-once`
  - `PASS frontier action case: find-element`
  - `PASS frontier action case: checkbox-frame`
- Worker recovery:
  - `PASS safe checkpoint emitted run_resume_started`
  - `PASS ambiguous action required confirmation with zero replay`

### `npm run check` — PASS

- `tsc -p tsconfig.json --noEmit`: PASS
- `biome check .`: `Checked 180 files ... No fixes applied.`

### Repository state

- `git diff --check b1c83d2..HEAD`: PASS, no output.
- No plan/spec files changed.
- No staged or unstaged files before report creation.

## Self-review

Reviewed transition legality, storage failure degradation, checkpoint payload boundaries, action dispatch order, stop/abort interaction, restored in-flight behavior, runtime-message migration compatibility, panel run-ID reconciliation, vision cache placement, scoped verification, and canonical gate inclusion.

Findings:

- No blocker found.
- Mutative tools remain serialized per run only around dispatch/journal commit, preventing concurrent checkpoint ownership from hiding another in-flight effect.
- `buildRunToolSet` remains created per run; no execute closure cache introduced.
- CDP remains opt-in; durability code does not alter tool permission policy.
- Ambiguous recovery never calls `BrowserTools.executeTool` and keeps composer interactive.

## Residual risks

1. Recovery context intentionally refuses prior tool-message histories, embedded base64/image content, or payloads above 128 KiB. Such runs produce explicit `run_interrupted` instead of unsafe/incomplete automatic resume. This favors no-replay/context-integrity over broader resume coverage.
2. Ambiguous recovery presents status/banner and leaves composer interactive; it does not add dedicated confirm/discard buttons. User continuation replaces stale checkpoint without replay.
3. Explicit async visual descriptions receive a 1-second bounded final wait. Slower descriptions produce deterministic pending disclosure instead of blocking run up to provider timeout.
4. Worker fixture validates Chrome target restart, resume event, and zero tool replay from an ambiguous checkpoint; it does not use a paid/live model, by design.

## Fix 1 — review findings resolved

Implementation commit: `2e66e9e` (`fix: preserve tool history in run recovery`).

- **Important safe-resume gap:** `background/run-checkpoint-store.ts` now sanitizes normal tool-call/tool-result history for recovery instead of rejecting every `role: 'tool'` message. Pairing IDs remain intact; tool arguments/results are redacted through persistence sanitizers; image/base64 payloads and sensitive keyed values are stripped; total snapshot remains capped at 128 KiB. `background.ts` now emits existing checkpoint-unavailable warning when either checkpoint state or recovery context cannot be stored.
- **Minor stopped label mismatch:** `sidepanel/ui/panel-core.ts` now routes explicit `run_stopped` status through `getTerminalStatusPresentation('stopped')`, yielding required `Interrompida` label.
- **Coverage:** added realistic prior tool turn recovery test, pairing/redaction assertions, byte-bound failure test, and stopped-label assertion.

Validation after fix:

- Focused: `npm run test:vitest -- --run tests/vitest/run-checkpoint-store.test.ts tests/vitest/run-recovery.test.ts tests/vitest/run-terminal-reason.test.ts` — PASS, 3 files / 14 tests.
- Required check: `npm run check` — PASS, TypeScript and Biome (`Checked 180 files ... No fixes applied.`).
- Milestone gate: `npm run test:frontier` — PASS:
  - build: production `build:all` passed;
  - Vitest: 15 files / 56 tests passed;
  - legacy unit: 336 passed;
  - validator: 33 passed;
  - main E2E: 16 checks passed;
  - frontier actions: click-once, find-element, checkbox-frame passed;
  - worker recovery: safe resume event and ambiguous zero-replay checks passed.

Fix evidence: `.superpowers/sdd/2026-08-30-frontier-browser-agent-master/task-3-fix-1-report.md`.

## Fix 2 — stale same-turn recovery snapshot resolved

Implementation commit: `f4eae30` (`fix: advance safe run recovery snapshots`).

- **Critical same-turn replay gap:** recovery history now refreshes after run-local tool/retry/visual history changes, after compaction, and before terminal context commit. Each refresh advances coordinator `contextRevision`; following checkpoint persists matching revision.
- **Commit-to-history crash window:** recovery snapshots carry `lastCommittedActionId`. Recovery pauses when checkpoint committed action is absent from snapshot, preventing auto-replay between browser-effect commit and replay-history persistence.
- **Storage degradation:** oversized/failed recovery snapshots disable resume and clear active recovery keys best-effort; live execution continues with informational warning.
- **Regression:** worker-restart fixture now covers committed mutative action plus stale history and asserts `run_resume_required` with zero `tool_execution_start` replay.

Validation after fix:

- Focused Vitest: `npm run test:vitest -- --run tests/vitest/run-coordinator.test.ts tests/vitest/run-checkpoint-store.test.ts tests/vitest/run-recovery.test.ts tests/vitest/action-journal.test.ts` — PASS, 4 files / 19 tests.
- Focused worker restart: `npm run build:all && node dist/tests/e2e/test-worker-recovery.js` — PASS, safe resume plus committed-stale and ambiguous zero-replay checks.
- Required check: `npm run check` — PASS, TypeScript and Biome (`Checked 180 files ... No fixes applied.`).
- Milestone gate: `npm run test:frontier` — PASS: production build; Vitest 15 files / 58 tests; legacy unit 336; validator 33; main E2E 16; all frontier action fixtures; all three worker-recovery checks.

Fix evidence: `.superpowers/sdd/2026-08-30-frontier-browser-agent-master/task-3-fix-2-report.md`.
