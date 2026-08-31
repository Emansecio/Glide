# Task 4 report — Browser kernel

Status: DONE_WITH_CONCERNS

Commit range: `365970e^..0351282` (base `eee3e1b`, head `0351282`)

## Commits

- `365970e feat: route browser operations by explicit frame`
- `f65ab6b feat: add snapshot-scoped stable element handles`
- `e194da1 refactor: centralize DOM operations in content bridge`
- `9f1e7dd feat: verify browser action postconditions`
- `05f3c7f feat: add opt-in native browser input backend`
- `a50f57b perf: select browser tools by execution phase`
- `0351282 style: format browser kernel sources`

## Implemented

- Typed `BrowserBridgeClient` with explicit `{ frameId }`, aborts, typed unavailable/timeout results, and shared frame-probe deadline.
- Bridge-first routing for `findElement` and `click`; timed-out mutations never fall through to injection.
- Per-frame snapshot registry: eight snapshots, 60-second expiry, throttled DOM revision tracking.
- Stable handles containing snapshot/ref/tab/frame/selector/fingerprint/revision; stale or cross-frame handles fail closed with candidates.
- Handles returned by bridge `findElement` and `readPage`; accepted by action schemas while selector contracts remain compatible.
- Canonical content operation packs for reads, actions, forms, and waits. Deleted `tools/injected-fn-registry.ts` and its `new Function` path.
- Optional postconditions for click/type/select. Action executes once; polling returns verified evidence or `POSTCONDITION_FAILED` plus observed state.
- Bridge-default input policy and opt-in CDP native hover/drag. Disabled permission returns `NATIVE_INPUT_PERMISSION_REQUIRED`; native source coordinates require verified stable handle; CDP sessions detach in `finally`.
- Deterministic tool packs preserving public names and unknown/non-browser definitions. Core schema remains under 12,000 JSON characters. `buildRunToolSet` still creates per-run execute closures.
- Production `dist` rebuilt after milestone slices.

## Changed files

- `ai/runtime-cache.ts`
- `ai/tool-packs.ts`
- `background.ts`
- `content/dom-interact.ts`
- `content/element-snapshot.ts`
- `content/glide-bridge.ts`
- `content/operations/action.ts`
- `content/operations/form.ts`
- `content/operations/read.ts`
- `content/operations/wait.ts`
- `scripts/build.mjs`
- `tests/e2e/test-frontier-actions.ts`
- `tests/e2e/test-stable-handles.ts`
- `tests/unit/run-unit-tests.ts`
- `tests/vitest/action-postcondition.test.ts`
- `tests/vitest/browser-bridge-client.test.ts`
- `tests/vitest/browser-operation-parity.test.ts`
- `tests/vitest/input-backend.test.ts`
- `tests/vitest/stable-element-handle.test.ts`
- `tests/vitest/tool-packs.test.ts`
- `tools/action-postcondition.ts`
- `tools/browser-bridge-client.ts`
- `tools/browser-tools.ts`
- `tools/cdp-session.ts`
- `tools/content-bridge.ts`
- `tools/injected-fn-registry.ts` (deleted)
- `tools/input-backend.ts`
- `tools/stable-element-handle.ts`
- `tools/tool-definitions.ts`
- `tools/tool-schema.ts`

Diff: 30 files, 1,530 insertions, 800 deletions.

## TDD evidence

### Task 1

RED:

```text
npm run test:vitest -- --run tests/vitest/browser-bridge-client.test.ts
FAIL: Cannot find module '../../tools/browser-bridge-client.js'
```

GREEN:

```text
Test Files 1 passed (1)
Tests 4 passed (4)
PASS frontier action case: click-once
PASS frontier action case: find-element
```

### Task 2

RED:

```text
npm run test:vitest -- --run tests/vitest/stable-element-handle.test.ts
FAIL: Failed to resolve import '../../tools/stable-element-handle.js'
```

GREEN:

```text
Test Files 1 passed (1)
Tests 4 passed (4)
PASS stable element handles
```

Initial E2E build exposed missing test entry:

```text
Error: Cannot find module 'dist/tests/e2e/test-stable-handles.js'
```

Added explicit build entry; rerun passed.

### Task 3

RED:

```text
npm run test:vitest -- --run tests/vitest/browser-operation-parity.test.ts
FAIL: Cannot find module '../../content/operations/action.js'
```

GREEN:

```text
Test Files 1 passed (1)
Tests 14 passed (14)
BrowserTools source baseline printed by test
Unit Tests: 335 passed
PASS frontier action case: click-once
PASS frontier action case: find-element
```

`tools/injected-fn-registry.ts` deleted. Remaining `new Function` belongs only to explicit user-script runner, not browser DOM injection registry.

### Task 4

RED:

```text
npm run test:vitest -- --run tests/vitest/action-postcondition.test.ts
FAIL: Cannot find module '../../tools/action-postcondition.js'
```

GREEN:

```text
Test Files 1 passed (1)
Tests 2 passed (2)
PASS frontier action case: postcondition
```

Fixture asserts one checkbox click while postcondition verifies checked state.

### Task 5

RED:

```text
npm run test:vitest -- --run tests/vitest/input-backend.test.ts
FAIL: Cannot find module '../../tools/input-backend.js'
```

GREEN:

```text
Test Files 1 passed (1)
Tests 3 passed (3)
npm run test:frontier: PASS
```

### Task 6

RED:

```text
npm run test:vitest -- --run tests/vitest/tool-packs.test.ts
FAIL: Cannot find module '../../ai/tool-packs.js'
```

GREEN:

```text
Test Files 1 passed (1)
Tests 4 passed (4)
npm run test:frontier: PASS
```

## Final commands and outputs

```text
npm run test:frontier
PASS: 21 Vitest files / 90 tests; legacy unit 335 passed; validator 33 passed;
production E2E passed; frontier click/find/frame cases passed; worker recovery safe/committed/ambiguous cases passed with zero replay.
```

```text
npm run check
Initial run failed on Biome formatting only (17 diagnostics).
npx biome check --write .
Fixed 14 files.
npm run check
PASS: tsc --noEmit; Biome checked 196 files, no fixes.
```

```text
npm run build:all
PASS: background.js 1.0 MiB; sidepanel/panel.js 206.3 KiB; content.js 45.8 KiB; test bundles built.
```

```text
node dist/tests/e2e/test-stable-handles.js
PASS stable element handles
node dist/tests/e2e/test-frontier-actions.js --case postcondition
PASS frontier action case: postcondition
```

`git status --porcelain=v1`: empty. No staged files.

## Self-review

- No mutation fanout: bridge client always sends one tab plus one frame.
- No timed-out mutation replay: bridge timeout is returned, not injected again.
- Stable handle checks tab/frame, snapshot lifetime, selector resolution, and fingerprint before action.
- Action postcondition runs after single action and only observes/polls.
- CDP remains opt-in; bridge remains default and usable without debugger.
- `buildRunToolSet` remains per-run; pack filtering does not cache execute closures.
- Public tool names and selector fields remain present.
- Tab-scoped panel code untouched.
- Production build, validator, browser action suite, stable-handle suite, postcondition fixture, and worker recovery suite pass.

## Residual risks / concerns

1. Production pack selection currently derives only coarse report intent available at run setup: ordinary automation gets core; report intent adds extract. Pure selector supports forms/tabs/advanced/diagnostics and outstanding calls, but background does not yet pass raw task text or per-pass failure state. Form/diagnostic expansion is therefore not fully adaptive in live orchestration.
2. CDP-native fixture is policy-covered but not exercised with debugger permission in automated E2E; Chrome permission/banner environment remains manual/optional.
3. Legacy direct-injection algorithms remain in `BrowserTools` for bridge-disabled compatibility and MAIN-world-only diagnostics. Canonical production DOM path is content bridge; source-size reduction is smaller than full fallback deletion.

## Review gate

Self-review: no blocker found. Independent reviewer still required by acceptance contract. Focus review on live tool-pack expansion and bridge-disabled compatibility boundary.

## Fix 1 evidence

Status: DONE

Implementation commit: `381ba76 fix: close browser kernel review findings`

Closed review findings:

1. `url_changed` now captures pre-action URL when `from` is omitted; unchanged URL fails with `POSTCONDITION_FAILED`.
2. Stable handles now use shared deep-selector resolution for Glide `>>>` shadow selectors. Expired snapshots also return refreshed candidates.
3. Background now rebuilds tool packs per orchestration pass from latest user task text, active failures, and outstanding calls, then emits deterministic pack state in execution context.

Tests added/updated:

- `tests/vitest/action-postcondition.test.ts` — omitted-baseline unchanged-URL regression.
- `tests/vitest/stable-element-handle.test.ts` — shadow handle round-trip and expired-snapshot candidate recovery.
- `tests/vitest/background-tool-packs.test.ts` — background pass selection, failure diagnostics, outstanding-call retention, and prompt state.

Validation:

```text
Focused Vitest: 5 files / 30 tests passed.
npm run check: typecheck + Biome passed (199 files).
npm run build:all: production bundles passed.
Postcondition E2E: passed.
Stable-handle E2E: passed.
npm run test:frontier: 22 Vitest files / 96 tests; legacy unit 335; validator 33; all E2E and worker-recovery cases passed.
```

Full fix artifact: `.superpowers/sdd/2026-08-30-frontier-browser-agent-master/task-4-fix-1-report.md`.
