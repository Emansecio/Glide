# Glide API Reference

This document describes the internal extension APIs used between Sidepanel UI and Background Service Worker.

## Runtime Envelope

Background -> sidepanel runtime events use a common envelope (`types/runtime-messages.ts`):

```ts
{
  schemaVersion: 2;
  runId: string;
  sessionId: string;
  turnId?: string;
  timestamp: number;
  type: RuntimeMessageType;
  // payload fields...
}
```

## Sidepanel -> Background Messages

### `user_message`

Start a normal assistant run.

```ts
{
  type: 'user_message';
  message: string;
  conversationHistory: Message[];
  selectedTabs?: chrome.tabs.Tab[];
  sessionId?: string;
}
```

Response (immediate):

```ts
{ success: true; queued: true }
```

### `execute_tool`

Manual tool execution path.  
Important: this path now uses the same permission checks as normal runs.

```ts
{
  type: 'execute_tool';
  tool: string;
  args?: Record<string, unknown>;
  sessionId?: string;
  toolCallId?: string;
}
```

Response:

```ts
{
  success: boolean;
  result?: unknown;
  error?: string;
}
```

### `get_execution_events`

Read persisted execution events.

```ts
{ type: 'get_execution_events' }
```

Response:

```ts
{
  success: boolean;
  events?: ExecutionEvent[];
  error?: string;
}
```

## Background -> Sidepanel Message Types

Main streaming and run lifecycle events:

- `assistant_stream_start`
- `assistant_stream_delta` (`channel: 'text' | 'reasoning'`)
- `assistant_stream_stop`
- `assistant_final`
- `run_error`
- `run_warning`
- `context_compacted`
- `tool_execution_start`
- `tool_execution_result`
- `plan_update`
- `manual_plan_update`
- `subagent_start`
- `subagent_complete`

Reference source of truth: `types/runtime-messages.ts`.
Non-schema messages are not used for runtime errors; failures are emitted as `run_error`.

## Storage Keys (`chrome.storage.local`)

Main settings keys:

- `provider`, `apiKey`, `model`, `customEndpoint`
- `systemPrompt`, `temperature`, `maxTokens`, `timeout`, `contextLimit`
- `configs`, `activeConfig`
- `visionBridge`, `visionProfile`
- `useOrchestrator`, `orchestratorProfile`, `auxAgentProfiles`
- `toolPermissions`, `allowedDomains`
- `enableScreenshots`, `sendScreenshotsAsImages`, `screenshotQuality`
- `autoRecoveryMode`, `screenshotOnFailure`, `screenshotRetention`
- `showThinking`, `streamResponses`, `autoScroll`, `confirmActions`, `saveHistory`

Provider values currently supported in runtime model resolution:

- `openai`
- `anthropic`
- `google`
- `ollama`
- `kimi`
- `custom`

## Tool Definitions

Defined by `BrowserTools.getToolDefinitions()` in `tools/browser-tools.ts`.

Current tool names:

- `navigate`
- `openTab`
- `click`
- `type`
- `pressKey`
- `scroll`
- `getContent`
- `screenshot`
- `getTabs`
- `closeTab`
- `switchTab`
- `focusTab`
- `groupTabs`
- `describeSessionTabs`

## `getContent` Modes

`getContent` supports:

- `text` (default)
- `html` (preview/truncated)
- `title`
- `url`
- `links`
- `structure`

Optional controls:

- `selector`
- `maxChars`
- `maxItems`
- `tabId`

## Security-Relevant API Behavior

### Dedicated Locked-Tab Mode

`user_message` runs execute in a single dedicated tab managed by the background service worker.

- The tab is created automatically (if needed) and reused across runs.
- Browser tool calls are pinned to the locked tab id.
- Passing a different `tabId` is blocked with:
  - `code: "TAB_LOCK_POLICY"`
  - `policy.type: "tab_lock"`

Browser tools allowed while lock is active:

- `navigate`
- `click`
- `type`
- `pressKey`
- `scroll`
- `getContent`
- `screenshot`

Blocked browser tools while lock is active:

- `openTab`
- `focusTab`
- `switchTab`
- `closeTab`
- `groupTabs`
- `getTabs`
- `describeSessionTabs`

### Permission and Domain Gates

Every tool execution path checks:

1. Category permission (`read`, `interact`, `navigate`, `tabs`, `screenshots`)
2. Optional domain allowlist (`allowedDomains`)

### Screenshot Data Retention

Screenshot `dataUrl` is filtered according to `screenshotRetention`:

- `ephemeral`: do not retain image payload
- `debug-short`: keep only when image sending is enabled
- `persistent`: keep payload

Execution telemetry persisted for diagnostics is trimmed and redacted for sensitive keys (`apiKey`, `token`, `password`, `authorization`, `text`, `value`, `content`).

When `screenshot` needs a non-active target tab, it may temporarily focus that tab for capture and then restore previous focus.
The result can include:

- `focusedForCapture?: boolean`
- `restoredFocus?: boolean`
- `capturedTabId?: number`

### Markdown URL Policy (UI)

Rendered markdown links/images are sanitized:

- links: `http`, `https`, `mailto`
- images: `http`, `https`
- invalid/unsafe URLs are downgraded to plain text
