# Frontier 01 Action and Context Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce single browser activation, single-frame mutation, and one versioned context commit per turn.

**Architecture:** Extract pure action/selector/context contracts first, keep existing public tool names and runtime events through adapters, then redirect current call sites. Background remains canonical owner of context.

**Tech Stack:** TypeScript, Vitest, Playwright, Chrome MV3

**Spec:** `docs/superpowers/specs/2026-08-30-frontier-browser-agent-program-design.md`

## Global Constraints

- Every regression test must fail before implementation and pass afterward.
- Existing selector arguments and runtime messages remain accepted.
- Mutative tools may target exactly one frame.
- Context revisions are monotonic integers scoped to session lineage.
- Stop/abort prevents later compaction storage or runtime emission.

---

### Task 1: Make rich click exactly-once

**Files:**
- Modify: `content/dom-interact.ts:400-455`
- Create: `tests/e2e/test-frontier-actions.ts`
- Modify: `scripts/build.mjs`

**Interfaces:**
- Preserves: `performRichClick(element): ClickResult`.
- Produces invariant: one `click` event and one control state transition.

- [ ] **Step 1: Add browser regressions**

Fixture assertions:

```ts
expect(await counters('#button')).toMatchObject({ click: 1 });
expect(await checkboxState()).toMatchObject({ click: 1, change: 1, checked: true });
expect(await submitState()).toMatchObject({ submit: 1 });
```

Invoke production bridge `click`, not page-local helper.

- [ ] **Step 2: Run and confirm failures**

Run: `npm run build:all && node dist/tests/e2e/test-frontier-actions.js --case click-once`  
Expected: button click count `2`; checkbox remains `false`.

- [ ] **Step 3: Remove duplicate activation**

Keep pointer/mousedown/mouseup dispatch. Replace manual click event plus native click with one call:

```ts
try {
  eventTarget.click();
} catch (error) {
  return { success: false, code: 'CLICK_FAILED', error: String(error) };
}
```

Do not dispatch a separate `MouseEvent('click')`.

- [ ] **Step 4: Run action and legacy gates**

Run: `npm run build:all && node dist/tests/e2e/test-frontier-actions.js --case click-once && npm run test:unit`  
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add content/dom-interact.ts tests/e2e/test-frontier-actions.ts scripts/build.mjs
 git commit -m "fix: activate browser targets exactly once"
```

### Task 2: Extract scored unique selector engine

**Files:**
- Create: `content/selector-engine.ts`
- Modify: `content/dom-interact.ts`
- Modify: `tools/browser-tools.ts`
- Create: `tests/vitest/selector-engine.test.ts`

**Interfaces:**
- Produces:

```ts
export type SelectorCandidate = { selector: string; score: number; reason: string; unique: boolean };
export function matchesElementQuery(element: Element, query: string, fuzzy: boolean): { matched: boolean; score: number; reason: string };
export function buildUniqueSelector(element: Element, root?: Document | ShadowRoot | Element): SelectorCandidate;
```

- [ ] **Step 1: Write failing tests**

Cover one-character ID not matching unrelated phrase, duplicate stable class rejection, unique `data-testid`, accessible name ranking, and scoped structural fallback.

```ts
expect(matchesElementQuery(inputWithIdC, 'Second action', false).matched).toBe(false);
expect(buildUniqueSelector(secondAction).selector).not.toBe('.action');
```

Use `environment: 'jsdom'` only for this file through a file directive.

- [ ] **Step 2: Run and confirm missing module**

Run: `npm run test:vitest -- --run tests/vitest/selector-engine.test.ts`  
Expected: FAIL resolving selector engine.

- [ ] **Step 3: Implement engine and replace copies**

Require query field length at least three before reverse containment; prefer exact normalized equality/forward containment. Validate uniqueness with `querySelectorAll`. Replace selector builders and matching logic in content bridge and BrowserTools injected fallbacks.

- [ ] **Step 4: Run focused tests and browser fixture**

Run: `npm run test:vitest -- --run tests/vitest/selector-engine.test.ts && npm run build:all && node dist/tests/e2e/test-frontier-actions.js --case find-element`  
Expected: exact query ranks intended button first and selectors resolve uniquely.

- [ ] **Step 5: Commit**

```bash
git add content/selector-engine.ts content/dom-interact.ts tools/browser-tools.ts tests/vitest/selector-engine.test.ts
 git commit -m "fix: generate scored unique element selectors"
```

### Task 3: Restrict checkbox/radio mutation to one frame

**Files:**
- Modify: `tools/content-bridge.ts`
- Modify: `content/glide-bridge.ts`
- Modify: `content/dom-interact.ts`
- Modify: `tools/browser-tools.ts:7135-7233`
- Modify: `tools/tool-definitions.ts`
- Create: `tests/vitest/frame-target.test.ts`
- Modify: `tests/e2e/test-frontier-actions.ts`

**Interfaces:**
- Extends bridge client with optional `{ frameId }` message option.
- Adds bridge op `setChecked`.
- `fillForm` accepts optional `frameUrl` and `frameSelector` while retaining existing args.

- [ ] **Step 1: Add failing cross-frame test**

Create same `.consent` checkbox in top and child frame. Fill child explicitly; assert child checked and top unchecked. With no frame target and duplicate matches, expect `FRAME_AMBIGUOUS` and zero mutation.

- [ ] **Step 2: Run and confirm current multi-frame mutation**

Run: `npm run build:all && node dist/tests/e2e/test-frontier-actions.js --case checkbox-frame`  
Expected: both checkboxes mutate or ambiguity is not detected.

- [ ] **Step 3: Implement targeted bridge operation**

Use read-only frame probe to collect matching frame IDs. Resolve explicit frame through existing `resolveTargetFrameId`; otherwise require exactly one match. Send `setChecked` with `chrome.tabs.sendMessage(tabId, request, { frameId })`. Remove `allFrames: true` mutation.

- [ ] **Step 4: Run frame and unit tests**

Run: `npm run test:vitest -- --run tests/vitest/frame-target.test.ts && npm run build:all && node dist/tests/e2e/test-frontier-actions.js --case checkbox-frame`  
Expected: one frame mutates.

- [ ] **Step 5: Commit**

```bash
git add tools/content-bridge.ts content/glide-bridge.ts content/dom-interact.ts tools/browser-tools.ts tools/tool-definitions.ts tests
 git commit -m "fix: target one frame for checked form fields"
```

### Task 4: Introduce versioned context transaction

**Files:**
- Create: `background/context-transaction.ts`
- Modify: `background/session-context.ts`
- Modify: `background.ts`
- Modify: `types/runtime-messages.ts`
- Modify: `sidepanel/ui/panel-core.ts`
- Modify: `sidepanel/ui/panel-guards.ts`
- Create: `tests/vitest/context-transaction.test.ts`

**Interfaces:**

```ts
export type ContextCommit = {
  sessionId: string;
  previousSessionId?: string;
  revision: number;
  runId: string;
  turnId: string;
  messages: Message[];
  compacted: boolean;
  contextUsage: ContextUsage;
};

export class ContextTransactionStore {
  read(sessionId: string): { revision: number; messages: Message[] };
  commit(input: ContextCommitInput): ContextCommit;
}
```

- [ ] **Step 1: Write failing transaction tests**

Assert monotonic revision, stale source revision rejection, one terminal commit per run/turn, and duplicate commit idempotency.

- [ ] **Step 2: Run and confirm missing contract**

Run: `npm run test:vitest -- --run tests/vitest/context-transaction.test.ts`  
Expected: FAIL resolving module.

- [ ] **Step 3: Implement store adapter and runtime event**

Add additive `context_commit` runtime type. Existing `context_compacted` remains accepted during migration. Background commits final `nextHistory` once; compaction feeds messages into same terminal commit instead of emitting an independently appendable context payload.

Panel stores `contextRevision`, applies only newer snapshots, and never appends `assistant_final.responseMessages` when matching commit revision already arrived.

- [ ] **Step 4: Add and run panel ordering tests**

Test both event orders: commit then final, final then commit. Both produce one assistant response in context.

Run: `npm run test:vitest -- --run tests/vitest/context-transaction.test.ts && npm run typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background/context-transaction.ts background/session-context.ts background.ts types/runtime-messages.ts sidepanel/ui/panel-core.ts sidepanel/ui/panel-guards.ts tests/vitest/context-transaction.test.ts
 git commit -m "feat: commit model context by monotonic revision"
```

### Task 5: Make compaction abort-aware and transactional

**Files:**
- Modify: `background.ts:3371-3524`
- Modify: `background/session-lifecycle.ts`
- Modify: `background/context-transaction.ts`
- Create: `tests/vitest/compaction-transaction.test.ts`

**Interfaces:**
- `maybeCompactContext` consumes `sourceRevision` and `abortSignal`.
- It returns compacted messages; caller owns commit/emission.

- [ ] **Step 1: Write failing abort tests**

Simulate abort while summary promise is pending. Assert no session deletion, no new session, no context commit, and no `context_compacted` event. Test stale revision identically.

- [ ] **Step 2: Run and confirm current late commit**

Run: `npm run test:vitest -- --run tests/vitest/compaction-transaction.test.ts`  
Expected: FAIL because compaction commits independently.

- [ ] **Step 3: Combine abort signals and move commit to caller**

Use `AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)])` where supported, with a small compatibility helper otherwise. Before return validate run ownership, abort registry, tombstone, generation, and source revision. Include `previousSummary` in truncate-only fallback.

- [ ] **Step 4: Run compaction and complete gates**

Run: `npm run test:vitest -- --run tests/vitest/compaction-transaction.test.ts tests/vitest/context-transaction.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background.ts background/session-lifecycle.ts background/context-transaction.ts tests/vitest/compaction-transaction.test.ts
 git commit -m "fix: abort stale context compaction commits"
```

### Task 6: Fix manual tool ownership and prompt identity

**Files:**
- Create: `ai/system-prompt-mode.ts`
- Modify: `ai/default-prompt.ts`
- Modify: `background/settings-cache.ts`
- Modify: `background.ts`
- Modify: `sidepanel/ui/panel-settings.ts`
- Create: `tests/vitest/manual-tool-and-prompt.test.ts`

**Interfaces:**
- Produces `resolveSystemPromptMode(storedPrompt, storedMode): 'default' | 'custom'`.
- Manual run acquires/releases same ownership contract as normal run without becoming active model orchestration.

- [ ] **Step 1: Write failing tests**

Assert a custom prompt containing “Glide browser automation” remains custom. Assert exact shipped default migrates to default mode. Execute manual tool stub and expect underlying successful result, not `RUN_SUPERSEDED`.

- [ ] **Step 2: Run and confirm failures**

Run: `npm run test:vitest -- --run tests/vitest/manual-tool-and-prompt.test.ts`  
Expected: custom prompt replaced; manual result discarded.

- [ ] **Step 3: Implement explicit mode and scoped ownership lease**

Persist `systemPromptMode`. Infer only once during settings migration using exact normalized equality with shipped prompt. Add `withOrchestrationOwnership(runId, fn)` that restores previous owner in `finally`; manual tools use it.

- [ ] **Step 4: Run focused and full tests**

Run: `npm run test:vitest -- --run tests/vitest/manual-tool-and-prompt.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ai/system-prompt-mode.ts ai/default-prompt.ts background/settings-cache.ts background.ts sidepanel/ui/panel-settings.ts tests/vitest/manual-tool-and-prompt.test.ts
 git commit -m "fix: preserve custom prompts and manual tool results"
```
