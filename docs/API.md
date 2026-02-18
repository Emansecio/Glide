# API Documentation

## Chrome Runtime Messages

Comunicação entre Sidepanel e Background Service Worker.

### Mensagens do Sidepanel para Background

#### user_message
Enviar mensagem do usuário para processamento.

```typescript
{
  type: 'user_message';
  message: string;
  conversationHistory: Message[];
  selectedTabs?: chrome.tabs.Tab[];
  sessionId?: string;
}
```

**Resposta**: Nenhuma (streaming via runtime messages)

#### execute_tool
Executar ferramenta manualmente.

```typescript
{
  type: 'execute_tool';
  tool: string;
  args: Record<string, unknown>;
}
```

**Resposta**:
```typescript
{
  success: true;
  result: any;
}
```

### Mensagens do Background para Sidepanel

#### assistant_stream_start
Início do streaming de resposta.

```typescript
{
  type: 'assistant_stream_start';
}
```

#### assistant_stream_delta
Chunk do streaming.

```typescript
{
  type: 'assistant_stream_delta';
  content: string;
  channel: 'text' | 'reasoning';
}
```

#### assistant_stream_stop
Fim do streaming de resposta.

```typescript
{
  type: 'assistant_stream_stop';
}
```

#### assistant_final
Resposta final completa.

```typescript
{
  type: 'assistant_final';
  content: string;
  thinking: string | null;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  responseMessages: Message[];
}
```

#### run_error
Erro na execução.

```typescript
{
  type: 'run_error';
  message: string;
}
```

#### context_compacted
Contexto foi compactado.

```typescript
{
  type: 'context_compacted';
  summary: string;
  trimmedCount: number;
  preservedCount: number;
  newSessionId: string;
}
```

## Chrome Storage API

### Estrutura de Dados

```typescript
interface StorageSchema {
  // Configuração ativa
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  contextLimit: number;
  timeout: number;

  // Features
  enableScreenshots: boolean;
  sendScreenshotsAsImages: boolean;
  screenshotQuality: 'low' | 'medium' | 'high';
  showThinking: boolean;
  streamResponses: boolean;
  autoScroll: boolean;
  confirmActions: boolean;
  saveHistory: boolean;

  // Perfis
  configs: Record<string, ConfigProfile>;
  activeConfig: string;

  // Configurações de perfis especiais
  visionBridge: boolean;
  visionProfile: string;
  useOrchestrator: boolean;
  orchestratorProfile: string;
  auxAgentProfiles: string[];

  // Permissões
  toolPermissions: {
    read: boolean;
    interact: boolean;
    navigate: boolean;
    tabs: boolean;
    screenshots: boolean;
  };
  allowedDomains: string;
}
```

### Exemplos

```typescript
// Salvar configuração
await chrome.storage.local.set({
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-...'
});

// Ler configuração
const settings = await chrome.storage.local.get([
  'provider',
  'apiKey',
  'model'
]);

// Remover configuração
await chrome.storage.local.remove('apiKey');
```

## Browser Tools API

### Interface

```typescript
class BrowserTools {
  async navigate(args: { url: string }): Promise<{ success: boolean; url: string }>;

  async getContent(args: {
    selector?: string;
    format?: 'html' | 'text' | 'markdown'
  }): Promise<{ content: string; url: string }>;

  async click(args: {
    selector: string;
    timeout?: number;
  }): Promise<{ success: boolean }>;

  async type(args: {
    selector: string;
    text: string;
    clear?: boolean;
    submit?: boolean;
  }): Promise<{ success: boolean }>;

  async scroll(args: {
    direction: 'up' | 'down' | 'left' | 'right';
    amount?: number;
  }): Promise<{ success: boolean }>;

  async pressKey(args: {
    key: string;
    modifier?: string;
  }): Promise<{ success: boolean }>;

  async tabs(args: {
    action: 'list' | 'activate' | 'close';
    tabId?: number;
  }): Promise<{ tabs: TabInfo[] }>;

  async screenshot(args: {
    fullPage?: boolean;
    selector?: string;
  }): Promise<{ dataUrl: string }>;
}
```

## AI SDK Client

### resolveLanguageModel

Cria instância do modelo baseado nas configurações.

```typescript
import { resolveLanguageModel } from './ai/sdk-client.js';

const model = resolveLanguageModel({
  provider: 'openai',
  apiKey: 'sk-...',
  model: 'gpt-4o',
  customEndpoint: undefined
});
```

### generateText

Gera texto com o modelo.

```typescript
import { generateText } from 'ai';

const result = await generateText({
  model,
  messages: [
    { role: 'user', content: 'Olá!' }
  ],
  maxOutputTokens: 2048
});

console.log(result.text);
```

### streamText

Streaming de texto.

```typescript
import { streamText } from 'ai';

const result = streamText({
  model,
  messages: [...],
  onChunk: ({ chunk }) => {
    if (chunk.type === 'text-delta') {
      console.log(chunk.text);
    }
  }
});

for await (const text of result.textStream) {
  console.log(text);
}
```

## UI Components API

### Toast Notifications

```typescript
// Exibir toast de sucesso
this.showSuccessToast('Configurações salvas', 3000);

// Exibir erro
this.showErrorBanner('Erro ao conectar');

// Limpar banners
this.clearErrorBanner();
```

### Status Updates

```typescript
// Atualizar status
this.updateStatus('Processando...', 'active');
this.updateStatus('Concluído', 'success');
this.updateStatus('Erro', 'error');
this.updateStatus('Aviso', 'warning');

// Tipos: 'default' | 'success' | 'error' | 'warning' | 'active'
```

### Model Display

```typescript
// Atualizar display do modelo
this.updateModelDisplay();

// Buscar modelos disponíveis
await this.fetchAvailableModels();
```

Comportamento do seletor custom:
- As opções são agrupadas por família (`OpenAI`, `Anthropic`, `Google`, `Kimi`, etc.).
- Quando o provider ativo é `ollama`, todos os modelos são agrupados na família `Ollama`.

## Types

### Message

```typescript
interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | ContentPart[];
  thinking?: string | null;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  meta?: {
    kind?: 'summary';
    approxTokens?: number;
  };
}
```

### ToolCall

```typescript
interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
```

### ToolResult

```typescript
interface ToolResult {
  toolCallId: string;
  toolName: string;
  output: any;
}
```

### ConfigProfile

```typescript
interface ConfigProfile {
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  contextLimit: number;
  timeout: number;
  enableScreenshots: boolean;
  sendScreenshotsAsImages: boolean;
  screenshotQuality: string;
  showThinking: boolean;
  streamResponses: boolean;
  autoScroll: boolean;
  confirmActions: boolean;
  saveHistory: boolean;
}
```

### RunMeta

```typescript
interface RunMeta {
  runId: string;
  turnId: string;
  sessionId: string;
}
```

## Events

### UI Events

```typescript
// Chat scroll
window.addEventListener('chat-scroll', (e) => {
  console.log(e.detail.scrollTop);
});

// Model change
elements.modelSelect?.addEventListener('change', (e) => {
  console.log(e.target.value);
});
```

### Chrome Events

```typescript
// Tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    console.log('Tab loaded:', tab.url);
  }
});

// Storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  console.log('Storage changed:', changes);
});
```
