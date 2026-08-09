# Glide Quality Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve performance, test confidence, UI accessibility, and context/history isolation through small changes that preserve the existing extension contracts.

**Architecture:** Keep the existing MV3 split and prototype-based panel modules. Add bounded stream buffering, explicit deep-copy helpers for conversation snapshots, serialized history writes, and focus management inside existing seams. Extend the current custom unit runner and Playwright E2E suite instead of introducing a second test framework.

**Tech Stack:** TypeScript, vanilla DOM, Chrome MV3, esbuild, Biome, Playwright, existing unit runner.

---

### Task 1: Bound streaming buffers

**Files:**
- Modify: `background/runtime-batcher.ts`
- Modify: `sidepanel/ui/panel-core.ts`
- Modify: `sidepanel/ui/panel-ui.ts`
- Test: `tests/unit/run-unit-tests.ts`

- [ ] Add a maximum per-channel delta size and flush chunks when a provider emits an unusually large delta.
- [ ] Bound the panel's pending stream queue by coalescing adjacent deltas with the same run, turn, and channel.
- [ ] Add unit tests for large background deltas and UI queue coalescing.

### Task 2: Preserve context isolation and tool-pair invariants

**Files:**
- Modify: `ai/message-schema.ts`
- Modify: `ai/model-convert.ts`
- Modify: `sidepanel/ui/panel-core.ts`
- Modify: `sidepanel/ui/panel-history.ts`
- Test: `tests/unit/run-unit-tests.ts`

- [ ] Add a typed deep-clone helper for conversation snapshots.
- [ ] Use independent cloned histories when restoring or compacting sessions.
- [ ] Filter orphan tool-result parts at the provider conversion boundary while preserving valid tool pairs.
- [ ] Add tests for cloning, orphan filtering, and valid multi-tool turns.

### Task 3: Serialize history persistence

**Files:**
- Modify: `sidepanel/ui/panel-ui.ts`
- Modify: `sidepanel/ui/panel-history.ts`

- [ ] Add a per-panel promise queue so overlapping history writes cannot interleave.
- [ ] Add an explicit history schema version to persisted sessions.
- [ ] Keep existing quota retry and pruning behavior unchanged.

### Task 4: Improve modal and icon-button accessibility

**Files:**
- Modify: `sidepanel/panel.html`
- Modify: `sidepanel/templates/sidebar-shell.html`
- Modify: `sidepanel/templates/main.html`
- Modify: `sidepanel/templates/modals/oauth-help.html`
- Modify: `sidepanel/templates/panels/history.html`
- Modify: `sidepanel/ui/modal-controller.ts`
- Modify: `sidepanel/ui/panel-core.ts`
- Test: `tests/e2e/run-e2e.ts`

- [ ] Set the document language to `pt-BR`.
- [ ] Add explicit accessible names to static icon-only controls.
- [ ] Mark the OAuth help modal as a dialog with a labelled title.
- [ ] Trap keyboard focus while the modal is open and restore focus after close.
- [ ] Add an E2E accessibility smoke test for language, names, and modal semantics.

### Task 5: Verify

- [ ] Run `npm run check`.
- [ ] Run `npm run test:unit`.
- [ ] Run `npm run validate`.
- [ ] Run the E2E suite.
- [ ] Inspect the final diff and confirm no unrelated files changed.
