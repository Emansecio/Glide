import { normalizeProviderId } from './sdk-client.js';

const LEGACY_ANTHROPIC_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-sonnet-4-5': 'claude-sonnet-5',
  'claude-opus-4-8': 'claude-opus-5',
  'claude-opus-4-7': 'claude-opus-5',
  'claude-opus-4-6': 'claude-opus-5',
};

export function migrateAnthropicModel(model?: string): string {
  const trimmed = String(model || '').trim();
  if (!trimmed) return 'claude-sonnet-5';
  return LEGACY_ANTHROPIC_MODEL_MAP[trimmed] || trimmed;
}

/** Anthropic reasoning effort — fixed to low (no medium/high UI). */
export function buildAnthropicProviderOptions() {
  return {
    anthropic: {
      effort: 'low' as const,
    },
  };
}

export function resolveProviderOptions(provider?: string) {
  if (normalizeProviderId(provider) === 'anthropic') {
    return { providerOptions: buildAnthropicProviderOptions() };
  }
  return {};
}
