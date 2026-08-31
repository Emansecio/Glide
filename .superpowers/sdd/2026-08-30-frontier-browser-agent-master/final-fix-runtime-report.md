# Final runtime-compatibility fix report

Date: 2026-08-31  
Scope: Final-review Important findings 1–4 only

## Result

Implemented cold-worker context lineage negotiation, fail-closed lossy recovery, manual plan-state provenance, and Portuguese/locale-neutral adaptive tool-pack selection. Deterministic restart coverage confirms second turn commits once across display history, context history, persisted storage, and reload.

## Changes

### 1. Cold-worker context revision handshake

- Added `contextRevision` to `user_message`.
- Added explicit `contextLineage` acknowledgements: `cold_required`, `cold_adopted`, and `warm_confirmed`.
- Added `ContextTransactionStore.adoptLineage()` so a cold worker can adopt panel-owned revision/history without synthesizing prior commits.
- Background rejects warm revision mismatches before run queueing.
- Panel marks a session synchronized only after matching session/revision acknowledgement.
- Deterministic MV3 restart E2E uses a local model fixture, restarts the service worker between turns, verifies revision `1 -> 2`, then checks exactly one second final in display/context/storage/reload.

### 2. Fail-closed structured recovery loss

- Recovery sanitization now preserves full prompt and tool-result text while snapshot remains within the total 128 KiB budget.
- Added structured `RunRecoveryLoss` reasons for secret redaction, binary redaction, and total-byte omission.
- Recovery snapshots persist loss metadata instead of reporting lossy data as complete.
- `assessRecovery()` refuses automatic resume whenever `loss.lossy` is true.
- `run_interrupted` carries structured `recoveryLoss` for diagnostics/confirmation UI paths.
- Added long-prompt and long-tool-result byte-exact regressions plus browser restart coverage proving lossy context emits interruption and never `run_resume_started`.

### 3. Provenance-protected model `update_plan`

- Added `statusProvenance: 'model' | 'manual'` to plan steps.
- Manual acknowledgements mark affected states as manual, including dependent resets.
- Stable-ID plan rebuild preserves matching manual state/provenance.
- Model updates now route through `applyModelPlanUpdate()` instead of mutating `currentPlan` directly.
- Conflicting model updates return a conclusive protected result and cannot overwrite acknowledged manual state.
- Added unit and production runtime E2E for manual `done ->` model `pending`; status remains `done`.

### 4. Portuguese and locale-neutral adaptive tool intent

- Exported shared diacritic-insensitive task text normalization.
- Added Portuguese form, upload, extraction, tab, advanced, diagnostic, and core-action intent roots.
- Added conservative `forms + extract` expansion for non-empty, unrecognized locale/intent while keeping effect-heavy advanced packs evidence-gated.
- Added recent completed-tool pack retention for continuation requests, alongside existing outstanding-call retention.
- Added Portuguese regressions for “selecione uma opção”, “preencha o formulário”, “anexe o arquivo”, “extraia a tabela”, and “continue/prossiga” after prior form activity.

## TDD evidence

Focused tests were added first and failed against missing lineage adoption/model-update APIs and old truncating/English-only behavior. After implementation:

- Focused Vitest: **6 files, 47 tests passed**.
- `npm run check`: **passed** (`tsc --noEmit` + Biome).
- Focused restart E2E: **passed**, including cold lineage and lossy recovery.
- Panel runtime E2E: **passed**, including manual-plan protection.
- `npm run test:frontier`: **passed**:
  - production build passed;
  - Vitest **42 files, 195 tests passed**;
  - legacy unit suite **328 passed**;
  - extension validator **33 passed**;
  - panel, frontier-action, stable-handle, and worker-recovery E2E gates passed.

## Residual risks

- Restart model fixture is deterministic and local; no paid-provider interruption run was performed.
- Recovery payloads above 128 KiB intentionally require interruption/confirmation rather than automatic resume.
- Findings 5–8 and deferred minor findings remain outside this runtime slice.

## Acceptance

```json
{
  "slice": "final-review-important-1-4-runtime-compatibility",
  "status": "pass",
  "cold_worker_lineage": "pass",
  "lossy_recovery_fail_closed": "pass",
  "manual_plan_provenance": "pass",
  "portuguese_continuation_tool_packs": "pass",
  "focused_tests": "47/47",
  "frontier_gate": "pass"
}
```
