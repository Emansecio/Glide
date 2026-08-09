# Browser Failure Terminal State and Runtime Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkboxes so progress can be tracked explicitly.

**Goal:** Make repeated browser-tool failures terminate visibly and consistently, while removing the confirmed low-risk bottlenecks in run, history, panel, DOM, and build paths.

**Architecture:** Keep the existing single automatic recovery attempt. Centralize the decision as a small pure helper, route thrown tool exceptions through the same result pipeline as ordinary tool failures, and emit one structured `run_error` when recovery is exhausted. The panel will use the existing error banner and add a concise failure turn to persisted transcript history. Performance changes remain local and preserve existing contracts.

**Tech Stack:** TypeScript, Chrome Extension Manifest V3 APIs, vanilla DOM, esbuild, Biome, custom unit/E2E harness.

---

## Task 1: Define and test the failed-tool terminal policy

- [x] Add unit tests in `tests/unit/run-unit-tests.ts` for three outcomes: no failure completes, first unverified browser failure continues once, and a second unverified failure terminates.
- [x] Add a pure decision helper in `background/failure-recovery.ts` returning `complete`, `continue`, or `fail`.
- [x] Keep `shouldForceFailedToolContinuation` as a compatibility wrapper only if existing callers/tests still need it.
- [x] Run the focused unit suite and confirm the new tests pass.

## Task 2: Emit a terminal browser error and normalize thrown exceptions

- [x] Add a unit-tested helper that turns a thrown tool exception into the existing `{ success: false }` contract with a stable error code.
- [x] In `background.ts`, replace the browser loop's boolean recovery check with the three-state policy.
- [x] On `fail`, extract the last failed tool result, sanitize and bound the tool name/code/error/hint, emit `run_error` with code `BROWSER_RECOVERY_EXHAUSTED`, release the run lock, and return before `run_quality_gate` or `assistant_final`.
- [x] Change the tool-execution catch path to assign the normalized failed result and continue through normalization, telemetry, recovery hints, and result dispatch instead of returning early.
- [x] Add or extend unit coverage for sanitization and thrown-error normalization.

## Task 3: Make terminal failure visible and persistent in the panel

- [x] Extend the panel E2E fixture to deliver a structured exhausted-recovery `run_error`.
- [x] Assert that busy/streaming controls are cleared, the red error banner is shown, and one concise assistant failure turn is added to the transcript.
- [x] In `sidepanel/ui/panel-core.ts`, record only explicitly marked terminal automation failures in transcript history; retain the existing error banner and cleanup behavior.
- [x] Fix the deterministic composer E2E expectation by making `setComposerBusy(true)` hide Send and show Stop through the existing centralized method.
- [x] Make the tool-failure metadata E2E open the activity surface before expecting an activity-tree row.
- [x] Run the focused E2E suite.

## Task 4: Apply confirmed low-risk runtime optimizations

- [x] In `background/run-pass-cache.ts`, append converted tail messages to the owned cache rather than copying the full history each pass; add a reference-preservation regression test.
- [x] In `tools/browser-tools.ts`, select the largest table with one linear scan and measure each table once.
- [x] In `sidepanel/ui/panel-history.ts`, reuse the coherent cached history index inside the serialized write queue before falling back to storage IPC.
- [x] In `background/panel-port.ts`, remove stale ports from both the Set and metadata map when posting fails.
- [x] In `sidepanel/ui/panel-tools.ts` and `panel-ui.ts`, coalesce tool-log autoscroll to one animation frame and declare its handle on the UI class.
- [x] Run unit tests and typecheck after the runtime changes.

## Task 5: Remove duplicate build work and verify the production package

- [x] Change `build:all` in `package.json` to invoke `scripts/build.mjs --target=all --prod` once, preserving one TypeScript check.
- [x] Run `npm run check`.
- [x] Run `npm run test:unit`.
- [x] Run `npm run test:e2e:run`.
- [x] Run `npm run validate`.
- [x] Run `npm run build` last so `dist/` contains only the production extension artifacts.
- [x] Inspect the final diff/files and report implemented fixes plus explicitly deferred higher-risk items.
