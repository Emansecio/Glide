export const SETTINGS_STORAGE_KEYS = [
  'provider',
  'apiKey',
  'model',
  'customEndpoint',
  'systemPrompt',
  'systemPromptMode',
] as const;

/**
 * Credenciais são guardadas POR PROVEDOR (`apiKey_anthropic`, `apiKey_codex`, …)
 * além do slot ativo `apiKey`.
 *
 * Antes existia só o slot global: trocar de provedor no formulário persistia a chave
 * do provedor ANTERIOR sob o novo (o campo mantinha o valor antigo), então um token
 * OAuth do Claude podia ser enviado ao endpoint da OpenAI — 401 e vazamento de
 * credencial entre provedores. Com um slot por provedor, cada credencial sobrevive à
 * troca e nunca é usada com o provedor errado.
 *
 * `apiKey` continua sendo a fonte que o runtime lê (compatibilidade com o bundle
 * OAuth, o SDK e as configurações já salvas); os slots por provedor são o arquivo de
 * onde ele é reidratado.
 */
export const PROVIDER_KEY_IDS = ['anthropic', 'codex', 'opencode', 'qwen', 'xai', 'ollama', 'command-code'] as const;

export const providerApiKeyField = (provider: string): string => `apiKey_${provider}`;

export const PROVIDER_API_KEY_FIELDS = PROVIDER_KEY_IDS.map(providerApiKeyField);

export const SETTINGS_LOAD_KEYS = [...SETTINGS_STORAGE_KEYS, ...PROVIDER_API_KEY_FIELDS] as const;

/**
 * Mapa provedor→chave a partir do storage cru, semeando o provedor ativo com o
 * `apiKey` legado quando o slot dele ainda não existe (migração silenciosa de quem
 * já tinha credencial salva).
 */
export const readProviderKeyMap = (raw: Record<string, unknown>, activeProvider: string): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const provider of PROVIDER_KEY_IDS) {
    const stored = raw?.[providerApiKeyField(provider)];
    map[provider] = typeof stored === 'string' ? stored : '';
  }
  const legacy = typeof raw?.apiKey === 'string' ? raw.apiKey : '';
  if (legacy && activeProvider && !map[activeProvider]) {
    map[activeProvider] = legacy;
  }
  return map;
};

/** Chave efetiva de um provedor: o slot dele, com fallback para o valor informado. */
export const resolveProviderApiKey = (
  keyMap: Record<string, string> | null | undefined,
  provider: string,
  fallback = '',
): string => {
  const stored = keyMap?.[provider];
  if (typeof stored === 'string' && stored.trim()) return stored;
  return fallback;
};

export async function readSettings(keys: readonly string[] = SETTINGS_LOAD_KEYS) {
  return chrome.storage.local.get([...keys]);
}

export async function writeSettings(payload: Record<string, unknown>) {
  await chrome.storage.local.set(payload);
}
