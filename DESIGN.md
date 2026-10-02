# Glide V2 — sistema de interface

Branco, azul e preto/cinza. Claro e escuro. Pouca cor, movimento em tudo.

Referências: a extensão do ChatGPT (composer de uma linha, botão de enviar
sólido, transições contínuas), Apple (espaço em branco, tracking negativo em
títulos, curvas longas) e Notion (superfícies macias, hierarquia por contraste
em vez de caixas).

## As três regras

1. **Cinza carrega a hierarquia, azul carrega a interação.** Se um elemento não
   responde a clique nem representa um estado que o usuário ligou, ele é
   neutro. Azul aparece em: anel de foco, item de modelo selecionado, toggle de
   atividade ligado, ponto de status "executando", barra da nav ativa, link.
2. **Ação primária é tinta sólida, não cor de marca.** Preto no claro, branco no
   escuro. É o elemento de maior contraste da tela — e o único que precisa ser.
3. **Nada aparece do nada.** Todo elemento que entra vem de algum lugar (de
   baixo, do gatilho, da esquerda) e sai por onde entrou.

## Tokens

Tudo em `sidepanel/styles/base.css`. Cada cor é um `light-dark(claro, escuro)`,
então **não existe bloco de tema duplicado**: trocar de tema é trocar
`color-scheme` no `:root`, e todos os pares viram de lado sozinhos.

| Grupo | Tokens |
| --- | --- |
| Superfície | `--background` `--surface` `--surface-sunken` `--background-elevated` `--card-hover` |
| Overlay | `--overlay-hover` `--overlay-press` `--overlay-scrim` |
| Tinta | `--foreground` `--muted` `--muted-dim` `--border` `--border-strong` |
| Primário | `--ink` `--ink-hover` `--ink-foreground` |
| Azul | `--accent` `--accent-hover` `--accent-muted` `--accent-border` `--accent-ring` |
| Enviar | `--send-bg` `--send-bg-hover` `--send-fg` |
| Espaço | `--space-1`…`--space-8` (2, 4, 6, 8, 12, 16, 20, 28) |
| Raio | `--radius-xs` 6 · `-sm` 8 · base 10 · `-lg` 14 · `-xl` 20 · `-full` |
| Texto | `--text-mono` 11 · `-xs` 12 · `-sm` 13 · base 14 · `-lg` 16 · `-xl` 19 · `-brand` 21 |
| Duração | `--dur-1` 90ms · `-2` 140 · `-3` 200 · `-4` 320 · `-5` 460 |
| Curva | `--ease-out` `--ease-in-out` `--ease-drawer` `--ease-spring` |
| Elevação | `--shadow-xs` `--shadow-sm` `--shadow-md` `--shadow-lg` |

> **`light-dark()` é uma função de COR.** Envolver um valor composto —
> `light-dark(0 1px 2px rgba(…), …)` para uma sombra — produz valor inválido, e
> o CSS **descarta a declaração inteira em silêncio**, sem aviso no console.
> Foi assim que as quatro sombras da V2 nasceram mortas, levando junto o anel de
> foco do composer, que dividia a mesma declaração `box-shadow`. Na função entra
> só a cor; a geometria fica fora e é igual nos dois temas.

**Deixar o botão de enviar azul** é uma linha: `--send-bg: var(--accent)` em
`base.css`.

## Mark

Uma esfera com um clique dentro: arco espesso de 288° com abertura a leste, mais
um ponto sólido no centro. Duas primitivas, um peso de traço, nenhum gradiente —
e a forma resultante é também a inicial do produto.

Fonte única em `icons/glide-mark.svg`, herdando `currentColor`. O arco é um path
explícito e **não** um `stroke-dasharray`: dash escala junto com `transform`, o
que quebra silenciosamente ao reaproveitar a geometria em outro tamanho.

Aparece em quatro lugares além dos ícones — cabeçalho da gaveta, estado vazio,
glifo do assistente e o harness de preview. Ao mexer na geometria, os quatro
precisam acompanhar (`grep "M18.88 16.82"`).

### Ícone da barra do Chrome

`icons/glide-logo.svg` → `npm run icons` → `icon16/48/128.png`.

Diferente do mark de interface, o ícone vem sobre uma **placa azul sólida** com
a marca vazada em branco. O PNG anterior era transparente com a marca escura e
sumia na barra de ferramentas escura do Chrome; a placa garante contraste nos
dois temas, e o azul destaca no meio dos ícones cinza.

### O que foi descartado

Três rodadas de teste, cada candidato renderizado em 16/24/32/96 px, sobre placa
de tinta, placa azul e as barras clara e escura (folhas em `docs/v2-preview/`):

- **Cursor dentro do anel** — a 16px vira o botão de *play*.
- **Traço de glide** (arco + ponto solto) — não se lê em tamanho nenhum.
- **Ondas de clique** — vira ícone de wi-fi girado.
- **Disco com furo deslocado** — lê como um olho.
- **Corpo em órbita** (ponto sobre a circunferência) — bonito em tamanho grande,
  mas arco-com-ponto é a forma de um *spinner*: o usuário acharia que travou.
- **Anel + ponto centrado** — impecável e genérico; é o símbolo de gravar.

## Foco

Um foco, um indicador. O anel global de `:focus-visible` (base.css) vale para
botões e links. O composer é a exceção: quem indica o foco dele é a **moldura
inteira**, e o `textarea` tem o anel próprio suprimido — campos de texto casam
com `:focus-visible` até no clique do mouse, então os dois desenhavam ao mesmo
tempo (um retângulo azul reto encostado por dentro do arredondado).

A moldura acende com `:has(textarea:focus)`, não com `:focus-within`: este
último dispara com qualquer descendente focado, e tabular até o botão de anexo
pintava a moldura ao mesmo tempo que o botão mostrava o anel dele.

## Curvas

- `--ease-out` `cubic-bezier(.22,1,.36,1)` — padrão. Arranca e assenta.
- `--ease-drawer` `cubic-bezier(.32,.72,0,1)` — gaveta lateral e painel de
  atividade (curva do iOS).
- `--ease-spring` `linear(…)` — mola com overshoot real. Só no que "salta":
  dropdown, botão de enviar, chips, checkbox do plano, modal. Em superfície
  grande, enjoa.

## Movimento

`sidepanel/styles/motion.css` concentra keyframes e animações de entrada.
Elementos criados por JS animam sozinhos — uma `animation` declarada na classe
dispara quando o nó entra no documento, então quase nada exige código.

| Momento | Animação |
| --- | --- |
| Turno de conversa | `rise-in` 320ms; corpo do assistente com 40ms de atraso |
| Bolha do usuário | `pop-in` com mola |
| Passo de ferramenta | `slide-in-left` (direção em que a linha do tempo cresce) |
| Estado vazio | cascata de 60ms entre marca, título, subtítulo e dica |
| Bloco de execução | título vivo com `.shimmer` ("Pensando…", "Clicando…", "Respondendo…"); cada troca sobe em fade (`setExecutionActivityLabel`) e a barra de status repete o mesmo verbo. O shimmer é um véu da cor do fundo com uma janela transparente, movido em `transform` |
| Acompanhar o fim | `scrollToBottom` desliza com desaceleração (τ = 55 ms) quando o conteúdo cresce; pula direto em ação do usuário, em redimensionamento da área visível e quando o layout muda acima do texto |
| Abrir/fechar execução | `::details-content` desliza até `auto` (`interpolate-size`) |
| Ferramenta rodando | ícone respira (`breathe`); ao concluir, `check-pop` |
| Executando | ponto de status com halo pulsante |
| Streaming | cada trecho entra em `fade-in` (`.stream-chunk`) + cursor piscando no fim |
| Plano | gaveta desliza (`grid-template-rows` 1fr↔0fr), barra de progresso em `scaleX`, visto desenhado por `stroke-dashoffset`, ponto que respira na etapa atual |
| Troca de tema | `.theme-transition` no `:root` por 260ms, só cor e fundo |

Tudo dentro de `@media (prefers-reduced-motion: no-preference)`; o `reduce`
mantém opacidade e cor e descarta deslocamento e escala.

## Composer

A V1 empilhava seis controles numa grade de três colunas dentro de ~300px e
tudo truncava. Na V2 o estado saiu da barra e virou uma linha própria acima do
composer, com a largura inteira do painel. A barra ficou com um grupo de cada
lado:

```
● Executando · 3 ferramentas          Ctx 12k/200k
┌──────────────────────────────────────────────┐
│  Mensagem…                                   │
│  ＋   ☰   ⌗                    Sonnet 5 ⌄  ⬆ │
└──────────────────────────────────────────────┘
```

Os IDs continuam os mesmos da V1 (`#statusBar`, `#statusDot`, `#statusText`,
`#statusMeta`, `#sendBtn`…), então nenhum módulo de `sidepanel/ui/` precisou
mudar por causa do layout.

## Tema

`sidepanel/ui/theme.ts`. Três modos em ciclo: sistema → claro → escuro. O botão
fica no cabeçalho da gaveta.

Persistência em `localStorage` e não em `chrome.storage` **de propósito**: a
leitura é síncrona, então `initTheme()` roda antes do primeiro layout em
`panel.ts`. Com storage assíncrono o painel abriria no tema do sistema e
piscaria para o tema salvo.

## Preview

```bash
npm run preview
```

Monta os templates reais + o CSS real numa página estática com conteúdo falso
em `dist/sidepanel/preview.html` — dá para ajustar CSS sem recarregar a extensão
no Chrome.

- `preview.html?theme=light|dark&view=chat|empty|sidebar|settings|history|menu`
- `preview-split.html` — claro e escuro lado a lado

## Desempenho

Medido no harness de preview, conversa de 160 turnos, A/B na mesma página
(números do Chrome desta máquina — servem para comparar as duas versões entre
si, não como referência absoluta).

### Frame durante o streaming

Texto chegando ao DOM e um frame medido a cada anexação:

| | médio | p95 | pior | frames > 20 ms (de 60) |
| --- | --- | --- | --- | --- |
| sem `contain` | 18,4–19,9 ms | 26–30 ms | 34 ms | 29–30 |
| com `contain` | 13,1–13,5 ms | 16,6 ms | 18,5 ms | **0** |

Metade dos frames estourava o orçamento de 60 fps; agora nenhum. Reproduzido
com a ordem das rodadas invertida, para descartar efeito de aquecimento.

### Operações pontuais

| | antes | depois |
| --- | --- | --- |
| Fechamento da resposta, 300 blocos (`innerHTML +=` → `insertAdjacentHTML`) | 184,3 ms | 2,8 ms |
| 300× `updateActivityState` (reflow forçado → densidade memorizada) | 14,7 ms | 0,4 ms |

`innerHTML +=` é quadrático: serializa todo o DOM existente, concatena,
reparseia. O ganho cresce com o tamanho da resposta.

### Regras que sustentam isso

1. **Nunca ler layout depois de escrever nele** no mesmo bloco síncrono.
   `clientWidth`, `scrollHeight` e `getBoundingClientRect` forçam o navegador a
   recalcular na hora. Meça uma vez, memorize, invalide no `ResizeObserver`.
2. **Animar só `transform` e `opacity`.** São as duas propriedades que o
   compositor resolve sem repintar. `box-shadow`, `background-position` e
   `backdrop-filter` repintam a cada frame.
3. **Um `requestAnimationFrame` por frame, por finalidade.** Vários callbacks
   agendados para o mesmo frame leem layout repetidas vezes para chegar ao
   mesmo resultado.
4. **Escrita condicional.** `textContent`, `dataset` e `classList.toggle`
   sujam o elemento mesmo quando o valor não muda.

### Latência das chamadas ao modelo

- **Token OAuth espelhado em memória** (`ai/anthropic-oauth.ts`). O fetch de
  cada request chamava `chrome.storage.local.get` — IPC para o processo do
  navegador antes de o socket abrir, uma vez por step. O espelho é invalidado
  por `chrome.storage.onChanged`; sem esse listener disponível, o cache é
  desligado em vez de servir credencial velha.
- **Breakpoint de cache rolante** (`ai/prompt-cache.ts` +
  `prepareStep`). Uma passe do agente é uma request por step, não uma só. Com o
  breakpoint parado no fim do prefixo inicial, todo resultado de ferramenta
  produzido durante a passe ficava fora da região cacheada e era recobrado a
  cada step. Agora são dois breakpoints: uma âncora fixa (garante o acerto) e um
  rolante no fim (grava o rabo acumulado para o step seguinte).

### Um cache que foi removido em vez de implementado

`getCachedToolSet` tinha nome de cache e não cacheava; havia até uma
`buildToolSetCacheKey` pronta e nunca usada. Medido antes de decidir:
`buildToolSet` custa **15 µs** para as ferramentas e roda **uma vez por
run** — `jsonSchema()` é um getter preguiçoso e `tool()` é a função identidade,
não há compilação de schema para reaproveitar.

Cachear trocaria 0,015 ms por conversa por um bug de verdade: o `execute` fecha
sobre estado do run corrente (contador de execuções que impede replay de efeitos
colaterais num retry, watchdog de atividade, `runMeta`, aba travada). Reusar
entre runs mandaria as chamadas do run novo para os contadores e a aba do run
anterior.

Resultado: a chave morta saiu, a função virou `buildRunToolSet`, e o teste
"does not reuse execute closures" ficou como guarda para quem tentar
"otimizar" isto de novo.

### Em aberto

O `<execution_state>` que `enhanceSystemPrompt` monta entra concatenado no bloco
`system`, e muda a cada passe (progresso do plano, próxima chamada exigida).
Como o `system` é o começo do prefixo, **qualquer mudança nele invalida o cache
inteiro entre passes**. Dentro de uma passe não há problema — o payload é
montado uma vez —, mas entre passes o prefixo nunca acerta.

A correção é mover o bloco volátil para o fim das mensagens, depois do
breakpoint. Não fiz aqui porque muda a posição de uma instrução de
comportamento no prompt e isso pede um teste com modelo real antes. Vale medir:
`cachedInputTokens` na resposta mostra o tamanho do acerto.

## O que não mudou

`background.ts`, `ai/`, `background/`, `content/`, `tools/` e a lógica de
`sidepanel/ui/` são idênticos à V1. A V2 é camada visual, estrutura do composer
e movimento.
