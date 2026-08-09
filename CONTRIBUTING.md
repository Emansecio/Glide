# Contributing To Glide

Thanks for contributing to Glide.

## Local Setup

```bash
git clone <repo-url>
cd "Glide V2"
npm install
```

Build extension:

```bash
npm run build
```

Load unpacked extension from `dist/` in `chrome://extensions/`.

## Development Commands

```bash
# Extension bundle only
npm run build

# Test bundles only
npm run build:test

# Type checks
npm run typecheck

# Validation and tests
npm run validate
npm run test
npm run test:unit
```

## Pull Request Checklist

1. Keep changes scoped and explain intent clearly.
2. Run at minimum:
   - `npm run check` (typecheck + biome — o `check` FALHA em formatação divergente;
     `npm run lint:fix` resolve)
   - `npm run validate`
   - `npm run test:unit`
3. Update docs for behavior, API, or script changes.
4. Add or update tests when behavior changes.
5. Include migration notes if a workflow changed.
6. If `sidepanel/` UI files changed, run `npm run build` before handoff so `dist/` stays in sync.
7. Mudou aparência? Confira nos dois temas — `npm run preview` e abrir
   `preview-split.html` é mais rápido que recarregar a extensão. Valor cru de cor,
   raio, sombra ou duração fora de `base.css` não passa.

## Coding Guidelines

- TypeScript first; keep public behavior explicit.
- Prefer small, focused changes.
- Avoid introducing broad abstractions unless needed.
- Keep security-sensitive paths explicit:
  - runtime message handlers
  - tool permission checks
  - URL sanitization
  - screenshot data handling

## Documentation Policy

When behavior changes, update:

- `README.md` (user/developer workflow)
- `docs/API.md` (runtime messages and tool contracts)
- `docs/ARCHITECTURE.md` (system flow)
- `CHANGELOG.md` (release notes)
- `DESIGN.md` (tokens, movimento, tipografia, mark — qualquer mudança visual)
- `AGENTS.md` (harness: scripts, gate, regras de UI, o que não reintroduzir)

Registre também **o que foi descartado e por quê**. A maior parte do valor
desses documentos está nas armadilhas já pagas — `light-dark()` que engole a
declaração inteira, `innerHTML +=` quadrático, cache de toolset que vazaria
closure entre runs. Sem esse registro, a próxima pessoa refaz o mesmo caminho.

## Branch And Commit Style

- Use descriptive branch names: `feat/...`, `fix/...`, `docs/...`
- Use clear commit messages that state impact
- Reference issues when applicable
