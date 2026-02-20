# Contributing To Glide

Thanks for contributing to Glide.

## Local Setup

```bash
git clone <repo-url>
cd parchi
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
   - `npm run typecheck`
   - `npm run validate`
   - `npm run test:unit`
3. Update docs for behavior, API, or script changes.
4. Add or update tests when behavior changes.
5. Include migration notes if a workflow changed.
6. If `sidepanel/` UI files changed, run `npm run build` before handoff so `dist/` stays in sync.

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

## Branch And Commit Style

- Use descriptive branch names: `feat/...`, `fix/...`, `docs/...`
- Use clear commit messages that state impact
- Reference issues when applicable
