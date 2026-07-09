# Glide API Reference

Glide exposes browser-control tools from `tools/browser-tools.ts` to the assistant loop in `background.ts`.

## Browser Tools

| Tool | Purpose |
| --- | --- |
| `navigate` | Navigate the current executable tab to an absolute URL. |
| `openTab` | Open a new session tab, subject to the session tab limit. |
| `click` | Click a DOM element by selector, text hint, or attribute hint. Supports retries, accessible frames, and `>>>` shadow DOM selectors. |
| `hover` | Move the pointer over an element to reveal menus, flyouts, toolbars, and CSS hover states. Supports retries, accessible frames, and `>>>` shadow DOM selectors. |
| `mouse` | Perform advanced mouse actions: `doubleClick` and `rightClick`. Supports retries, accessible frames, and `>>>` shadow DOM selectors. |
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
| `getNetworkRequests` | Inspect buffered Fetch/XHR and resource timing data. |
| `getStorageData` | Read localStorage, sessionStorage, or cookies with truncation. |
| `getPerformanceMetrics` | Return navigation, paint, resource, and memory metrics. |
| `getConsoleOutput` | Capture buffered console output and page errors. |

## Selector Notes

- Prefer `findElement` before `click` or `type` when a selector is uncertain.
- Prefer stable selectors: `id`, `data-testid`, `name`, `aria-label`, and placeholder.
- Use `host-selector >>> inner-selector` for open shadow roots.
- Frame-aware tools inject into accessible frames when the main document does not contain the target.

## Runtime Messages

Runtime messages are defined in `types/runtime-messages.ts` and normalized through the sidepanel/background flow.

Primary message categories:

- User input and assistant responses.
- Tool call start/progress/result updates.
- Plan and activity updates.
- Settings, history, and tab context updates.

The background service worker is the execution boundary: UI code requests actions, the background validates permissions and arguments, then browser tools interact with Chrome APIs or page scripts.
