# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog and Semantic Versioning.

## [V2] - 2026-07-31 — Interface

Fork de interface a partir da V1 estável. Backend, tools e providers idênticos;
o que mudou é a camada visual, a estrutura do composer, o movimento e duas
otimizações de latência. Sistema completo em [DESIGN.md](DESIGN.md).

### Added

- **Tema claro e escuro** (`sidepanel/ui/theme.ts`), três modos: claro (padrão),
  escuro e sistema. Cada token de cor é um `light-dark(claro, escuro)`, então não
  existe folha de tema duplicada — trocar de tema é trocar `color-scheme` no
  `:root`. Dois controles em sincronia: ícone no cabeçalho da gaveta e segmentado
  rotulado em Configurações → Aparência.
  - Persistido em `localStorage` de propósito: leitura síncrona, aplicada antes do
    primeiro paint. Com storage assíncrono o painel abriria claro e piscaria.
- **Tipografia empacotada** (`fonts/`, `sidepanel/styles/fonts.css`): Geist na
  interface, Instrument Serif nos títulos grandes, Geist Mono em dado técnico.
  Só os subsets `latin` e `latin-ext`, 113 KB. A CSP da extensão bloqueia webfont
  remota, então os `.woff2` viajam no pacote.
- **Camada de movimento** (`sidepanel/styles/motion.css`): entrada de turnos com
  cascata, bolha do usuário com mola, passos de ferramenta entrando pela
  esquerda, shimmer recortado no glifo do rótulo "Trabalhando…", halo pulsante no
  ponto de execução, cursor piscando no streaming. Tudo sob
  `prefers-reduced-motion`.
- **Mark novo** (`icons/glide-mark.svg`): esfera com um clique dentro — arco de
  288° com abertura a leste e ponto sólido no centro. Substitui o sunburst nos
  ícones e nos quatro pontos onde estava inline.
- **Harness de preview** (`npm run preview`): costura os templates reais com o
  CSS real numa página estática, para iterar em CSS sem recarregar a extensão.
  Aceita `?theme=` e `?view=`; `preview-split.html` mostra claro e escuro lado a
  lado.
- **`npm run icons`**: regenera os PNGs a partir do SVG.
- **Breakpoint de cache rolante** (`applyStepPromptCacheBreakpoints` +
  `prepareStep`): uma passe emite uma request por step, e o breakpoint parado no
  prefixo inicial deixava todo resultado de ferramenta da passe fora da região
  cacheada. Agora são dois — âncora fixa e rolante.
- **Espelho em memória do token OAuth** (`ai/anthropic-oauth.ts`): remove um
  `chrome.storage.local.get` do caminho crítico de cada request. Invalidado por
  `chrome.storage.onChanged`; sem esse listener, o cache se desliga em vez de
  servir credencial velha.

### Changed

- **Paleta**: branco, azul (`#0068d6` / `#4a9eff`) e preto/cinza, substituindo o
  carvão morno com acento laranja. Azul só onde há interação; ação primária é
  tinta sólida.
- **Composer numa linha**: o estado do run saiu da barra e virou uma linha
  própria acima do composer, com a largura inteira do painel. A grade de três
  colunas empilhava seis controles em ~300px e truncava tudo. IDs preservados —
  nenhum módulo de `sidepanel/ui/` mudou por causa do layout.
- **Base tipográfica** de 13px para 14px; escalas de espaço e raio explícitas.
- Ícone da barra do Chrome passa a ter **placa azul com a marca vazada**.
- `getCachedToolSet` → **`buildRunToolSet`**. O nome prometia um cache que não
  existia; medido em 15 µs por run, e cachear quebraria o `execute` que fecha
  sobre estado do run.

### Fixed

- **Sombras não funcionavam.** Os quatro tokens `--shadow-*` envolviam a sombra
  inteira em `light-dark()`, que é uma função de **cor** — valor inválido, e o CSS
  descarta a declaração em silêncio. Todas as elevações estavam mortas, e o anel
  de foco do composer caía junto por dividir a mesma declaração `box-shadow`.
- **Anel de foco duplicado no composer**: o `textarea` desenhava o próprio anel
  de `:focus-visible` (campos de texto casam com ele até no clique do mouse) por
  dentro da moldura do composer. Agora a moldura é o único indicador, via
  `:has(textarea:focus)` — que também corrige a moldura acendendo quando o foco
  ia para um botão da barra.
- **`.btn` sobrescrevia `.btn-primary`** (mesma especificidade, declarado depois):
  botões primários perdiam o preenchimento sólido.
- Botão de contorno usava `--background` fixo e virava um buraco mais escuro que
  a superfície dentro de cartões no tema escuro.
- **Ícone sumia na barra escura do Chrome**: o PNG era transparente com a marca
  escura.

### Performance

Medido no harness de preview, conversa de 160 turnos, A/B na mesma página.

- **Frame durante o streaming**: 29–30 de 60 frames acima de 20 ms → **0**.
  Média 18,4–19,9 ms → 13,1–13,5 ms; p95 26–30 ms → 16,6 ms.
- **Fechamento da resposta** (300 blocos): 184,3 ms → 2,8 ms, trocando
  `innerHTML +=` (quadrático) por `insertAdjacentHTML`.
- **300× `updateActivityState`**: 14,7 ms → 0,4 ms, memorizando a densidade em vez
  de reler `clientWidth` a cada tick do cronômetro.
- Pulso do ponto de status migrado de `box-shadow` para pseudo-elemento em
  `transform`/`opacity`; `backdrop-filter` removido dos véus animados;
  `contain: layout style` nos turnos; listener de scroll passivo e agrupado num
  `requestAnimationFrame`.

### Documentation

- `DESIGN.md` novo: tokens, curvas, movimento, tipografia, foco, mark, medições
  de desempenho e o que foi descartado em cada decisão.
- `AGENTS.md` e `docs/ARCHITECTURE.md` atualizados para a V2. Corrigidos dois
  erros herdados: o entry point é `sidepanel/panel.ts` (não `sidepanel.ts`) e
  `openPanelOnActionClick` é `false` (não `true`).

## [Unreleased]

### Added

- Frontier browser-agent contracts: per-run action journal, safe MV3 checkpoints, explicit terminal reasons, versioned context commits, stable element handles, frame-addressed content bridges, effect postconditions, and adaptive tool packs.
- Bounded local execution telemetry for queue/execute/verification latency, result size, recovery stage, checkpoint phase, and context revision. Event payloads exclude user content and secrets.
- Deterministic invariant evaluations (`npm run test:evals`), opt-in public read-only live evaluations (`GLIDE_LIVE_TESTS=1 npm run test:evals:live`), and reviewed bundle/tool-schema budgets (`npm run check:budgets`).
- Vitest coverage for asynchronous legacy cases; false-green custom-runner registrations removed.
- Migration fixture from checkpoint `82772fc` covering settings, sessions, plans, provider slots, and tab-scoped panel ownership.
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

- Browser mutations are bridge-first and target one explicit frame. CDP remains opt-in; ambiguous effects are never automatically replayed.
- Existing storage and runtime contracts migrate additively: old selectors/refs and schema-v2 readers remain supported, while new telemetry fields are optional.
- Validator updated to check real `dist/` structure and current docs/scripts.
- Test runner output normalized for readable pass/fail logs.
- Manual `execute_tool` path now uses the same runtime policy pipeline as normal runs.
- Sidepanel UI premium redesign (anti-slop) — **superseded pela V2 acima**: a
  paleta morna, as superfícies de vidro e a fonte por CDN não existem mais (a CSP
  da extensão bloqueia webfont remota; a Geist hoje é empacotada). Mantido como
  registro histórico:
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
