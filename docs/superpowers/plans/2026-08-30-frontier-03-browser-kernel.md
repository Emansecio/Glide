# Frontier 03 Browser Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate browser DOM operations behind frame-addressable bridges, stable handles, postconditions, and adaptive tool packs.

**Architecture:** Content bridge becomes canonical all-frame execution kernel. Background resolves tab/frame and sends typed requests; duplicated injected implementations retire incrementally. Plain selectors remain compatible while stable handles become preferred.

**Tech Stack:** TypeScript, Chrome content scripts/MV3 messaging, CDP opt-in, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-08-30-frontier-browser-agent-program-design.md`

## Global Constraints

- No dynamic `eval` or `new Function` path.
- Mutation always targets one tab and one frame.
- Content bridge remains usable without debugger permission.
- CDP paths require existing opt-in permission.
- Existing tool names and selector args remain accepted.

---

### Task 1: Add typed frame-addressable bridge client

**Files:**
- Create: `tools/browser-bridge-client.ts`
- Modify: `tools/content-bridge.ts`
- Modify: `content/glide-bridge.ts`
- Modify: `tools/browser-tools.ts`
- Create: `tests/vitest/browser-bridge-client.test.ts`

**Interfaces:**

```ts
export class BrowserBridgeClient {
  send(tabId: number, frameId: number, op: GlideBridgeOp, payload: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<GlideBridgeResponse>;
  probeFrames(tabId: number, request: FrameProbeRequest): Promise<FrameProbeResult[]>;
}
```

- [ ] **Step 1: Write timeout/frame routing tests**

Mock `chrome.tabs.sendMessage`; assert `{ frameId }` option, abort handling, typed unavailable result, and one deadline shared across probe/dispatch.

- [ ] **Step 2: Run and confirm missing client**

Run: `npm run test:vitest -- --run tests/vitest/browser-bridge-client.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement client and adapt one read + one mutation**

Route `findElement` and `click` through client. Preserve current fallback only for bridge-unavailable reads; never replay timed-out mutation.

- [ ] **Step 4: Run browser bridge tests**

Run: `npm run test:vitest -- --run tests/vitest/browser-bridge-client.test.ts && npm run build:all && node dist/tests/e2e/test-frontier-actions.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/browser-bridge-client.ts tools/content-bridge.ts content/glide-bridge.ts tools/browser-tools.ts tests/vitest/browser-bridge-client.test.ts
 git commit -m "feat: route browser operations by explicit frame"
```

### Task 2: Add snapshot registry and stable handles

**Files:**
- Create: `content/element-snapshot.ts`
- Create: `tools/stable-element-handle.ts`
- Modify: `content/dom-interact.ts`
- Modify: `content/glide-bridge.ts`
- Modify: `tools/tool-schema.ts`
- Modify: `tools/tool-definitions.ts`
- Create: `tests/vitest/stable-element-handle.test.ts`
- Create: `tests/e2e/test-stable-handles.ts`

**Interfaces:**

```ts
export type StableElementHandle = { version: 1; snapshotId: string; ref: string; tabId: number; frameId: number; selector: string; fingerprint: ElementFingerprint; domRevision: number };
export function verifyElementHandle(handle: StableElementHandle, element: Element, currentRevision: number): HandleVerification;
```

- [ ] **Step 1: Write fingerprint and stale-handle tests**

Create snapshot, insert a new button before target, then act with original handle. Expected: intended element still resolves by selector/fingerprint or `STALE_ELEMENT_HANDLE`; never new ordinal element.

- [ ] **Step 2: Run and confirm current ref retargets**

Run: `npm run build:all && node dist/tests/e2e/test-stable-handles.js`  
Expected: ordinal ref resolves different element.

- [ ] **Step 3: Implement bounded per-frame snapshot registry**

Keep latest eight snapshots or 60 seconds, whichever first. Increment DOM revision via throttled `MutationObserver`. `readPage` and `findElement` return handle objects alongside refs/selectors.

- [ ] **Step 4: Accept handles in action schemas**

Add optional `handle` object to click, type, select, highlight, elementScreenshot, and pressKey. Selector remains accepted. Bridge verifies handle before mutation and returns refreshed candidates on stale failure.

Run: `npm run test:vitest -- --run tests/vitest/stable-element-handle.test.ts && npm run build:all && node dist/tests/e2e/test-stable-handles.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add content/element-snapshot.ts tools/stable-element-handle.ts content/dom-interact.ts content/glide-bridge.ts tools tests
 git commit -m "feat: add snapshot-scoped stable element handles"
```

### Task 3: Move canonical DOM operations into content bridge

**Files:**
- Create: `content/operations/read.ts`
- Create: `content/operations/action.ts`
- Create: `content/operations/form.ts`
- Create: `content/operations/wait.ts`
- Modify: `content/dom-interact.ts`
- Modify: `content/glide-bridge.ts`
- Modify: `tools/browser-tools.ts`
- Delete: `tools/injected-fn-registry.ts`
- Modify: `tests/unit/run-unit-tests.ts`

**Interfaces:**
- Content operation modules export source-normal functions called directly by bridge listeners.
- BrowserTools holds orchestration/routing only, not duplicate page algorithms.

- [ ] **Step 1: Add parity matrix tests**

For click, hover, type, pressKey, scroll, findElement, getContent, readPage, wait, selectOption, setChecked, dismissModal, and highlight, run top-frame and child-frame fixture cases through bridge.

- [ ] **Step 2: Record production bundle baseline**

Run esbuild with metafile and save measured numbers in test output. Expected baseline: BrowserTools contributes about 141 KiB minified.

- [ ] **Step 3: Extract operations and replace injected fallbacks**

Bridge listener imports operation registry. BrowserTools uses frame probes plus bridge client. Keep injection only for APIs unavailable to content script, such as selected MAIN-world diagnostics.

- [ ] **Step 4: Remove dead registry and tests**

Delete `new Function` registry paths and replace unit assertions with bridge routing assertions.

Run: `npm run test:frontier && npm run build`  
Expected: PASS; no `new Function` in browser injection registry.

- [ ] **Step 5: Commit**

```bash
git add -A content tools/browser-tools.ts tests/unit/run-unit-tests.ts
 git commit -m "refactor: centralize DOM operations in content bridge"
```

### Task 4: Add postcondition contracts

**Files:**
- Create: `tools/action-postcondition.ts`
- Modify: `tools/tool-schema.ts`
- Modify: `tools/tool-definitions.ts`
- Modify: `tools/browser-tools.ts`
- Modify: `content/operations/action.ts`
- Create: `tests/vitest/action-postcondition.test.ts`

**Interfaces:**

```ts
export type ActionPostcondition =
  | { kind: 'url_changed'; from?: string }
  | { kind: 'visible'; selector: string }
  | { kind: 'hidden'; selector: string }
  | { kind: 'checked'; selector: string; value: boolean }
  | { kind: 'text_contains'; selector?: string; text: string };
```

- [ ] **Step 1: Write postcondition tests**

Assert matching evidence returns `verified: true`; timeout returns successful action plus `verified: false`, code `POSTCONDITION_FAILED`, and observed state.

- [ ] **Step 2: Run and confirm absent contract**

Run: `npm run test:vitest -- --run tests/vitest/action-postcondition.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement optional schema and bridge evaluation**

Action executes once, then observation polls within remaining shared deadline. Never replay action because postcondition failed.

- [ ] **Step 4: Run focused and fixture tests**

Run: `npm run test:vitest -- --run tests/vitest/action-postcondition.test.ts && npm run build:all && node dist/tests/e2e/test-frontier-actions.js --case postcondition`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/action-postcondition.ts tools/tool-schema.ts tools/tool-definitions.ts tools/browser-tools.ts content/operations/action.ts tests
 git commit -m "feat: verify browser action postconditions"
```

### Task 5: Add hybrid native input backend

**Files:**
- Create: `tools/input-backend.ts`
- Modify: `tools/cdp-session.ts`
- Modify: `tools/browser-tools.ts`
- Modify: `tools/tool-definitions.ts`
- Create: `tests/vitest/input-backend.test.ts`
- Modify: `tests/e2e/test-frontier-actions.ts`

**Interfaces:**

```ts
export type InputBackend = 'bridge' | 'cdp';
export function chooseInputBackend(tool: string, args: Record<string, unknown>, debuggerEnabled: boolean): InputBackend;
```

- [ ] **Step 1: Write backend policy tests**

Click/type default bridge. Hover/drag with `native: true` use CDP only when permission enabled; otherwise return `NATIVE_INPUT_PERMISSION_REQUIRED`, not fake native success.

- [ ] **Step 2: Run and confirm missing policy**

Run: `npm run test:vitest -- --run tests/vitest/input-backend.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement CDP pointer helpers**

Use `Input.dispatchMouseEvent` for move/down/up and resolve coordinates from verified handle. Preserve yellow debugger banner behavior and detach sessions in `finally`.

- [ ] **Step 4: Run policy and optional native fixture tests**

Run: `npm run test:vitest -- --run tests/vitest/input-backend.test.ts && npm run test:frontier`  
Expected: PASS; CDP-specific case skips when permission unavailable.

- [ ] **Step 5: Commit**

```bash
git add tools/input-backend.ts tools/cdp-session.ts tools/browser-tools.ts tools/tool-definitions.ts tests
 git commit -m "feat: add opt-in native browser input backend"
```

### Task 6: Add adaptive tool packs and schema budget

**Files:**
- Create: `ai/tool-packs.ts`
- Modify: `tools/tool-definitions.ts`
- Modify: `background.ts`
- Modify: `ai/runtime-cache.ts`
- Create: `tests/vitest/tool-packs.test.ts`

**Interfaces:**

```ts
export type ToolPackName = 'core' | 'forms' | 'extract' | 'diagnostics' | 'tabs' | 'advanced';
export function selectToolPacks(input: ToolPackIntent): ToolPackName[];
export function buildPackedToolDefinitions(packs: ToolPackName[], maxSessionTabs: number): ToolDefinition[];
```

- [ ] **Step 1: Write intent and budget tests**

Simple click task exposes core under 12,000 JSON characters. Form task adds forms. Analysis task adds extract. Failure can add diagnostics on next orchestration pass. Outstanding tool calls retain their definitions.

- [ ] **Step 2: Run and record current 30,802-character failure**

Run: `npm run test:vitest -- --run tests/vitest/tool-packs.test.ts`  
Expected: core path exceeds budget or packs absent.

- [ ] **Step 3: Partition definitions without renaming tools**

Build full source definitions once per run, filter by selected packs/permissions per pass, and include deterministic pack state in execution prompt. Do not cache execute closures.

- [ ] **Step 4: Run agent/tool gates**

Run: `npm run test:vitest -- --run tests/vitest/tool-packs.test.ts && npm run test:frontier`  
Expected: budgets and compatibility pass.

- [ ] **Step 5: Commit**

```bash
git add ai/tool-packs.ts tools/tool-definitions.ts background.ts ai/runtime-cache.ts tests/vitest/tool-packs.test.ts
 git commit -m "perf: select browser tools by execution phase"
```
