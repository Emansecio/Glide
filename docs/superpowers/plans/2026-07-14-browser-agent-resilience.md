# Browser Agent Resilience Implementation Plan

> **For agentic workers:** Execute this plan task by task. Keep changes surgical, preserve unrelated work in the dirty tree, and validate each slice before continuing.

**Goal:** Make Glide recover predictably from browser-action failures, deliver visual context to every supported provider, avoid premature termination and repeated-action loops, and wait for usable page state without changing the visible settings UI.

**Architecture:** Keep the current MV3 background/content/sidepanel structure. Add only small testable helpers where the existing large background flow needs explicit policy: runtime-setting ownership, activity-based timeout, visual-capability routing, repeated-failure signatures, and bridge fallback classification. Reuse the existing injection and DOM-inspection paths as fallbacks rather than creating a second automation stack.

**Tech Stack:** Chrome Extension Manifest V3, TypeScript, AI SDK, Playwright, existing custom unit/integration/E2E runners.

---

## Task 1: Fix bridge message ownership and frame fallback

**Files:**
- Modify: `content.ts`
- Modify: `tools/browser-tools.ts`
- Create or modify: `tools/content-bridge.ts`
- Modify: `tests/unit/run-unit-tests.ts`
- Modify: `tests/e2e/run-e2e.ts`

1. Add a failing unit test proving that only `ELEMENT_NOT_FOUND` and `BRIDGE_UNSUPPORTED` bridge results request the existing injection fallback; definitive errors remain final.
2. Add a failing browser test that loads the production content bundle and asserts that `glide_bridge/ping` is answered by the bridge listener, not by the legacy action listener.
3. Restrict the legacy content listener to its known `message.action` commands and return `false` for unowned messages.
4. Route recoverable bridge misses to the existing all-frame injection path for `click` and `type`.
5. Run the focused unit and E2E checks and confirm the ping plus fallback behavior are green.

## Task 2: Load all runtime settings and use an inactivity timeout

**Files:**
- Modify: `sidepanel/ui/settings-keys.ts`
- Modify: `background/settings-cache.ts`
- Create: `background/activity-timeout.ts`
- Modify: `background.ts`
- Modify: `tests/unit/run-unit-tests.ts`

1. Add failing tests for the complete runtime-key list and for a resettable timeout that does not expire while tool work remains active.
2. Keep the five user-facing settings keys unchanged and export a separate exhaustive `RUNTIME_SETTINGS_KEYS` list for background loading and invalidation.
3. Replace the fixed whole-pass model timer with a small inactivity watchdog. Reset it on streamed text/reasoning chunks and immediately before/after each tool execution; postpone expiry while a tool call is active.
4. Preserve the existing absolute run watchdog and safety caps.
5. Run focused tests, type validation, and confirm advanced stored settings affect the runtime again without exposing new UI controls.

## Task 3: Deliver screenshots to every supported provider

**Files:**
- Modify: `background.ts`
- Modify: `ai/sdk-client.ts` only if capability metadata is needed
- Modify: `tests/unit/run-unit-tests.ts`

1. Add failing tests for visual eligibility: Ollama is eligible without an API key; cloud providers require their configured authentication; Anthropic keeps direct image media while Codex, OpenCode, and Ollama use synchronous textual visual description.
2. Centralize the provider-capability decision in a small pure helper.
3. For explicit and failure screenshots, await the existing visual-description path before the current model pass continues when direct image media is unavailable.
4. Avoid duplicate descriptions for Anthropic direct-media requests.
5. If visual analysis fails, append a concise warning and continue with fresh DOM structure instead of aborting the run.
6. Run focused tests and the provider request-shape tests.

## Task 4: Bound failed-action recovery and repeated loops

**Files:**
- Create: `background/failure-recovery.ts`
- Modify: `background.ts`
- Modify: `tests/unit/run-unit-tests.ts`

1. Add failing tests for a failure signature containing tool name, normalized target/selector, tab ID, and URL; the third identical failure must return `REPEATED_FAILURE`.
2. Add failing tests for one forced continuation when a model pass ends after failed tools without verification, followed by final failure if no progress occurs.
3. Record only failed browser actions; reset the matching counter after a successful action or meaningful page-state change.
4. Inject the structured recovery notice into the existing prompt path and require selector refinement, `findElement`, `wait`, or fresh structure before retrying.
5. Preserve existing step, recovery, tab, screenshot, and event limits.
6. Run focused tests and an integration scenario that previously repeated the same action.

## Task 5: Wait for navigation readiness and keep DOM context fresh

**Files:**
- Modify: `tools/browser-tools.ts`
- Modify: `background/dom-cache.ts`
- Modify: `background/service-config.ts`
- Modify: `tests/unit/run-unit-tests.ts`
- Modify: `tests/e2e/run-e2e.ts`

1. Add failing tests for the shorter DOM-cache TTL and invalidation after `wait` and `dismissModal`.
2. Add a bounded tab-readiness helper used by `navigate` and `openTab`: wait for Chrome load completion, then briefly probe the content bridge.
3. Return navigation success with `ready: false` and an actionable warning when readiness times out, so the agent can inspect/wait rather than treating accepted navigation as fully usable.
4. Change the DOM cache default TTL from 30 seconds to 5 seconds and include `wait`/`dismissModal` in invalidating operations.
5. Run focused unit and browser tests for accepted navigation, delayed readiness, and bounded timeout.

## Task 6: Repair validation coverage and provider documentation

**Files:**
- Modify: `tests/e2e/run-e2e.ts`
- Modify: `README.md`
- Modify other existing test fixtures only where required by current tab-scoped behavior

1. Replace the stale `#tabSelectorBtn` assertion with assertions matching the current tab-scoped side-panel architecture.
2. Keep the production-bundle bridge ping as a permanent regression test.
3. Correct the provider list to Anthropic, Codex, OpenCode, and Ollama; describe Kimi only as an OpenCode model preset if mentioned.
4. Run `npm run build` as the required production build.
5. Run the full validator, unit, integration, and E2E suites. Separate any pre-existing unrelated blocker from failures introduced by this implementation.
6. Inspect the final diff only for touched files. Do not stage or commit because the workspace already contains unrelated user work.

## Acceptance Criteria

- `glide_bridge/ping` reaches the bridge listener in the real production content bundle.
- Recoverable top-frame element misses reach the existing all-frame fallback.
- Background runtime loading honors all currently supported advanced settings while the visible settings UI remains unchanged.
- Active streaming/tool execution resets model inactivity timeout; the absolute run watchdog still bounds execution.
- Explicit/failure screenshots become usable context for Anthropic, Codex, OpenCode, and Ollama.
- Three identical failed actions stop with a structured repeated-failure error, and one bounded recovery continuation is attempted before final failure.
- Navigation reports whether the destination is actually ready, with bounded waiting.
- DOM structure is cached for at most 5 seconds and invalidated by wait/modal transitions.
- Production build and all relevant automated suites pass.
