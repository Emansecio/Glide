import { normalizeQwenModelId } from './qwen-settings.js';
import { PROVIDER_DEFAULT_MODELS, normalizeProviderId } from './sdk-client.js';

export type ProviderUiMeta = {
  keyLabel: string;
  keyPlaceholder: string;
  keyHint: string;
  modelHint: string;
  showEndpoint: boolean;
  canDetectModels: boolean;
};

export const PROVIDER_UI: Record<string, ProviderUiMeta> = {
  anthropic: {
    keyLabel: 'Token OAuth do Claude Code',
    keyPlaceholder: 'Cole seu token OAuth do Claude Code...',
    keyHint:
      'Use "Conectar com Claude" para logar com sua assinatura (o token renova sozinho), ou cole o token de ~/.claude/.credentials.json.',
    modelHint: 'Escolha Claude Sonnet 5 ou Claude Opus 5 (Claude Code).',
    showEndpoint: false,
    canDetectModels: false,
  },
  codex: {
    keyLabel: 'Chave de API (OpenAI / Codex)',
    keyPlaceholder: 'sk-...',
    keyHint:
      'Use "Conectar via navegador" para login ChatGPT/Codex (renova sozinho), cole uma chave sk-, ou importe ~/.codex/auth.json.',
    modelHint: 'Família GPT-5.6: escolha Luna ou Terra.',
    showEndpoint: true,
    canDetectModels: true,
  },
  opencode: {
    keyLabel: 'Chave de API do OpenCode Zen',
    keyPlaceholder: 'Cole sua chave do OpenCode Zen...',
    keyHint: 'Chave obtida em opencode.ai/zen. Endpoint padrão: https://opencode.ai/zen/v1.',
    modelHint: 'Nome do modelo no OpenCode Zen (ex: qwen3-coder, kimi-k2, grok-code-fast-1).',
    showEndpoint: true,
    canDetectModels: true,
  },
  qwen: {
    keyLabel: 'Chave ModelStudio (Coding / Token Plan)',
    keyPlaceholder: 'sk-sp-…',
    keyHint:
      'Importe ~/.qwen/settings.json (botão Importar) ou cole BAILIAN_CODING_PLAN_API_KEY / BAILIAN_TOKEN_PLAN_API_KEY. OAuth gratuito do qwen.ai foi descontinuado.',
    modelHint: 'Ex.: qwen3-coder-plus, qwen3.6-plus, MiniMax-M2.5 (Coding Plan intl).',
    showEndpoint: true,
    canDetectModels: true,
  },
  xai: {
    keyLabel: 'Token Grok / API key xAI',
    keyPlaceholder: 'xai-… ou cole o access token da sessão',
    keyHint:
      'Importe ~/.grok/auth.json (sessão do Grok CLI, renova sozinha) ou cole uma API key de console.x.ai (xai-…).',
    modelHint: 'Grok 4.5 ou Composer 2.5 (alias de coding).',
    showEndpoint: true,
    canDetectModels: true,
  },
  ollama: {
    keyLabel: 'Chave de API (opcional)',
    keyPlaceholder: 'Normalmente vazio para Ollama local',
    keyHint: 'O Ollama local não exige chave. Preencha apenas se o seu servidor exigir.',
    modelHint: 'Modelo instalado no Ollama (use "Detectar modelos" abaixo).',
    showEndpoint: true,
    canDetectModels: true,
  },
  'command-code': {
    keyLabel: 'Chave de API do Command Code',
    keyPlaceholder: 'Cole sua chave do Command Code...',
    keyHint: 'A chave fica salva no slot do Command Code e usa a API oficial em api.commandcode.ai.',
    modelHint: 'Modelo padrão: Kimi K3 (moonshotai/Kimi-K3).',
    showEndpoint: false,
    canDetectModels: false,
  },
};

export const PROVIDER_PRESET_MODELS: Record<string, string[]> = {
  anthropic: ['claude-sonnet-5', 'claude-opus-5'],
  codex: ['gpt-5.6-luna', 'gpt-5.6-terra'],
  opencode: ['qwen3-coder', 'kimi-k2', 'grok-code-fast-1', 'claude-sonnet-4-5'],
  // Token Plan (default Glide): IDs reais de GET /models. Coding Plan continua
  // aceitando os ids sem sufixo via import de ~/.qwen/settings.json.
  qwen: [
    'deepseek-v4-flash-0731',
    'deepseek-v4-pro',
    'qwen3.6-flash',
    'qwen3.7-plus',
    'qwen3.7-max',
    'qwen3.8-max',
    'qwen3.8-max-preview',
    'glm-5.2',
    'qwen3-coder-plus',
    'qwen3-coder-next',
    'MiniMax-M2.5',
  ],
  xai: ['grok-4.5', 'composer-2.5'],
  'command-code': ['moonshotai/Kimi-K3'],
  ollama: [],
};

export const GPT_56_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra'] as const;

const GPT_56_MODEL_SET = new Set<string>(GPT_56_MODELS);

export function isGpt56Model(model: string): boolean {
  return GPT_56_MODEL_SET.has(
    String(model || '')
      .trim()
      .toLowerCase(),
  );
}

/**
 * Remove modelos GPT antigos das configurações persistidas. Codex fica
 * deliberadamente restrito à família GPT-5.6; OpenCode não exibe aliases GPT
 * antigos, mas continua aceitando seus modelos não-GPT.
 */
export function normalizeProviderModel(provider: string, model?: string): string {
  const normalizedProvider = normalizeProviderId(provider);
  let normalizedModel = String(model || '').trim();
  if (normalizedProvider === 'codex') {
    return isGpt56Model(normalizedModel) ? normalizedModel.toLowerCase() : 'gpt-5.6-luna';
  }
  if (normalizedProvider === 'opencode' && /^gpt-/i.test(normalizedModel)) {
    return 'qwen3-coder';
  }
  if (normalizedProvider === 'qwen') {
    // deepseek-v4-flash (sem data) → 403; id canônico é deepseek-v4-flash-0731.
    normalizedModel = normalizeQwenModelId(normalizedModel);
  }
  return normalizedModel || PROVIDER_DEFAULT_MODELS[normalizedProvider];
}

export function filterProviderModels(provider: string, models: string[]): string[] {
  const normalizedProvider = normalizeProviderId(provider);
  let unique = [
    ...new Set((Array.isArray(models) ? models : []).map((model) => String(model || '').trim()).filter(Boolean)),
  ];
  if (normalizedProvider === 'codex') {
    return [...GPT_56_MODELS];
  }
  if (normalizedProvider === 'opencode') {
    return unique.filter((model) => !/^gpt-/i.test(model));
  }
  if (normalizedProvider === 'qwen') {
    unique = unique.map((model) => normalizeQwenModelId(model));
    return [...new Set(unique)];
  }
  return unique;
}

/** Human labels for the model picker (id stays the API model string). */
export const MODEL_DISPLAY_LABELS: Record<string, string> = {
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-opus-5': 'Claude Opus 5',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'deepseek-v4-flash-0731': 'DeepSeek V4 Flash (0731)',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'qwen3.6-flash': 'Qwen 3.6 Flash',
  'qwen3.7-plus': 'Qwen 3.7 Plus',
  'qwen3.7-max': 'Qwen 3.7 Max',
  'qwen3.8-max': 'Qwen 3.8 Max',
  'qwen3.8-max-preview': 'Qwen 3.8 Max Preview',
  'glm-5.2': 'GLM 5.2',
  'qwen3-coder-plus': 'Qwen3 Coder Plus',
  'qwen3-coder-next': 'Qwen3 Coder Next',
  'MiniMax-M2.5': 'MiniMax M2.5',
  'grok-4.5': 'Grok 4.5',
  'composer-2.5': 'Composer 2.5',
  'moonshotai/Kimi-K3': 'Kimi K3',
};

export {
  PROVIDER_DEFAULT_ENDPOINTS,
  PROVIDER_DEFAULT_MODELS,
  migrateStoredProvider,
  normalizeProviderId,
  resolveProviderBaseUrl,
} from './sdk-client.js';
