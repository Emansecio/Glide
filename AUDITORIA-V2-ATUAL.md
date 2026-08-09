# Auditoria Glide V2 — achados por prioridade

> **Documento vigente.** Instantâneo 2026-07-31.  
> Não confundir com `AUDITORIA-GLIDE.md` (histórico V1).  
> **Modo:** audit-only (nenhuma correção aplicada na auditoria).  
> **Ordenação:** prioridade de ação (1 = fazer primeiro), não só severidade bruta.

---

## Como ler

| Campo | Significado |
| --- | --- |
| **#** | Ordem de ataque (1 = mais urgente) |
| **Sev** | P1 / P2 / P3 / PRED / PERF |
| **Esforço** | S = pequeno · M = médio · L = grande |
| **Confiança** | confirmed · partial |

**Critério de ranking:** segurança/isolamento → correção de fluxo primário → custo/reliability do agente → polish.

| Onda | # | Objetivo |
| --- | ---: | --- |
| **A — Crítico** | 1–10 | Segurança + runs que travam / mentem |
| **B — Alto** | 11–25 | Automação errada, contexto, OAuth/compaction |
| **C — Médio** | 26–40 | Edge cases, DX de tools, residual |
| **D — Baixo** | 41–63 | Polish, preditivos de reforço, higiene de perf local |

---

## Cabeçalho da auditoria

| Campo | Valor |
| --- | --- |
| Escopo | `background.ts`, `background/*`, `tools/*`, `content/*`, `ai/*`, `sidepanel/ui/*`, `manifest.json` |
| Status | **VERMELHO** — P1s em isolamento, SSRF, lifecycle de run, prompt-cache |
| Contagem | 7 P1 · 25 P2 · 18 P3 · 6 PRED · 7 PERF = **63** itens |
| Suite / Chrome real | Não executados nesta passagem |

---

## Mapa rápido (só título + ordem)

### Onda A — Crítico (1–10)

| # | Sev | ID | Título |
| ---: | --- | --- | --- |
| 1 | P1 | P1-1 | `trackTab` matricula a aba ativa do usuário |
| 2 | P1 | P1-2 | `httpRequest` segue redirect sem revalidar host privado |
| 3 | P1 | P1-3 | `navigate`/`openTab` só validam URL pedida |
| 4 | P1 | P1-5 | Lock de run preso após `assistant_final` / `stop_run` |
| 5 | P1 | P1-7 | Trocar sessão / nova conversa não manda `stop_run` |
| 6 | P1 | P1-4 | Retry “sem prompt cache” ainda envia breakpoints |
| 7 | P1 | P1-6 | Histórico persistido = só display (perde tool chain) |
| 8 | P2 | P2-1 | `agentInitiatedTabCloses` sticky se `closeTab` falha |
| 9 | P2 | P2-3 | Tools / recovery XML ignoram abort do run |
| 10 | P2 | P2-2 | Tools em voo estendem watchdogs sem teto |

### Onda B — Alto (11–25)

| # | Sev | ID | Título |
| ---: | --- | --- | --- |
| 11 | P2 | P2-9 | Compaction chama `abortActiveStreaming` e libera composer |
| 12 | P2 | P2-18 | `execute_tool` manual interleave com agent run |
| 13 | P2 | P2-8 | `getTabs` / `groupTabs` sem isolamento de sessão |
| 14 | P2 | P2-4 | `MUTATIVE_TOOLS` incompleto (cache DOM stale) |
| 15 | P2 | P2-5 | `nth-child` com índice por tag (seletor errado) |
| 16 | P2 | P2-6 | `type` sucesso sem verificar valor |
| 17 | P2 | P2-7 | `dismissModal` sucesso sem verificar fechamento |
| 18 | P2 | P2-10 | `tool_use` sem `tool_result` passa no convert |
| 19 | P2 | P2-16 | Compaction sobrescreve display com context |
| 20 | P2 | P2-14 | User bubble órfão em rejeição pós-ACK |
| 21 | P2 | P2-17 | `assistant_final` vazio dessincroniza display/context |
| 22 | P2 | P2-12 | OAuth `expiresAt=0` → refresh a cada request |
| 23 | P2 | P2-11 | Compaction `maxOutputTokens` ~48k |
| 24 | P2 | P2-13 | Recovery de `fn(kwargs)` vira `{ value }` |
| 25 | P2 | P2-15 | Adoção de aba dedicada non-HTTP |

### Onda C — Médio (26–40)

| # | Sev | ID | Título |
| ---: | --- | --- | --- |
| 26 | P2 | P2-19 | `pressKey` sempre dispara input+change |
| 27 | P2 | P2-20 | `tabResolveMemo` não limpa em close/nav |
| 28 | P2 | P2-21 | CDP `send` sem allowlist (debugger on) |
| 29 | P2 | P2-22 | Timeout de inject não cancela script na página |
| 30 | P2 | P2-23 | Sentinel `glideActiveRun` clear fire-and-forget |
| 31 | P2 | P2-24 | Usage `totalTokens` inconsistente na compaction |
| 32 | P2 | P2-25 | Hard timeout non-stream com mensagem errada |
| 33 | PERF | G1 | Compaction síncrona no exclusive lock |
| 34 | PERF | G2 | Recovery screenshot+vision no path crítico |
| 35 | PERF | G3 | Refresh OAuth thrash (liga a #22) |
| 36 | PERF | G4 | DOM cache + mutative incompleto (liga a #14) |
| 37 | PERF | G6 | Sumarização maxOutput ~48k (liga a #23) |
| 38 | P3 | P3-1 | Visão assíncrona continua após stop |
| 39 | P3 | P3-2 | Sleep de retry ignora abort |
| 40 | P3 | P3-8 | `clearAnthropicOAuth` não limpa slots de key |

### Onda D — Baixo (41–63)

| # | Sev | ID | Título |
| ---: | --- | --- | --- |
| 41 | P3 | P3-3 | Categoria `tabs` ignora allowedDomains |
| 42 | P3 | P3-4 | `stream_start` a cada passe |
| 43 | P3 | P3-5 | Shallow merge `providerOptions.anthropic` |
| 44 | P3 | P3-6 | Aliases Anthropic vs recovery em texto |
| 45 | P3 | P3-7 | Model cache key = últimos 8 da API key |
| 46 | P3 | P3-9 | `findElement` type=link ignora role=link |
| 47 | P3 | P3-10 | Shadow host cache 2s sem invalidate |
| 48 | P3 | P3-11 | Guard hostname-only (sem DNS) |
| 49 | P3 | P3-12 | Links markdown sem scheme |
| 50 | P3 | P3-13 | Alt de imagem double-escape |
| 51 | P3 | P3-14 | Textarea auto-grow layout thrash |
| 52 | P3 | P3-15 | Placeholder `@@CODE_BLOCK_N@@` colide |
| 53 | P3 | P3-16 | Summary fora do fragment no rebuild |
| 54 | P3 | P3-17 | `pendingSessionId` só em finishActiveRun |
| 55 | P3 | P3-18 | `execution_state` invalida cache entre passes |
| 56 | PERF | G5 | `getContent` bridge usa `innerText` |
| 57 | PERF | G7 | Textarea thrash (liga a #51) |
| 58 | PRED | PRED-1 | Run zumbi (reforço de #4–5, #9) |
| 59 | PRED | PRED-2 | SSRF redirect em prod (reforço de #2–3) |
| 60 | PRED | PRED-3 | Thrash OAuth (reforço de #22) |
| 61 | PRED | PRED-4 | History esquece tools (reforço de #7) |
| 62 | PRED | PRED-5 | 400 tool_use (reforço de #18) |
| 63 | PRED | PRED-6 | Falso “extensão reiniciou” (reforço de #30) |

---

# Onda A — Crítico

Corrigir antes de qualquer polish. Segurança + runs que o usuário sente como “quebrado”.

---

### #1 · P1-1 · `trackTab` matricula a aba ativa do usuário
| | |
| --- | --- |
| **Sev / confiança / esforço** | P1 · confirmed · M |
| **Arquivo** | `tools/browser-tools.ts` (~676–700, `trackTab` ~564–567) |

**Evidence:** Em `resolveExecutableTab`, a aba `active: true` entra nos candidatos e **cada** candidato vivo chama `this.trackTab(tab)`. `closeTab`/`focusTab` só checam `sessionTabs.has(tabId)`.

**Impact:** Aba de e-mail/banco do usuário vira “da sessão”; o modelo pode focar/fechar.

**Fix:** Track só abas abertas/adotadas de propósito. Nunca matricular fallback “active” só por probe.

**Preditivo ligado:** isolamento de sessão em geral.

---

### #2 · P1-2 · `httpRequest` segue redirect sem revalidar host privado (SSRF)
| | |
| --- | --- |
| **Sev / confiança / esforço** | P1 · confirmed · M |
| **Arquivo** | `tools/http-request.ts` (~89–111); `manifest.json` `<all_urls>` |

**Evidence:** `requireHttpUrl` só na URL inicial; `redirect: 'follow'` + `credentials: 'include'`; `response.url` final sem guard.

**Impact:** Open-redirect → metadata/LAN/CGNAT via SW da extensão.

**Fix:** `redirect: 'manual'` (ou hop-a-hop) + `requireHttpUrl` em cada hop/final.

**Preditivo:** PRED-2.

---

### #3 · P1-3 · `navigate` / `openTab` só validam a URL pedida
| | |
| --- | --- |
| **Sev / confiança / esforço** | P1 · confirmed · M |
| **Arquivo** | `tools/browser-tools.ts` (~812–823, ~849–876) |

**Evidence:** Chrome segue redirects; readiness devolve URL final sem `requireHttpUrl` / `isPrivateOrLoopbackHost`.

**Impact:** Mesma classe SSRF no contexto da aba (cookies + rede do usuário).

**Fix:** Após readiness, falhar se URL final for privada; não marcar sucesso.

**Preditivo:** PRED-2.

---

### #4 · P1-5 · Lock de run preso após `assistant_final` / `stop_run`
| | |
| --- | --- |
| **Sev / confiança / esforço** | P1 · confirmed · M |
| **Arquivo** | `background.ts` (~1865–1907, ~1926–1951, ~681–701, ~1067–1076) |

**Evidence:** Composer desbloqueia no `assistant_final`; compaction ainda segura `activeRunId`. `stop_run` só `abort()`, não zera lock (watchdog de idle zera).

**Impact:** “Já existe uma execução…” com UI livre; `run_status_query` mente “vivo”.

**Fix:** Liberar lock em eventos terminais; compaction fora do exclusive lock; clear no `stop_run` como no watchdog.

**Preditivo:** PRED-1. **Perf:** G1.

---

### #5 · P1-7 · Session switch / nova conversa sem `stop_run`
| | |
| --- | --- |
| **Sev / confiança / esforço** | P1 · confirmed · S |
| **Arquivo** | `panel-history.ts` (~349–365); `panel-ui.ts`; vs `activeRunId` no worker |

**Evidence:** UI zera estado local e aborta stream DOM; **não** manda `stop_run`. Worker segue; eventos filtrados por `sessionId`.

**Impact:** UI idle, SW ocupado, agente clica sem feedback.

**Fix:** `stop_run` + aguardar idle via `run_status_query`.

**Preditivo:** PRED-1.

---

### #6 · P1-4 · Retry “sem prompt cache” ainda manda breakpoints
| | |
| --- | --- |
| **Sev / confiança / esforço** | P1 · confirmed · S |
| **Arquivo** | `background.ts` (~1304–1308, ~1516–1526); `ai/prompt-cache.ts` |

**Evidence:** `callMessages` carimbado antes do loop; `disableAnthropicPromptCache()` só flipa flag; `providerOptions` permanecem; `continue` reenvia com cache.

**Impact:** Recovery OAuth/resposta vazia **não** desliga cache de verdade → retries mortos → falha do run.

**Fix:** Rebuild `callMessages` limpo + `promptCacheApplied = false` no disable.

---

### #7 · P1-6 · Histórico = só display → reload perde tool chain
| | |
| --- | --- |
| **Sev / confiança / esforço** | P1 · confirmed · M |
| **Arquivo** | `panel-history.ts` (~209–211); `panel-core.ts` (~393–412); `panel-chat.ts` (~72) |

**Evidence:** Persist usa `displayHistory`. Tools vivem em `contextHistory`. Load preenche os dois com o mesmo transcript de UI.

**Impact:** Continuidade de automação morre no reload.

**Fix:** Persistir/restaurar `contextHistory` (ou transcript de contexto) separado do display.

**Preditivo:** PRED-4.

---

### #8 · P2-1 · `agentInitiatedTabCloses` sticky se `closeTab` falha
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `background.ts` (~2202–2206, ~590–609) |

**Evidence:** Mark **antes** do execute; falha deixa id no Set; `onRemoved` trata close manual como “agente” e não aborta run na aba travada.

**Impact:** Usuário fecha a aba do run e a automação segue.

**Fix:** Mark só no sucesso; ou sempre abortar se for `activeRunLockedTabId`.

---

### #9 · P2-3 · Tools / XML recovery ignoram abort
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · M |
| **Arquivo** | `background.ts` `executeToolByName`; loop recovery XML |

**Evidence:** Abort checado no modelo; tools não leem o controller; recovery sequencial sem check entre calls.

**Impact:** Stop “não para” enquanto tools mutam o browser.

**Fix:** Checar aborted no início de cada tool e entre recovery calls.

**Preditivo:** PRED-1.

---

### #10 · P2-2 · Tools em voo estendem watchdogs sem teto
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · M |
| **Arquivo** | `background.ts` (~247–250, ~1323–1329, ~2039–2641) |

**Evidence:** `activeInFlightToolCalls > 0` renova idle + activity; path inclui recovery/vision; sem wall-clock de tool no run.

**Impact:** Hang de Chrome API → run eterno até SW die.

**Fix:** Timeout por tool + max wall-clock do run; não renovar idle indefinidamente.

---

# Onda B — Alto

Corrigir logo após a Onda A. Quebra automação, contexto e custo.

---

### #11 · P2-9 · Compaction → `abortActiveStreaming` libera composer mid-run
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `panel-core.ts` (~415–421); `panel-streaming.ts` (~351–363); deferred `background.ts` (~1262–1273) |

**Evidence:** Deferred compaction no **início** do próximo run; handler desbusy + stop liveness; stream start não re-busy.

**Impact:** UI livre no meio do run; double-send; liveness off.

**Fix:** Compaction só rebinda history; não abortar stream se run ativo.

---

### #12 · P2-18 · `execute_tool` manual interleave com agent
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · M |
| **Arquivo** | `background.ts` (~730–765) |

**Evidence:** Check de `activeRunId` no case; `await loadRuntimeSettings` cede o loop; manual path não seta lock.

**Impact:** Mutações concorrentes na aba.

**Fix:** Mutex único tool/agent.

---

### #13 · P2-8 · `getTabs` / `groupTabs` sem isolamento
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `tools/browser-tools.ts` (~3982–3997) |

**Evidence:** Lista janela inteira; groupTabs aceita ids arbitrários (close/focus exigem sessão).

**Impact:** Vazamento de URLs; reagrupa abas do usuário.

**Fix:** Filtrar à sessão; exigir membership em groupTabs.

---

### #14 · P2-4 · `MUTATIVE_TOOLS` incompleto
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `background/service-config.ts` (~62–76); cache TTL 5s |

**Evidence:** Faltam `executeScript`, `setInputFiles`, `hover`, `clipboard`, `cdp`.

**Impact:** `getContent`/`findElement` stale → cliques errados.

**Fix:** Ampliar set (ou invalidar em qualquer non-read).

**Perf:** G4.

---

### #15 · P2-5 · `nth-child` com índice por tag
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `content/dom-interact.ts` (~300–305) |

**Evidence:** Índice entre same-tag siblings, seletor `nth-child` (conta todos os filhos).

**Impact:** Fallback de findElement aponta nó errado.

**Fix:** `nth-of-type` ou índice real em `parent.children`.

---

### #16 · P2-6 · `type` sucesso sem verify
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · M |
| **Arquivo** | `content/glide-bridge.ts` (~202–205); inject applyValue |

**Evidence:** Set + events → `success: true` sem ler valor de volta.

**Impact:** React controlado reseta; form errado com “sucesso”.

**Fix:** Assert pós-write; `VALUE_NOT_APPLIED` se divergir.

---

### #17 · P2-7 · `dismissModal` sucesso sem verify
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `content/dom-interact.ts` (~554–584) |

**Evidence:** Sem before/after de dialogs; “sem dialog” ainda pode ser success.

**Impact:** Modelo segue com overlay aberto.

**Fix:** Sucesso só se contagem baixou / target sumiu.

---

### #18 · P2-10 · `tool_use` sem result no convert
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · M |
| **Arquivo** | `ai/model-convert.ts` (~42–86) |

**Evidence:** Dropa results órfãos; mantém `toolCalls` completos sem pair.

**Impact:** 400 Anthropic em histórico parcial.

**Fix:** Strip calls sem result ou synthetic tool_result.

**Preditivo:** PRED-5.

---

### #19 · P2-16 · Compaction sobrescreve display com context
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · M |
| **Arquivo** | `panel-core.ts` (~424–437) |

**Evidence:** Ambos arrays = `contextMessages`; renderer ignora roles `tool`.

**Impact:** UI perde execução; persist grava lixo de modelo como “display”.

**Fix:** Compaction só em `contextHistory`.

---

### #20 · P2-14 · User bubble órfão pós-ACK
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · M |
| **Arquivo** | `panel-chat.ts`; `background.ts` concurrent; `panel-core.ts` run_error |

**Evidence:** Push user antes do SW; concurrent `run_error` não reverte.

**Impact:** Mensagem fantasma no próximo contexto.

**Fix:** `clientTurnId` + rollback em concurrent/preflight.

---

### #21 · P2-17 · Empty `assistant_final` desync display/context
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `panel-chat.ts` (~237–246); `panel-core.ts` appendContext |

**Evidence:** Display early-return; context ainda appenda.

**Impact:** Turns invisíveis no prompt.

**Fix:** Não appendar context se display rejeitar (ou bolha “vazia”).

---

### #22 · P2-12 · OAuth `expiresAt=0` → refresh por request
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `ai/anthropic-oauth.ts` (~245–246, write/refresh) |

**Evidence:** `!expiresAt` força refresh; import/refresh sem TTL grava 0.

**Impact:** Martelada no token endpoint; latência multi-step.

**Fix:** Default TTL; soft refresh se expiry desconhecido.

**Perf:** G3. **Preditivo:** PRED-3.

---

### #23 · P2-11 · Compaction `maxOutputTokens` ~48k
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `background.ts` ~`0.8 * reserveTokens`; reserve 60000 |

**Evidence:** 48k de **saída** para sumário; muitos modelos rejeitam.

**Impact:** Fail → truncate-only; custo extra.

**Fix:** Cap 2k–4k independente de reserve.

**Perf:** G6.

---

### #24 · P2-13 · Recovery `fn(kwargs)` → `{ value }`
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · M |
| **Arquivo** | `ai/tool-call-recovery.ts` |

**Evidence:** Non-JSON args viram `{ value: raw }`.

**Impact:** Side effects com args errados no recovery.

**Fix:** Parser kwargs ou só JSON object.

---

### #25 · P2-15 · Dedicated tab non-HTTP
| | |
| --- | --- |
| **Sev / confiança / esforço** | P2 · confirmed · S |
| **Arquivo** | `background.ts` (~991–998) |

**Evidence:** Pode adotar `chrome://` se não há http candidate.

**Impact:** Inject falha; recovery queimado.

**Fix:** Só http(s); senão `DEDICATED_RUN_TAB_URL`.

---

# Onda C — Médio

Melhorias de reliability e custo depois do núcleo estável.

---

### #26 · P2-19 · `pressKey` sempre input+change
**Arquivo:** `content/dom-interact.ts` (~794–804) · **Esforço:** S  
Só emitir input/change para teclas que editam valor.

### #27 · P2-20 · `tabResolveMemo` sem clear
**Arquivo:** `tools/browser-tools.ts` · **Esforço:** S  
Invalidar em `onRemoved` / loading.

### #28 · P2-21 · CDP unrestricted (opt-in debugger)
**Arquivo:** `tools/cdp-session.ts` · **Esforço:** M  
Allowlist de methods + validar URLs de navigate.

### #29 · P2-22 · Timeout inject não cancela script
**Arquivo:** `tools/browser-tools.ts` (~743–756) · **Esforço:** L  
Abort token / documentar limitação / CDP terminate.

### #30 · P2-23 · Sentinel clear fire-and-forget
**Arquivo:** `background.ts` clear/write sentinel · **Esforço:** S  
`await` no finally; TTL no recover. **PRED-6.**

### #31 · P2-24 · Usage totalTokens inconsistente
**Arquivo:** `ai/compaction.ts`, `message-schema.ts` · **Esforço:** S  
`total = total || input+output`; aceitar usage sem total.

### #32 · P2-25 · Hard timeout com mensagem de inactivity
**Arquivo:** `background.ts` (~1416–1511) · **Esforço:** S  
Flag `hardTimedOut` na classificação de erro.

### #33 · PERF G1 · Compaction no exclusive lock
Mesma raiz de #4 — liberar lock antes / fase separada.

### #34 · PERF G2 · Vision/screenshot no path crítico da tool
Async default; budget; não bloquear recovery desnecessariamente.

### #35 · PERF G3 · OAuth refresh thrash
Mesma raiz de #22.

### #36 · PERF G4 · DOM cache stale
Mesma raiz de #14.

### #37 · PERF G6 · maxOutput sumário
Mesma raiz de #23.

### #38 · P3-1 · Visão pós-stop
Cancel queue por runId; passar AbortSignal do run.

### #39 · P3-2 · Retry sleep ignora abort
Sleep abortável ligado ao signal.

### #40 · P3-8 · `clearAnthropicOAuth` deixa apiKey
Limpar/blank `apiKey` + `apiKey_anthropic` quando iguais ao access token.

---

# Onda D — Baixo

Polish, residual de design, preditivos já cobertos por itens acima.

---

### #41 · P3-3 · `tabs` ignora allowedDomains
Documentar ou aplicar allowlist a URLs de tab onde fizer sentido. · partial

### #42 · P3-4 · Multi `stream_start`
Um stream session por run / só start se anterior parou. · partial

### #43 · P3-5 · Shallow merge `providerOptions.anthropic`
Deep-merge de `cacheControl`. · confirmed (impacto futuro)

### #44 · P3-6 · Aliases vs recovery texto
Mapear alias→original no allow-list. · partial

### #45 · P3-7 · Cache key últimos 8 da key
Hash completo ou prefix+suffix+len. · confirmed raro

### #46 · P3-9 · `type: link` sem `role=link`
Incluir role=link no filtro.

### #47 · P3-10 · Shadow host cache 2s
TTL menor / invalidar em miss.

### #48 · P3-11 · Guard sem DNS
Residual arquitetural; mitiga com #2–3. · partial

### #49 · P3-12 · Links markdown sem scheme
Opcional prefix `https://` para `www.`; path-only se desejado.

### #50 · P3-13 · Alt double-escape
Escapar uma vez só.

### #51 · P3-14 · Textarea layout thrash
rAF coalescer / CSS field-sizing. · **G7**

### #52 · P3-15 · Placeholder code block colide
Tokens opacos aleatórios.

### #53 · P3-16 · Summary fora do fragment
Construir summary no mesmo fragment.

### #54 · P3-17 · `pendingSessionId` lag
Aplicar sessionId imediatamente em compaction se sem run ativo.

### #55 · P3-18 · `execution_state` invalida cache entre passes
Mover bloco volátil para depois do breakpoint (teste com modelo real).

### #56 · PERF G5 · `innerText` no bridge getContent
Tradeoff conhecido; preferir textContent quando “barato” bastar.

### #57 · PERF G7 · Textarea thrash
Ver #51.

### #58 · PRED-1 · Run zumbi
Cobertura de teste de #4, #5, #9.

### #59 · PRED-2 · SSRF em prod
Teste com 302 → 127.0.0.1 / metadata (#2–3).

### #60 · PRED-3 · OAuth thrash
Teste bundle `expiresAt: 0` (#22).

### #61 · PRED-4 · History sem tools
Teste reload pós multi-tool (#7).

### #62 · PRED-5 · 400 tool_use
Fixture convert (#18).

### #63 · PRED-6 · Falso recover
Simulate delayed sentinel clear (#30).

---

## Checklist por onda (copiar)

### Onda A
- [ ] #1 P1-1 trackTab  
- [ ] #2 P1-2 httpRequest redirect  
- [ ] #3 P1-3 navigate redirect  
- [ ] #4 P1-5 run lock  
- [ ] #5 P1-7 stop no session switch  
- [ ] #6 P1-4 prompt-cache strip  
- [ ] #7 P1-6 context history persist  
- [ ] #8 P2-1 closeTab mark  
- [ ] #9 P2-3 abort em tools  
- [ ] #10 P2-2 tool wall-clock  

### Onda B
- [ ] #11–#25 (ver mapa)

### Onda C
- [ ] #26–#40

### Onda D
- [ ] #41–#63

---

## Não é achado (já endurecido)

| Tema | Por que ok hoje |
| --- | --- |
| IPv4-mapped `::ffff:` | reconstrói hex + fail-closed |
| History aliasing display/context | clones independentes |
| Composer stuck em run_error | `setComposerBusy(false)` |
| Bridge type em select | `BRIDGE_UNSUPPORTED` → inject |
| mouse mutative | no set |
| Heartbeat non-stream infinito | hard timeout |
| OAuth 400 brick | só `invalid_grant` |
| API key global só | slots por provedor |
| Image tokens thrash | custo fixo 1200 |
| XML recovery sem filtro | filtered by allowlist |
| finally/watchdog leak vision | limpeza por runId |
| Screenshot orphan race | index-first + lock |
| visionBridgeSync forçado | settings respeitadas |
| innerHTML += streaming | appendData |
| OAuth reconcile no blur | só se user editou |
| Markdown links/code escape | corrigido |
| Multimodal [object Object] | parts tratados |
| Sem stop_run / sem liveness | existem |

---

## Contagem

| Classe | Qtd |
| --- | ---: |
| P1 | 7 |
| P2 | 25 |
| P3 | 18 |
| PRED | 6 |
| PERF | 7 |
| **Total indexado** | **63** |
| Não-bug (referência) | 18 |

---

## Metadados

| | |
| --- | --- |
| Data | 2026-07-31 |
| Projeto | Glide V2 0.2.0 |
| Ordenação | prioridade de ação (#1 → #63) |
| Alterações de produto | nenhuma |
| Próximo passo | Onda A (#1–#10) + `npm run check` / `test:unit` após cada lote |

*Fim — documento ordenado por prioridade.*
