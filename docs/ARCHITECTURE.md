# Glide Architecture

Glide is a Chrome Manifest V3 extension for LLM-driven browser control.

## Main Components

| Area | Files | Responsibility |
| --- | --- | --- |
| Manifest and bundle | `manifest.json`, `scripts/build.mjs`, `dist/` | Build and load the extension artifacts. |
| Background worker | `background.ts` | Owns provider calls, tool execution, tab resolution, permission checks, and streaming updates. |
| Browser tools | `tools/browser-tools.ts` | Implements navigation, DOM interaction, page inspection, screenshots, diagnostics, and tab control. |
| Sidepanel UI | `sidepanel/` | Chat UI, settings, history, activity panel, plan drawer, and composer. |
| AI utilities | `ai/` | Provider conversion, retry handling, message schema, and context compaction. |
| Shared types | `types/` | Runtime messages and shared contracts. |
| Tests | `tests/` | Extension validator, unit tests, and e2e runners. |

## Control Flow

1. The user sends a message from the sidepanel.
2. `background.ts` builds provider messages and streams the model response.
3. When the model requests a tool, the background validates the tool name, arguments, tab target, and permission gate.
4. `tools/browser-tools.ts` executes the browser action through Chrome APIs or `chrome.scripting.executeScript`.
5. The result is sent back to the model and mirrored to the sidepanel activity timeline.

## Browser Execution Model

- The sidepanel is tab-scoped.
- Browser actions resolve an executable tab before running.
- Session tabs are tracked and can be grouped.
- DOM actions run first in the resolved document and can fall back to accessible frames.
- Shadow DOM access uses the custom `>>>` selector chain for open shadow roots.
- Dynamic pages are handled with retries, waits, and structured discovery through `findElement` and `getContent`.

## Reliability Principles

- Validate tool arguments before execution.
- Prefer stable selectors and discovery tools over brittle generated selectors.
- Return actionable failure metadata, including candidate elements when available.
- Keep generated extension artifacts in `dist/` synchronized by running `npm run build` after UI or tool changes.
- Treat `npm test` as the broad local gate: it builds, validates the extension package, and runs unit tests.

## Current Local Gate

```bash
npm run typecheck
npx biome check tools/browser-tools.ts
npm run test:unit
npm run build
npm test
```
