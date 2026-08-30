# Frontier 05 Evaluations and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove frontier invariants continuously and expose bounded diagnostics for latency, recovery, checkpoints, context, schema, and bundle cost.

**Architecture:** Add bounded execution telemetry and deterministic benchmark cases without introducing a remote observability service. CI gates behavior and budgets; live evaluations remain explicit optional commands.

**Tech Stack:** TypeScript, Vitest, Playwright, esbuild metafiles, Chrome MV3

**Spec:** `docs/superpowers/specs/2026-08-30-frontier-browser-agent-program-design.md`

## Global Constraints

- No remote service or user-content telemetry.
- No screenshots, page bodies, prompts, credentials, or typed values in metrics.
- CI fixtures remain deterministic and local.
- Live tests are opt-in and propagate failures.
- Budget changes require explicit code review through constants and tests.

---

### Task 1: Add bounded execution telemetry model

**Files:**
- Create: `background/execution-telemetry.ts`
- Modify: `background/execution-events.ts`
- Modify: `background.ts`
- Modify: `types/runtime-messages.ts`
- Create: `tests/vitest/execution-telemetry.test.ts`

**Interfaces:**

```ts
export type ToolTelemetry = {
  runId: string;
  actionId?: string;
  tool: string;
  tabId?: number;
  frameId?: number;
  queueMs: number;
  executeMs: number;
  verifyMs: number;
  totalMs: number;
  resultBytes: number;
  recoveryStage: string;
  checkpointPhase: string;
  contextRevision: number;
};
export class ExecutionTelemetryBuffer { append(event: ToolTelemetry): void; snapshot(): ToolTelemetry[]; }
```

- [ ] **Step 1: Write redaction and cap tests**

Append 250 events; expect latest 200. Assert serialized output omits args, URL query, text, result body, screenshot, and credentials. Durations clamp to finite nonnegative values.

- [ ] **Step 2: Run and confirm missing module**

Run: `npm run test:vitest -- --run tests/vitest/execution-telemetry.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement buffer and instrument tool phases**

Record timestamps around queue/dispatch/verification. Reuse existing execution event storage batching. Add optional fields to runtime messages without breaking old readers.

- [ ] **Step 4: Run telemetry and full tests**

Run: `npm run test:vitest -- --run tests/vitest/execution-telemetry.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background/execution-telemetry.ts background/execution-events.ts background.ts types/runtime-messages.ts tests/vitest/execution-telemetry.test.ts
 git commit -m "feat: record bounded run execution telemetry"
```

### Task 2: Add invariant benchmark manifest

**Files:**
- Create: `tests/evals/frontier-cases.ts`
- Create: `tests/evals/frontier-graders.ts`
- Create: `tests/evals/run-frontier-evals.ts`
- Modify: `scripts/build.mjs`
- Modify: `package.json`
- Create: `tests/vitest/frontier-graders.test.ts`

**Interfaces:**

```ts
export type FrontierCase = { id: string; fixture: string; goal: string; invariants: string[]; timeoutMs: number };
export type FrontierGrade = { caseId: string; passed: boolean; failures: string[]; metrics: Record<string, number> };
```

- [ ] **Step 1: Write grader tests**

Cases fail on duplicate events, cross-frame mutation, stale-handle mutation, repeated ambiguous action, missing context revision, or wrong terminal reason.

- [ ] **Step 2: Run and confirm missing graders**

Run: `npm run test:vitest -- --run tests/vitest/frontier-graders.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement deterministic cases**

Include click-once, form-frame, stale-handle, shadow-dialog, SPA navigation, compaction-stop, worker-safe-resume, worker-ambiguous-action, long-Markdown, and history-restart.

Add script:

```json
"test:evals": "npm run build:all && node dist/tests/evals/run-frontier-evals.js"
```

- [ ] **Step 4: Run eval suite**

Run: `npm run test:evals`  
Expected: all case grades pass and JSON summary writes only to temporary directory.

- [ ] **Step 5: Commit**

```bash
git add tests/evals tests/vitest/frontier-graders.test.ts scripts/build.mjs package.json
 git commit -m "test: add deterministic frontier behavior evals"
```

### Task 3: Add bundle and tool-schema budgets

**Files:**
- Create: `scripts/check-budgets.mjs`
- Create: `config/performance-budgets.json`
- Modify: `scripts/build.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Create: `tests/vitest/performance-budgets.test.ts`

**Interfaces:**

```json
{
  "backgroundBytes": 1050000,
  "panelBytes": 230000,
  "contentBytes": 120000,
  "coreToolSchemaChars": 12000,
  "fullToolSchemaChars": 33000
}
```

- [ ] **Step 1: Write budget parser tests**

Missing file, nonfinite values, and exceeded budget fail with measured/allowed output. Passing input exits zero.

- [ ] **Step 2: Run and confirm missing checker**

Run: `npm run test:vitest -- --run tests/vitest/performance-budgets.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Emit build metafile summary and implement checker**

Build writes `dist/build-metrics.json` containing output bytes and top input contributors. Checker imports tool pack builder to measure serialized schemas.

Add `npm run check:budgets` after production build in CI.

- [ ] **Step 4: Run budget gate**

Run: `npm run build && npm run check:budgets`  
Expected: PASS under committed budgets.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-budgets.mjs config/performance-budgets.json scripts/build.mjs package.json .github/workflows/ci.yml tests/vitest/performance-budgets.test.ts
 git commit -m "ci: enforce extension and tool schema budgets"
```

### Task 4: Migrate async legacy tests to Vitest

**Files:**
- Create: `tests/vitest/http-request.test.ts`
- Create: `tests/vitest/execute-script-runner.test.ts`
- Create: `tests/vitest/session-compaction-queue.test.ts`
- Create: `tests/vitest/injected-bridge.test.ts`
- Modify: `tests/unit/run-unit-tests.ts`

**Interfaces:**
- Replaces all six `runner.test(... async ...)` and two unawaited `runner.asyncTest(...)` cases with awaited Vitest tests.

- [ ] **Step 1: Copy assertions into awaited tests**

Use `it('...', async () => { await ... })`; preserve mocks and add `expect.assertions` where rejection paths matter.

- [ ] **Step 2: Deliberately break one assertion and prove gate fails**

Run focused test with intentionally wrong expected value. Expected: Vitest exits nonzero. Restore assertion.

- [ ] **Step 3: Remove migrated legacy registrations**

Delete eight false-green registrations from custom runner after equivalent Vitest cases pass.

- [ ] **Step 4: Run both runners**

Run: `npm run test:vitest && npm run test:unit`  
Expected: PASS; no `runner.test(... async` and no unawaited `runner.asyncTest` remain.

- [ ] **Step 5: Commit**

```bash
git add tests/vitest tests/unit/run-unit-tests.ts
 git commit -m "test: migrate asynchronous cases to Vitest"
```

### Task 5: Add optional live evaluation command

**Files:**
- Create: `tests/evals/run-live-frontier-evals.ts`
- Modify: `scripts/build.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- `npm run test:evals:live` requires `GLIDE_LIVE_TESTS=1`; otherwise exits with documented skip status `0`.
- When enabled, any case failure exits nonzero.

- [ ] **Step 1: Write environment-gate tests**

Disabled invocation returns skip result without browser launch. Enabled child status propagates exactly.

- [ ] **Step 2: Implement small live manifest**

Use stable public pages only for navigation/read capability; no account login, mutation, or CAPTCHA bypass. Record URLs in source and keep suite outside CI.

- [ ] **Step 3: Document commands and limitations**

Update README providers to include Command Code and document deterministic vs live evals.

- [ ] **Step 4: Run disabled gate and full deterministic gate**

Run: `npm run test:evals:live && npm run test:frontier && npm run test:evals`  
Expected: disabled live suite skips; deterministic suites pass.

- [ ] **Step 5: Commit**

```bash
git add tests/evals/run-live-frontier-evals.ts scripts/build.mjs package.json README.md
 git commit -m "test: add optional live browser evaluations"
```

### Task 6: Final integration and compatibility audit

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/API.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `manifest.json` only if dependency/build output requires no new permission

**Interfaces:**
- Documents runtime message additions, stable handles, postconditions, terminal reasons, checkpoint behavior, and migration.

- [ ] **Step 1: Run migration fixture against pre-program storage**

Load storage snapshot created from checkpoint commit `82772fc`; assert settings, sessions, plans, provider slots, and active panel ownership load without reset.

- [ ] **Step 2: Run complete verification matrix**

```bash
npm run check
npm run test:vitest
npm run test:unit
npm run build
npm run validate
npm run build:all
node dist/tests/e2e/run-e2e.js
npm run test:evals
npm run check:budgets
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 3: Update docs from verified behavior**

Document exact compatibility/migration path and residual limitations. Do not claim trusted events without CDP or automatic replay of ambiguous effects.

- [ ] **Step 4: Re-run production gate after docs/build metadata changes**

Run: `npm run build && npm run validate && npm run check:budgets`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md docs manifest.json
 git commit -m "docs: document frontier browser agent contracts"
```
