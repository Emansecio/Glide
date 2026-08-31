# Task 5 report — Product, Markdown, and history

## Result

Milestone implemented in commits `5a64edf..a130f92` (base `538585c`). Production bundle builds and validates. Focused suites, canonical frontier gate, legacy unit suite, extension validator, deterministic panel E2E, browser-action E2E, and worker-recovery E2E pass. One aggregate run hit a worker-recovery Playwright timeout after prior cases passed; immediate focused rerun passed all three recovery cases.

## Commits

- `5a64edf feat: render CommonMark and GFM with markdown-it`
- `5c4dd94 perf: preserve deferred Markdown finalization`
- `cc12616 feat: retain partial output from interrupted runs`
- `70b9215 feat: acknowledge manual plan checklist updates`
- `2771012 fix: bind assistant actions to matching user turn`
- `1da619c fix: preserve long reports within history budgets`
- `60b40c1 fix: bound attachments before decoding`
- `f251dcd polish: harden Markdown and turn layout`
- `254a605 style: format product milestone sources`
- `a130f92 fix: close product milestone review findings`

## Changed files

- `package.json`, `package-lock.json`
- `ai/message-schema.ts`, `ai/persist-serialization.ts`
- `background.ts`, `background/plan-controller.ts`
- `types/plan.ts`, `types/runtime-messages.ts`
- `sidepanel/styles/chat.css`
- `sidepanel/ui/attachment-policy.ts`
- `sidepanel/ui/history-budget.ts`, `sidepanel/ui/history-storage.ts`
- `sidepanel/ui/markdown-render-defer.ts`, `sidepanel/ui/markdown-renderer.ts`
- `sidepanel/ui/panel-attachments.ts`, `panel-chat.ts`, `panel-core.ts`, `panel-history.ts`, `panel-markdown.ts`, `panel-plan.ts`, `panel-streaming.ts`, `panel-ui.ts`
- Eight new focused Vitest files listed below.

Diff summary: 30 files, 1,397 insertions, 312 deletions.

## Implementation

1. Replaced regex Markdown parser with `markdown-it`, HTML disabled, safe external link policy, HTTP(S)-only images, task-list support, table wrappers, and escaped fallback.
2. Added normalized source digests to deferred Markdown jobs. Equivalent terminal content retains pending parse; changed content replaces it through same defer policy; detached targets no-op.
3. Persisted non-empty interrupted stream output once with `meta.finishReason`, `meta.partial = true`, and visible `Interrompida` metadata. Empty streams remain absent.
4. Added plan identity/version contracts, `manual_plan_update`, `plan_update_ack`, background validation, sequential completion checks, pending UI controls, stale canonical reconciliation, and model-update versioning.
5. Bound copy/edit handlers to source and preceding user text held in closures. Restored history rebuilds `.chat-turn` ownership and rebinds actions without large DOM data attributes.
6. Replaced 4,000-character history cap with 200 KiB structured session fitting. Tool-heavy payloads compact first; text truncation records visible structured metadata; distinct context transcript receives independent budget. Quota retry uses same fitter.
7. Added pre-read attachment count/per-file/total policy. Image dimensions are checked before canvas allocation; object URLs and image sources are always cleaned in `finally`.
8. Preserved multiline user text, bounded Markdown images, wrapped wide tables, and attached streaming assistant output to current connected turn.

## TDD evidence

### Red

- Markdown: focused run failed with `Cannot find module '../../sidepanel/ui/markdown-renderer.js'`.
- Terminal render: 3 failures; `reconcileTerminalMarkdownRender` and `digestMarkdownSource` absent.
- Partial output: 5 failures; finalizer absent and persisted metadata lost.
- Plan controller: suite failed because `background/plan-controller.js` was absent.
- Assistant actions: first-turn edit expected `first user`, received `latest user`.
- History budget: suite failed because `history-budget.js` was absent.
- Attachment policy: suite failed because `attachment-policy.js` was absent.
- Layout: 2 failures; CSS contracts absent and stream container outside `.chat-turn`.

### Green

- `markdown-renderer.test.ts`: 4/4 passed.
- `stream-terminal-render.test.ts`: 4/4 passed.
- `partial-output.test.ts`: 5/5 passed.
- `plan-controller.test.ts`: 4/4 passed.
- `assistant-actions.test.ts`: 2/2 passed.
- `history-budget.test.ts`: 4/4 passed.
- `attachment-policy.test.ts`: 4/4 passed after review regression addition.
- `message-layout.test.ts`: 2/2 passed.
- Full Vitest: 30 files, 125 tests passed.
- Legacy unit suite: 335 passed.
- Extension validator: 33 passed.
- Panel E2E: all 16 checks passed.
- Browser actions: click-once, find-element, checkbox-frame passed.
- Worker recovery focused rerun: safe checkpoint, committed-action confirmation/no replay, ambiguous-action confirmation/no replay passed.

## Commands and outputs

- `npm install markdown-it && npm install --save-dev @types/markdown-it` — passed; 0 vulnerabilities.
- Eight focused red commands: `npm run test:vitest -- --run tests/vitest/<milestone-test>.test.ts` — failed as recorded above before implementation.
- Repeated focused green commands — all focused tests passed with counts above.
- `npm run typecheck` — passed.
- `npm run build && npm run validate && npm run build:all && node dist/tests/e2e/run-e2e.js` — production build passed; validator 33/33; panel E2E all passed.
- `npm run check` — passed after Biome formatting.
- `npm run test:frontier` — product suites 30/125, legacy 335, validator 33, panel/action E2E passed; final worker-recovery process timed out on third wait once.
- `npm run test:worker-recovery:run` — immediate rerun passed all 3 cases.
- `git diff --check` — passed.
- `git status --short` — empty before report write.

## Migration and compatibility

- Legacy plans without identity/version remain schema-compatible; newly built plans receive stable `planId` and monotonic `version`.
- Existing history schema remains version 1 and loads unchanged. New partial/truncation metadata is optional.
- Existing public tool names, per-run toolset construction, bridge-first browser paths, CDP opt-in, tab-scoped panel behavior, and ambiguous-effect no-replay behavior remain untouched.
- Full/redacted/off persistence modes remain active before byte fitting.

## Self-review

Review found and fixed:

1. Synthetic manual plan runtime IDs could claim panel `activeRunId` after run completion. Background now uses request response only when no active run; runtime ack is emitted only with real active run metadata.
2. Unsupported batch files could reserve total attachment bytes and reject later valid files. Policy now rejects unsupported types before count/byte reservation; regression test added.
3. Runtime plan validator accepted malformed optional identity/version fields. Optional fields now validate when present.

No blocker found in final diff. No staged files expected after report commit.

## Residual risks / concerns

- One aggregate Playwright worker-recovery run timed out once; immediate isolated rerun passed all recovery invariants. Treat as harness flake unless repeated.
- Plan requested layout assertions in `tests/e2e/run-e2e.ts`; equivalent DOM/CSS assertions were added in `tests/vitest/message-layout.test.ts`, while existing production E2E was run unchanged. Runtime coverage exists, but file-level plan wording was not followed exactly.
- Image pixel-limit path depends on browser image metadata decode. Unit policy covers rejection-before-read for byte limits; production E2E does not synthesize a >20 MP image.
