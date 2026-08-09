# Auditoria robusta — Extensão Glide (MV3)

> **Documento histórico — instantâneo da V1, não é o estado atual.**
> Escrito antes do fork V2 (a suíte tinha 128 testes; hoje são 177) e parte dos
> achados já foi corrigida desde então. Trate cada item como hipótese a
> reverificar contra o código, não como diagnóstico vigente. Para o estado atual,
> veja `AGENTS.md`, `docs/ARCHITECTURE.md` e `DESIGN.md`.

**Escopo:** `ai/`, `background/` + `background.ts`, `tools/`, `content/`, `sidepanel/ui/`.
**Modo:** somente leitura (nada foi editado).
**Verificação:** `npm run check` (tsc + biome) limpo; `npm run test:unit` = 128/128 passando.
**Complexidade:** MEDIUM/HIGH (auth/tokens, integrações externas, DOM não confiável, sem persistência de run).
**Status de saúde:** **VERMELHO** — 1 bypass de segurança confirmado + causa concreta do erro que você relatou + P1s de corrupção de contexto.

Todos os achados abaixo foram verificados de forma independente contra o código-fonte (e, no caso do bypass de IP, reproduzidos em Node).

---

## 0. O erro que você relata: "Erro no provedor (anthropic): Invalid bearer token"

Esse texto é a Anthropic dizendo que o **token OAuth enviado não é aceito** (expirado, malformado ou revogado). Há duas camadas de problema:

### 0.1 — O humanizador de erro NÃO reconhece "Invalid bearer token" como problema de credencial
`background/service-config.ts:191`
```ts
if (lower.includes('401') || lower.includes('unauthorized') || (lower.includes('invalid') && lower.includes('key'))) {
  return `Credencial inválida ou expirada para ${prov}. Verifique a API key...`;
}
```
"Invalid bearer token" contém `invalid` mas **não** contém `key`, `401` nem `unauthorized`. Então ele cai no fallback genérico (`service-config.ts:201`) e mostra o texto cru — exatamente o que você vê. **Consequência:** o usuário nunca recebe a orientação de "reconectar", e um problema de sessão OAuth se disfarça de "erro do provedor". **Correção:** adicionar `bearer`/`token` ao teste de 401.

### 0.2 — Causas concretas do token ficar inválido (ranqueadas)

**(a) `reconcileManualAnthropicToken` destrói o bundle de refresh ao interagir com o campo da chave — CONFIRMED (P1 do erro)**
`sidepanel/ui/bind-settings.ts:42-48` + `ai/anthropic-oauth.ts:88-95`

O campo "Token OAuth" é preenchido com o **access token atual** (`panel-settings.ts:191`). Quando o token é renovado em background (`writeAnthropicOAuth` grava um access token novo), o campo do formulário continua mostrando o **token antigo**. Qualquer evento `change` no campo (basta dar foco e sair — o listener dispara com valor diferente do bundle) executa:
```ts
// bind-settings.ts:46
provider === 'anthropic' ? reconcileManualAnthropicToken(pasted) : ...
// anthropic-oauth.ts:92
if (bundle && bundle.accessToken !== manual) { await clearAnthropicOAuth(); }
```
Como o token exibido ≠ `bundle.accessToken` (que já foi rotacionado), o bundle inteiro — **inclusive o refresh token** — é apagado. A partir daí sobra só um access token estático que **não renova**; quando ele expira (poucas horas), toda requisição vira "Invalid bearer token" e **não há recuperação automática** até reconectar. Isso explica perfeitamente "mesmo assim ainda aparecem erros" após testes: cada vez que você abre as Configurações e mexe no campo depois de um refresh, mata a sessão.
**Verificação:** conecte via "Conectar com Claude", espere/force um refresh, abra Configurações, clique no campo do token e clique fora; inspecione `chrome.storage.local` → `anthropicOAuth` sumiu.

**(b) Sessão marcada como "morta" por falha transitória de refresh, sem auto-recuperação — CONFIRMED (P2)**
`ai/anthropic-oauth.ts:160-162, 176-178`

Se `refreshAnthropicToken` retornar HTTP 400 **ou** 401, `markRefreshRejected` grava `refreshRejectedAt` e, a partir daí, `ensureFreshAnthropicToken` retorna o **access token velho sem nunca mais tentar renovar** — inclusive no caminho `forceRefresh` do retry de 401 (o guard de `refreshRejectedAt` na linha 160 vem **antes** do `needsRefresh`). Um 400 pontual do endpoint (hiccup da Anthropic, clock skew, corpo malformado) transforma-se em sessão permanentemente quebrada → "Invalid bearer token" em loop. Há um `run_warning` ("Sessão do Claude expirada"), mas o run **prossegue com o token morto** (`background.ts:1035-1043`) e ainda estoura o erro cru.
**Verificação:** unit test forçando `refreshAnthropicToken` a lançar `AnthropicRefreshError(…, 400)` e confirmar que chamadas seguintes não tentam refresh.

**(c) Slot global único `apiKey` compartilhado entre providers — PARTIAL (P2)**
`sidepanel/ui/settings-keys.ts:1` + `panel-settings.ts:122-134`

Só existe **um** `apiKey` no storage para todos os providers. `handleProviderChange` persiste imediatamente. Trocar de provider (ex.: Anthropic→Codex→Anthropic) pode gravar a chave errada sob o provider ativo (token Anthropic indo pra OpenAI = 401, ou o token OAuth sendo sobrescrito). Recomendo chave por provider (`apiKey_anthropic`, `apiKey_codex`, …).

> **Ação mais provável para resolver seu caso agora:** reconecte em Configurações → "Conectar com Claude" e **não mexa mais no campo do token**. As correções (a) e (b) eliminam a recorrência.

---

## 1. Achados P1 (bug/segurança confirmados)

### P1-1 — Bypass do guard de host privado/loopback via IPv6 IPv4-mapped (SEGURANÇA)
`tools/validation.ts:42`
```ts
const ipv4 = host.startsWith('::ffff:') ? host.slice(7) : host;
```
O código assume `::ffff:a.b.c.d` (decimal pontilhado), mas `new URL()` **canoniza para hexadecimal**. Reproduzido em Node:
```
http://[::ffff:169.254.169.254]/ -> [::ffff:a9fe:a9fe]
http://[::ffff:127.0.0.1]/       -> [::ffff:7f00:1]
```
Após remover colchetes, `host.slice(7)` = `a9fe:a9fe`, que não casa o regex IPv4 → retorna "não privado". Como o modelo controla a URL de `navigate`/`openTab` e `requireHttpUrl` é o único guard por padrão (allowedDomains vazio), um modelo (ou injeção via conteúdo de página) pode dirigir o navegador a loopback, RFC1918 e ao **endpoint de metadata da cloud** — justamente o que o comentário do guard diz impedir.
**Correção:** normalizar o host antes de testar (converter hex mapeado para IPv4, ou bloquear qualquer `::ffff:` cujo sufixo não seja IPv4 privado reconhecido; e bloquear IPv6 numérico não-explicitamente-público). O alcance fim-a-fim depende do dual-stack do SO, mas o guard está objetivamente furado.

### P1-2 — Heartbeat do modo não-streaming neutraliza os dois watchdogs
`background.ts:1275-1283`
```ts
const heartbeatId = setInterval(() => { this.touchActiveRun(runMeta.runId); activityWatchdog.touch(); }, 15000);
try { await result.text; } finally { clearInterval(heartbeatId); }
```
Com `streamResponses: false`, o heartbeat "toca" o `ModelActivityWatchdog` **e** o watchdog do run a cada 15s em wall-clock, sem nenhum sinal real de progresso, e não há `AbortSignal.timeout` sobre `result.text`. Uma conexão de provedor que trava sem fechar deixa o run **pendurado para sempre**: nem o timeout de atividade nem o `ACTIVE_RUN_TIMEOUT_MS` (120s) disparam. UI presa em "executando" até recarregar a extensão.
**Correção:** só tocar os watchdogs em progresso real; envolver `result.text` num timeout.

### P1-3 — `displayHistory` e `contextHistory` viram o MESMO array após compaction/restauração
`sidepanel/ui/panel-history.ts:322-323` e `sidepanel/ui/panel-core.ts:392-393`
```ts
this.displayHistory = normalized; this.contextHistory = normalized; // mesma referência
```
No fluxo normal são arrays separados; `sendMessage` faz `displayHistory.push(...)` **e** `contextHistory.push(...)`. Depois de qualquer compaction ou `loadSession`, os dois apontam para o mesmo array → **cada turno insere a mensagem 2×**. Esse array vai como `conversationHistory` ao background e vira `currentHistory` do modelo → **o modelo recebe contexto duplicado**, o medidor infla, o histórico persistido acumula lixo e a UI mostra bolhas duplicadas.
**Correção:** clonar em uma das atribuições (`this.contextHistory = [...normalized]`).

### P1-4 — Estimador de tokens conta base64 de imagem como texto → compaction em loop
`ai/message-utils.ts:63-85` (usado por `ai/compaction.ts` e `panel-context.ts`)
```ts
return acc + Math.ceil(JSON.stringify(part).length / 4); // part de imagem
```
Um part `{type:'image', image:'data:...'}` de ~500KB vira ~125k "tokens" (e ainda soma +1200). Com 1–2 screenshots anexados (`panel-attachments.ts` gera dataURL até 1600px), estoura `contextLimit - reserve` → `shouldCompact` dispara. Como a imagem fica na janela preservada, a estimativa continua alta e **a compaction re-dispara a cada turno** (thrash de sumarização, custo, latência) — e alimenta o P1-3.
**Correção:** contar imagem por um custo fixo (ex.: ~1200 tokens) em vez de `JSON.stringify` do base64.

---

## 2. Achados P2

- **`type` em `<select>` reporta sucesso sem selecionar — CONFIRMED.** `content/glide-bridge.ts:184` + `dispatchInputEvents:28-46`. `tool-definitions.ts` promete suporte a select, mas o bridge não trata select e devolve `{success:true}`; o path inject (que trata) nunca roda. Dropdown fica no default e o modelo segue confiante → submit com valor errado. (`type` em campos `disabled`/`readonly` também dá falso-sucesso — PARTIAL.)
- **`mouse` fora de `MUTATIVE_TOOLS` → cache de DOM não invalidado — CONFIRMED.** `background/service-config.ts:53-66`. `doubleClick`/`rightClick` mutam a página mas `getContent`/`findElement` (TTL 5s) servem estrutura pré-ação. Adicionar `mouse` ao set.
- **`run_error` não reabilita o botão de envio — CONFIRMED.** `panel-core.ts:319-332` remove `running` e reseta streaming, mas nunca faz `sendBtn.removeAttribute('disabled')`/`classList.remove('loading')` (só nos caminhos de sucesso em `panel-chat.ts`). Após qualquer erro, botão fica travado com spinner; só Enter funciona.
- **API key do OAuth Codex não é persistida — CONFIRMED.** `panel-settings.ts:99-110`. Só seta `.value` (não dispara o listener) e **não** chama `persistAllSettings`, ao contrário do fluxo Anthropic (linha 67). Se o usuário não clicar em Salvar, a chave gerada some.
- **Recovery de XML executa ferramentas fora do toolset da sessão — CONFIRMED.** `background.ts:1407-1410`. `extractXmlToolCalls` não é filtrado por `availableToolNames` (só `extractRecoverableToolCalls` é). Um modelo que emita `<tool_call>spawn_subagent</tool_call>` dispara subagentes mesmo com orquestrador desligado, contornando o gate.
- **`visionBridgeSync:true` hardcoded → fila de visão é código morto e bloqueia por até 30s — CONFIRMED.** `background.ts:2339,2381`. Cada screenshot de recovery bloqueia o tool result por `VISION_DESCRIBE_TIMEOUT_MS`; a config `visionBridgeSync=false` do usuário é ignorada; `forceAsyncVision` nunca é lido.
- **Abort por watchdog pula a limpeza do `finally` — CONFIRMED.** `background.ts:250-260` vs `1738-1751`. O watchdog zera `activeRunId` antes do finally, cujo guard (`activeRunId === runMeta.runId`) passa a ser falso → leak permanente em `pendingVisionByRun`, flush adiado, controller pendurado.
- **Mensagem multimodal renderizada como "[object Object]" — CONFIRMED.** `panel-history.ts:416-421`. `escapeHtml(msg.content)` com `content` array (pós-compaction) → `[object Object],...`.
- **Markdown: escape duplo em inline code e links com query corrompidos — CONFIRMED.** `panel-markdown.ts:53` re-escapa código já escapado (`&amp;` → `&amp;amp;`); `48-51` corrompe `?a=1&b=2` em links. Sem XSS (o pipeline de escape está correto — verificado como negativo), mas todo link com 2+ params aponta para URL errada.

---

## 3. Achados P3 / preditivos (ciclo de vida MV3)

- **Nenhum estado de run sobrevive à morte do service worker — CONFIRMED (preditivo).** `background.ts` mantém `activeRunId`, watchdogs (`setTimeout`), histórico e eventos bufferizados 100% em memória; `init()` não persiste "run em andamento" nem notifica um run morto ao reiniciar. Se o Chrome matar o SW no meio de um run (>30s sem chunks), **nenhum `run_error`/`run_complete` é emitido** — painel preso em "executando" e eventos perdidos. Não há watchdog no lado do painel. **Correção:** persistir sentinel de run ativo e, no `init`, emitir `run_error` para runs órfãos.
- **Sem handler de cancelamento de run no background — PARTIAL.** `handleMessage` não tem `stop/abort/cancel`. Único jeito de parar: fechar a aba travada (só em automação) ou esperar 120s.
- **Blob de screenshot gravado fora do lock do índice — PARTIAL.** `background/screenshot-store.ts:101-121`. Se o SW morrer entre gravar o blob e inserir no índice, o blob fica órfão e o prune (que só lê o índice) nunca o remove → acúmulo em `storage.session` (quota ~10MB).
- **`forceCompactionCut` pode preservar `tool` órfão — PARTIAL.** `ai/compaction.ts:291-301`. Histórico compactado começando com tool-result sem o tool_use correspondente → 400 "tool_result without tool_use" na Anthropic no turno seguinte.
- **Transcript persistido pode quebrar pares e corromper args — PARTIAL.** `panel-history.ts:36-64,100-110`. Corte por bytes pode partir o par assistant(toolCalls)/tool; `args` truncado em 4000 chars com `...` faz `JSON.parse` falhar na restauração.
- **`agentInitiatedTabCloses` marcado antes da checagem de permissão — CONFIRMED.** `background.ts:1783-1785`. Se o `closeTab` for bloqueado/falhar, a entrada não sai do Set; se o usuário depois fechar essa aba, o abort do run é suprimido.

---

## 4. Higiene técnica

- `panel-markdown.ts` — o pipeline de escape/sanitização de URL está **correto** (verificado; sem XSS): tudo é escapado antes das regex, URLs passam por whitelist http/https/mailto com `new URL()`, atributos com `escapeAttribute`.
- `background.ts:338-347` — `forceAsyncVision` computado e nunca lido (morto).
- `tools/browser-tools.ts:3832` — `executeScript` usa `new Function()` no world MAIN; quebra em páginas com CSP sem `unsafe-eval` (retorna `{success:false}`, não falso-sucesso).
- `codex-oauth.ts:105` — `accessToken`/`refreshToken`/`idToken` descartados; sem rota de refresh (limitação assumida).

---

## 5. Verificação executada

- `npm run check` (tsc --noEmit + biome) → **limpo**.
- `npm run test:unit` → **128/128 passando** (inclui a suíte de política OAuth Anthropic).
- Node: canonicalização IPv4-mapped confirmada (P1-1).
- Leitura cruzada de todos os anchors P1/P2 contra o código-fonte.

## 6. Risco residual

- Não executei a extensão em Chrome real: o roteamento fim-a-fim do IPv4-mapped (P1-1) e o clique duplo bridge→inject (uncertain) dependem de runtime.
- Hosts que resolvem para IP privado via DNS público (`*.nip.io`) não são cobríveis por checagem de hostname literal — limitação de design.
- Refutado (não é achado): o token Anthropic **é** renovado por-request via `createAnthropicAuthFetch` (não só no início do run), então expiração no meio de run longo é coberta — salvo quando o bundle foi apagado (P1 do erro) ou marcado morto (0.2b).

---

## Prioridade sugerida de correção
1. **0.1 + 0.2a + 0.2b** — resolve o "Invalid bearer token" recorrente (seu problema imediato).
2. **P1-1** — fechar o bypass de host privado (segurança).
3. **P1-3 + P1-4** — parar a duplicação de contexto e o loop de compaction com anexos.
4. **P1-2 + run órfão MV3** — evitar UI pendurada.
5. P2 (select/mouse/botão/Codex key) conforme uso.
