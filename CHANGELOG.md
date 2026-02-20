# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and Semantic Versioning.

## [Unreleased]

### Added

- Target-based build workflow:
  - `build:ext` for extension artifacts
  - `build:test` for test bundles

### Changed

- Validator updated to check real `dist/` structure and current docs/scripts.
- Test runner output normalized for readable pass/fail logs.
- Manual `execute_tool` path now uses the same runtime policy pipeline as normal runs.
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
