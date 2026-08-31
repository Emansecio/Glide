# Glide API Reference

Glide exposes browser-control tools from `tools/browser-tools.ts` to the assistant loop in `background.ts`.

## Browser Tools

| Tool | Purpose |
| --- | --- |
| `navigate` | Navigate the current executable tab to an absolute URL. |
| `openTab` | Open a new session tab, subject to the session tab limit. |
| `click` | Click a DOM element by selector, text hint, or attribute hint. Supports retries, accessible frames, and `>>>` shadow DOM selectors. |
| `hover` | Move the pointer over an element to reveal menus, flyouts, toolbars, and CSS hover states. Supports retries, accessible frames, and `>>>` shadow DOM selectors. |
| `mouse` | Advanced mouse: `doubleClick`, `rightClick`, or `drag` (needs `toSelector`). |
| `type` | Fill `input`, `textarea`, `select`, and `contenteditable` fields. Supports retries, accessible frames, shadow DOM selectors, native value setters, and input/change events. |
| `pressKey` | Dispatch keyboard events to a selected or focused element. |
| `scroll` | Scroll the page or an element. |
| `getContent` | Extract text, HTML, title, URL, links, or structured page data with selectors. |
| `screenshot` | Capture the current tab. |
| `getTabs` | List known browser tabs. |
| `closeTab` | Close a tab. |
| `switchTab` | Switch the active executable tab. |
| `focusTab` | Focus an existing tab. |
| `groupTabs` | Group session tabs. |
| `describeSessionTabs` | Describe the current session tab set. |
| `findElement` | Search visible interactive elements by text, label, placeholder, name, or test id. |
| `wait` | Wait for a fixed time or for a selector to appear. Supports `>>>` shadow DOM selectors and accessible frames. |
| `executeScript` | Execute JavaScript in the page context and return the result. |
| `getNetworkRequests` | Capture Fetch/XHR/WebSocket (method, url, status, headers, requestBody, apiHints) plus resource timing. Install hooks first, then re-read after the UI action. |
| `getStorageData` | Read localStorage, sessionStorage, or cookies with truncation. |
| `getPerformanceMetrics` | Return navigation, paint, resource, and memory metrics. |
| `getConsoleOutput` | Capture buffered console output and page errors. |
| `readPage` | Interactive inventory with refs (`e1`…) and CSS selectors. Prefer before blind click/type. |
| `clipboard` | Read or write clipboard text from the page context. |
| `setInputFiles` | Assign synthetic text files to `input[type=file]`. |
| `cdp` | Opt-in Chrome DevTools Protocol (`toolPermissions.debugger`). attach / detach / send. |

## Selector Notes

- Prefer `findElement` before `click` or `type` when a selector is uncertain.
- Prefer stable selectors: `id`, `data-testid`, `name`, `aria-label`, and placeholder.
- Use `host-selector >>> inner-selector` for open shadow roots.
- Frame-aware tools route bridge messages to one explicit `frameId`; mutations never fan out across frames.
- `readPage` and `findElement` return versioned stable handles containing snapshot, tab, frame, selector, fingerprint, and DOM revision. Plain refs/selectors remain accepted for migration compatibility.
- Mutation with a stale or mismatched handle fails closed with `STALE_ELEMENT_HANDLE` and refreshed candidates.
- Effect tools may accept an expected `postcondition`; results expose verification evidence. Browser-dispatched events are synthetic through the bridge unless opt-in CDP input is enabled, so they are not claimed as trusted native events.

## Runtime Messages

Runtime messages are defined in `types/runtime-messages.ts` and normalized through the sidepanel/background flow.

Primary message categories:

- User input and assistant responses.
- Tool call start/progress/result updates.
- Plan and activity updates.
- Settings, history, and tab context updates.
- Versioned `context_commit`, run recovery, and explicit terminal-state updates.

Tool start/result messages add optional telemetry fields without invalidating schema-v2 readers: `actionId`, `tabId`, `frameId`, `queueMs`, `executeMs`, `verifyMs`, `totalMs`, `resultBytes`, `checkpointPhase`, and `contextRevision`. `recoveryStage` remains bounded. Persisted telemetry keeps at most 200 content-free events and excludes arguments, typed values, prompts, credentials, screenshots, result bodies, and URL queries.

Terminal reasons are `completed`, `awaiting_user`, `stopped`, `failed`, `interrupted`, and `ambiguous_action`. `run_resume_started` means a safe checkpoint resumed. `run_resume_required` means an in-flight effect is ambiguous and needs user confirmation; it is never replayed automatically.

The background service worker is the execution boundary: UI code requests actions, the background validates permissions and arguments, then routes bridge-first operations or Chrome APIs. CDP remains opt-in through `toolPermissions.debugger`.
