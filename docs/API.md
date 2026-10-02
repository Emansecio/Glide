# Glide API Reference

Glide exposes browser-control tools from `tools/browser-tools.ts` to the assistant loop in `background.ts`.

## Browser Tools

| Tool | Purpose |
| --- | --- |
| `navigate` | Navigate the current executable tab to an absolute URL. |
| `openTab` | Open a new session tab. |
| `selectOption` | Select an option in a native `<select>` or custom ARIA dropdown (MUI/React-Select combobox + portal listbox). Provide exactly one of `value`, `label`, or `index`. |
| `fillForm` | Fill multiple form fields in one call (`text`, `checked`, or `option` per field). Runs sequentially and returns per-field results. At most 20 fields per call; more is rejected. |
| `dismissModal` | Close the topmost open modal/dialog: close button, then Escape, then backdrop click. |
| `highlightElement` | Draw a transient outline overlay on an element (`selector` or `readPage` ref) so the user can see what is being acted on. |
| `findInPage` | Find text in visible page content (TreeWalker over text nodes); returns match contexts and total count, and scrolls the first match into view. |
| `extractTable` | Extract a structured HTML table (largest by default, or `selector`). `colspan` cells repeat their text; short rows are padded. |
| `harvestScroll` | Harvest repeated items from infinite-scroll lists until `stableRounds` pass with no new items, `maxItems`, or 20 rounds. |
| `annotatedScreenshot` | Set-of-marks screenshot: numbered overlays on interactive elements plus a marks list (ref, selector, tag, text, box). |
| `elementScreenshot` | Clipped screenshot around one element (`selector` or `readPage` ref). |
| `navigateHistory` | Navigate browser history (`back`, `forward`, `reload`) and wait for tab readiness. |
| `httpRequest` | HTTP request from the extension host, outside page CSP, including target-site cookies. Private/loopback hosts are blocked; an opaque redirect is reported as an error. |
| `captureDownload` | Capture a file download triggered by the page (or start one directly) and return its id, filename, mime, size, and state. |
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
| `cdp` | Chrome DevTools Protocol, always available (gated by the `interact` permission). attach / detach / send. |

## Selector Notes

- Prefer `findElement` before `click` or `type` when a selector is uncertain.
- Prefer stable selectors: `id`, `data-testid`, `name`, `aria-label`, and placeholder.
- Use `host-selector >>> inner-selector` for open shadow roots.
- Frame-aware tools route bridge messages to one explicit `frameId`; mutations never fan out across frames.
- `readPage` and `findElement` return versioned stable handles containing snapshot, tab, frame, selector, fingerprint, and DOM revision. Plain refs/selectors remain accepted for migration compatibility.
- Mutation with a stale or mismatched handle fails closed with `STALE_ELEMENT_HANDLE` and refreshed candidates.
- Effect tools may accept an expected `postcondition`; results expose verification evidence. Browser-dispatched events are synthetic through the bridge unless CDP native input is requested (`native: true`), so they are not claimed as trusted native events.

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

The background service worker is the execution boundary: UI code requests actions, the background validates permissions and arguments, then routes bridge-first operations or Chrome APIs. CDP is always available; the legacy `toolPermissions.debugger` flag is ignored.
