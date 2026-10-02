export type TaskIntent = {
  usesBrowserAutomation: boolean;
  requiresDetailedReport: boolean;
};

/** Structural delimiters — unlikely to collide with user-authored text. */
export const INJECTED_TAB_CONTEXT_START = '<!-- glide:injected-tab-context:v1 -->';
export const INJECTED_TAB_CONTEXT_END = '<!-- /glide:injected-tab-context -->';
/** @deprecated Legacy marker kept for backward-compatible stripping only. */
const LEGACY_SELECTED_TABS_CONTEXT_MARKER = '[Contexto das abas selecionadas:]';

export function stripInjectedTabContext(text: string): string {
  if (!text || typeof text !== 'string') return text;

  const structuralStart = text.indexOf(INJECTED_TAB_CONTEXT_START);
  if (structuralStart >= 0) {
    const structuralEnd = text.indexOf(INJECTED_TAB_CONTEXT_END, structuralStart);
    if (structuralEnd >= 0) {
      return (text.slice(0, structuralStart) + text.slice(structuralEnd + INJECTED_TAB_CONTEXT_END.length)).trim();
    }
    return text.slice(0, structuralStart).trim();
  }

  const legacyIndex = text.indexOf(LEGACY_SELECTED_TABS_CONTEXT_MARKER);
  if (legacyIndex < 0) return text;
  return text.slice(0, legacyIndex).trim();
}

export function normalizeTaskIntentText(text: unknown): string {
  const withoutDiacritics = Array.from(String(text || '').normalize('NFD'))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join('');
  return withoutDiacritics.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Minimal shape of a conversation message needed to detect recent tool usage —
// kept structural (not importing Message from message-schema.ts) to avoid a
// cross-module dependency for a one-field check.
export type ToolActivityMessage = { role?: string; toolCalls?: unknown[] };

// Was a browser tool used recently? A follow-up in an ongoing browser task
// ("e aí?", "você disse que ia verificar e não voltou") rarely repeats action
// keywords itself, but must still get tool access — otherwise the agent has
// nothing to call and can only respond with text, mid-task. Bounded to a small
// trailing window so an unrelated topic change eventually drops the signal.
export function hasRecentToolActivity(history: ToolActivityMessage[] | undefined | null, windowSize = 10): boolean {
  if (!Array.isArray(history) || history.length === 0) return false;
  const recent = history.slice(-windowSize);
  return recent.some(
    (message) =>
      message?.role === 'tool' ||
      (message?.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0),
  );
}

/**
 * Small talk puro: a ÚNICA classe de mensagem que dispensa ferramentas.
 *
 * O gate antes era fail-CLOSED por palavra-chave (só liberava ferramentas com um
 * verbo/termo conhecido em PT), então pedidos legítimos ficavam sem NENHUMA
 * ferramenta e o agente respondia que não conseguia ver a página: "summarize this
 * page" (inglês não estava na lista), "compare as abas" (o plural não casava
 * `\baba\b`), "tira um print disso". Como o custo de expor o toolset sem precisar é
 * só o schema no prompt — e o custo de NÃO expor é a tarefa falhar — invertemos:
 * ferramentas ligadas por padrão, desligadas apenas em saudação/agradecimento puro.
 */
const SMALL_TALK_RE =
  /^(oi+|ola+|alo|hello|hi+|hey|yo|e ai|eai|bom dia|boa tarde|boa noite|tudo bem\??|como vai\??|obrigad[oa]+|vlw|valeu|thanks|thank you|thx|ok|okay|beleza|blz|legal|otimo|perfeito|entendi|bye|tchau|até|ate mais)[!.?\s]*$/;

const isSmallTalkOnly = (text: string): boolean => {
  if (!text) return true;
  // Uma saudação seguida de pedido real ("oi, abra o gmail") NÃO é small talk:
  // o regex é ancorado nas duas pontas, então só casa a mensagem inteira.
  if (SMALL_TALK_RE.test(text)) return true;
  // Combinações curtas de cortesia ("oi, tudo bem?", "valeu, obrigado").
  const parts = text
    .split(/[,;.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.length <= 3 && parts.every((part) => SMALL_TALK_RE.test(part));
};

export function detectTaskIntent(
  rawText: unknown,
  options: { selectedTabCount?: number; recentToolActivity?: boolean } = {},
): TaskIntent {
  const text = normalizeTaskIntentText(stripInjectedTabContext(String(rawText || '')));
  const recentToolActivity = options.recentToolActivity === true;
  const hasAttachedTabs = Number(options.selectedTabCount || 0) > 0;

  const requiresDetailedReport =
    /\b(analise|analisar|audite|auditar|revisao|relatorio|mapeie|mapear|inspecione|inspecionar|extraia|extrair|resuma|resumir|liste|listar|evidencias|workspace|cards|sidebar|navegacao|analyz|audit|report|summar|extract|inspect|list)/.test(
      text,
    );

  // Fail-open: só small talk puro (e sem tarefa em andamento) fica sem ferramentas.
  const usesBrowserAutomation = !isSmallTalkOnly(text) || recentToolActivity || hasAttachedTabs;

  return {
    usesBrowserAutomation,
    requiresDetailedReport: usesBrowserAutomation && requiresDetailedReport,
  };
}
