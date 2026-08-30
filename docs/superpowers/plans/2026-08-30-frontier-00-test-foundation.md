# Frontier 00 Test Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish awaited Vitest tests and deterministic browser fixtures before changing action/runtime contracts.

**Architecture:** Vitest runs pure and Chrome-mocked TypeScript tests directly. Existing custom tests remain as a compatibility gate until migrated. Playwright serves deterministic HTTP fixtures and loads the production extension bundle.

**Tech Stack:** TypeScript, Vitest, Playwright, esbuild, Chrome MV3

**Spec:** `docs/superpowers/specs/2026-08-30-frontier-browser-agent-program-design.md`

## Global Constraints

- Preserve vanilla TypeScript/CSS and tab-scoped side-panel behavior.
- Keep current `npm run test:unit`, validator, and E2E commands working during migration.
- New async tests must be awaited by runner semantics.
- Browser fixtures must not depend on live sites.
- Every package change must update `package-lock.json`.

---

### Task 1: Add Vitest runner without replacing legacy gates

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.config.ts`
- Create: `tests/vitest/setup.ts`
- Create: `tests/vitest/smoke.test.ts`

**Interfaces:**
- Produces: scripts `test:vitest`, `test:vitest:watch`; Vitest globals disabled; shared Chrome mock reset in `tests/vitest/setup.ts`.

- [ ] **Step 1: Add failing smoke test**

```ts
import { describe, expect, it } from 'vitest';
import { normalizePlanStatus } from '../../types/plan.js';

describe('vitest foundation', () => {
  it('loads project TypeScript modules', () => {
    expect(normalizePlanStatus('done')).toBe('done');
  });
});
```

- [ ] **Step 2: Confirm runner is absent**

Run: `npm run test:vitest -- --run tests/vitest/smoke.test.ts`  
Expected: FAIL because script/package is unavailable.

- [ ] **Step 3: Install and configure Vitest**

Run: `npm install --save-dev vitest`

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['tests/vitest/setup.ts'],
    include: ['tests/vitest/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    testTimeout: 15_000,
  },
});
```

Add scripts:

```json
"test:vitest": "vitest run",
"test:vitest:watch": "vitest"
```

Create `tests/vitest/setup.ts` with `afterEach(() => vi.unstubAllGlobals())` and no persistent global Chrome object.

- [ ] **Step 4: Run focused and existing tests**

Run: `npm run test:vitest -- --run tests/vitest/smoke.test.ts && npm run test:unit`  
Expected: Vitest 1 pass; legacy runner remains green.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/vitest
 git commit -m "test: add awaited Vitest foundation"
```

### Task 2: Add deterministic browser fixture server

**Files:**
- Create: `tests/e2e/fixture-server.ts`
- Create: `tests/e2e/fixtures/action-lab.html`
- Create: `tests/e2e/fixtures/frame-lab.html`
- Create: `tests/e2e/fixtures/child-frame.html`
- Create: `tests/e2e/frontier-helpers.ts`
- Modify: `scripts/build.mjs`

**Interfaces:**
- Produces: `startFixtureServer(): Promise<{ baseUrl: string; close(): Promise<void> }>`.
- Produces: `sendManualTool(panel, tool, args)` and `sendBridge(panel, op, payload, frameId?)`.

- [ ] **Step 1: Write fixture-server unit test**

Create `tests/vitest/fixture-server.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer } from '../e2e/fixture-server.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('fixture server', () => {
  it('serves action and frame labs over HTTP', async () => {
    const server = await startFixtureServer();
    close = server.close;
    expect((await fetch(`${server.baseUrl}/action-lab.html`)).status).toBe(200);
    expect(await (await fetch(`${server.baseUrl}/frame-lab.html`)).text()).toContain('child-frame.html');
  });
});
```

- [ ] **Step 2: Run test and observe missing module**

Run: `npm run test:vitest -- --run tests/vitest/fixture-server.test.ts`  
Expected: FAIL resolving `fixture-server.js`.

- [ ] **Step 3: Implement server and fixtures**

Use `node:http`, bind `127.0.0.1` on port `0`, reject paths escaping fixture root, and return proper MIME types. `action-lab.html` must expose counters on `window.__actionLab` for click, input, change, submit, hover, and checkbox state. `frame-lab.html` and child fixture must contain duplicate checkbox selectors to detect cross-frame mutation.

Add test sources to `TEST_ENTRY_POINTS` in `scripts/build.mjs` only when they are executable entrypoints; fixture HTML is copied by test setup, not extension build.

- [ ] **Step 4: Run fixture test**

Run: `npm run test:vitest -- --run tests/vitest/fixture-server.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e scripts/build.mjs
 git commit -m "test: add deterministic browser fixture server"
```

### Task 3: Make live scripts propagate child failures

**Files:**
- Create: `scripts/run-child.mjs`
- Modify: `package.json`
- Create: `tests/vitest/run-child.test.ts`

**Interfaces:**
- Produces: `runChild(scriptPath, extraEnv): number`; CLI exits with exact child status or `1` on signal/spawn failure.

- [ ] **Step 1: Write failing exit propagation test**

```ts
import { expect, it } from 'vitest';
import { runChild } from '../../scripts/run-child.mjs';

it('returns non-zero child status', () => {
  expect(runChild(['-e', 'process.exit(7)'], {})).toBe(7);
});
```

- [ ] **Step 2: Confirm missing helper fails**

Run: `npm run test:vitest -- --run tests/vitest/run-child.test.ts`  
Expected: FAIL resolving helper.

- [ ] **Step 3: Implement helper and replace three `node -e` scripts**

Use `spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv } })`; return `result.status ?? 1`. CLI assigns `process.exitCode`.

- [ ] **Step 4: Run test and syntax checks**

Run: `npm run test:vitest -- --run tests/vitest/run-child.test.ts && npm run typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-child.mjs package.json tests/vitest/run-child.test.ts
 git commit -m "fix: propagate live test exit status"
```

### Task 4: Add frontier aggregate gate

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run test:frontier` running Vitest, legacy unit, validator, and deterministic E2E after one production test build.

- [ ] **Step 1: Add aggregate script**

```json
"test:frontier": "npm run build:all && npm run test:vitest && node dist/tests/unit/run-unit-tests.js && node dist/tests/validate-extension.js && node dist/tests/e2e/run-e2e.js"
```

- [ ] **Step 2: Add Vitest CI step before legacy unit tests**

Run `npm run test:vitest` in test job. Keep E2E job unchanged.

- [ ] **Step 3: Run complete local gate**

Run: `npm run test:frontier`  
Expected: all processes exit `0`.

- [ ] **Step 4: Commit**

```bash
git add package.json .github/workflows/ci.yml
 git commit -m "ci: add frontier regression gate"
```
