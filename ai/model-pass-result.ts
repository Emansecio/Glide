/**
 * Classifica o resultado de um passe do modelo.
 *
 * O sintoma "Model returned an empty response" dispara quando o harness recebe
 * usage (tokens out) mas nenhum conteúdo acionável. Esse predicado é o seam
 * único para decidir se o passe é vazio — usado pelo loop em background.ts e
 * pelos testes de regressão do caso OAuth/cache/reasoning-only.
 */

export type ModelPassContent = {
  text?: string | null;
  reasoningText?: string | null;
  toolCalls?: readonly unknown[] | null;
  toolResults?: readonly unknown[] | null;
};

const hasNonEmptyText = (value: unknown): boolean => String(value || '').trim().length > 0;

/**
 * True quando o passe não trouxe texto, reasoning nem ferramentas.
 * Reasoning conta: ~20 tokens de thinking sem texto era classificado como
 * vazio e virava "Erro no provedor" mesmo com a API respondendo.
 */
export function isEmptyModelPassResult(pass: ModelPassContent): boolean {
  if (hasNonEmptyText(pass.text)) return false;
  if (hasNonEmptyText(pass.reasoningText)) return false;
  if ((pass.toolCalls?.length || 0) > 0) return false;
  if ((pass.toolResults?.length || 0) > 0) return false;
  return true;
}
