# Frontier 02 Run Durability and Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume MV3-interrupted runs from safe checkpoints, pause ambiguous effects, and deliver explicit terminal/vision/verification state.

**Architecture:** Add a run coordinator and session-backed checkpoint/action journal behind current background methods. Existing run loop remains, but all phase transitions and recovery decisions pass through coordinator contracts.

**Tech Stack:** TypeScript, Vitest, Chrome storage.session, AI SDK, Playwright

**Spec:** `docs/superpowers/specs/2026-08-30-frontier-browser-agent-program-design.md`

## Global Constraints

- Never replay an action left `in_flight` after worker death.
- Checkpoint persistence failure must not crash a live run.
- Runtime changes are additive and migration-compatible.
- Existing stop, sentinel, and tab-lock behavior remains.
- Context is referenced by revision, not duplicated inside checkpoints.

---

### Task 1: Add run coordinator state machine

**Files:**
- Create: `background/run-coordinator.ts`
- Create: `background/run-types.ts`
- Create: `tests/vitest/run-coordinator.test.ts`
- Modify: `background.ts`

**Interfaces:**

```ts
export type RunPhase = 'starting' | 'model' | 'action_prepared' | 'action_in_flight' | 'committing' | 'awaiting_user' | 'completed' | 'failed' | 'stopped' | 'ambiguous';
export type RunTerminalReason = 'completed' | 'awaiting_user' | 'stopped' | 'failed' | 'interrupted' | 'ambiguous_action';
export class RunCoordinator {
  start(meta: RunMeta, input: RunResumeInput): RunState;
  transition(runId: string, next: RunPhase): RunState;
  terminal(runId: string, reason: RunTerminalReason): RunState;
  get(runId: string): RunState | null;
}
```

- [ ] **Step 1: Write invalid-transition tests**

Assert `completed -> model` and `stopped -> committing` throw; `action_in_flight -> ambiguous` and `model -> completed` succeed.

- [ ] **Step 2: Run and confirm missing module**

Run: `npm run test:vitest -- --run tests/vitest/run-coordinator.test.ts`  
Expected: FAIL resolving coordinator.

- [ ] **Step 3: Implement explicit transition table**

Use a frozen map of allowed next phases. State includes run/session/turn IDs, context revision, selected tabs, request envelope, phase, terminal reason, timestamps.

- [ ] **Step 4: Adapt current lifecycle boundaries**

Start coordinator after exclusive lock acquisition; transition around model/tool/commit paths; terminalize in success, stop, and catch branches. Do not yet persist.

Run: `npm run test:vitest -- --run tests/vitest/run-coordinator.test.ts && npm run typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background/run-coordinator.ts background/run-types.ts background.ts tests/vitest/run-coordinator.test.ts
 git commit -m "feat: centralize run lifecycle transitions"
```

### Task 2: Persist checkpoints in storage.session

**Files:**
- Create: `background/run-checkpoint-store.ts`
- Modify: `background/storage-access.ts`
- Modify: `background/run-coordinator.ts`
- Create: `tests/vitest/run-checkpoint-store.test.ts`

**Interfaces:**

```ts
export interface RunCheckpointStore {
  write(state: RunCheckpoint): Promise<void>;
  readActive(): Promise<RunCheckpoint | null>;
  clear(runId: string): Promise<void>;
}
```

Storage key: `glideActiveRunCheckpointV1`.

- [ ] **Step 1: Write storage and migration tests**

Test round-trip, wrong-version rejection, stale terminal cleanup, write failure returning a disabled-resume signal without throwing into run loop.

- [ ] **Step 2: Run and confirm missing store**

Run: `npm run test:vitest -- --run tests/vitest/run-checkpoint-store.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement store with bounded serialized payload**

Persist request text, IDs, selected tab IDs, phase, revision, action metadata digests, and timestamps. Do not persist screenshots, tool bodies, credentials, or model output buffers.

- [ ] **Step 4: Persist each safe transition**

Coordinator awaits writes before dispatching a mutative action, and best-effort writes for non-mutative phase changes. Terminal states clear checkpoint after terminal event flush.

Run: `npm run test:vitest -- --run tests/vitest/run-checkpoint-store.test.ts tests/vitest/run-coordinator.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background/run-checkpoint-store.ts background/storage-access.ts background/run-coordinator.ts tests/vitest/run-checkpoint-store.test.ts
 git commit -m "feat: persist safe active run checkpoints"
```

### Task 3: Add exactly-once action journal

**Files:**
- Create: `background/action-journal.ts`
- Modify: `background/run-types.ts`
- Modify: `background/run-coordinator.ts`
- Modify: `background.ts`
- Create: `tests/vitest/action-journal.test.ts`

**Interfaces:**

```ts
export class ActionJournal {
  prepare(input: PreparedAction): Promise<ActionJournalEntry>;
  markInFlight(actionId: string): Promise<ActionJournalEntry>;
  commit(actionId: string, result: unknown): Promise<ActionJournalEntry>;
  markAmbiguous(actionId: string): Promise<ActionJournalEntry>;
}
```

- [ ] **Step 1: Write state and restart tests**

Assert duplicate `commit` is idempotent, duplicate `markInFlight` does not dispatch, and restored `in_flight` becomes `ambiguous`.

- [ ] **Step 2: Run and confirm missing journal**

Run: `npm run test:vitest -- --run tests/vitest/action-journal.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Wrap mutative tool dispatch**

Classify effects in one exported set. Generate `actionId` from run/tool-call sequence, not random time. Persist prepared and in-flight before `BrowserTools.executeTool`; commit before result enters model history.

- [ ] **Step 4: Run focused tests**

Run: `npm run test:vitest -- --run tests/vitest/action-journal.test.ts tests/vitest/run-checkpoint-store.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background/action-journal.ts background/run-types.ts background/run-coordinator.ts background.ts tests/vitest/action-journal.test.ts
 git commit -m "feat: journal browser effects before dispatch"
```

### Task 4: Recover safe checkpoints and pause ambiguity

**Files:**
- Create: `background/run-recovery.ts`
- Modify: `background.ts`
- Modify: `types/runtime-messages.ts`
- Modify: `sidepanel/ui/panel-core.ts`
- Modify: `sidepanel/ui/panel-status.ts`
- Create: `tests/vitest/run-recovery.test.ts`
- Create: `tests/e2e/test-worker-recovery.ts`

**Interfaces:**
- Produces runtime messages `run_resume_started`, `run_resume_required`, `run_interrupted`.
- Produces `recoverCheckpoint(checkpoint): 'resume' | 'confirm' | 'discard'`.

- [ ] **Step 1: Write recovery decision tests**

Safe phases `model`, `committing` with committed context revision resume. `action_in_flight` requires confirmation. Terminal/stale checkpoints discard.

- [ ] **Step 2: Run and confirm missing recovery module**

Run: `npm run test:vitest -- --run tests/vitest/run-recovery.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement startup recovery**

On service initialization, load checkpoint after session context hydration. Resume with a new run ID linked by `resumedFromRunId`, same request and tabs, and an execution-state note referencing last committed action. Ambiguous action emits required-confirmation event and keeps composer interactive.

- [ ] **Step 4: Add Playwright worker-restart fixture**

Terminate service worker after a read-only checkpoint and verify new worker emits resume. Terminate while fixture delays a click result and verify no second click plus `run_resume_required`.

Run: `npm run build:all && node dist/tests/e2e/test-worker-recovery.js`  
Expected: safe resume and zero ambiguous replay.

- [ ] **Step 5: Commit**

```bash
git add background/run-recovery.ts background.ts types/runtime-messages.ts sidepanel/ui/panel-core.ts sidepanel/ui/panel-status.ts tests
 git commit -m "feat: resume safe runs after worker restart"
```

### Task 5: Add explicit terminal reasons and plan handoffs

**Files:**
- Modify: `types/runtime-messages.ts`
- Modify: `background.ts`
- Modify: `sidepanel/ui/panel-core.ts`
- Modify: `sidepanel/ui/panel-chat.ts`
- Modify: `sidepanel/ui/panel-status.ts`
- Create: `tests/vitest/run-terminal-reason.test.ts`

**Interfaces:**
- `assistant_final.finishReason?: RunTerminalReason`.
- Transcript message metadata stores same reason.

- [ ] **Step 1: Write reason mapping tests**

`textAwaitsUser` maps to `awaiting_user`; user stop maps `stopped`; recovered ambiguous effect maps `ambiguous_action`; normal valid final maps `completed`.

- [ ] **Step 2: Run and confirm absent metadata**

Run: `npm run test:vitest -- --run tests/vitest/run-terminal-reason.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement additive field and UI states**

Show `Aguardando você`, `Interrompida`, or `Ação precisa de confirmação`; only normal completion shows `Pronto`. Preserve non-empty partial assistant output with finish metadata.

- [ ] **Step 4: Run tests and E2E status assertions**

Run: `npm run test:vitest -- --run tests/vitest/run-terminal-reason.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add types/runtime-messages.ts background.ts sidepanel/ui/panel-core.ts sidepanel/ui/panel-chat.ts sidepanel/ui/panel-status.ts tests/vitest/run-terminal-reason.test.ts
 git commit -m "feat: expose explicit run terminal reasons"
```

### Task 6: Deliver async vision into orchestration

**Files:**
- Create: `background/vision-inbox.ts`
- Modify: `background.ts`
- Modify: `background/vision-queue.ts`
- Create: `tests/vitest/vision-inbox.test.ts`

**Interfaces:**

```ts
export class VisionInbox {
  publish(runId: string, item: VisionContextItem): void;
  consume(runId: string): VisionContextItem[];
  hasPending(runId: string): boolean;
}
```

- [ ] **Step 1: Write delivery tests**

Assert successful screenshot description is included exactly once in next orchestration pass even with zero action failures. Assert late description after terminal is discarded.

- [ ] **Step 2: Run and confirm current loss**

Run: `npm run test:vitest -- --run tests/vitest/vision-inbox.test.ts`  
Expected: description never reaches prompt without failure recovery.

- [ ] **Step 3: Implement inbox consumption**

Publish queue completion into inbox. Before each model pass, consume items and append bounded `<visual_context>` user message after cache anchor. If explicit screenshot requested and description remains pending at would-be final, force one bounded continuation or return deterministic pending status.

- [ ] **Step 4: Run vision and full gates**

Run: `npm run test:vitest -- --run tests/vitest/vision-inbox.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background/vision-inbox.ts background/vision-queue.ts background.ts tests/vitest/vision-inbox.test.ts
 git commit -m "feat: deliver asynchronous vision to model loop"
```

### Task 7: Replace boolean verification with evidence state

**Files:**
- Create: `background/verification-state.ts`
- Modify: `background/service-config.ts`
- Modify: `background.ts`
- Create: `tests/vitest/verification-state.test.ts`

**Interfaces:**

```ts
export class VerificationState {
  recordEffect(effect: EffectEvidence): void;
  recordObservation(observation: ObservationEvidence): VerificationOutcome;
  pending(): EffectEvidence | null;
  reset(): void;
}
```

- [ ] **Step 1: Write evidence-matching tests**

Assert `wait` alone does not create pending verification. `readPage` on same tab/frame and newer revision clears pending; observation from another frame does not. Successful declared postcondition clears automatically.

- [ ] **Step 2: Run and confirm boolean behavior fails**

Run: `npm run test:vitest -- --run tests/vitest/verification-state.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Classify tools and integrate evidence**

Replace `awaitingVerification` writes with state methods. Browser results carry tab/frame/navigation/DOM revisions. Recovery prompt reads pending effect details without raw typed values.

- [ ] **Step 4: Run full orchestration gates**

Run: `npm run test:vitest -- --run tests/vitest/verification-state.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background/verification-state.ts background/service-config.ts background.ts tests/vitest/verification-state.test.ts
 git commit -m "feat: verify effects with scoped browser evidence"
```
