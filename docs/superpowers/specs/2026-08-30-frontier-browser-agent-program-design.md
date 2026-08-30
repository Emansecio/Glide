# Glide V2 Frontier Browser Agent — Program Design

**Date:** 2026-08-30  
**Status:** Approved for implementation  
**Approach:** Incremental strangler migration  
**Compatibility:** Versioned, migration-compatible contracts

## 1. Purpose

Turn Glide V2 from an advanced browser assistant into a browser agent with four enforceable guarantees:

1. **Exactly one action** for each accepted mutative tool call.
2. **Exactly one context commit** for each completed turn.
3. **Stable target identity** across observation and action.
4. **Verifiable outcomes** for browser mutations and interrupted runs.

The program also replaces weak custom infrastructure where mature focused dependencies reduce risk: Vitest for tests and markdown-it for CommonMark/GFM rendering.

## 2. Constraints

- Preserve current tab-scoped side-panel behavior.
- Preserve vanilla TypeScript/CSS architecture; no React/Tailwind rewrite.
- Preserve existing provider settings, sessions, runtime messages, and public tool names through adapters/migrations.
- Keep `buildRunToolSet` per-run; its execute closures are run-scoped and must not be cached.
- Keep production extension loadable from `dist/` after every implementation slice.
- Use bridge-first browser interaction. CDP remains opt-in and is used only when native input semantics are required and debugger permission is enabled.
- Resume MV3-interrupted runs only from safe checkpoints. Never replay an ambiguous mutative action automatically.
- CI browser evaluations use deterministic fixtures. Live-site evaluations remain optional and non-blocking.

## 3. Delivery Model

Implementation uses small vertical slices. Each slice includes contract, implementation, migration adapter, focused tests, production build, and validator. Commits remain independently revertible.

### Milestone A — Action and context correctness

- Single browser activation primitive.
- Scored unique selector generation.
- Frame-targeted checkbox/radio mutation.
- Abort-aware compaction transaction.
- One canonical context revision per turn.
- Fix manual `execute_tool` ownership.
- Correct prompt default/custom identity.

### Milestone B — Run durability and orchestration

- Persist safe run checkpoints in `chrome.storage.session`.
- Persist action journal states: `prepared`, `in_flight`, `committed`, `ambiguous`.
- Resume generation from last safe checkpoint after service-worker restart.
- Pause and request user confirmation for ambiguous effects.
- Explicit terminal reasons: `completed`, `awaiting_user`, `stopped`, `failed`, `interrupted`, `ambiguous_action`.
- Versioned context commits and UI reconciliation.
- Vision-result inbox delivered into next model step/pass.
- Observation/effect verification state machine.

### Milestone C — Browser kernel

- Canonical DOM operations live in all-frame content bridges.
- Background routes bridge messages to explicit `frameId`; no `new Function` registry.
- Snapshot-scoped element handles carry snapshot ID, frame ID, selector, fingerprint, and DOM revision.
- Stale or mismatched handles fail closed with refreshed candidates.
- Action tools support optional expected postconditions and return evidence.
- Bridge input remains default; CDP supplies native hover/drag/pointer paths when enabled.
- Tool definitions split into intent/phase packs to reduce schema cost.

### Milestone D — Product, Markdown, and history

- markdown-it rendering with controlled link/image policy and existing visual system.
- Streaming terminal path preserves deferred parsing and partial interrupted output.
- Plan checklist sends versioned updates to background and reconciles acknowledgements.
- Assistant actions bind after history restore and target the corresponding user turn.
- Long history fields preserve complete content within byte budgets; truncation is structured and visible.
- Attachment byte/count/dimension limits apply before full decoding.
- Explicit awaiting-user/interrupted presentation states.

### Milestone E — Tests, evaluations, and observability

- Vitest becomes canonical unit/integration runner.
- Legacy runner remains temporarily as compatibility coverage, then is retired.
- Browser fixtures cover duplicate events, React controls, frames, stale handles, shadow DOM, dialogs, SPA mutation, downloads, network idle, and worker restart.
- Action/context invariants become executable tests.
- Tool latency, retries, result size, context revision, checkpoint state, and terminal reason enter bounded execution telemetry.
- Bundle budgets and schema-token budgets become CI checks.
- Optional live evaluations use explicit environment gates and propagate exit status.

## 4. Architecture

### 4.1 Run coordinator

Introduce a `RunCoordinator` boundary around lifecycle state currently spread through `background.ts`.

```ts
type RunPhase =
  | 'starting'
  | 'model'
  | 'action_prepared'
  | 'action_in_flight'
  | 'committing'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'ambiguous';

interface RunCheckpoint {
  version: 1;
  runId: string;
  sessionId: string;
  turnId: string;
  phase: RunPhase;
  contextRevision: number;
  selectedTabIds: number[];
  request: { message: string; panelTabId?: number };
  lastCommittedActionId?: string;
  inFlightAction?: ActionJournalEntry;
  updatedAt: number;
}
```

`RunCoordinator` owns transitions, checkpoint persistence, abort status, and terminal reason. Existing background methods call it through a small adapter during migration.

### 4.2 Action journal

Every mutative browser call receives an `actionId`.

```ts
interface ActionJournalEntry {
  actionId: string;
  runId: string;
  toolCallId?: string;
  tool: string;
  argsDigest: string;
  target?: StableElementHandle;
  state: 'prepared' | 'in_flight' | 'committed' | 'ambiguous';
  resultDigest?: string;
  startedAt: number;
  completedAt?: number;
}
```

Transition order:

1. Persist `prepared`.
2. Persist `in_flight` before dispatch.
3. Execute once.
4. Persist result and `committed`.
5. Only then expose successful result to orchestration.

A worker restart with `in_flight` state never replays automatically. UI receives `run_resume_required` and shows action details without sensitive arguments.

### 4.3 Context transaction

Background is sole canonical owner of model context. Panel stores display transcript separately and mirrors context only from versioned snapshots.

```ts
interface ContextCommit {
  sessionId: string;
  previousSessionId?: string;
  revision: number;
  runId: string;
  turnId: string;
  messages: Message[];
  compacted: boolean;
  usage: ContextUsage;
}
```

Rules:

- Exactly one commit per terminal turn.
- Mid-run compaction increments revision but records included turn/action IDs.
- Panel applies only revisions newer than current revision.
- `assistant_final` never independently appends context already present in a commit.
- Compaction commit validates run ownership, abort state, session generation, and source revision immediately before storage mutation.

### 4.4 Browser bridge and frames

Content script already loads in all frames. Extend bridge routing so background sends `chrome.tabs.sendMessage(tabId, request, { frameId })`.

Canonical bridge operations replace duplicated injected functions for click, hover, type, wait, find, read, select, highlight, and checkbox mutation. Background may use read-only frame probes to choose a frame, but mutations always target one explicit frame.

The `new Function` registry is removed because isolated-world CSP rejects it.

### 4.5 Stable element handles

`readPage` and `findElement` return selectors plus handles:

```ts
interface StableElementHandle {
  version: 1;
  snapshotId: string;
  ref: string;
  tabId: number;
  frameId: number;
  selector: string;
  fingerprint: {
    tag: string;
    role?: string;
    accessibleName?: string;
    testId?: string;
    inputType?: string;
  };
  domRevision: number;
}
```

Before mutation, bridge resolves selector and verifies fingerprint. Failure returns `STALE_ELEMENT_HANDLE` with refreshed candidates. Plain selectors remain supported for compatibility.

### 4.6 Selector engine

One source-injectable selector module supplies content bridge, fixtures, screenshots, readPage, and findElement.

Candidate scoring order:

1. Unique ID.
2. Unique test ID/name/ARIA/placeholder.
3. Accessible-name and role combination.
4. Unique stable class combination.
5. Scoped structural path.

Every selector is checked for uniqueness in its frame. Match results include score and reason. Reverse-substring matching is prohibited for fields shorter than three characters.

### 4.7 Verification state machine

Tools are classified as:

- **Effect:** click, type, select, fill, navigation, scroll, drag, dismiss.
- **Observation:** readPage, getContent, findElement, screenshot, wait, storage/network/console reads.
- **Neutral:** plan and session metadata.

An effect creates pending verification with target/action/revision. An observation clears it only when evidence matches the same tab/frame and a newer DOM/navigation revision. Tool-specific postconditions may verify automatically.

### 4.8 Tool packs

Keep existing names but construct schema from packs selected by intent and execution phase:

- `core`: navigate, readPage, findElement, click, type, wait.
- `forms`: selectOption, fillForm, pressKey, setInputFiles.
- `extract`: getContent, findInPage, extractTable, harvestScroll.
- `diagnostics`: network, console, storage, performance, screenshots.
- `tabs`: session tab operations.
- `advanced`: executeScript, httpRequest, CDP, downloads.

Pack selection is deterministic from task intent, permissions, active failures, and explicit model continuation needs. Recovery may add a pack on the next pass; it never silently removes tools needed by outstanding calls.

### 4.9 Markdown and streaming

`markdown-it` produces HTML through one adapter. Existing CSS classes and escaping/link policies remain. Parsing of long terminal content is scheduled through idle work; `assistant_final` updates metadata without cancelling equivalent pending render.

Partial output becomes a transcript message with `meta.finishReason = 'stopped' | 'failed' | 'interrupted'` when non-empty.

### 4.10 Test architecture

Vitest projects:

- `unit`: pure contracts, selector scoring, state machines, migrations, Markdown.
- `integration`: background adapters with mocked Chrome APIs and storage.
- `browser`: Playwright extension with deterministic fixture server.

Browser mutation tests assert both returned result and observed event/state counts. Every regression from the audit receives a failing test before implementation.

## 5. Compatibility and Migration

- Runtime schema keeps current version accepted while new fields remain optional.
- New message types are additive.
- Existing persisted sessions load with `contextRevision = 0`.
- Existing plain refs/selectors continue, but responses encourage stable handles.
- Existing `systemPrompt` gets `systemPromptMode` inferred once: exact shipped default becomes `default`; every other non-empty value becomes `custom`.
- Existing plan messages remain accepted; new manual updates include plan version and receive acknowledgement.
- Legacy unit command remains available until Vitest reaches equivalent coverage.

## 6. Error Handling

- Ambiguous side effect: no retry; pause run and request user decision.
- Stale handle: no mutation; return refreshed candidates.
- Compaction abort or stale revision: discard generated summary and keep source session.
- Checkpoint storage failure: continue current run, disable automatic resume, emit informational warning.
- Vision backlog timeout: expose deterministic pending/failed status and continue through DOM recovery.
- Markdown parse failure: escaped plain-text fallback.
- Migration failure: retain original payload and surface bounded diagnostic; never delete source data first.

## 7. Observability

Execution events gain bounded fields:

- `actionId`, `checkpointPhase`, `contextRevision`.
- `tabId`, `frameId`, selector score/reason without sensitive field values.
- Tool queue, execution, verification, and total latency.
- Retry/recovery stage and terminal reason.
- Tool-schema characters/tokens and bundle sizes in build reports.

No unbounded screenshots, page bodies, prompts, or attachment payloads enter telemetry.

## 8. Acceptance Criteria

Program is complete when:

1. One click causes one handler invocation and one native state transition.
2. Mutations never execute across multiple frames without explicit targeting.
3. Stale handles cannot mutate a different element.
4. Stop prevents later compaction/context commits from that run.
5. Each completed turn has one monotonically versioned context commit.
6. Safe worker interruption resumes; ambiguous mutation pauses without replay.
7. Vision descriptions reach model orchestration or expose a deterministic failed state.
8. Verification tracks evidence by tab/frame/revision.
9. Restored history preserves long reports within documented byte budgets.
10. Markdown fixtures and streaming terminal races pass.
11. Vitest, production build, validator, deterministic Playwright suite, bundle budget, and schema budget all pass.
12. Existing settings/sessions migrate without manual reset.

## 9. Explicit Non-goals

- React/Tailwind migration.
- Global side panel behavior.
- Automatic replay of uncertain side effects.
- CDP permission enabled by default.
- Live websites as blocking CI dependencies.
- Toolset execute-closure caching.
- Security audit or unrelated permission redesign.
