# Glide Architecture

Glide is a Chrome Manifest V3 extension for LLM-driven browser control.

> **Glide V2** — fork de interface. Backend, tools e providers são idênticos à
> V1 em `../Glide`; o que mudou é a camada visual, a estrutura do composer, o
> movimento e duas otimizações de latência. Sistema visual em
> [DESIGN.md](../DESIGN.md).

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
| Design assets | `icons/`, `fonts/`, `DESIGN.md` | Mark, typefaces empacotadas e o sistema visual. |
| Dev harness | `scripts/preview.mjs`, `scripts/render-icons.mjs` | Preview estático da UI e geração dos PNGs. |

## Sidepanel Layer

O painel não é um framework — é uma classe (`SidePanelUI`) cujos métodos são
anexados via prototype por módulos separados.

```
panel.ts
  ├── initTheme()          aplica o tema salvo ANTES do primeiro layout
  ├── loadPanelLayout()    busca os templates HTML e monta o #appRoot
  ├── bindThemeToggle()    liga o ícone da gaveta + o segmentado das configurações
  └── new SidePanelUI()    panel-modules.ts registra os panel-*.ts no prototype
```

Consequência prática: **todo membro ou método novo precisa ser declarado na
classe em `panel-ui.ts`**, mesmo sendo implementado noutro arquivo — caso
contrário o typecheck reprova.

Os templates são HTML estático em `sidepanel/templates/`, buscados em runtime por
`layout-loader.ts`. Os IDs neles são o contrato com `panel-elements.ts`: mover um
elemento de lugar é seguro, renomear o ID não.

### Estilo e tema

`panel.css` importa nove arquivos em ordem: `@font-face` primeiro, tokens depois,
movimento por último. Cada token de cor é um `light-dark(claro, escuro)`, então
trocar de tema é trocar `color-scheme` no `:root` — não existe folha de tema
duplicada. O tema é persistido em `localStorage` (leitura síncrona, aplicada
antes do primeiro paint; com storage assíncrono o painel abriria claro e piscaria
para escuro).

## Control Flow

1. The user sends a message from the sidepanel.
2. `background.ts` resolves the provider profile and runs a **credential pre-flight**
   (`background/preflight.ts`). A missing key or a revoked Claude session fails the run
   immediately with an actionable message (`details.action = 'open_settings'`) — before
   any tab is created or locked.
3. `background.ts` builds provider messages and streams the model response. For Anthropic,
   `ai/prompt-cache.ts` marks the last message with an `ephemeral` cache breakpoint so the
   stable prefix is reused across steps; an empty provider response disables the cache for
   the worker's lifetime and retries without it.
   - Uma passe não é uma request: o SDK emite uma por step. `prepareStep` chama
     `applyStepPromptCacheBreakpoints`, que mantém dois breakpoints — uma âncora
     fixa no fim do prefixo inicial e um rolante na última mensagem — para que os
     resultados de ferramenta acumulados durante a passe também entrem no prefixo
     cacheado em vez de serem recobrados por step.
   - O token OAuth é espelhado em memória (`ai/anthropic-oauth.ts`), invalidado
     por `chrome.storage.onChanged`. Sem esse espelho, cada request começava com
     um `chrome.storage.local.get` no caminho crítico.
4. When the model requests a tool, the background validates the tool name, arguments, tab
   target, and permission gate.
5. `tools/browser-tools.ts` executes the browser action through Chrome APIs or
   `chrome.scripting.executeScript`.
6. The result is sent back to the model and mirrored to the sidepanel activity timeline.

## Run Lifecycle Control

- **Stop**: the composer's stop button (or `Esc`) sends `stop_run`; the background emits
  `run_stopped` and aborts the run's `AbortController`. A tool already in flight finishes,
  then the loop unwinds — stopping is bounded, not instantaneous.
- **Liveness**: run state lives only in service-worker memory. `sidepanel/ui/panel-run-liveness.ts`
  watches for silence and sends `run_status_query`, which both revives an evicted worker
  (triggering `recoverOrphanedRun`) and reports whether the run still exists. The composer is
  only unlocked when the worker confirms there is no active run.
- **Credentials**: stored per provider (`apiKey_anthropic`, `apiKey_codex`, …) plus the active
  `apiKey` slot; see `sidepanel/ui/settings-keys.ts`. The runtime always prefers the active
  provider's slot, so a key is never sent to the wrong provider.

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
- Treat `npm test` as the broad local gate: it builds, validates the extension package, runs unit tests, and runs the Playwright E2E suite. Provider/model checks remain opt-in via the `test:live:*` scripts.

## Rendering Principles (V2)

O painel renderiza durante o streaming — texto chegando a ~20 flushes por
segundo enquanto passos de ferramenta são inseridos. Isso torna o custo por
frame parte da arquitetura, não um detalhe de CSS:

- Leitura de layout (`clientWidth`, `scrollHeight`) nunca depois de escrita no
  mesmo bloco síncrono; meça uma vez e memorize.
- Anime só `transform` e `opacity`; o resto repinta.
- Um `requestAnimationFrame` por frame, por finalidade.
- `contain` nos turnos de conversa, para que um flush não marque a lista inteira
  como suja.
- Nunca `innerHTML +=` — é quadrático. `insertAdjacentHTML` ou
  `Text.appendData`.

Medições em [DESIGN.md](../DESIGN.md#desempenho).

## Current Local Gate

```bash
npm run check      # tsc --noEmit + biome check .
npm run test:unit  # builda tudo e roda a suíte unitária
npm run validate   # valida o pacote da extensão em dist/
npm run build      # build de produção
```

`npm run check` is `typecheck` + `biome check .`; run `npx biome check --write .` to apply
formatting fixes.

Auxiliares de desenvolvimento (não fazem parte do gate):

```bash
npm run preview    # dist/sidepanel/preview.html — itera CSS sem recarregar a extensão
npm run icons      # icons/glide-logo.svg → icon16/48/128.png
```
