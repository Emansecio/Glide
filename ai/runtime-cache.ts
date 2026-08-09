import type { Tool } from 'ai';
import type { ToolDefinition } from '../tools/tool-schema.js';
import { type SDKModelSettings, buildToolSet, resolveLanguageModel } from './sdk-client.js';

type RunToolSet = Record<string, Tool>;

const MODEL_CACHE_MAX = 32;
const modelCache = new Map<string, ReturnType<typeof resolveLanguageModel>>();

function touchModelCacheEntry(cacheKey: string, model: ReturnType<typeof resolveLanguageModel>) {
  if (modelCache.has(cacheKey)) modelCache.delete(cacheKey);
  modelCache.set(cacheKey, model);
  while (modelCache.size > MODEL_CACHE_MAX) {
    const oldest = modelCache.keys().next().value;
    if (!oldest) break;
    modelCache.delete(oldest);
  }
}

export const buildModelCacheKey = (settings: SDKModelSettings) => {
  const provider = String(settings.provider || '');
  const model = String(settings.model || '');
  const endpoint = String(settings.customEndpoint || '');
  const codexMode = String(settings.codexAuthMode || '');
  // length + prefix + suffix: evita colisão de duas keys com o mesmo rabo de 8 chars.
  const key = String(settings.apiKey || '');
  const keyHint = key ? `${key.length}:${key.slice(0, 4)}:${key.slice(-8)}` : '0';
  return `${provider}:${model}:${endpoint}:${codexMode}:${keyHint}`;
};

export const getCachedLanguageModel = (settings: SDKModelSettings) => {
  const cacheKey = buildModelCacheKey(settings);
  const cached = modelCache.get(cacheKey);
  if (cached) {
    touchModelCacheEntry(cacheKey, cached);
    return cached;
  }
  const model = resolveLanguageModel(settings);
  touchModelCacheEntry(cacheKey, model);
  return model;
};

/** Test-only introspection of model cache size. */
export const getModelCacheSizeForTests = () => modelCache.size;

/**
 * Monta o toolset de UM run. Sem cache, de propósito.
 *
 * O nome anterior era `getCachedToolSet` e não cacheava nada — havia até uma
 * função de chave pronta, nunca usada. Cachear aqui seria trocar quase nada por
 * um bug: o `execute` fecha sobre estado do run corrente (o contador de
 * execuções que impede replay de efeitos colaterais num retry, o watchdog de
 * atividade, o runMeta, a aba travada). Reusar o toolset entre runs mandaria as
 * chamadas do run novo para os contadores e a aba do run anterior.
 *
 * E o que se economizaria é ruído: medido em 15 µs para as 29 ferramentas,
 * uma vez por run. `jsonSchema()` é um getter preguiçoso e `tool()` é a função
 * identidade — não há compilação de schema para reaproveitar.
 *
 * O teste "does not reuse execute closures" existe para pegar quem tentar
 * "otimizar" isto de novo.
 */
export const buildRunToolSet = (
  tools: ToolDefinition[],
  execute: (toolName: string, args: Record<string, unknown>, options: { toolCallId: string }) => Promise<unknown>,
  provider?: string,
  getScreenshotImage?: (toolCallId: string) => string | undefined,
): RunToolSet => buildToolSet(tools, execute, provider, getScreenshotImage);

export const invalidateRuntimeCaches = () => {
  modelCache.clear();
};
