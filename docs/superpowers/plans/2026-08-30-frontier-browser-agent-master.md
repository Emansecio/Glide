# Frontier Browser Agent Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute all approved Glide V2 frontier-agent milestones in dependency order while keeping each merged slice production-loadable.

**Architecture:** Six focused plans form one strangler program. Foundation runs first; action/context correctness establishes contracts; durability and browser-kernel work then proceed from that base; product/UI follows shared runtime types; evaluations close program.

**Tech Stack:** TypeScript, Chrome MV3, Vitest, Playwright, markdown-it, esbuild

**Spec:** `docs/superpowers/specs/2026-08-30-frontier-browser-agent-program-design.md`

## Global Constraints

- Checkpoint baseline commit: `82772fc`.
- Design commit: `1d2f186`.
- Use isolated worktrees for writer agents.
- Merge only commits whose focused tests and production build pass.
- Run conflict-sensitive integration in main worktree after each lane merge.
- Never replay ambiguous mutative effects.
- Preserve migration compatibility and existing public tool names.

---

### Task 1: Test foundation

**Plan:** `docs/superpowers/plans/2026-08-30-frontier-00-test-foundation.md`

**Produces:** Vitest runner, deterministic fixture server, propagated child status, aggregate gate.

- [ ] Execute every checkbox in plan 00.
- [ ] Review test semantics and package/build changes.
- [ ] Merge commits and run `npm run test:frontier`.

### Task 2: Action and context correctness

**Plan:** `docs/superpowers/plans/2026-08-30-frontier-01-action-context-correctness.md`

**Consumes:** Vitest and fixture helpers from Task 1.

**Produces:** exactly-once click, selector engine, frame-safe forms, versioned context transaction, abort-aware compaction, prompt/manual-tool fixes.

- [ ] Execute every checkbox in plan 01.
- [ ] Review action safety and context invariants.
- [ ] Merge commits and run `npm run test:frontier`.

### Task 3: Run durability and orchestration

**Plan:** `docs/superpowers/plans/2026-08-30-frontier-02-run-durability-orchestration.md`

**Consumes:** context revisions and focused tests from Tasks 1–2.

**Produces:** coordinator, checkpoints, action journal, safe recovery, terminal reasons, vision inbox, scoped verification.

- [ ] Execute every checkbox in plan 02.
- [ ] Review restart and ambiguous-action behavior.
- [ ] Merge commits and run worker recovery plus frontier gates.

### Task 4: Browser kernel

**Plan:** `docs/superpowers/plans/2026-08-30-frontier-03-browser-kernel.md`

**Consumes:** action journal, verification evidence, selector engine.

**Produces:** frame-addressable bridge, stable handles, canonical content operations, postconditions, hybrid input, tool packs.

- [ ] Execute every checkbox in plan 03.
- [ ] Review bridge compatibility and selector/handle behavior.
- [ ] Merge commits and run browser action/handle suites.

### Task 5: Product, Markdown, and history

**Plan:** `docs/superpowers/plans/2026-08-30-frontier-04-product-markdown-history.md`

**Consumes:** terminal reasons, context commits, runtime message additions.

**Produces:** markdown-it, durable streaming output, acknowledged plans, correct actions, long history, attachment limits, layout polish.

- [ ] Execute every checkbox in plan 04.
- [ ] Review UI behavior, accessibility, and history migration.
- [ ] Merge commits and run production E2E/validator.

### Task 6: Evaluations and observability

**Plan:** `docs/superpowers/plans/2026-08-30-frontier-05-evals-observability.md`

**Consumes:** all program contracts.

**Produces:** bounded telemetry, deterministic evals, budgets, awaited async tests, optional live suite, final docs.

- [ ] Execute every checkbox in plan 05.
- [ ] Review telemetry redaction boundary and eval validity.
- [ ] Run complete verification matrix from plan 05 Task 6.
- [ ] Request final code review and address blocking findings.
