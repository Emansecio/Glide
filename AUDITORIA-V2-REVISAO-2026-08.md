# Auditoria Glide V2 — Revisão 2026-08 (análise de código)

> **Complemento, não substituto.** Este documento registra os achados da revisão
> de código de 2026-08-02, feita DEPOIS e INDEPENDENTE da
> `AUDITORIA-V2-ATUAL.md` (2026-07-31, 63 itens). Nenhum item daquela auditoria
> é repetido aqui; sobreposições são marcadas como "liga a #N".
> **Método:** três frentes paralelas de leitura direta de código — performance,
> superfície de ferramentas de navegador, visual/feedback de execução.
> **Ordenação:** por eixo, depois por impacto visível ao usuário.

---

## Como ler

| Campo | Significado |
| --- | --- |
| **ID** | PERF-Rn (performance) · Wn (fraqueza de tool) · Tn (tool proposta) · Vn (visual) · Fn (feedback) |
| **Esforço** | S = pequeno · M = médio · L = grande |
| **Confiança** | confirmed · partial |

| Eixo | Itens |
| --- | --- |
| Performance | PERF-R1 … R17 |
| Tools — fraquezas novas | W1 … W8 |
| Tools — propostas | T1 … T16 (tiers 1–3) |
| Visual | V1 … V12 |
| Feedback de execução | F1 … F14 |

---

## Mapa rápido

### Performance

| # | ID | Título | Esforço |
| ---: | --- | --- | --- |
| 1 | PERF-R1 | `user_message` clona o histórico inteiro via IPC a cada envio | L |
| 2 | PERF-R2 | Persistência regrava blob `chatSessions` completo + 2 transcripts | M |
| 3 | PERF-R3 | Screenshot: captura → decode → re-encode → base64 lento | M |
| 4 | PERF-R4 | Cold start do SW: imports eager + boot I/O a cada wake | L |
| 5 | PERF-R5 | `findElement` varre até 300 interativos com layout reads | M |
| 6 | PERF-R6 | `stream_stop` reparseia markdown inteiro (freeze 50–150 ms) | M |
| 7 | PERF-R7 | Tool events sem batching + render em duplicidade + scroll por start | M |
| 8 | PERF-R8 | `plan_update` reconstrói o drawer inteiro | S |
| 9 | PERF-R9 | Shimmer anima `background-position` (repaint/frame) | S |
| 10 | PERF-R10 | Probe de modelos refeito a cada abertura do painel | S |
| 11 | PERF-R11 | Thinking timer reseta `className` a cada segundo | S |
| 12 | PERF-R12 | Sidebar transiciona `box-shadow` junto com `transform` | S |
| 13 | PERF-R13 | `RunPassCache` faz `JSON.stringify(options)` por step | S |
| 14 | PERF-R14 | Assinatura de persistência stringifica transcript inteiro | S |
| 15 | PERF-R15 | Shadow pierce revarre `querySelectorAll('*')` a cada 500 ms | M |
| 16 | PERF-R16 | Sem Port persistente — todo tráfego é `sendMessage` discreto | M |
| 17 | PERF-R17 | Stash do markdown usa `split().join()` repetidos | S |

### Tools — fraquezas novas

| # | ID | Título | Esforço |
| ---: | --- | --- | --- |
| 1 | W1 | `BROWSER_ACTION_TOOLS` é subset desatualizado (sem hover/mouse/dismissModal/wait) | S |
| 2 | W2 | `wait` selector sucede em elemento oculto/detachado | S |
| 3 | W3 | `readPage` tem `isVisible` mais fraco que `findElement` | S |
| 4 | W4 | `dismissModal` inline sem fallback de backdrop | S |
| 5 | W5 | `click` reporta sucesso sem verificar efeito | M |
| 6 | W6 | `screenshot` rouba foco da aba ativa | S |
| 7 | W7 | `setInputFiles` só aceita texto UTF-8 (sem binário) | S |
| 8 | W8 | `getNetworkRequests stop:true` fora de `MUTATIVE_TOOLS` | S |

### Visual

| # | ID | Título | Esforço |
| ---: | --- | --- | --- |
| 1 | V1 | `prefers-reduced-motion` ainda desliza gavetas/modal | M |
| 2 | V2 | `box-shadow` em transitions (sidebar, composer, forms) | S |
| 3 | V3 | px/em crus fora dos tokens (settings, composer, chat) | L |
| 4 | V4 | Strings em inglês numa UI em PT | S |
| 5 | V5 | Nav sem `aria-current` | S |
| 6 | V6 | Checklist do plano sem `role/aria-checked` | S |
| 7 | V7 | Tool steps inline não expandem resultado | M |
| 8 | V8 | Contraste do send desabilitado no tema escuro | S |
| 9 | V9 | Token drift: tracking e padding | M |
| 10 | V10 | `textarea` sem `aria-label` | S |
| 11 | V11 | Bloco de compaction sub-estilizado + header em inglês | S |
| 12 | V12 | Shimmer aceitável, mas sem teto de duração | S |

### Feedback de execução

| # | ID | Título | Esforço |
| ---: | --- | --- | --- |
| 1 | F1 | Sem duração ao vivo em tool rodando | S |
| 2 | F2 | `sessionTokenTotals` calculado e nunca renderizado | M |
| 3 | F3 | Retry/sobrecarga vira banner genérico de 6 s | S |
| 4 | F4 | Sem indicador de aba/página alvo durante automação | M |
| 5 | F5 | Sem fila de mensagem — só bloqueio duro | M |
| 6 | F6 | Compaction durante run é só toast | S |
| 7 | F7 | Atividade de visão/screenshot mal visível | M |
| 8 | F8 | Sem copiar resposta / regenerar / editar última | M–L |
| 9 | F9 | Recovery de erro não aparece na UI | M |
| 10 | F10 | Activity toggle mostra nome cru da tool | S |
| 11 | F11 | Stop sem confirmação/affordance de consequência | S |
| 12 | F12 | Tokens por turno só em tooltip (tradeoff aceito) | S |
| 13 | F13 | Sem notificação ao concluir com painel desfocado | M |
| 14 | F14 | Send "loading" sem cue de movimento | S |

---

# Eixo 1 — Performance (detalhes)

### PERF-R1 · `user_message` clona o histórico inteiro via IPC
| | |
| --- | --- |
| **Arquivo** | `sidepanel/ui/panel-chat.ts` ~L77–86 · confirmed · **L** |

**Evidence:** `chrome.runtime.sendMessage({ type: 'user_message', ..., conversationHistory: this.contextHistory })` — structured clone do contexto inteiro (turns de tool, payloads de `getContent`, imagens) a cada envio. Custo cresce linearmente com a sessão; sessões longas adicionam centenas de ms antes do run começar.

**Fix:** Histórico autoritativo no service worker keyed por `sessionId`; painel envia só `{ sessionId, newUserMessage, messageId }`. Migração única para sessões existentes.

---

### PERF-R2 · Persistência regrava blob `chatSessions` + 2 transcripts
| | |
| --- | --- |
| **Arquivo** | `sidepanel/ui/panel-history.ts` ~L211–244, ~L170–177 · confirmed · **M** |

**Evidence:** Após cada turno (debounce ~350 ms): lê o array inteiro de sessões, monta dois transcripts (`displayHistory` + `contextHistory`), stringifica para assinatura de dedup, regrava o array todo. Sessões longas de automação batem retry de quota (`slice(0, 70%)`) e o `JSON.stringify` trava a main thread.

**Fix:** Chave por sessão (`chatSession:${id}`) com append incremental; assinatura `(id, messageCount, lastMessageId)`; `contextTranscript` só quando difere do transcript.

---

### PERF-R3 · Screenshot: captura → decode → re-encode → base64 lento
| | |
| --- | --- |
| **Arquivo** | `tools/browser-tools.ts` ~L4050–4097, ~L4111–4147 · confirmed · **M** |

**Evidence:** `captureVisibleTab` JPEG → `fetch(dataUrl)` → `createImageBitmap` → `OffscreenCanvas` → `convertToBlob` (re-encode 0.8) → base64 via `String.fromCharCode.apply(null, Array.from(...))`. Capturas HiDPI bloqueiam o SW por dezenas–centenas de ms; paths de recovery multiplicam isso.

**Fix:** Repassar `maxWidth`/`quality` ao `captureVisibleTab` quando suportado; pular re-encode quando já ≤1280 px; base64 via `btoa` chunked; considerar devolver `screenshotId` sem base64 inline no path do modelo.

---

### PERF-R4 · Cold start do SW: imports eager + boot I/O
| | |
| --- | --- |
| **Arquivo** | `background.ts` ~L1–117, ~L366–404, ~L566–678 · confirmed · **L** |

**Evidence:** Toda ressurreição do SW parseia o grafo inteiro (AI SDK + compaction + browser-tools) antes de tratar a primeira mensagem; `hydrateExecutionEvents`, `recoverOrphanedRun`, `pruneScreenshotStore` e `installProviderNetRequestRules` entram no caminho crítico de `run_status_query`.

**Fix:** Chunks lazy (`run-orchestrator`, `tool-runner`, `oauth`) — esbuild `splitting: true` exige `format: esm` no SW (Chrome 123+ aceita, verificar `scripts/build.mjs`); defer de prune/DNR para idle/alarm; flag "rules installed" em `storage.session`.

---

### PERF-R5 · `findElement` varre até 300 interativos com layout reads
| | |
| --- | --- |
| **Arquivo** | `content/dom-interact.ts` ~L1138–1210, ~L62–119 · confirmed · **M** |

**Evidence:** `MAX_CANDIDATE_SCAN = 300`; cada candidato passa por `isVisible` (`getBoundingClientRect` + `getComputedStyle`). Loops de recovery chamam `findElement` repetidamente; em SPAs pesadas cada chamada relê layout.

**Fix:** Busca scope-first (dialog → form → landmark) antes do scan geral; cap default 80 com `deep: true` opt-in; cache do último seletor vencedor por URL da aba; `checkVisibility()` quando suficiente.

---

### PERF-R6 · `stream_stop` reparseia o markdown inteiro
| | |
| --- | --- |
| **Arquivo** | `sidepanel/ui/panel-streaming.ts` ~L224–246 · confirmed · **M** |

**Evidence:** Durante o streaming não há reparse (bom — `Text.appendData`), mas o `stream_stop` sempre roda `renderMarkdown(buf)` completo: O(n) de regex sobre toda a resposta. Resposta de 4k tokens congela 50–150 ms exatamente no "assentar" da bolha.

**Fix:** Markdown incremental (parse só do tail, mantendo estado de code block/lista) ou defer do parse completo para `requestIdleCallback` mantendo o texto puro visível.

---

### PERF-R7 · Tool events sem batching + render duplo + scroll por start
| | |
| --- | --- |
| **Arquivo** | `background.ts` ~L2096–2119; `sidepanel/ui/panel-tools.ts` ~L316–343 · confirmed · **M** |

**Evidence:** Dois `sendRuntime` por tool (`sendStart` + `sendResult`), sem o batching de 16 ms que os deltas de stream têm. No painel, cada tool cria entrada inline **e** no activity log, e agenda `scrollToBottom()` por start. Run de 20 tools = 40 round-trips + 40 subárvores DOM + 40 scrolls.

**Fix:** Batch de tool events no SW (janela 16 ms, coalescer start+result quando rápido); render em uma só superfície; pular scroll quando já perto do fim.

---

### PERF-R8 · `plan_update` reconstrói o drawer inteiro
**Arquivo:** `sidepanel/ui/panel-plan.ts` ~L64–127 · confirmed · **S**
`planChecklist.innerHTML = steps.map(...).join('')` destrói e recria todos os nós a cada mutação do plano. **Fix:** diff por `step.id` — atualizar classes/texto nos `<li>` existentes, append/remove só o que mudou.

### PERF-R9 · Shimmer anima `background-position`
**Arquivo:** `sidepanel/styles/motion.css` ~L173–201 · confirmed · **S**
`.execution-details-title.shimmer` roda durante toda a passe de tools; `background-position` não é composited. **Fix:** keyframe de opacidade (`breathe`, já definido no mesmo arquivo) ou máscara em pseudo-elemento com `transform: translateX`.

### PERF-R10 · Probe de modelos a cada abertura do painel
**Arquivo:** `sidepanel/panel.ts` ~L33; `sidepanel/ui/panel-status.ts` ~L203–274 · confirmed · **S**
Toda abertura dispara wake do SW + probe HTTP (Ollama `/api/tags` ou lista cloud) e reconstrói o `<select>`. **Fix:** cache em `storage.session` com TTL 5–10 min; stale-while-revalidate.

### PERF-R11 · Thinking timer reseta `className` por segundo
**Arquivo:** `sidepanel/ui/panel-streaming.ts` ~L129–134; `panel-status.ts` ~L63–75 · confirmed · **S**
`updateStatus` faz `statusDot.className = 'status-dot'` a cada tick mesmo sem mudança. **Fix:** timer escreve só `statusText.textContent`; `updateActivityState` condicional a mudança real.

### PERF-R12 · Sidebar transiciona `box-shadow`
**Arquivo:** `sidepanel/styles/layout.css` ~L32–42 · confirmed · **S**
`transition: transform …, box-shadow …` repinta a sombra a cada frame dos 460 ms da gaveta. **Fix:** sombra estática quando aberta (sem interpolação) ou fade de opacidade em pseudo-elemento. Liga a V2.

### PERF-R13 · `RunPassCache` stringifica options por step
**Arquivo:** `background/run-pass-cache.ts` ~L16–20 · confirmed · **S**
`JSON.stringify(options || {})` a cada `getModelMessages`; objeto é estável. **Fix:** chave de campos explícitos (`systemMessageMode`) ou chave pré-computada pelo caller.

### PERF-R14 · Assinatura de persistência stringifica transcript
**Arquivo:** `sidepanel/ui/panel-history.ts` ~L170–177 · confirmed · **S**
`safeJsonStringify({ id, title, messageCount, transcript })` duplica o trabalho de JSON a cada persist. **Fix:** `` `${id}:${messageCount}:${lastId}:${updatedAt}` ``.

### PERF-R15 · Shadow pierce revarre `*` a cada 500 ms
**Arquivo:** `content/dom-interact.ts` ~L155–194 · confirmed · **M**
`SHADOW_HOST_CACHE_TTL_MS = 500`; bursts de tools (click→type→find) estouram o TTL e revarrem a árvore em páginas com shadow roots (YouTube, Salesforce). **Fix:** invalidar por MutationObserver (added nodes com shadowRoot) em vez de TTL; ou TTL 5 s + invalidate em navegação. Liga a P3-10 da auditoria anterior (ângulo de perf, não de correção).

### PERF-R16 · Sem Port persistente panel↔SW
**Arquivo:** `background.ts` ~L4273–4276; `sidepanel/ui/panel-core.ts` ~L178 · confirmed · **M**
Todo o tráfego é `chrome.runtime.sendMessage` discreto (structured-clone + dispatch por mensagem); batching cobre só deltas de stream. **Fix:** `runtime.connect` no init do painel, frames `{ channel, payload }` multiplexados; SW empurra eventos batched pelo Port.

### PERF-R17 · Stash do markdown com `split().join()` repetidos
**Arquivo:** `sidepanel/ui/panel-markdown.ts` ~L74–76 · confirmed · **S**
Cada entrada do stash revarre o HTML inteiro — O(stash × tamanho). Só roda no fechamento, mas amplifica PERF-R6. **Fix:** uma regex `@@ML\d+@@` com lookup, ou construção por array.

---

# Eixo 2 — Ferramentas de navegador

## Catálogo atual (31 tools)

29 browser tools em `tools/tool-definitions.ts` + `set_plan`/`update_plan` em `background/session-tools.ts`. `switchTab` é alias de `focusTab` (`tools/tool-registry.ts:15-16`). Categorias de permissão em `background/tool-permissions.ts`: navigate, interact, read, screenshots, tabs, scripting, debugger.

Cobertura que **já existe** (verificada no código — o AGENTS.md estava parcialmente desatualizado): hover, double/right-click e drag (`mouse`), `<select>` nativo via `type`, shadow DOM aberto (`>>>`), captura de rede com hooks MAIN-world, CDP opt-in, tabs com escopo de sessão, clipboard, upload sintético de arquivos-texto, storage/console/perf diagnostics.

Visão por provedor (`background/vision-queue.ts:156-164`): **Anthropic = imagem direta** no tool result; Codex/OpenCode/Ollama = **descrição textual** via chamada de visão secundária; sem credencial = indisponível.

## Fraquezas novas

### W1 · `BROWSER_ACTION_TOOLS` é subset desatualizado
**Arquivo:** `background/service-config.ts:49` · confirmed · **S**
Só `navigate/click/type/scroll/pressKey` contam como "browser action" para auto-screenshot recovery, `awaitingVerification` e contagem de falhas consecutivas (`background.ts:2451-2579`). `hover`, `mouse`, `dismissModal`, `wait` mutam/interagem e não disparam Layer 4. **Fix:** ampliar o set.

### W2 · `wait` selector sucede em oculto/detachado
**Arquivo:** `tools/browser-tools.ts:3320-3324` · confirmed · **S**
Checa só presença no DOM via `deepQuerySelector`. **Fix:** gate de visibilidade (alinhar com `dom-interact.isVisible`); novas conditions `visible`/`hidden` (ver T2).

### W3 · `readPage` com `isVisible` mais fraco
**Arquivo:** `tools/browser-tools.ts:5063-5068` vs `content/dom-interact.ts:62-119` · confirmed · **S**
Perde elementos fixed/sticky em portals que `findElement` enxerga. **Fix:** reusar a mesma rotina de visibilidade.

### W4 · `dismissModal` inline sem backdrop
**Arquivo:** `tools/browser-tools.ts:3211-3216` · confirmed · **S**
O path injetado para no Escape; o bridge tem backdrop click (`dom-interact.ts:595-604`). Taxa de sucesso menor em sheets. **Fix:** incluir tentativa de backdrop no fallback inline.

### W5 · `click` sucesso sem verificar efeito
**Arquivo:** `tools/browser-tools.ts:1211-1217` · confirmed · **M**
Retorna `success: true` após despachar eventos, sem checar navegação/toggle/efeito (exceto `waitForDialog`). **Fix:** pós-condições baratas (mudança de URL, `aria-expanded`, `classList`, valor) com report `effectVerified`.

### W6 · `screenshot` rouba foco
**Arquivo:** `tools/browser-tools.ts:4024-4027` · confirmed · **S**
Ativa a aba alvo antes de capturar, interrompendo o usuário se o painel está em outra aba. **Fix:** capturar sem ativar quando possível (captureVisibleTab da janela alvo) e restaurar foco sempre.

### W7 · `setInputFiles` só texto UTF-8
**Arquivo:** `tools/browser-tools.ts:5252-5256`; `tool-definitions.ts:364` · confirmed · **S**
Sem caminho base64/binário — impossível subir imagem/PDF. **Fix:** `contentBase64` opcional com decode para `Uint8Array` no `File`.

### W8 · `getNetworkRequests stop:true` fora de `MUTATIVE_TOOLS`
**Arquivo:** `background/service-config.ts:68-89` · confirmed · **S**
Teardown dos hooks muda a superfície da página sem invalidar o cache DOM. **Fix:** incluir (ou invalidar em qualquer chamada com `stop`/`clear`).

## Propostas de novas tools (priorizadas por impacto ÷ esforço)

### Tier 1

| ID | Tool | Params (esboço) | Onde | Destrava |
| --- | --- | --- | --- | --- |
| T1 | `pressKey` modifiers | `modifiers?: ("Control"\|"Alt"\|"Shift"\|"Meta")[]` | `dom-interact.ts` + definitions | Ctrl+A/Ctrl+S/Ctrl+F, navegação em planilha |
| T2 | `wait` visible/hidden/networkIdle | `condition`, `idleMs?` (default 500) | `browser-tools.ts` + hooks de rede existentes | transições SPA, listas lazy, pós-submit |
| T3 | `selectOption` | `selector`, `value?/label?/index?` | `dom-interact.ts` | MUI/AntD/React-Select, `[role=combobox]` |
| T4 | `fillForm` | `fields: [{selector, text?, checked?, option?}]`, `submitSelector?` | `browser-tools.ts` (reusa type/click) | checkout, login multi-campo em 1 chamada |
| T5 | `annotatedScreenshot` (set-of-marks) | `scope?`, `maxMarks?` → imagem + `{ref, selector, box}[]` | `browser-tools.ts` + OffscreenCanvas | grounding estilo computer-use ("clica no e3") |

### Tier 2

| ID | Tool | Notas |
| --- | --- | --- |
| T6 | `captureDownload` | permissão `downloads` no manifest + listener; exportar CSV/PDF/relatório |
| T7 | `navigateHistory` | `back/forward/reload` via `chrome.tabs.goBack/goForward/reload` |
| T8 | `targetFrame` | `frameId?/frameUrl?` em click/type/wait/findElement via `executeScript({frameIds})` — iframes de pagamento/SSO |
| T9 | `findInPage` | TreeWalker/`window.find` + scroll-into-view |
| T10 | `highlightElement` | overlay visível ao usuário durante o run (só transform/opacity, regras do DESIGN) — confiança + debug |

### Tier 3 (especializadas / CDP-gated)

| ID | Tool | Notas |
| --- | --- | --- |
| T11 | `extractTable` | matriz de células, não só headers/rowcount |
| T12 | `harvestScroll` | scroll-até-estável com dedupe por `itemSelector` |
| T13 | `setStorage`/`setCookie` | precisa permissão `cookies`; feature flags, A/B |
| T14 | `printToPdf` | wrapper CDP `Page.printToPDF` (debugger opt-in) |
| T15 | `selectText` | Selection/Range API — copiar trecho, citar |
| T16 | `elementScreenshot` | CDP `captureScreenshot` com clip do boundingRect |

---

# Eixo 3 — Visual

### V1 · `prefers-reduced-motion` ainda desliza gavetas/modal
**Arquivos:** `sidepanel/styles/base.css` L330–337 (exclui `transform` da redução); `layout.css` L42 (`.sidebar`); `tools.css` L120 (`.activity-panel`); `modals.css` L150–162 · confirmed · **M**
DESIGN manda reduzir deslocamento/escala no `reduce`; as duas maiores superfícies móveis continuam deslizando. **Fix:** no bloco `reduce`, `transform: none` + transições só de opacidade/cor para `.sidebar`, `.activity-panel`, `.modal-content`, `.jump-to-latest`, banners.

### V2 · `box-shadow` em transitions
**Arquivos:** `layout.css` L42; `composer.css` L208; `settings.css` L169 · confirmed · **S**
Viola a regra de perf #2 do DESIGN (repaint a cada frame). **Fix:** remover das transitions; anel de foco vira token `--focus-ring` aplicado sem transição. Liga a PERF-R12.

### V3 · px/em crus fora dos tokens
**Arquivos (amostra):** `settings.css` L50/L98/L167; `composer.css` L233/L266/L367; `chat.css` L60 (`letter-spacing: -0.01em` vs `--tracking-tight`), L343 (`font-size: 0.86em`); `box-shadow: 0 0 0 3px var(--accent-ring)` duplicado em `composer.css` L222 e `settings.css` L187 · confirmed · **L**
**Fix:** tokens novos em `base.css` (`--focus-ring`, `--control-height`, `--composer-max-height`…) e varredura nos três arquivos.

### V4 · Strings em inglês numa UI em PT
**Arquivos:** `panel-streaming.ts` L131 (`Thinking`), L269 (`Reasoning`), L329 (`Plan`); `panel-chat.ts` L217 (`Context compacted`) · confirmed · **S**
A barra de status é a principal superfície de feedback do run. **Fix:** "Pensando", "Raciocínio", "Plano", "Contexto compactado".

### V5 · Nav sem `aria-current`
**Arquivo:** `sidepanel/ui/panel-navigation-helpers.ts` L61–73; `sidebar-shell.html` L40–59 · confirmed · **S**
**Fix:** `aria-current="page"` no item ativo em `setActiveNavItem`.

### V6 · Checklist do plano sem `role/aria-checked`
**Arquivo:** `sidepanel/ui/panel-plan.ts` L111–118 · confirmed · **S**
**Fix:** `role="checkbox"` + `aria-checked` no toggle.

### V7 · Tool steps inline não expandem resultado
**Arquivos:** `panel-streaming.ts` L155–164; `panel-tools.ts` L568–575 · confirmed · **M**
Erro de tool mostra só "Erro" no transcript; detalhe exige abrir o painel de atividade. **Fix:** espelhar o padrão `<details>` do activity no step inline, com `aria-expanded`.

### V8 · Contraste do send desabilitado no escuro
**Arquivo:** `composer.css` L494–499 · confirmed · **S**
`--card-hover` (#202024) × `--muted-dim` (#71717a) é limítrofe e lê "quebrado", não "ocupado". **Fix:** tokens `--control-disabled-bg/fg` via `light-dark()`.

### V9 · Token drift de tracking/padding
**Arquivos:** `layout.css` L100 (`-0.008em`); `padding: 10px 11px` repetido em chat/tools/utilities · confirmed · **M**
**Fix:** normalizar para a escala `--space-*` e um tracking por tier de título.

### V10 · `textarea` sem `aria-label`
**Arquivo:** `sidepanel/templates/main.html` L87 · confirmed · **S**
Placeholder não é nome acessível. **Fix:** `aria-label="Mensagem"`.

### V11 · Bloco de compaction sub-estilizado
**Arquivos:** `chat.css` L190–208; header em inglês em `panel-chat.ts` L217 · confirmed · **S**
Evento significativo que passa despercebido no escuro. **Fix:** borda esquerda `--warning-muted` (padrão banners), header PT, `--text-xs` + `--muted-dim`.

### V12 · Shimmer sem teto
**Arquivo:** `motion.css` L173–201 · partial · **S**
Aceito pelo DESIGN, mas roda pela duração inteira da passe. **Fix:** ver PERF-R9; opcionalmente teto de duração.

---

# Eixo 4 — Feedback de execução

Mapa do que existe hoje (verificado): status line com dot + texto + meta (`Ctx ~12k/200k`), typing indicator, timer "Thinking", execution `<details>` com chips semânticos, tool steps inline + activity log com duração pós-resultado, plan drawer, banners âmbar/vermelho com ação de Configurações em erro de credencial, toast de compaction, tokens por turno no header do assistente, watchdog de liveness, stop por botão/Esc.

### F1 · Sem duração ao vivo em tool rodando
**Arquivo:** `panel-tools.ts` L590–602 · confirmed · **S** — duração só aparece no resultado. **Fix:** tick 1s no `tool-step-meta` a partir de `dataset.start`, usando `formatExecutionDuration`, `--text-mono`.

### F2 · `sessionTokenTotals` nunca renderizado
**Arquivo:** `panel-usage.ts` L73–80; `panel-ui.ts` L105 · confirmed · **M**
Agregado existe e não vai para o DOM. **Fix:** linha compacta "Sessão: 42k in / 8k out" no `statusMeta` (title) ou linha colapsável no activity panel.

### F3 · Retry/sobrecarga fáceis de perder
**Arquivo:** `panel-core.ts` L406–410; `notifications.ts` L21 · confirmed · **S**
`run_warning` vira banner âmbar com auto-dismiss de 6 s. **Fix:** padrão dedicado — dot warning + "Tentando novamente (429)…" no `#statusText`; chip opcional no execution details.

### F4 · Sem indicador de aba/página alvo
**Arquivo:** `panel-tools.ts` L539–546 · confirmed · **M**
Args mostram host em alguns steps, mas nada persistente. **Fix:** segunda linha/`statusMeta`: "Aba: example.com/path" a partir do último resultado de navegação; limpar no fim do run.

### F5 · Sem fila de mensagem — bloqueio duro
**Arquivo:** `panel-chat.ts` L12–16 · confirmed · **M**
**Fix (mínimo):** copy mais clara + link para stop. Fila real ("Enviar após conclusão") é decisão de produto.

### F6 · Compaction durante run é só toast
**Arquivo:** `panel-core.ts` L464–476 · confirmed · **S**
**Fix:** aviso inline âmbar não-bloqueante acima do composer (padrão `run-incomplete-banner`).

### F7 · Visão/screenshot mal visível
**Arquivo:** `panel-core.ts` L424–426 · confirmed · **M**
**Fix:** estilo distinto no tool step de `screenshot`/visão (ícone de câmera já existe); thumbnail opcional no activity panel.

### F8 · Sem copiar / regenerar / editar última
**Arquivo:** ausente em `sidepanel/ui/*` · confirmed · **M–L**
**Fix:** ações no header do assistente (`icon-btn` + `aria-label`): copiar markdown, regenerar (reenviar último turno do usuário).

### F9 · Recovery não aparece na UI
**Arquivo:** `panel-tools.ts` L340 · confirmed · **M**
**Fix:** para códigos conhecidos (`NO_EXECUTABLE_TAB` etc.), ação no banner ("Abrir aba" / "Trocar aba").

### F10 · Activity toggle mostra nome cru
**Arquivo:** `panel-tools.ts` L707–713 · confirmed · **S**
**Fix:** `getToolPresentation(activeToolName).running`.

### F11 · Stop sem affordance de consequência
**Arquivo:** `panel-chat.ts` L130–136 · confirmed · **S**
**Fix (mínimo):** `aria-label` do stop com texto de consequência; hold-to-stop é opcional.

### F12 · Tokens por turno só em tooltip
**Arquivo:** `panel-tools.ts` L659–667 · confirmed · **S**
Tradeoff aceito; coberto por F2 no agregado.

### F13 · Sem notificação ao concluir desfocado
**Arquivo:** ausente · confirmed · **M**
**Fix:** toggle "Notificar ao concluir" nas Configurações → `chrome.notifications` no `assistant_final` quando `document.hidden`.

### F14 · Send "loading" sem cue de movimento
**Arquivo:** `composer.css` L494–499; comentário em `panel-tools.ts` L475 menciona spinner inexistente · confirmed · **S**
**Fix:** spinner CSS só com `transform`/`opacity` (pseudo-elemento), ou confiar no halo do status dot.

---

## Verificado bom (não mexer)

| Tema | Evidência |
| --- | --- |
| Streaming sem reparse por delta | `Text.appendData` em `panel-streaming.ts` L59–67 |
| Scroll com rAF dual coalescido | `_scrollRafId`/`_scrollSyncRafId` em `panel-scroll.ts` |
| Densidade do composer memorizada | `getComposerDensityCached` + ResizeObserver por largura |
| Budget de `extractPageStructure` | `queryLimited` + `approxJsonBytes` em `dom-interact.ts` L1353–1438 |
| Execution events bufferizados durante o run | flush só no fim, `background.ts` L3313–3320 |
| Tema em plano único `light-dark()` | `theme.ts` só flipa `color-scheme` |
| `contain: layout paint` no activity panel | `tools.css` L127 |
| Severidade de banners separada | `notifications.ts` L12–17 |
| `setComposerBusy` como verdade única | `panel-tools.ts` L478–495 |
| Watchdog de liveness sem matar tool lenta | `panel-run-liveness.ts` L3–16 |

---

## Contagem

| Classe | Qtd |
| --- | ---: |
| PERF | 17 |
| W (fraquezas de tools) | 8 |
| T (tools propostas) | 16 |
| V (visual) | 12 |
| F (feedback) | 14 |
| **Total indexado** | **67** |
| Verificado bom | 10 |

---

## Metadados

| | |
| --- | --- |
| Data | 2026-08-02 |
| Projeto | Glide V2 0.2.0 |
| Relação | complemento da `AUDITORIA-V2-ATUAL.md` (63 itens, 2026-07-31) — sem repetição |
| Método | 3 frentes paralelas de leitura de código (perf / tools / visual+feedback) |
| Alterações de produto | nenhuma neste documento |
| Execução | plano de ondas em `.cursor/plans/` — Onda 1 (quick wins) → Onda 2 (tools) → Onda 3 (perf estrutural) → Onda 4 (feedback/visual estrutural) |

*Fim — revisão de código pós-auditoria.*
