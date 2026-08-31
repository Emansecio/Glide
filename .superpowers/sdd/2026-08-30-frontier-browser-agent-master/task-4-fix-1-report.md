# Task 4 fix 1 report — Browser kernel review findings

Status: DONE

Implementation commit: `381ba76 fix: close browser kernel review findings`

## Findings closed

### Important — `url_changed` false-positive without `from`

- `content/operations/action.ts` captures `location.href` before click dispatch when caller omits `from`.
- `content/operations/form.ts` captures same baseline before type/select mutations.
- `tools/action-postcondition.ts` resolves omitted `from` from captured baseline and refuses verification without any baseline.
- `tests/vitest/action-postcondition.test.ts` proves unchanged URL returns `POSTCONDITION_FAILED` with observed URL and resolved baseline.

### Important — shadow-DOM stable handles fail resolution

- Added shared `tools/deep-selector.ts`; `content/dom-interact.ts` re-exports same resolver for compatibility.
- `tools/stable-element-handle.ts` now resolves Glide `>>>` selectors through shared deep-selector helper.
- Expired snapshots now return refreshed candidates instead of empty recovery evidence.
- `tests/vitest/stable-element-handle.test.ts` covers shadow-root handle round-trip and expired-snapshot candidates.

### Important — live tool packs not adaptive

- Added `background/tool-pack-state.ts` as background runtime seam.
- `background.ts` now rebuilds filtered tool definitions for every orchestration pass from real latest user task text, active tool-failure state, and outstanding call names.
- Failed browser pass activates diagnostics on next recovery pass.
- Outstanding calls retain owning pack until matching tool result appears.
- Deterministic active-pack state enters `<tool_packs>` execution context each pass.
- `tests/vitest/background-tool-packs.test.ts` covers real form intent, recovery diagnostics, outstanding extract calls, result matching, filtered definitions, and prompt state.

## Validation evidence

```text
npm run test:vitest -- --run tests/vitest/action-postcondition.test.ts tests/vitest/stable-element-handle.test.ts tests/vitest/tool-packs.test.ts tests/vitest/background-tool-packs.test.ts tests/vitest/browser-operation-parity.test.ts
PASS: 5 files, 30 tests.
```

```text
npm run check
PASS: tsc --noEmit; Biome checked 199 files, no fixes.
```

```text
npm run build:all
PASS: production background, sidepanel, content, and test bundles built.
node dist/tests/e2e/test-frontier-actions.js --case postcondition
PASS frontier action case: postcondition
node dist/tests/e2e/test-stable-handles.js
PASS stable element handles
```

```text
npm run test:frontier
PASS: 22 Vitest files / 96 tests; legacy unit 335 passed; validator 33 passed; production E2E passed; frontier click/find/frame cases passed; worker recovery safe/committed/ambiguous cases passed with zero replay.
```

## Diff evidence

Implementation diff: 12 files, 301 insertions, 93 deletions.

Residual risks:

- CDP-native input fixture remains permission-dependent/manual, unchanged from milestone report. Policy and no-permission paths remain automated.
- Legacy bridge-disabled compatibility injection remains unchanged and outside three blocking findings.

Review verdict after fix: all three Important findings closed; load-bearing stale-candidate concern also closed.
