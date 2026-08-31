# Final Critical Fix Report — Exactly-once / Stable Handles

**Date:** 2026-08-30

**Scope:** Three Critical findings from `final-review.md` only.

## Implemented

- Added argument-aware effect classification:
  - `httpRequest`: journals `POST`, `PUT`, `PATCH`, `DELETE`; leaves `GET`/`HEAD` observational.
  - `captureDownload`: journals direct `url` starts and `trigger.selector` clicks; listener-only capture remains observational.
- Added explicit dispatched-outcome certainty. Bridge timeout/abort/unavailable-after-send, script timeout, download timeout, HTTP abort/timeout, and thrown handler failures report unknown completion.
- Production dispatch now calls `ActionJournal.markAmbiguous()` for unknown mutative outcomes instead of committing them.
- Ambiguous live runs now:
  - persist terminal `ambiguous_action` coordinator/checkpoint state;
  - emit `run_resume_required` with bounded action identity;
  - abort/quarantine orchestration and release run lock;
  - block recovery/replay;
  - retain ambiguous checkpoint for restart confirmation.
- Stable-handle actions now fail closed when bridge verification is disabled/unavailable. Explicit `frameUrl`/`frameSelector` resolves one frame, routes through bridge, then validates handle tab/frame/fingerprint there. No handle-to-selector injection fallback remains.
- Preserved selector-only compatibility, bridge-first policy, and opt-in CDP native-input policy.

## Tests added or strengthened

- `tests/vitest/action-outcome.test.ts`: argument-dependent mutation classification, delayed unknown mutation, coordinator terminalization, conclusive failure commit.
- `tests/vitest/capture-download-outcome.test.ts`: direct download dispatch followed by timeout is unknown.
- `tests/vitest/stable-handle-routing.test.ts`: bridge-disabled handle; handle with `frameUrl`; handle with `frameSelector`; no injection fallback.
- `tests/vitest/browser-bridge-client.test.ts`: mutation occurs once after caller timeout; timeout certainty remains unknown.
- `tests/vitest/http-request.test.ts`: timed-out dispatched POST is unknown.
- `tests/vitest/stable-element-handle.test.ts`: unverifiable handle cannot selector-fallback to replacement.
- `tests/e2e/test-frontier-actions.ts`: production background/manual-tool delayed mutation executes once, terminalizes ambiguous, and blocks replay.
- `tests/e2e/test-stable-handles.ts`: production-path stale replacement, bridge-disabled handle, and explicit-frame handle routing.
- `tests/e2e/test-worker-recovery.ts`: in-flight POST and download checkpoints require confirmation after worker restart with zero tool replay.
- Canonical Frontier E2E gate now runs delayed ambiguity and stable-handle suites.

## TDD evidence

Initial focused run failed **10 regressions** across six files: missing effect classifier, missing outcome certainty, bridge-disabled fallback, explicit-frame bridge bypass, invalid-handle selector fallback, POST/download timeout certainty. After implementation, focused suite passed **10 files / 45 tests**.

## Validation

- `npm run test:vitest -- --run tests/vitest/action-outcome.test.ts tests/vitest/action-journal.test.ts tests/vitest/run-coordinator.test.ts tests/vitest/run-checkpoint-store.test.ts tests/vitest/run-recovery.test.ts tests/vitest/browser-bridge-client.test.ts tests/vitest/http-request.test.ts tests/vitest/capture-download-outcome.test.ts tests/vitest/stable-handle-routing.test.ts tests/vitest/stable-element-handle.test.ts`
  - PASS: 10 files, 45 tests.
- `node dist/tests/e2e/test-frontier-actions.js --case delayed-ambiguous`
  - PASS: one delayed mutation, ambiguous terminal, replay blocked.
- `node dist/tests/e2e/test-stable-handles.js`
  - PASS: stale replacement, bridge-disabled, `frameUrl`, `frameSelector`.
- `node dist/tests/e2e/test-worker-recovery.js`
  - PASS: safe resume plus click/POST/download ambiguity, zero restart replay.
- `npm run check`
  - PASS: TypeScript and Biome.
- `npm run test:frontier`
  - PASS: production build; Vitest 42 files / 179 tests; legacy unit 328; validator 33; panel E2E 16; Frontier action, stable-handle, and worker-recovery suites.
- `git diff --check`
  - PASS.

## Residual risks

- Outcome classification intentionally treats any failure after dispatch without conclusive evidence as unknown. This can require user confirmation when transport failure likely occurred before mutation; safety favors no replay.
- No live-site/provider test was run; deterministic production extension fixtures cover requested paths.
