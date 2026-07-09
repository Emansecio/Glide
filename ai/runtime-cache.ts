import type { Tool } from 'ai';
import type { ToolDefinition } from '../tools/tool-schema.js';
import { type SDKModelSettings, buildToolSet, resolveLanguageModel } from './sdk-client.js';

type CachedToolSet = Record<string, Tool>;

const modelCache = new Map<string, ReturnType<typeof resolveLanguageModel>>();

const hashString = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
};

export const buildModelCacheKey = (settings: SDKModelSettings) => {
  const provider = String(settings.provider || '');
  const model = String(settings.model || '');
  const endpoint = String(settings.customEndpoint || '');
  const keyHint = String(settings.apiKey || '').slice(-8);
  return `${provider}:${model}:${endpoint}:${keyHint}`;
};

export const getCachedLanguageModel = (settings: SDKModelSettings) => {
  const cacheKey = buildModelCacheKey(settings);
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;
  const model = resolveLanguageModel(settings);
  modelCache.set(cacheKey, model);
  return model;
};

export const buildToolSetCacheKey = (tools: ToolDefinition[], provider?: string) => {
  const names = tools.map((tool) => tool.name).join(',');
  return `${String(provider || 'default')}:${hashString(names)}:${tools.length}`;
};

export const getCachedToolSet = (
  tools: ToolDefinition[],
  execute: (toolName: string, args: Record<string, unknown>, options: { toolCallId: string }) => Promise<unknown>,
  provider?: string,
  getScreenshotImage?: (toolCallId: string) => string | undefined,
): CachedToolSet => buildToolSet(tools, execute, provider, getScreenshotImage);

export const invalidateRuntimeCaches = () => {
  modelCache.clear();
};
