# Changelog

Todas as mudanças notáveis neste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Semantic Versioning](https://semver.org/lang/pt-BR/spec/v2.0.0.html).

## [0.2.0] - 2026-02-18

### Adicionado
- Suporte completo ao provider Ollama com detecção automática de modelos
- Sistema de toast notifications para feedback visual
- Provider Kimi para programação
- Perfis múltiplos com roles (Principal, Visão, Orquestrador, Auxiliar)
- Compactação de contexto automática
- Painel de plano com checklist visual
- Sistema de atividades com log de ferramentas

### Corrigido
- Detecção automática de modelos Ollama via endpoint `/api/tags`
- Validação de API key não obrigatória para Ollama
- Layout do plan drawer alinhado com composer
- Truncamento de texto na barra de ferramentas
- Limpeza de campos ao trocar de provider

### Modificado
- Redesign completo da interface do sidepanel
- Melhorias no sistema de streaming de respostas
- Otimização de performance com context compaction
- Atualização do Vercel AI SDK para v6

## [0.1.0] - 2026-01-21

### Adicionado
- Lançamento inicial do Glide
- Interface de chat com streaming
- Suporte a OpenAI e Anthropic
- Ferramentas de automação básicas (navigate, click, type, scroll)
- Sistema de histórico de conversas
- Configurações de provider
- Testes unitários (31/31 passando)

---

## Tipos de Mudanças

- `Adicionado` para novas funcionalidades.
- `Modificado` para mudanças em funcionalidades existentes.
- `Descontinuado` para funcionalidades que serão removidas.
- `Removido` para funcionalidades removidas.
- `Corrigido` para correções de bugs.
- `Segurança` para vulnerabilidades.
