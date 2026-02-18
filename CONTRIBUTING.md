# Contribuindo para o Glide

Obrigado por seu interesse em contribuir com o Glide! Este documento fornece diretrizes para contribuição.

## Código de Conduta

- Seja respeitoso e inclusivo
- Aceite críticas construtivas
- Foque no que é melhor para a comunidade

## Como Contribuir

### Reportando Bugs

1. Verifique se o bug já foi reportado nas issues
2. Se não, crie uma nova issue com:
   - Título claro e descritivo
   - Passos para reproduzir
   - Comportamento esperado vs atual
   - Screenshots (se aplicável)
   - Versão do Chrome e do Glide

### Sugerindo Funcionalidades

1. Abra uma issue com o label `enhancement`
2. Descreva a funcionalidade e seu caso de uso
3. Discuta a implementação proposta

### Pull Requests

1. Fork o repositório
2. Crie uma branch (`git checkout -b feature/nome-da-feature`)
3. Faça suas alterações
4. Execute os testes (`npm run test`)
5. Execute o lint (`npm run lint`)
6. Commit com mensagens claras
7. Push para sua branch
8. Abra um PR descrevendo as mudanças

## Desenvolvimento Local

### Setup

```bash
git clone <repo>
cd parchi
npm install
npm run build
```

### Carregando no Chrome

1. Abra `chrome://extensions/`
2. Ative "Modo desenvolvedor"
3. Clique em "Carregar sem compactação"
4. Selecione a pasta `dist/`

### Fluxo de Desenvolvimento

```bash
# Build contínuo durante desenvolvimento
npm run build

# Verificar tipos
npm run typecheck

# Lint
npm run lint

# Formatar
npm run format

# Testes
npm run test:unit
```

## Padrões de Código

### TypeScript

- Use tipagem estrita
- Evite `any`
- Documente funções públicas

### CSS

- Use variáveis CSS definidas em `base.css`
- Mantenha consistência com o tema escuro
- Prefira classes semânticas

### Commits

- Use mensagens claras em português ou inglês
- Referencie issues quando aplicável

## Estrutura de Arquivos

```
sidepanel/ui/     # UI logic (TypeScript)
sidepanel/styles/ # CSS styles
ai/               # AI SDK logic
tools/            # Browser automation tools
tests/            # Test files
```

## Testes

- Adicione testes para novas funcionalidades
- Mantenha cobertura de testes existentes
- Testes E2E usam Playwright

## Revisão de Código

Todos os PRs passam por revisão. Critérios:

- Código funciona conforme descrito
- Segue padrões do projeto
- Tem testes apropriados
- Passa em todos os checks

## Perguntas?

Abra uma issue com o label `question`.

## Agradecimentos

Todas as contribuições são valorizadas!
