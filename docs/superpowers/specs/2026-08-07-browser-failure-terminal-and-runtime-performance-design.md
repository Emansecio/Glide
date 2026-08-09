# Glide Browser Failure Terminal and Runtime Performance Design

## Objective

Prevent a failed browser action from ending silently or being presented as success, while removing confirmed bottlenecks in tool-heavy runs and keeping the changes bounded to runtime, tool execution, panel state, and verification infrastructure.

## Approaches Considered

1. **Retry indefinitely:** maximizes persistence but can loop, repeat side effects, and waste model calls. Rejected.
2. **Fail on the first browser error:** clear and cheap, but discards the existing selector/DOM recovery path. Rejected.
3. **One bounded recovery, then terminal failure:** preserves one automatic repair attempt and guarantees an explicit, actionable failure if verification still does not succeed. Selected.

## Runtime Behavior

When a browser tool fails without a later successful verification:

1. The first failed pass remains informational and forces one recovery pass.
2. The recovery pass must change strategy and use fresh page evidence.
3. If that pass still contains a failed browser tool and verification remains pending, orchestration stops before the quality gate.
4. The background emits one `run_error` containing a sanitized summary of the failed tool, error code/message, and next hint.
5. No `assistant_final`, generic fallback, or success quality event is emitted for that terminal path.
6. The panel clears busy/stream/tool state, shows the persistent error banner, marks unfinished tool rows as failed, and records a concise assistant-visible failure in the transcript/history.

Thrown tool exceptions must enter the same normalization, telemetry, recovery, and error-classification pipeline as ordinary `{ success: false }` results. They must not return early from `executeToolByName`.

## Performance Scope

Implement only confirmed, low-risk improvements on hot paths:

- append the incremental run-pass message tail without copying the full cached array each pass;
- select the largest HTML table in one linear scan, counting each table once;
- remove the redundant `chrome.storage.local` read from history persistence when the coherent in-memory index exists;
- remove stale panel-port records when `postMessage` fails;
- coalesce tool-log autoscroll to one animation frame;
- eliminate the duplicate TypeScript pass in `build:all` and leave the final Chrome-loadable `dist/` as a production-only build after verification.

Provider-probe cancellation, xAI OAuth mirroring, model-cache credential hashing, and hard cancellation of arbitrary injected JavaScript remain separate follow-ups because they change provider/auth or browser-execution contracts and need dedicated design/testing. Dead-export cleanup is intentionally excluded.

## E2E Gate Repair

The current E2E suite has two deterministic baseline failures:

- `setComposerBusy(true)` shows the stop control but does not hide the send control, contrary to the single-state contract and existing test;
- the tool-failure metadata test waits for an inline tool row without first creating a streaming surface or opening the activity log.

Restore the intended composer toggle in production code. Update the metadata test to exercise the activity log in a valid non-stream run state, then assert the error metadata and banner.

## Testing Strategy

Use red-green regression coverage at the narrowest real seams:

1. A pure failure-decision helper distinguishes `continue`, `complete`, and `fail` after the bounded recovery.
2. A background orchestration test or observable harness proves a second unverified failure emits `run_error` and no `assistant_final`.
3. A tool-exception test proves thrown exceptions are normalized and recorded like returned failures.
4. Existing cache, table, history, panel-port, composer, and tool-log tests receive focused assertions for each optimization.
5. Run `npm run check`, unit tests, E2E, validation, and finally `npm run build` so `dist/` contains the production extension rather than test bundles.

## Acceptance Criteria

- A browser action may receive one bounded automatic recovery attempt.
- A second unverified failure always produces a visible, actionable terminal error.
- The failed turn cannot emit a success/fallback final.
- The composer and activity state are usable immediately after failure.
- Thrown and returned tool failures share one observable pipeline.
- Confirmed hot-path optimizations preserve behavior and pass focused regressions.
- Full automated gates pass, and the final `dist/` is rebuilt in production mode.

