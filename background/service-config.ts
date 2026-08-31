// Pure configuration, limits, shared types and provider-error humanizer for the
// background service. Extracted from background.ts so the BackgroundService class
// file stays focused on runtime orchestration. Nothing here touches `this`.

export type RunMeta = {
  runId: string;
  turnId: string;
  sessionId: string;
  resumedFromRunId?: string;
};

export type ExecutionEvent = {
  id: string;
  runId: string;
  turnId: string;
  sessionId: string;
  toolName: string;
  callId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  tabId: number | null;
  url: string;
  success: boolean;
  errorCode: string;
  errorMessage: string;
  resultPreview: string;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const MIN_REQUEST_TIMEOUT_MS = 1000;
export const MAX_REQUEST_TIMEOUT_MS = 90000;
/**
 * Teto rígido para uma única resposta do modelo em modo NÃO-streaming. Sem
 * chunks, os watchdogs de atividade seriam tocados por heartbeat indefinidamente;
 * este limite garante que uma conexão de provedor travada faça o run FALHAR em
 * vez de pendurar para sempre. Generoso o suficiente para respostas longas reais.
 */
export const NON_STREAM_MODEL_HARD_TIMEOUT_MS = 300000;
export const DEFAULT_MODEL_MAX_TOKENS = 8192;
export const MIN_MODEL_MAX_TOKENS = 256;
export const MAX_MODEL_MAX_TOKENS = 32000;
export const DEFAULT_CONTEXT_LIMIT = 200000;
export const MIN_CONTEXT_LIMIT = 16000;
export const MAX_CONTEXT_LIMIT = 1000000;
export const EXECUTION_EVENTS_KEY = 'executionEvents';
export const MAX_EXECUTION_EVENTS = 200;
export const EXECUTION_PREVIEW_LIMIT = 500;
export const EXECUTION_TEXT_LIMIT = 500;
/** Tools that capture page images and share screenshot-store / vision delivery. */
export const SCREENSHOT_TOOLS = new Set(['screenshot', 'annotatedScreenshot', 'elementScreenshot']);

export const BROWSER_ACTION_TOOLS = [
  'navigate',
  'navigateHistory',
  'click',
  'type',
  'scroll',
  'pressKey',
  'hover',
  'mouse',
  'dismissModal',
  'wait',
  'selectOption',
  'fillForm',
] as const;
/**
 * Aba de trabalho criada quando não há nenhuma aba adotável. Precisa ser uma página
 * http(s) real: `chrome.scripting` não injeta em páginas da própria extensão nem em
 * `about:blank`, então uma página "interna" deixaria a primeira inspeção do agente
 * falhar. example.com é estável, mínima e sem rastreamento.
 */
export const DEDICATED_RUN_TAB_URL = 'https://example.com';

export const ACTIVE_RUN_TIMEOUT_MS = 120000; // watchdog window: reset only after this long with zero run activity
/**
 * Teto de wall-clock enquanto há tool em voo. Sem isto, o idle watchdog
 * renovava a cada 15s só porque `activeInFlightToolCalls > 0`, e um hang de
 * chrome.* prendia o run para sempre. Cobrem executeScript (≤120s) + folga.
 */
export const MAX_IN_FLIGHT_TOOL_WALL_MS = 180000;
export const VISION_DESCRIBE_TIMEOUT_MS = 30000;
export const ORCHESTRATION_RETRY_NORMALIZE = { addIds: false, addTimestamps: false } as const;
/** Tools that mutate the page or tab set — invalidate DOM cache after them. */
export const MUTATIVE_TOOLS = new Set([
  'click',
  'mouse',
  'type',
  'pressKey',
  'scroll',
  'wait',
  'dismissModal',
  'navigate',
  'openTab',
  'closeTab',
  'focusTab',
  'switchTab',
  'groupTabs',
  // Também mutam DOM/estado da página — sem isto o cache de getContent/findElement
  // servia estrutura pré-ação por até 5s.
  'hover',
  'executeScript',
  'setInputFiles',
  'selectOption',
  'fillForm',
  'navigateHistory',
  'clipboard',
  'cdp',
]);

/** Whether a tool call should invalidate the DOM cache for getContent/findElement. */
export function shouldInvalidateDomCache(toolName: string, args?: Record<string, unknown>): boolean {
  if (MUTATIVE_TOOLS.has(toolName)) return true;
  if (toolName === 'getNetworkRequests') {
    return args?.stop === true || args?.clear === true;
  }
  return false;
}

/** Cap de saída da sumarização de compaction (reserveTokens é orçamento de INPUT). */
export const COMPACTION_MAX_OUTPUT_TOKENS = 4096;
// Tab-management tools operate on the session tab set (BrowserTools enforces
// session membership for close/focus/switch), so they are NOT pinned to a single
// tab. This lets the agent open new tabs from the current one and act on them.
export const TAB_MANAGEMENT_TOOLS = new Set([
  'openTab',
  'closeTab',
  'focusTab',
  'switchTab',
  'groupTabs',
  'getTabs',
  'describeSessionTabs',
]);
/**
 * Tools exposed to the model during a dedicated locked-tab automation run.
 * Must stay aligned with the system prompt (network capture, page diagnostics,
 * executeScript). Omitting a tool here removes it from the function schema even
 * if it exists in tool-definitions — which previously made the agent claim it
 * had "no network access" while the prompt insisted otherwise.
 */
export const LOCKED_TAB_ALLOWED_BROWSER_TOOLS = new Set([
  'navigate',
  'openTab',
  'closeTab',
  'focusTab',
  'switchTab',
  'groupTabs',
  'getTabs',
  'describeSessionTabs',
  'click',
  'hover',
  'mouse',
  'type',
  'pressKey',
  'scroll',
  'getContent',
  'screenshot',
  'annotatedScreenshot',
  'elementScreenshot',
  'findElement',
  'wait',
  'dismissModal',
  // Page diagnostics / API discovery (still gateable via toolPermissions)
  'getNetworkRequests',
  'getConsoleOutput',
  'getStorageData',
  'getPerformanceMetrics',
  'executeScript',
  'httpRequest',
  'readPage',
  'clipboard',
  'setInputFiles',
  'selectOption',
  'fillForm',
  'navigateHistory',
  'highlightElement',
  'captureDownload',
  'findInPage',
  'extractTable',
  'harvestScroll',
  // CDP only present in schema when toolPermissions.debugger === true
  'cdp',
]);

export type FailureClass = 'selector' | 'timing' | 'permission' | 'navigation' | 'unknown';
export type RecoveryStage = 'none' | 'structure' | 'retry' | 'screenshot' | 'vision';
export type EvidenceConfidence = 'low' | 'medium' | 'high';
export type QualityMode = 'speed' | 'balanced' | 'max';

export type EvidenceEntry = {
  key: string;
  section:
    | 'sidebar'
    | 'workspace'
    | 'cards'
    | 'tables'
    | 'actions'
    | 'filters'
    | 'tabs'
    | 'badges'
    | 'kpis'
    | 'visual'
    | 'content'
    | 'unknown';
  source: string;
  mode?: string;
  text: string;
  url?: string;
  title?: string;
  timestamp: number;
};

export const resolveTimeoutMs = (value: unknown, fallback = DEFAULT_REQUEST_TIMEOUT_MS) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.floor(parsed)));
};

export const isAbortError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError';
};

export const isNoOutputGeneratedError = (error: unknown) => {
  const message = String((error as { message?: string })?.message || error || '').toLowerCase();
  if (!message) return false;
  return message.includes('no output generated') || message.includes('check the stream for errors');
};

// True for the sentinel errors that unwind the orchestration loop after a
// DELIBERATE stop (idle watchdog, or the user closing the run's locked tab) —
// the initiator already sent a specific, user-facing run_error before aborting.
// Framing these through humanizeProviderError would duplicate that message with
// a confusing "Erro no provedor: Run aborted." toast on top of the real reason.
export const isDeliberateRunStop = (error: unknown) => {
  const message = String((error as { message?: string })?.message || error || '');
  if (!message) return false;
  return message.startsWith('Run aborted.') || message.startsWith('Run superseded:');
};

export function humanizeProviderError(error: unknown, provider: string): string {
  const raw = String((error as any)?.message || error || 'Unknown error').trim();
  const lower = raw.toLowerCase();
  const prov = (provider || 'ollama').toLowerCase();

  if (lower.includes('cors')) {
    if (lower.includes('dangerous-direct-browser-access')) {
      return 'Erro da Anthropic: requisição ainda classificada como browser/CORS. Recarregue a extensão em chrome://extensions e tente novamente.';
    }
    if (prov === 'anthropic' || prov === 'claude') {
      if (lower.includes('not allowed')) {
        return 'Erro da Anthropic: CORS bloqueado pela configuração da organização. Contate o admin da org ou use outro provedor.';
      }
      return 'Erro da Anthropic: requisição classificada como browser/CORS. Recarregue a extensão e tente novamente.';
    }
    return `Erro de CORS no provedor ${prov}. Detecção de modelos e chamadas devem passar pelo service worker da extensão.`;
  }

  if (
    lower.includes('fetch failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('econnrefused') ||
    lower.includes('connect')
  ) {
    if (prov === 'ollama') {
      return 'Não foi possível conectar ao Ollama em http://localhost:11434. Verifique se o Ollama está rodando e se OLLAMA_ORIGINS=chrome-extension://* está definido no ambiente.';
    }
    if (prov === 'opencode') {
      return 'Falha de rede ao contatar OpenCode Zen. Verifique a chave de API, o endpoint https://opencode.ai/zen/v1 e sua conexão.';
    }
    if (prov === 'qwen' || prov === 'qwencloud' || prov === 'bailian' || prov === 'dashscope') {
      return 'Falha de rede ao contatar o Qwen/ModelStudio. Verifique o endpoint (coding-intl.dashscope… ou token-plan…) e a chave sk-sp-…';
    }
    if (prov === 'xai' || prov === 'grok') {
      return 'Falha de rede ao contatar a xAI (api.x.ai). Verifique a conexão e a credencial (sessão Grok ou API key xai-…).';
    }
    return `Falha de rede ao contatar ${prov}. Verifique a URL/endpoint, a chave de API e sua conexão.`;
  }

  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    (lower.includes('invalid') && lower.includes('key')) ||
    // Anthropic devolve "Invalid bearer token" (sem "401"/"key") quando o token
    // OAuth expirou, foi revogado ou o bundle de refresh foi perdido. Sem este
    // ramo o texto cru vazava como "Erro no provedor" genérico.
    (lower.includes('invalid') && (lower.includes('bearer') || lower.includes('token')))
  ) {
    if (prov === 'anthropic' || prov === 'claude') {
      return 'Sessão do Claude inválida ou expirada. Reconecte em Configurações → "Conectar com Claude" (e evite editar o campo do token manualmente).';
    }
    if (prov === 'qwen' || prov === 'qwencloud' || prov === 'bailian' || prov === 'dashscope') {
      return 'Chave do Qwen/ModelStudio inválida ou expirada. No Qwen Code use /auth → Alibaba ModelStudio e gere uma chave sk-sp-… nova; depois importe ~/.qwen/settings.json no Glide.';
    }
    if (prov === 'xai' || prov === 'grok') {
      return 'Sessão Grok/xAI inválida ou expirada. Importe de novo ~/.grok/auth.json (rode `grok login` se preciso) ou cole uma API key de console.x.ai.';
    }
    return `Credencial inválida ou expirada para ${prov}. Verifique a API key nas configurações.`;
  }

  if (
    lower.includes('403') ||
    lower.includes('forbidden') ||
    lower.includes('accessdenied') ||
    lower.includes('unpurchased')
  ) {
    if (prov === 'qwen' || prov === 'qwencloud' || prov === 'bailian') {
      return 'Acesso negado a este modelo no Qwen/ModelStudio (plano sem elegibilidade ou modelo não comprado). Troque o modelo ou o plano (Coding vs Token) em Configurações.';
    }
    return `Acesso negado (403) no ${prov}. A chave pode não ter permissão, ou a organização bloqueia o acesso.`;
  }

  if (lower.includes('404') || lower.includes('not found') || lower.includes('model_not_found')) {
    return `O modelo configurado não existe neste provedor (${prov}). Escolha outro modelo em Configurações.`;
  }

  // Limite de uso: o erro mais comum no Claude Code OAuth e no Codex. Sem este ramo
  // o usuário recebia o texto cru do provedor e nenhuma orientação.
  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes('quota')
  ) {
    if (prov === 'qwen' || prov === 'qwencloud' || prov === 'bailian') {
      const resetMatch = raw.match(/reset at ([0-9-:\s]+UTC)/i);
      const resetHint = resetMatch ? ` Cota renova em ${resetMatch[1].trim()}.` : '';
      return `Cota do Qwen/ModelStudio esgotada (janela de 5h do Token Plan ou limite do Coding Plan).${resetHint} Aguarde o reset ou troque de plano/modelo.`;
    }
    if (lower.includes('credit') || lower.includes('billing') || lower.includes('insufficient')) {
      return `Créditos/cota esgotados no ${prov}. Verifique o plano ou a cobrança da conta antes de tentar de novo.`;
    }
    if (prov === 'anthropic' || prov === 'claude') {
      return 'Limite de uso do Claude atingido. Aguarde alguns minutos (ou troque de modelo/provedor) e tente novamente.';
    }
    return `Limite de requisições atingido no ${prov}. Aguarde alguns minutos e tente novamente.`;
  }

  // Sobrecarga temporária / instabilidade do provedor — não é culpa da configuração.
  if (
    lower.includes('overloaded') ||
    lower.includes('529') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('504') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway') ||
    lower.includes('gateway timeout')
  ) {
    return `O ${prov} está sobrecarregado ou instável agora. Já repetimos automaticamente; tente novamente em instantes.`;
  }

  if (lower.includes('500') || lower.includes('internal server error')) {
    return `O ${prov} respondeu com erro interno. Tente novamente; se persistir, troque de modelo.`;
  }

  if (
    lower.includes('context') &&
    (lower.includes('too long') || lower.includes('exceed') || lower.includes('limit'))
  ) {
    return `A conversa excedeu o limite de contexto do modelo (${prov}). Inicie uma nova conversa ou reduza os anexos.`;
  }

  // Surface the original but keep it short for banner
  const short = raw.length > 180 ? raw.slice(0, 177) + '...' : raw;
  return `Erro no provedor (${prov}): ${short}`;
}

export const GENERIC_TOOL_COMPLETION_TEXT = 'Task completed. See tool results above for details.';

export const mapScreenshotQuality = (value: unknown) => {
  const normalized = String(value || 'high').toLowerCase();
  if (normalized === 'low') return 50;
  if (normalized === 'medium') return 70;
  return 90;
};
