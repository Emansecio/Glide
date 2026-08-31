import { DEFAULT_SYSTEM_PROMPT } from './default-prompt.js';

export type SystemPromptMode = 'default' | 'custom';

const normalizePromptIdentity = (prompt: string): string =>
  String(prompt || '')
    .replace(/\r\n/g, '\n')
    .trim();

export function resolveSystemPromptMode(storedPrompt: unknown, storedMode: unknown): SystemPromptMode {
  if (storedMode === 'default' || storedMode === 'custom') return storedMode;
  const normalized = normalizePromptIdentity(String(storedPrompt || ''));
  if (!normalized || normalized === normalizePromptIdentity(DEFAULT_SYSTEM_PROMPT)) return 'default';
  return 'custom';
}

export async function withScopedOwnership<T>(
  ownerId: string,
  getOwner: () => string | null,
  setOwner: (owner: string | null) => void,
  operation: () => Promise<T>,
): Promise<T> {
  const previousOwner = getOwner();
  setOwner(ownerId);
  try {
    return await operation();
  } finally {
    if (getOwner() === ownerId) setOwner(previousOwner);
  }
}
