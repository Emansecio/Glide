# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and Semantic Versioning.

## [Unreleased]

### Added

- Target-based build workflow:
  - `build:ext` for extension artifacts
  - `build:test` for test bundles
- Browser automation tools:
  - `findElement`: fuzzy-matching element discovery by text/aria-label/placeholder/name/data-testid, returns optimal CSS selector
  - `wait`: polling-based wait for selector visibility or fixed delay
  - `pressKey` now dispatches `input` and `change` events for React/Vue compatibility
  - `getContent({ mode: "structure" })` now includes `selector` in all interactive nodes
- Harness Layer 3 automatic retry: when `click`/`type` fails with `ELEMENT_NOT_FOUND`, the harness auto-runs `findElement` and injects candidates into the model's recovery prompt
- Local Ollama auto-detection at startup (`http://localhost:11434/api/tags`, 3s timeout); silently switches provider to `openai-compatible` when found
- System prompt default updated with hierarchical recovery strategy (1. selector refinement, 2. findElement, 3. wait, 4. structure mode)
- Sidepanel tab-scoped behavior (contextual, not global/per-window):
  - `openPanelOnActionClick: false`; `chrome.action.onClicked` now enables the clicked tab explicitly (`setOptions({ tabId, path, enabled: true })`) and calls `sidePanel.open({ tabId })`
  - global default disabled at startup (`setOptions({ enabled: false })` with no `tabId`) so the panel no longer follows the user across tabs
  - `claimSidePanelOwnership()` disables the previous owner tab explicitly (always with a `tabId`) whenever a new tab claims the panel - never a bare no-tabId disable, which is what previously blocked re-opening
  - `chrome.tabs.onRemoved` clears ownership when the owner tab is closed
- Sidepanel session persistence (Chrome 142+):
  - `sidePanelTabId` persisted to `chrome.storage.session` under key `glideSidePanelTabId`, and hydrated back on service worker restart so ownership survives MV3 worker teardown
  - `chrome.sidePanel.onClosed` listener clears ownership when user manually closes the panel
- Ollama auto-detection now takes priority: always probes on startup and overrides saved provider settings when local Ollama is found

### Changed

- Validator updated to check real `dist/` structure and current docs/scripts.
- Test runner output normalized for readable pass/fail logs.
- Manual `execute_tool` path now uses the same runtime policy pipeline as normal runs.
- Sidepanel UI premium redesign (anti-slop):
  - warm-dark palette (`#0d0c0b` background, `#c9a96e` accent) with anti-AI-cyan stance
  - Liquid Glass surfaces (sidebar, composer, activity panel, modals, model picker, toasts)
  - Geist font via CDN
  - Generous border-radius scale (10/14/18/24px)
  - Tactile active states (`scale(0.96)`)
  - `prefers-reduced-motion` respected globally
  - refined scrollbar and warm text selection
  - empty state orb glow, asymmetric message bubbles
  - floating dock glass composer, warm accent send button
- Sidepanel UI refinements:
  - removed redundant composer `settings` button
  - moved context attach tools to `composer-context-tools` above input
  - converted activity trigger to compact icon button with dynamic ARIA/tooltip label
  - stabilized activity panel in layout flow (non-overlapping with chat content)
  - added mobile tab selector bottom-sheet presentation (`<480px`)
  - aligned sidebar backdrop blur entrance to `250ms` keyframe animation

### Security

- Subagent navigation rendering hardened to avoid HTML injection from dynamic names.
- Markdown URL policy restricted:
  - links allow `http`, `https`, `mailto`
  - images allow `http`, `https`

### Documentation

- Reworked local docs to align with current scripts, architecture, APIs, and security behavior.

## [0.2.0] - 2026-02-18

### Added

- Ollama provider integration with model discovery support.
- Kimi provider support.
- Multi-profile roles (main, vision, orchestrator, auxiliary).
- Context compaction flow.
- Plan drawer with checklist UX.
- Activity panel with tool log.

### Changed

- Sidepanel UI redesign and streaming UX improvements.
- AI SDK v6 integration.
- Responsive composer density (`normal`, `compact`, `tight`).

### Fixed

- Provider endpoint normalization and profile switching issues.
- Composer/status overlap in narrower sidepanel widths.
- Stability for long activity/context labels.
