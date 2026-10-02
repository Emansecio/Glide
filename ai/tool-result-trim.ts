import type { ModelMessage } from 'ai';

export type TrimToolResultsOptions = {
  /** Resultados de tool mais recentes que nunca são cortados. */
  keepRecent?: number;
  /** Total de caracteres (JSON) dos resultados de tool acima do qual cortamos os mais antigos. */
  maxTotalChars?: number;
  /** Tamanho do preview mantido de cada resultado antigo cortado. */
  previewChars?: number;
  /** Ao estourar, corta até esta fração do orçamento (histerese: o prefixo muda em lotes). */
  targetFraction?: number;
};

const DEFAULT_KEEP_RECENT = 6;
const DEFAULT_MAX_TOTAL_CHARS = 400_000;
const DEFAULT_PREVIEW_CHARS = 1_500;
const DEFAULT_TARGET_FRACTION = 0.6;
/** Custo fixo de uma imagem: base64 conta como milhares de caracteres mas poucos tokens. */
const IMAGE_COST_CHARS = 1_500;
const IMAGE_PLACEHOLDER = '[image omitted]';

const serializedSize = (value: unknown): { text: string; size: number } => {
  try {
    let images = 0;
    const text =
      JSON.stringify(value, (key, item) => {
        if (key === 'data' && typeof item === 'string' && item.length > 2_000) {
          images += 1;
          return IMAGE_PLACEHOLDER;
        }
        return item;
      }) ?? '';
    return { text, size: text.length + images * IMAGE_COST_CHARS };
  } catch {
    return { text: '', size: 0 };
  }
};

type ToolResultRef = { messageIndex: number; partIndex: number; size: number; text: string; isError: boolean };

/**
 * Um passe do agente pode ter dezenas de steps, e cada resultado de tool (getContent de 50k chars,
 * screenshots em base64…) é reenviado ao modelo em TODOS os steps seguintes. A compactação só roda
 * entre passes, então 20 resultados grandes estouravam a janela no meio do passe (400 "prompt too
 * long", sem retry porque tools já executaram). Quando o total passa do orçamento, os resultados
 * mais ANTIGOS viram um preview curto; os mais recentes ficam intactos. O corte vai até uma fração
 * do orçamento (histerese) para o prefixo mudar em lotes e não invalidar o cache a cada step.
 */
export function trimOldToolResults(messages: ModelMessage[], options: TrimToolResultsOptions = {}): ModelMessage[] {
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
  const maxTotal = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const target = maxTotal * (options.targetFraction ?? DEFAULT_TARGET_FRACTION);

  const refs: ToolResultRef[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if ((part as { type?: string }).type !== 'tool-result') return;
      const output = (part as { output?: { type?: string } }).output;
      const { text, size } = serializedSize(output);
      refs.push({
        messageIndex,
        partIndex,
        size,
        text,
        isError: typeof output?.type === 'string' && output.type.startsWith('error'),
      });
    });
  });

  let total = refs.reduce((sum, ref) => sum + ref.size, 0);
  if (total <= maxTotal || refs.length <= keepRecent) return messages;

  const replacements = new Map<string, unknown>();
  for (const ref of refs.slice(0, refs.length - keepRecent)) {
    if (total <= target) break;
    if (ref.size <= previewChars * 2) continue;
    const preview = ref.text.slice(0, previewChars);
    replacements.set(`${ref.messageIndex}:${ref.partIndex}`, {
      // Preserva o sinal de erro do resultado original.
      type: ref.isError ? 'error-text' : 'text',
      value: `[Earlier tool output trimmed to save context (${ref.size} chars). Preview: ${preview}…]`,
    });
    total -= ref.size - previewChars - 100;
  }
  if (replacements.size === 0) return messages;

  return messages.map((message, messageIndex) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
    const content = message.content.map((part, partIndex) => {
      const replacement = replacements.get(`${messageIndex}:${partIndex}`);
      return replacement ? { ...part, output: replacement } : part;
    });
    return { ...message, content } as ModelMessage;
  });
}
