# Task 5 fix 1 report — Product, Markdown, and history

## Result

All two Important findings and one Minor finding from `task-5-review.md` fixed in commit `42935ff`.

## Finding closure

### Stable plan identity — fixed

- `types/plan.ts` accepts explicit step IDs.
- Model steps without IDs match prior steps one-to-one using normalized titles.
- New steps receive collision-free IDs without reusing removed/current plan identity.
- Matched acknowledged `done` status remains authoritative after prepend or reorder.
- Regression: `keeps stable step identity when model prepends and reorders steps`.

### History byte fitting — fixed

- `sidepanel/ui/history-budget.ts` measures full compacted session before any transcript trimming.
- Under-budget skewed display/context transcripts remain byte-for-byte complete.
- Over-budget payloads compact tool data first.
- Remaining bytes are allocated adaptively: smaller transcript can retain full actual size and unused share flows to larger transcript.
- Text remains final fallback with structured truncation metadata.
- Regression: `preserves skewed distinct transcripts when whole session fits` plus existing balanced over-budget coverage.

### Nested rejected Markdown links — fixed

- Rejected `link_open` tokens carry metadata.
- `link_close` locates matching opener rather than assuming `index - 2`.
- Regression verifies `[**bad**](ftp://example.com)` renders `<span><strong>bad</strong></span>` with no `</a>`.

## Changed files

- `types/plan.ts`
- `sidepanel/ui/history-budget.ts`
- `sidepanel/ui/markdown-renderer.ts`
- `tests/vitest/plan-controller.test.ts`
- `tests/vitest/history-budget.test.ts`
- `tests/vitest/markdown-renderer.test.ts`

Implementation diff: 6 files, 173 insertions, 36 deletions.

## Validation evidence

- `npm run test:vitest -- --run tests/vitest/plan-controller.test.ts tests/vitest/history-budget.test.ts tests/vitest/markdown-renderer.test.ts`
  - PASS: 3 files, 15 tests.
- `npm run test:vitest -- --run tests/vitest/markdown-renderer.test.ts tests/vitest/stream-terminal-render.test.ts tests/vitest/partial-output.test.ts tests/vitest/plan-controller.test.ts tests/vitest/assistant-actions.test.ts tests/vitest/history-budget.test.ts tests/vitest/attachment-policy.test.ts tests/vitest/message-layout.test.ts`
  - PASS: 8 files, 32 tests.
- `npm run check && git diff --check`
  - PASS: TypeScript, Biome, whitespace validation.
- `npm run test:frontier`
  - PASS: production `build:all`.
  - PASS: Vitest 30 files, 128 tests.
  - PASS: legacy unit 335 tests.
  - PASS: extension validator 33 checks.
  - PASS: panel E2E 16 checks.
  - PASS: frontier action E2E 3 cases.
  - PASS: worker recovery E2E 3 cases.

## Residual risk

No open Critical, Important, Minor, or load-bearing spec finding from consolidated review. Historical browser/image risks already documented in main report remain unchanged and outside this fix scope.
