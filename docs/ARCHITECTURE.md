# Glide Architecture

## Overview

Glide is a Chrome extension with three runtime layers:

1. Sidepanel UI (`sidepanel/`)
2. Background Service Worker (`background.ts`)
3. Browser execution layer (`tools/browser-tools.ts` + Chrome APIs)

The sidepanel sends user intent, the background orchestrates LLM + tool execution, and tool results stream back to UI.

## High-Level Diagram

```text
User
  -> Sidepanel UI
  -> chrome.runtime message
  -> Background Service Worker
  -> AI provider (streaming + tool calls)
  -> BrowserTools / Chrome APIs
  -> runtime events
  -> Sidepanel UI
```

## Main Components

### Sidepanel (`sidepanel/`)

- Entry: `sidepanel/panel.ts`
- Layout loading: `sidepanel/ui/layout-loader.ts`
- Runtime message handling: `sidepanel/ui/panel-core.ts`
- Streaming rendering: `sidepanel/ui/panel-streaming.ts`
- Tool/activity rendering: `sidepanel/ui/panel-tools.ts`
- Markdown rendering/sanitization: `sidepanel/ui/panel-markdown.ts`

UI layout notes:

- `sidepanel/templates/main.html` keeps activity output in-flow between chat and composer for stable reading.
- Composer context actions (`file`, `tabs`) live in `composer-context-tools` above the textarea.
- `sidepanel/templates/tab-selector.html` uses desktop modal behavior and mobile bottom-sheet behavior (`<480px`) via `sidepanel/styles/panels.css`.
- Sidebar backdrop blur/open motion is driven by `sidepanel/styles/layout.css`.

### Background (`background.ts`)

- Receives message types (`user_message`, `execute_tool`, `get_execution_events`)
- Loads runtime settings from storage
- Ensures a dedicated locked tab for `user_message` runs
- Builds provider model and tool set
- Executes tool calls via `executeToolByName`
- Emits schema-versioned runtime events (`types/runtime-messages.ts`)
- Tracks execution events for log/export
- Enforces single active user run at a time to prevent mutable-state races

### Browser tools (`tools/browser-tools.ts`)

- Encapsulates browser actions and DOM extraction
- Maintains session tab state
- Implements structured extraction (`getContent` mode `structure`)
- Normalizes common tool failure return shapes

## Message Flow

### Normal Assistant Run

1. Sidepanel sends `user_message`
2. Background resolves/creates dedicated locked run tab
3. Background prepares context + tools (locked-tab allowlist)
4. Browser tools execute only against the dedicated tab id
5. Model streams deltas
6. Background emits:
   - `assistant_stream_start`
   - `assistant_stream_delta` (text/reasoning)
   - `assistant_stream_stop`
   - `assistant_final`
7. UI merges display history and context history

### Manual Tool Run

1. Sidepanel sends `execute_tool`
2. Background routes through `executeToolByName`
3. Same permission/domain/screenshot policies apply
4. Returns tool result to requester

## Security Boundaries

### Tool Permission Layers

Tool execution is gated by:

- category permission (`read`, `interact`, `navigate`, `tabs`, `screenshots`)
- optional allowed domain policy (`allowedDomains`)
- screenshot feature toggle
- dedicated locked-tab policy for normal runs (`TAB_LOCK_POLICY` on violations)

### Output Hardening

- Screenshot payload is sanitized before runtime transport and history persistence
- Markdown links/images are protocol-restricted in UI renderer
- Execution logs compact/trim large payload fields
- Execution telemetry redacts sensitive keys before persistence/export
- Screenshot capture can temporarily focus locked tab and restore prior focus

## Build Architecture

Build system is target-based (`scripts/build.mjs`):

- `--target=ext`: extension artifacts only
- `--target=test`: test runner bundles only
- `--target=all`: both

NPM wiring:

- `npm run build` / `build:ext` -> extension only
- `npm run build:test` -> tests only
- `npm run validate`, `npm test` -> compose both targets

This keeps default extension packaging clean while preserving test workflows.

## Persistent State Model

`chrome.storage.local` stores:

- active profile settings
- profile map (`configs`)
- permission and allowlist policy
- behavior flags (streaming, thinking, history, screenshot retention)
- chat session history and execution logs

In-memory state is split between:

- sidepanel runtime UI state
- background run orchestration state
- BrowserTools session tab state

## Operational Notes

- Extension loads from `dist/`
- Runtime message schema is versioned (`schemaVersion = 2`)
- Build performs TypeScript checks before bundling
