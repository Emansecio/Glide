# Glide V2 Polish and Code Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os problemas confirmados de acessibilidade, performance, cancelamento e verificação encontrados na revisão da extensão.

**Architecture:** Preservar a arquitetura Vanilla TypeScript + CSS existente. A UI usará `inert` e foco explícito para superfícies fechadas, controles nativos para ações de teclado, e o harness manterá buscas limitadas e lifecycle explícito para instrumentação de rede.

**Tech Stack:** Chrome MV3, TypeScript estrito, HTML/CSS vanilla, Biome, Playwright e testes unitários Node.

---

### Task 1: Corrigir foco e controles acessíveis

**Files:**
- Modify: `sidepanel/ui/panel-navigation-helpers.ts`
- Modify: `sidepanel/ui/panel-tools.ts`
- Modify: `sidepanel/ui/panel-ui.ts`
- Modify: `sidepanel/templates/main.html`
- Modify: `sidepanel/templates/sidebar-shell.html`
- Modify: `sidepanel/ui/panel-history.ts`
- Modify: `sidepanel/ui/panel-plan.ts`
- Modify: `sidepanel/templates/panels/settings-general.html`
- Modify: `sidepanel/ui/theme.ts`
- Test: `tests/unit/run-unit-tests.ts`

- [x] Aplicar `inert` a sidebar e activity panel quando fechados e devolver foco ao gatilho ao fechar.
- [x] Transformar item de histórico e cabeçalho do plano em controles nativos, sincronizando estado ARIA.
- [x] Implementar teclado no seletor de tema com roving `tabindex` e setas/Home/End.
- [x] Cobrir o novo parâmetro de lifecycle de rede no teste unitário de definições.

### Task 2: Reduzir custo do browser harness

**Files:**
- Modify: `tools/browser-tools.ts`
- Test: `tests/unit/run-unit-tests.ts`

- [x] Substituir materialização irrestrita de shadow hosts por travessia limitada e deduplicada.
- [x] Garantir que o fallback de frames não repita scans sem necessidade.
- [x] Marcar timeout de script e impedir fallback automático de mundo; a API do Chrome não permite cancelar a injeção já aceita.

### Task 3: Dar lifecycle aos hooks de rede

**Files:**
- Modify: `tools/browser-tools.ts`
- Test: `tests/unit/run-unit-tests.ts`

- [x] Adicionar ação de desinstalação que restaure `fetch`, XHR e WebSocket originais.
- [x] Liberar automaticamente os hooks após uma leitura com entradas e expor `stop:true` para leituras vazias.

### Task 4: Alinhar gates e documentação

**Files:**
- Modify: `tests/e2e/run-e2e.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `package.json`

- [x] Atualizar o teste de tema para o default claro atual.
- [x] Documentar que `npm test` inclui E2E e separar claramente testes live opt-in.

### Task 5: Verificação final

- [x] Rodar `npm run check`.
- [x] Rodar `npm run test:unit`.
- [x] Rodar `npm run validate`.
- [x] Rodar `npm run test:e2e`.
- [x] Fazer build de produção e revisar os arquivos tocados.
