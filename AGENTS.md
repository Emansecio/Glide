# Agent Notes

## Build & Deploy

- The extension is loaded from `dist/`. After UI changes, rebuild with `npm run build` or update the matching files in `dist/`.
- When editing UI code, prefer updating the source files under `sidepanel/` and then rebuilding so `dist/sidepanel/` stays in sync.
- **Always run `npm run build` before handing off UI changes** — this is the **production** build (`--prod`: minify, no sourcemaps, drop console).
- Use `npm run build:dev` only when you need sourcemaps for local debugging.
- Build script: `node scripts/build.mjs --target=ext --prod` (default via `npm run build` / `build:ext` / `build:prod`).

## Architecture Overview

- **Chrome Extension Manifest V3**, sidepanel-only.
- **Vanilla TypeScript + CSS** — no React, no Tailwind.
- **Styles** live in `sidepanel/styles/` and are split by concern:
  - `base.css` — CSS variables (warm-dark palette, liquid glass, typography, motion), resets, scrollbar, selection
  - `layout.css` — sidebar, nav, chat layout, responsive breakpoints
  - `chat.css` — message bubbles, empty state, thinking states
  - `composer.css` — input dock, model picker dropdown, send button, context tools
  - `tools.css` — activity panel, plan drawer, agent navigation
  - `settings.css` — settings forms, oauth, provider controls
  - `modals.css` — tab selector, oauth overlays, modal shells
  - `utilities.css` — toasts, buttons, jump-to-latest, reduced-motion overrides
- **Entry point**: `sidepanel/sidepanel.ts` bootstraps `panel-core.ts`.

## UI Design System

- **Direction**: warm workshop instrument — solid surfaces, no liquid-glass, no gold glow, no AI-orb empty states.
- **Palette**: background `#141210`, elevated `#1c1916`, ink `#f0ebe3`, muted `#9a9286`, accent clay `#d4713a` (not gold).
- **Font**: system only (CSP) — `Segoe UI` / `ui-sans-serif`; mono for labels (`ui-monospace`, Cascadia/Consolas).
- **Surfaces**: flat fills + 1px `--border` (`#2e2923`). Avoid `backdrop-filter` except nowhere.
- **Radius**: 4 / 6 / 8 px (utilitarian, nearly square).
- **Motion**: short opacity/transform only; honor `prefers-reduced-motion`. No spring bounce / shimmer / orb-breathe.
- **Density**: desktop-first internal tool; high information density without decorative chrome.

## Browser Automation Tools (`tools/browser-tools.ts`)

All tools run via content-script injection in the resolved executable tab.

| Tool | Purpose |
|-|-|
| `findElement` | Discover interactive elements by text/aria-label/placeholder/name/data-testid. `scope`: `auto` (prefer open dialog), `dialog`, `page`. Fuzzy by default. |
| `wait` | Conditions: `time`, `selector`, or `dialog` (wait for modal/role=dialog — Instagram sheets). |
| `click` | Rich pointer/mouse events (React/Instagram). Text-label fallback. `waitForDialog` (default true) reports `dialogOpen` / `openedDialog`. |
| `dismissModal` | Close topmost modal: close button → Escape → backdrop. |
| `type` | Type into inputs (React/Vue value setter + events). |
| `pressKey` | Keyboard events (Escape to close sheets, etc.). |
| `getContent` | `mode: "structure"` prioritizes open dialogs and includes `dialogs[]` + selectors. |
| `scroll` | Scroll the page or an element. |
| `navigate` | Navigate to a URL or go back/forward/reload. |

### findElement Selector Priority

The returned selector is chosen in this order:
1. `id` → `#id`
2. `data-testid` → `[data-testid="..."]`
3. `name` → `[name="..."]`
4. `aria-label` → `[aria-label="..."]`
5. `placeholder` → `[placeholder="..."]`
6. Stable class (lowercase alphanumeric/underscore/hyphen, 3–40 chars, no long numeric suffix) → `.class`
7. `tag:nth-child(index)` within parent

## Harness Recovery Strategy

When a browser action (`click`/`type`) fails with `ELEMENT_NOT_FOUND`, the harness performs an **automatic Layer 3 retry**:
1. Calls `findElement` with the original target description.
2. Injects the returned candidates into the model's error recovery prompt via `buildFailureRecoverySection()`.
3. The model is instructed to pick the correct selector or try `getContent({ mode: "structure" })`.

System prompt hierarchy for recovery:
1. Refine selector (class, id, data-testid)
2. Use `findElement` before acting
3. Use `wait` if element may not be ready
4. Fall back to `getContent({ mode: "structure" })`

## Ollama Auto-Detect

- **Startup probe**: On sidepanel `init()`, `fetchAvailableModels()` calls the background `detect_provider_models` / Ollama probe (`background/ollama-detect.ts`).
- **API**: Uses `GET {endpoint}/api/tags` (same source as CLI `ollama list`) — MV3 cannot shell out to `ollama.exe`.
- **Endpoints tried**: custom endpoint (if set), then `http://localhost:11434`, then `http://127.0.0.1:11434`.
- **Model rows**: name, short digest id, size label, relative modified time (cloud tags show size as `—` / `cloud`).
- **UI**: model picker shows meta line `id · size · modified`; status bar shows e.g. `Ollama online · 3 models @ http://localhost:11434`.
- **Prefer Ollama**: when Ollama is online with models and the user has no cloud API key (or already on Ollama), provider auto-switches to `ollama` and the first listed model is selected if the current one is missing.
- **Manual**: Settings → "Detectar modelos disponíveis" re-runs the probe (toast with count).
- **Default endpoint**: `http://localhost:11434`.

## UI Navigation Alignment & Tightly Bound Flows

To ensure a seamless, fluid user experience, the sidebar overlay automatically closes via `this.closeSidebar()` under the following transitions:
1. **Selecting Chat View**: When clicking the "Conversa" navigation item (`openChatView`), returning the focus to the main viewport.
2. **Loading Past Sessions**: When clicking a conversation session in the history list (`loadSession`), closing the overlay and instantly showing the loaded messages.
3. **Starting New Chats**: When clicking "Nova conversa" (`startNewSession`) inside the history list, starting fresh and returning directly to the clean chat workspace.
4. **Saving or Canceling Settings**: When clicking the "Salvar" (`saveSettings`) or "Cancelar" (`cancelSettings`) buttons in the settings panel, persisting/resetting data, sliding the sidebar closed, and returning cleanly to the active conversation.

## Side Panel Tab-Scoped Behavior

The side panel is **tab-scoped**, not global. It only appears on the tab where the user explicitly opened it.

- `openPanelOnActionClick: true` — clicking the extension icon opens the side panel on the current tab.
- `chrome.sidePanel.onOpened` captures the tab ID where the panel opened and stores it in `sidePanelTabId`.
- The Chrome Side Panel API natively handles tab-scoped visibility: the panel is visible only on its owner tab and automatically hides when switching to other tabs.
- `chrome.tabs.onRemoved` clears `sidePanelTabId` if the owning tab is closed.
- During a browser automation run, the side panel stays on its original tab; the dedicated run tab (`dedicatedTabId`) is separate.

### Session Persistence (Chrome 142+)

- `sidePanelTabId` is persisted to `chrome.storage.session` under key `glideSidePanelTabId`.
- `chrome.sidePanel.onClosed` clears `sidePanelTabId` from memory and storage when the user manually closes the panel.
- We do **not** call `setOptions({ enabled: false })` anywhere — doing so would block re-opening the panel on that tab.
