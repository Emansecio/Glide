import type { ModelMessage } from 'ai';
import { normalizeProviderId } from './providers.js';

/**
 * Prompt caching da Anthropic.
 *
 * O loop do agente reenvia o histórico inteiro a cada step (até 64 por passe), então
 * sem cache o prefixo estável (system + histórico + resultados de ferramenta) é
 * re-cobrado integralmente em cada chamada. Um breakpoint `ephemeral` no ÚLTIMO
 * message faz a Anthropic reaproveitar todo o prefixo anterior a ~10% do custo.
 *
 * Por que na mensagem e não no bloco `system`: uma tentativa anterior colocou o
 * breakpoint no system e o endpoint OAuth do Claude Code passou a devolver respostas
 * vazias intermitentes. O breakpoint em message é o que o próprio Claude Code usa.
 * Ainda assim tratamos isso como reversível: se um passe voltar vazio com o cache
 * ligado, `disableAnthropicPromptCache()` desliga para o resto da vida do worker e
 * o run segue sem cache em vez de falhar.
 */
const CACHE_CONTROL_EPHEMERAL = { type: 'ephemeral' as const };

/** Deep-merge anthropic.cacheControl without wiping other message-level anthropic options. */
const withCacheControl = (message: ModelMessage): ModelMessage => {
  const prev = (message.providerOptions || {}) as Record<string, unknown>;
  const prevAnthropic =
    prev.anthropic && typeof prev.anthropic === 'object' && !Array.isArray(prev.anthropic)
      ? (prev.anthropic as Record<string, unknown>)
      : {};
  return {
    ...message,
    providerOptions: {
      ...prev,
      anthropic: {
        ...prevAnthropic,
        cacheControl: CACHE_CONTROL_EPHEMERAL,
      },
    },
  } as ModelMessage;
};

let promptCacheDisabled = false;

export const isAnthropicPromptCacheEnabled = (provider?: string): boolean =>
  !promptCacheDisabled && normalizeProviderId(provider) === 'anthropic';

export const disableAnthropicPromptCache = () => {
  promptCacheDisabled = true;
};

/** Só para testes: restaura o estado inicial. */
export const resetAnthropicPromptCache = () => {
  promptCacheDisabled = false;
};

/**
 * Devolve as mensagens com um breakpoint de cache na última. Não muta a entrada:
 * o RunPassCache reutiliza o mesmo array entre passes, e marcar in-place deixaria
 * breakpoints acumulados em mensagens antigas (a Anthropic aceita no máximo 4).
 */
export function applyPromptCacheBreakpoint(messages: ModelMessage[], provider?: string): ModelMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (!isAnthropicPromptCacheEnabled(provider)) return messages;

  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!last || typeof last !== 'object') return messages;

  const next = messages.slice();
  next[lastIndex] = withCacheControl(last);
  return next;
}

/** Marca uma mensagem com breakpoint de cache sem mutar o array original. */
const markIndex = (messages: ModelMessage[], index: number): void => {
  const target = messages[index];
  if (!target || typeof target !== 'object') return;
  messages[index] = withCacheControl(target);
};

/**
 * Breakpoint rolante, aplicado a cada step de uma mesma passe.
 *
 * `applyPromptCacheBreakpoint` marca a última mensagem UMA vez, antes do
 * streamText. Só que uma passe não é uma request: o SDK roda um step por
 * chamada de ferramenta (até `maxModelSteps`), e cada step reenvia tudo. Com o
 * breakpoint parado no fim do prefixo inicial, todo resultado de ferramenta
 * produzido durante a passe fica FORA da região cacheada — e é recobrado
 * integralmente em cada step seguinte. Numa passe longa, com dumps de DOM
 * grandes, esse rabo não-cacheado vira a maior parte do input.
 *
 * Aqui usamos dois breakpoints (a Anthropic aceita até quatro):
 *
 *   - âncora: o fim do prefixo inicial. Não se move durante a passe, então
 *     garante acerto de cache em todos os steps.
 *   - rolante: a última mensagem do step atual. Grava o rabo acumulado no
 *     cache, para o próximo step lê-lo em vez de pagar de novo.
 */
export function applyStepPromptCacheBreakpoints(
  messages: ModelMessage[],
  provider: string | undefined,
  anchorIndex: number,
): ModelMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (!isAnthropicPromptCacheEnabled(provider)) return messages;

  const lastIndex = messages.length - 1;
  const anchor = Math.min(Math.max(anchorIndex, 0), lastIndex);

  const next = messages.slice();
  markIndex(next, anchor);
  // No primeiro step os dois coincidem — marcar de novo seria o mesmo objeto.
  if (lastIndex !== anchor) markIndex(next, lastIndex);
  return next;
}

/**
 * Resposta vazia do provedor — o sintoma que já apareceu com cache no bloco system.
 * Usado para desligar o cache e retentar em vez de falhar o run.
 */
export function isEmptyModelResponseError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || error || '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('model returned an empty response') ||
    message.includes('no output generated') ||
    message.includes('check the stream for errors')
  );
}
