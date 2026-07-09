export type ProviderUiMeta = {
  keyLabel: string;
  keyPlaceholder: string;
  keyHint: string;
  modelHint: string;
  needsKey: boolean;
  showEndpoint: boolean;
  canDetectModels: boolean;
};

export const PROVIDER_UI: Record<string, ProviderUiMeta> = {
  anthropic: {
    keyLabel: 'Token OAuth do Claude Code',
    keyPlaceholder: 'Cole seu token OAuth do Claude Code...',
    keyHint: 'Seu token OAuth obtido em ~/.claude/.credentials.json ou Keychain.',
    modelHint: 'Nome do modelo na Anthropic (ex: claude-sonnet-5, claude-opus-4-8).',
    needsKey: true,
    showEndpoint: false,
    canDetectModels: false,
  },
  codex: {
    keyLabel: 'Chave de API (OpenAI / Codex)',
    keyPlaceholder: 'sk-...',
    keyHint:
      'Use "Conectar via navegador" para gerar a chave via OAuth, cole uma chave, ou importe ~/.codex/auth.json.',
    modelHint: 'Nome do modelo (ex: gpt-5.1-codex, gpt-5.1).',
    needsKey: true,
    showEndpoint: true,
    canDetectModels: true,
  },
  opencode: {
    keyLabel: 'Chave de API do OpenCode Zen',
    keyPlaceholder: 'Cole sua chave do OpenCode Zen...',
    keyHint: 'Chave obtida em opencode.ai/zen. Endpoint padrão: https://opencode.ai/zen/v1.',
    modelHint: 'Nome do modelo no OpenCode Zen (ex: qwen3-coder, kimi-k2, grok-code-fast-1).',
    needsKey: true,
    showEndpoint: true,
    canDetectModels: true,
  },
  ollama: {
    keyLabel: 'Chave de API (opcional)',
    keyPlaceholder: 'Normalmente vazio para Ollama local',
    keyHint: 'O Ollama local não exige chave. Preencha apenas se o seu servidor exigir.',
    modelHint: 'Modelo instalado no Ollama (use "Detectar modelos" abaixo).',
    needsKey: false,
    showEndpoint: true,
    canDetectModels: true,
  },
};

export const PROVIDER_PRESET_MODELS: Record<string, string[]> = {
  anthropic: ['claude-sonnet-5', 'claude-opus-4-8'],
  codex: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1', 'gpt-5'],
  opencode: ['qwen3-coder', 'kimi-k2', 'grok-code-fast-1', 'claude-sonnet-4-5', 'gpt-5.1'],
  ollama: [],
};

export {
  PROVIDER_DEFAULT_ENDPOINTS,
  PROVIDER_DEFAULT_MODELS,
  migrateStoredProvider,
  normalizeProviderId,
  resolveProviderBaseUrl,
} from './sdk-client.js';
