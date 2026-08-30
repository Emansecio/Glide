# Frontier 04 Product Markdown and History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Markdown, streaming, plans, history, attachments, and interrupted states durable and trustworthy.

**Architecture:** Add focused policy/rendering modules behind current SidePanelUI prototypes. Keep existing DOM/CSS design, but make state authoritative through versioned runtime acknowledgements and structured transcript metadata.

**Tech Stack:** TypeScript, markdown-it, Vitest, Playwright, vanilla CSS

**Spec:** `docs/superpowers/specs/2026-08-30-frontier-browser-agent-program-design.md`

## Global Constraints

- Preserve current visual tokens and light/dark theme model.
- No React/Tailwind.
- Markdown rendering must have escaped plain-text fallback.
- Full history content is retained until byte budgets require structured truncation.
- UI never claims backend plan state before acknowledgement.

---

### Task 1: Replace custom parser with markdown-it adapter

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `sidepanel/ui/markdown-renderer.ts`
- Modify: `sidepanel/ui/panel-markdown.ts`
- Create: `tests/vitest/markdown-renderer.test.ts`

**Interfaces:**

```ts
export function renderMarkdownToHtml(source: string): { html: string; fallback: false } | { html: string; fallback: true; error: string };
```

- [ ] **Step 1: Write Markdown contract tests**

Cover headings, nested lists, task lists, ordered item `10`, fenced code language, escaped pipes in tables, blockquotes, inline code, links, images, raw HTML escaping, and malformed input fallback.

- [ ] **Step 2: Run against current parser and record failures**

Run: `npm run test:vitest -- --run tests/vitest/markdown-renderer.test.ts`  
Expected: nested/GFM/ordered/table cases fail or module is absent.

- [ ] **Step 3: Install and implement adapter**

Run: `npm install markdown-it && npm install --save-dev @types/markdown-it`

Configure `html: false`, `linkify: true`, `breaks: false`, and a link renderer that adds `target="_blank" rel="noopener noreferrer"`. Validate protocols through existing URL policy. On exception, return escaped text wrapped in paragraphs.

- [ ] **Step 4: Delegate SidePanelUI method to adapter**

Keep `SidePanelUI.prototype.renderMarkdown` as compatibility wrapper. Remove regex parser only after tests pass.

Run: `npm run test:vitest -- --run tests/vitest/markdown-renderer.test.ts && npm run typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json sidepanel/ui/markdown-renderer.ts sidepanel/ui/panel-markdown.ts tests/vitest/markdown-renderer.test.ts
 git commit -m "feat: render CommonMark and GFM with markdown-it"
```

### Task 2: Preserve deferred rendering through terminal events

**Files:**
- Modify: `sidepanel/ui/markdown-render-defer.ts`
- Modify: `sidepanel/ui/panel-streaming.ts`
- Modify: `sidepanel/ui/panel-chat.ts`
- Create: `tests/vitest/stream-terminal-render.test.ts`
- Modify: `tests/e2e/run-e2e.ts`

**Interfaces:**
- Pending render carries source digest and terminal metadata update callback.
- Equivalent final content does not cancel pending parse.

- [ ] **Step 1: Write race tests**

Schedule long stream stop, immediately deliver identical final, and assert one deferred render call with metadata finalized. Different final content invalidates old token and schedules new render. Detached element cancels safely.

- [ ] **Step 2: Run and confirm synchronous final parse**

Run: `npm run test:vitest -- --run tests/vitest/stream-terminal-render.test.ts`  
Expected: final path calls parser synchronously/cancels pending work.

- [ ] **Step 3: Implement source-digest reconciliation**

Store normalized content digest in pending render. `assistant_final` updates header/usage/tool summary immediately; matching Markdown render continues. Nonmatching final cancels and reschedules through same defer policy.

- [ ] **Step 4: Run race and E2E tests**

Run: `npm run test:vitest -- --run tests/vitest/stream-terminal-render.test.ts && npm run build:all && node dist/tests/e2e/run-e2e.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidepanel/ui/markdown-render-defer.ts sidepanel/ui/panel-streaming.ts sidepanel/ui/panel-chat.ts tests
 git commit -m "perf: preserve deferred Markdown finalization"
```

### Task 3: Persist partial interrupted output

**Files:**
- Modify: `sidepanel/ui/panel-streaming.ts`
- Modify: `sidepanel/ui/panel-core.ts`
- Modify: `sidepanel/ui/panel-history.ts`
- Modify: `ai/message-schema.ts`
- Create: `tests/vitest/partial-output.test.ts`

**Interfaces:**
- Assistant message metadata includes `finishReason` and `partial: boolean`.

- [ ] **Step 1: Write stop/error/restart tests**

Non-empty streamed text followed by stop/error becomes one assistant transcript entry marked partial. Empty stream creates none. History restore preserves marker.

- [ ] **Step 2: Run and confirm output is transient**

Run: `npm run test:vitest -- --run tests/vitest/partial-output.test.ts`  
Expected: display-only output is not persisted.

- [ ] **Step 3: Implement terminal stream capture**

Add `finalizePartialStreamingMessage(reason)` that normalizes buffer into display/context policy without pretending normal completion. Render small `Interrompida` metadata label.

- [ ] **Step 4: Run focused and history E2E tests**

Run: `npm run test:vitest -- --run tests/vitest/partial-output.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidepanel/ui ai/message-schema.ts tests/vitest/partial-output.test.ts
 git commit -m "feat: retain partial output from interrupted runs"
```

### Task 4: Make manual plan updates acknowledged

**Files:**
- Create: `background/plan-controller.ts`
- Modify: `background.ts`
- Modify: `types/runtime-messages.ts`
- Modify: `sidepanel/ui/panel-plan.ts`
- Modify: `sidepanel/ui/panel-core.ts`
- Create: `tests/vitest/plan-controller.test.ts`

**Interfaces:**
- Add `manual_plan_update { planId, version, stepId, status }`.
- Add `plan_update_ack { planId, version, accepted, plan?, error? }`.

- [ ] **Step 1: Write optimistic-race tests**

Click sends request but does not commit local authoritative state until ack. Stale version gets rejected with canonical plan. Successful ack advances version. Subsequent model update cannot silently undo acknowledged user state.

- [ ] **Step 2: Run and confirm no background consumer**

Run: `npm run test:vitest -- --run tests/vitest/plan-controller.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement controller and pending UI state**

Controller validates plan ID/version and sequential completion rules, updates `currentPlan`, emits normal `plan_update` plus ack. UI disables clicked control and shows pending state until ack.

- [ ] **Step 4: Run plan unit and E2E tests**

Run: `npm run test:vitest -- --run tests/vitest/plan-controller.test.ts && npm run build:all && node dist/tests/e2e/run-e2e.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background/plan-controller.ts background.ts types/runtime-messages.ts sidepanel/ui/panel-plan.ts sidepanel/ui/panel-core.ts tests
 git commit -m "feat: acknowledge manual plan checklist updates"
```

### Task 5: Bind assistant actions to their own turn

**Files:**
- Modify: `sidepanel/ui/panel-chat.ts`
- Modify: `sidepanel/ui/panel-history.ts`
- Create: `tests/vitest/assistant-actions.test.ts`
- Modify: `tests/e2e/run-e2e.ts`

**Interfaces:**
- `bindAssistantActions(header, markdownSource, precedingUserText)`.

- [ ] **Step 1: Write restored-history and older-turn tests**

Three user/assistant turns. Clicking edit on first assistant fills first user text, not latest. Copy works after history restore.

- [ ] **Step 2: Run and confirm current latest-user behavior**

Run: `npm run test:vitest -- --run tests/vitest/assistant-actions.test.ts`  
Expected: older action resolves latest user or restored actions lack listeners.

- [ ] **Step 3: Bind per-turn data**

During live and history rendering, carry preceding user text in closure or data map keyed by message ID. Avoid storing large raw text in DOM attributes.

- [ ] **Step 4: Run tests**

Run: `npm run test:vitest -- --run tests/vitest/assistant-actions.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidepanel/ui/panel-chat.ts sidepanel/ui/panel-history.ts tests
 git commit -m "fix: bind assistant actions to matching user turn"
```

### Task 6: Preserve long history with structured budgets

**Files:**
- Create: `sidepanel/ui/history-budget.ts`
- Modify: `sidepanel/ui/history-storage.ts`
- Modify: `sidepanel/ui/panel-history.ts`
- Modify: `ai/persist-serialization.ts`
- Create: `tests/vitest/history-budget.test.ts`

**Interfaces:**

```ts
export type TruncationMeta = { originalChars: number; retainedChars: number; reason: 'session_budget' | 'total_budget' };
export function fitSessionToBudget(session: StoredSession, maxBytes: number): StoredSession;
```

- [ ] **Step 1: Write long-report tests**

A 20k assistant report survives round-trip when under 200 KiB. When over budget, oldest tool-heavy content compacts first; assistant content truncation carries metadata and visible marker. Context transcript remains independently budgeted.

- [ ] **Step 2: Run and confirm 4k truncation**

Run: `npm run test:vitest -- --run tests/vitest/history-budget.test.ts`  
Expected: report restored near 4,003 chars.

- [ ] **Step 3: Replace per-field cap with byte-budget fitter**

Preserve current session and recent turns first. Compact tool payloads using existing persistence policies. Truncate human/assistant text only as final fallback and store metadata.

- [ ] **Step 4: Run quota and restore tests**

Run: `npm run test:vitest -- --run tests/vitest/history-budget.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidepanel/ui/history-budget.ts sidepanel/ui/history-storage.ts sidepanel/ui/panel-history.ts ai/persist-serialization.ts tests/vitest/history-budget.test.ts
 git commit -m "fix: preserve long reports within history budgets"
```

### Task 7: Enforce attachment limits before decoding

**Files:**
- Create: `sidepanel/ui/attachment-policy.ts`
- Modify: `sidepanel/ui/panel-attachments.ts`
- Create: `tests/vitest/attachment-policy.test.ts`

**Interfaces:**

```ts
export const ATTACHMENT_LIMITS = { textBytes: 2_000_000, imageBytes: 10_000_000, totalBytes: 24_000_000, maxImagePixels: 20_000_000 } as const;
export function validateAttachmentBatch(existing: PendingAttachmentMeta[], files: FileLike[]): AttachmentDecision[];
```

- [ ] **Step 1: Write rejection-before-read tests**

Mock file whose `text()`/reader throws if called. Oversized file must reject without invoking read. Batch over total limit rejects only exceeding additions with actionable reason.

- [ ] **Step 2: Run and confirm absent policy**

Run: `npm run test:vitest -- --run tests/vitest/attachment-policy.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Apply policy before FileReader/file.text**

Check bytes and counts first. For images, decode dimensions and reject oversized pixel count before canvas allocation where browser metadata permits; always revoke object URLs and clear image sources in `finally`.

- [ ] **Step 4: Run focused and full tests**

Run: `npm run test:vitest -- --run tests/vitest/attachment-policy.test.ts && npm run test:frontier`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidepanel/ui/attachment-policy.ts sidepanel/ui/panel-attachments.ts tests/vitest/attachment-policy.test.ts
 git commit -m "fix: bound attachments before decoding"
```

### Task 8: Finish Markdown and message layout polish

**Files:**
- Modify: `sidepanel/styles/chat.css`
- Modify: `sidepanel/ui/panel-streaming.ts`
- Modify: `sidepanel/ui/panel-chat.ts`
- Modify: `tests/e2e/run-e2e.ts`

**Interfaces:**
- Streaming assistant belongs to current `.chat-turn` when present.

- [ ] **Step 1: Add layout assertions**

Assert multiline user text preserves line breaks, Markdown images fit container, wide table scrolls horizontally, and streaming assistant is inside same turn wrapper as preceding user.

- [ ] **Step 2: Run and observe failures**

Run: `npm run build:all && node dist/tests/e2e/run-e2e.js`  
Expected: new layout assertions fail.

- [ ] **Step 3: Implement token-based CSS and turn placement**

Add `white-space: pre-wrap` to user content, `max-width: 100%; height: auto` to Markdown images, parser table wrapper with `overflow-x: auto`, and append stream container to `lastChatTurn` when connected.

- [ ] **Step 4: Run preview/build/E2E**

Run: `npm run build && npm run validate && npm run build:all && node dist/tests/e2e/run-e2e.js`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sidepanel/styles/chat.css sidepanel/ui tests/e2e/run-e2e.ts
 git commit -m "polish: harden Markdown and turn layout"
```
