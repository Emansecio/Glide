# Arquitetura do Glide

## Visão Geral

O Glide é uma extensão Chrome composta por três componentes principais:

1. **Sidepanel UI** - Interface do usuário
2. **Background Service Worker** - Orquestração e comunicação com LLMs
3. **Content Script** - Injeção em páginas web

## Diagrama de Componentes

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension                         │
│                                                             │
│  ┌──────────────┐         ┌──────────────────────────┐     │
│  │   Sidepanel  │◄───────►│   Background Service     │     │
│  │     UI       │  Msg    │        Worker            │     │
│  └──────────────┘         └──────────────┬───────────┘     │
│         │                                 │                 │
│         │                                 │ HTTP/WebSocket  │
│         │                                 ▼                 │
│         │                       ┌──────────────────┐       │
│         │                       │   AI Providers   │       │
│         │                       │  (OpenAI, etc.)  │       │
│         │                       └──────────────────┘       │
│         │                                 │                 │
│         │                                 │ Tool Calls      │
│         │                                 ▼                 │
│         │                       ┌──────────────────┐       │
│         │                       │   Browser APIs   │       │
│         │                       │  (tabs, etc.)    │       │
│         │                       └──────────────────┘       │
│         │                                 │                 │
│         │                                 │ DOM Access      │
│         ▼                                 ▼                 │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                  Content Script                      │  │
│  │              (Injetado nas páginas)                  │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Sidepanel UI

### Responsabilidades
- Renderização da interface
- Captura de input do usuário
- Exibição de mensagens e tool calls
- Gerenciamento de estado local

### Arquivos Principais
- `panel.html` - Estrutura HTML
- `panel-ui.ts` - Inicialização e elementos
- `panel-chat.ts` - Lógica de chat
- `panel-settings.ts` - Configurações
- `panel-streaming.ts` - Streaming de respostas

### Comunicação
```typescript
// Enviar mensagem para background
chrome.runtime.sendMessage({
  type: 'user_message',
  message: '...',
  conversationHistory: [...]
});

// Receber mensagens do background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'assistant_stream_delta') {
    // Atualizar UI
  }
});
```

## Background Service Worker

### Responsabilidades
- Processar mensagens do usuário
- Comunicar-se com LLMs
- Executar ferramentas do navegador
- Gerenciar estado da sessão

### Ciclo de Vida
1. Recebe `user_message` do sidepanel
2. Chama LLM com contexto e tools
3. Processa resposta e tool calls
4. Executa ferramentas via Chrome APIs
5. Retorna resultados para LLM ou UI

### Arquivos Principais
- `background.ts` - Service worker principal
- `browser-tools.ts` - Implementação das ferramentas

### Exemplo de Tool Execution
```typescript
async executeTool(toolName: string, args: any) {
  switch (toolName) {
    case 'navigate':
      return await chrome.tabs.update({ url: args.url });
    case 'getContent':
      return await this.executeContentScript(args);
    // ...
  }
}
```

## Content Script

### Responsabilidades
- Acesso ao DOM das páginas
- Execução de scripts na página
- Comunicação com background

### Casos de Uso
- Extrair conteúdo da página
- Simular interações do usuário
- Obter screenshots

## Fluxo de Dados

### 1. User Message
```
User -> Sidepanel -> Background -> LLM
```

### 2. Tool Call
```
LLM -> Background -> Browser API -> Content Script -> Background -> LLM
```

### 3. Final Response
```
LLM -> Background -> Sidepanel -> User
```

## Sistema de Providers

### Interface
```typescript
interface SDKModelSettings {
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint?: string;
}
```

### Implementações
- `anthropic` - Claude via @ai-sdk/anthropic
- `openai` - GPT via @ai-sdk/openai
- `ollama` - Modelos locais via OpenAI-compatible API
- `kimi` - Kimi via Anthropic-compatible API
- `custom` - Qualquer endpoint OpenAI-compatible

## Gerenciamento de Estado

### Chrome Storage
```typescript
// Configurações persistidas
chrome.storage.local.set({
  provider: 'openai',
  apiKey: '...',
  model: 'gpt-4o',
  configs: { ... },  // Perfis
  activeConfig: 'default'
});
```

### Estado em Memória
- `currentSettings` - Configurações ativas
- `currentPlan` - Plano de execução atual
- `toolCallViews` - Views de ferramentas
- `streamingState` - Estado do streaming

## Sistema de Tools

### Definição
```typescript
interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
```

### Tools Disponíveis
1. **navigate** - Navegar para URL
2. **getContent** - Obter conteúdo
3. **click** - Clicar elemento
4. **type** - Digitar texto
5. **scroll** - Rolagem
6. **pressKey** - Teclado
7. **tabs** - Gerenciar abas
8. **screenshot** - Screenshot

## Compactação de Contexto

Quando o contexto excede o limite:

1. Identifica ponto de corte
2. Resume mensagens antigas
3. Preserva mensagens recentes
4. Substitui resumo no contexto

## Segurança

### Permissões
- `sidePanel` - Acesso ao sidepanel
- `activeTab` - Acesso à aba ativa
- `scripting` - Injeção de scripts
- `tabs` - Gerenciamento de abas
- `storage` - Persistência
- `declarativeNetRequest` - Modificar headers

### Isolamento
- Service worker isolado
- Content script isolado da página
- Comunicação apenas via mensagens

## Performance

### Otimizações
- Context compaction para limitar tokens
- Streaming para respostas rápidas
- Lazy loading de componentes
- Cache de configurações

### Limites
- Max tokens por resposta: configurável
- Context limit: configurável
- Max tool calls: 48 por execução
