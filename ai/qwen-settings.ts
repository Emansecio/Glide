/**
 * Qwen Code / Alibaba ModelStudio (ex-“Qwen Cloud”) settings.
 *
 * Fonte canônica no disco: `~/.qwen/settings.json` (Qwen Code CLI).
 * OAuth gratuito do qwen.ai foi descontinuado em 2026-04-15; o fluxo atual é
 * OpenAI-compatible com chave `sk-sp-…` (Coding Plan ou Token Plan).
 */

export const QWEN_CODING_PLAN_BASE_URL_INTL = 'https://coding-intl.dashscope.aliyuncs.com/v1';
export const QWEN_TOKEN_PLAN_BASE_URL = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

/** Default Glide: Coding Plan internacional (o que o CLI do usuário usa). */
export const QWEN_DEFAULT_BASE_URL = QWEN_CODING_PLAN_BASE_URL_INTL;

export const QWEN_CODING_PLAN_ENV_KEY = 'BAILIAN_CODING_PLAN_API_KEY';
export const QWEN_TOKEN_PLAN_ENV_KEY = 'BAILIAN_TOKEN_PLAN_API_KEY';

/**
 * IDs canônicos do Coding Plan (intl).
 * Fonte: ~/.qwen/settings.json + respostas reais da API.
 */
export const QWEN_CODING_PLAN_MODELS = [
  'qwen3-coder-plus',
  'qwen3-coder-next',
  'qwen3.5-plus',
  'qwen3.6-plus',
  'qwen3.7-plus',
  'qwen3-max-2026-01-23',
  'MiniMax-M2.5',
  'kimi-k2.5',
  'glm-5',
  'glm-4.7',
] as const;

/**
 * IDs canônicos do Token Plan (lista real de GET /models).
 * Atenção: `deepseek-v4-flash` SEM sufixo devolve 403 AccessDenied;
 * o ID elegível é `deepseek-v4-flash-0731`.
 */
export const QWEN_TOKEN_PLAN_MODELS = [
  'deepseek-v4-flash-0731',
  'deepseek-v4-pro',
  'qwen3.6-flash',
  'qwen3.7-plus',
  'qwen3.7-max',
  'qwen3.8-max',
  'qwen3.8-max-preview',
  'glm-5.2',
] as const;

/** Aliases legados / nomes de display → id aceito pela API. */
export const QWEN_MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-v4-flash-0731',
  'DeepSeek-V4-Flash': 'deepseek-v4-flash-0731',
  'DeepSeek-V4-Flash-0731': 'deepseek-v4-flash-0731',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'DeepSeek-V4-Pro': 'deepseek-v4-pro',
};

/** Normaliza id de modelo Qwen (aliases de versão etc.). */
export function normalizeQwenModelId(model?: string): string {
  const raw = String(model || '').trim();
  if (!raw) return 'deepseek-v4-flash-0731';
  if (QWEN_MODEL_ALIASES[raw]) return QWEN_MODEL_ALIASES[raw];
  const lower = raw.toLowerCase();
  for (const [from, to] of Object.entries(QWEN_MODEL_ALIASES)) {
    if (from.toLowerCase() === lower) return to;
  }
  return raw;
}

export type QwenPlan = 'coding-plan' | 'token-plan' | 'unknown';

export type QwenImportResult = {
  apiKey: string;
  baseUrl: string;
  model: string;
  plan: QwenPlan;
  models: string[];
  /** Outras chaves encontradas (ex.: o outro plano) — para UI/debug, sem gravar sozinhas. */
  alternateKeys: Array<{ plan: QwenPlan; apiKey: string; baseUrl: string }>;
  source: 'qwen-settings' | 'flat-credentials';
};

const looksLikeBailianKey = (value: string) => {
  const t = value.trim();
  return t.startsWith('sk-sp-') || t.startsWith('sk-') || t.length >= 20;
};

export function detectQwenPlanFromBaseUrl(baseUrl: string): QwenPlan {
  const u = String(baseUrl || '').toLowerCase();
  if (u.includes('token-plan') || u.includes('compatible-mode')) return 'token-plan';
  if (u.includes('coding') || u.includes('dashscope')) return 'coding-plan';
  return 'unknown';
}

export function defaultBaseUrlForPlan(plan: QwenPlan): string {
  if (plan === 'token-plan') return QWEN_TOKEN_PLAN_BASE_URL;
  return QWEN_CODING_PLAN_BASE_URL_INTL;
}

function collectOpenAiModels(json: Record<string, unknown>): string[] {
  const providers = json.modelProviders as Record<string, unknown> | undefined;
  const list = providers?.openai;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String((entry as { id?: string }).id || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Extrai credencial + endpoint + modelo de um JSON de credenciais Qwen.
 * Aceita:
 * - `~/.qwen/settings.json` completo (env + model + modelProviders)
 * - blob plano `{ apiKey, baseUrl, model }`
 * - env-only `{ BAILIAN_CODING_PLAN_API_KEY, OPENAI_BASE_URL, ... }`
 */
export function parseQwenSettings(raw: unknown): QwenImportResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const json = raw as Record<string, unknown>;

  // --- settings.json do Qwen Code ---
  const env =
    json.env && typeof json.env === 'object' && !Array.isArray(json.env) ? (json.env as Record<string, unknown>) : {};
  const codingKey = String(env[QWEN_CODING_PLAN_ENV_KEY] || json[QWEN_CODING_PLAN_ENV_KEY] || '').trim();
  const tokenKey = String(env[QWEN_TOKEN_PLAN_ENV_KEY] || json[QWEN_TOKEN_PLAN_ENV_KEY] || '').trim();

  const modelBlock =
    json.model && typeof json.model === 'object' && !Array.isArray(json.model)
      ? (json.model as Record<string, unknown>)
      : {};
  const preferredModel = normalizeQwenModelId(
    String(modelBlock.name || json.modelName || json.OPENAI_MODEL || json.model || '').trim(),
  );
  const preferredBase = String(
    modelBlock.baseUrl || json.baseUrl || json.OPENAI_BASE_URL || json.customEndpoint || '',
  ).trim();

  const providerMeta =
    json.providerMetadata && typeof json.providerMetadata === 'object'
      ? (json.providerMetadata as Record<string, any>)
      : {};
  const codingMetaBase = String(providerMeta['coding-plan']?.baseUrl || '').trim();
  const tokenMetaBase = String(providerMeta['token-plan']?.baseUrl || '').trim();

  const alternateKeys: QwenImportResult['alternateKeys'] = [];
  if (codingKey && looksLikeBailianKey(codingKey)) {
    alternateKeys.push({
      plan: 'coding-plan',
      apiKey: codingKey,
      baseUrl: codingMetaBase || QWEN_CODING_PLAN_BASE_URL_INTL,
    });
  }
  if (tokenKey && looksLikeBailianKey(tokenKey)) {
    alternateKeys.push({
      plan: 'token-plan',
      apiKey: tokenKey,
      baseUrl: tokenMetaBase || QWEN_TOKEN_PLAN_BASE_URL,
    });
  }

  // Preferência: baseUrl do model ativo → plano correspondente → coding → token → flat.
  let plan: QwenPlan = preferredBase ? detectQwenPlanFromBaseUrl(preferredBase) : 'unknown';
  let apiKey = '';
  let baseUrl = preferredBase;

  if (plan === 'coding-plan' && codingKey) {
    apiKey = codingKey;
    baseUrl = preferredBase || codingMetaBase || QWEN_CODING_PLAN_BASE_URL_INTL;
  } else if (plan === 'token-plan' && tokenKey) {
    apiKey = tokenKey;
    baseUrl = preferredBase || tokenMetaBase || QWEN_TOKEN_PLAN_BASE_URL;
  } else if (codingKey) {
    plan = 'coding-plan';
    apiKey = codingKey;
    baseUrl = preferredBase || codingMetaBase || QWEN_CODING_PLAN_BASE_URL_INTL;
  } else if (tokenKey) {
    plan = 'token-plan';
    apiKey = tokenKey;
    baseUrl = preferredBase || tokenMetaBase || QWEN_TOKEN_PLAN_BASE_URL;
  }

  // Flat / OpenAI-style fallback
  if (!apiKey) {
    const flat = String(json.apiKey || json.OPENAI_API_KEY || json.DASHSCOPE_API_KEY || json.accessToken || '').trim();
    if (flat && looksLikeBailianKey(flat)) {
      apiKey = flat;
      baseUrl = preferredBase || QWEN_DEFAULT_BASE_URL;
      plan = detectQwenPlanFromBaseUrl(baseUrl);
    }
  }

  if (!apiKey) return null;

  const modelsFromFile = collectOpenAiModels(json).map(normalizeQwenModelId);
  const planModels = plan === 'token-plan' ? [...QWEN_TOKEN_PLAN_MODELS] : [...QWEN_CODING_PLAN_MODELS];
  const models = [...new Set([...(preferredModel ? [preferredModel] : []), ...modelsFromFile, ...planModels])];

  const model =
    preferredModel ||
    (plan === 'token-plan' ? 'deepseek-v4-flash-0731' : 'qwen3-coder-plus') ||
    models[0] ||
    'qwen3-coder-plus';

  const source: QwenImportResult['source'] =
    codingKey || tokenKey || json.modelProviders || json.providerMetadata ? 'qwen-settings' : 'flat-credentials';

  return {
    apiKey,
    baseUrl: baseUrl || defaultBaseUrlForPlan(plan),
    model,
    plan,
    models,
    alternateKeys: alternateKeys.filter((a) => a.apiKey !== apiKey),
    source,
  };
}

export type QwenAuthProbeResult = {
  ok: boolean;
  status: number;
  /** Auth aceita (inclui 429 cota / 403 modelo sem compra) — só 401 = chave morta. */
  authAccepted: boolean;
  detail: string;
};

/**
 * Probe leve: POST mínimo em /chat/completions.
 * 401 → chave inválida; 429/403 com body de cota/modelo → chave OK.
 */
export async function probeQwenAuth(
  apiKey: string,
  baseUrl: string,
  model = 'qwen3-coder-plus',
  fetchImpl: typeof fetch = fetch,
): Promise<QwenAuthProbeResult> {
  const base = String(baseUrl || QWEN_DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const detail = (await res.text().catch(() => '')).slice(0, 240);
    const authAccepted = res.status !== 401;
    return {
      ok: res.ok,
      status: res.status,
      authAccepted,
      detail,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      authAccepted: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Dado um parse de settings, tenta a credencial preferida e, se 401, o alternate
 * (Coding ↔ Token Plan). Assim o import do ~/.qwen não grava uma chave morta
 * quando o outro plano ainda autentica.
 */
export async function resolveWorkingQwenImport(
  parsed: QwenImportResult,
  fetchImpl: typeof fetch = fetch,
): Promise<QwenImportResult & { probeStatus: number; switchedFrom?: QwenPlan }> {
  const primaryProbe = await probeQwenAuth(parsed.apiKey, parsed.baseUrl, parsed.model, fetchImpl);
  if (primaryProbe.authAccepted) {
    return { ...parsed, probeStatus: primaryProbe.status };
  }

  for (const alt of parsed.alternateKeys) {
    const altModel =
      alt.plan === 'token-plan'
        ? 'deepseek-v4-flash-0731'
        : alt.plan === 'coding-plan'
          ? 'qwen3-coder-plus'
          : normalizeQwenModelId(parsed.model);
    const altProbe = await probeQwenAuth(alt.apiKey, alt.baseUrl, altModel, fetchImpl);
    if (altProbe.authAccepted) {
      return {
        ...parsed,
        apiKey: alt.apiKey,
        baseUrl: alt.baseUrl,
        plan: alt.plan,
        model: altModel,
        probeStatus: altProbe.status,
        switchedFrom: parsed.plan,
        alternateKeys: [
          { plan: parsed.plan, apiKey: parsed.apiKey, baseUrl: parsed.baseUrl },
          ...parsed.alternateKeys.filter((a) => a.apiKey !== alt.apiKey),
        ],
      };
    }
  }

  return { ...parsed, probeStatus: primaryProbe.status };
}
