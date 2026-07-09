export type TaskIntent = {
  usesBrowserAutomation: boolean;
  requiresDetailedReport: boolean;
};

const SELECTED_TABS_CONTEXT_MARKER = '[Contexto das abas selecionadas:]';

export function stripInjectedTabContext(text: string): string {
  const markerIndex = text.indexOf(SELECTED_TABS_CONTEXT_MARKER);
  if (markerIndex < 0) return text;
  return text.slice(0, markerIndex).trim();
}

function normalizeIntentText(text: unknown): string {
  const withoutDiacritics = Array.from(String(text || '').normalize('NFD'))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join('');
  return withoutDiacritics.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function detectTaskIntent(rawText: unknown, options: { selectedTabCount?: number } = {}): TaskIntent {
  const text = normalizeIntentText(stripInjectedTabContext(String(rawText || '')));
  const selectedTabCount = Math.max(0, Number(options.selectedTabCount || 0));

  const greetingOnly =
    /^(oi|ola|hello|hi|hey|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|thanks|thank you)[!. ]*$/.test(text);

  const hasUrlOrDomain =
    /\bhttps?:\/\//.test(text) || /\b(?:www\.)?[a-z0-9-]+\.(?:com|com\.br|net|org|io|ai|dev|app|br)\b/.test(text);

  const hasBrowserCommand =
    /\b(abra|abrir|abre|acesse|acessa|navegue|navegar|entre|entrar|va para|ir para|go to|open|navigate|pesquise|pesquisar|procure|procurar|busque|buscar|clique|clicar|click|preencha|preencher|digite|digitar|type|role|rolar|scroll|login|logar)\b/.test(
      text,
    );

  const mentionsKnownWebTarget =
    /\b(instagram|facebook|youtube|gmail|google|twitter|x\.com|linkedin|whatsapp|tiktok|github|site|pagina|aba|browser|navegador)\b/.test(
      text,
    );

  const asksAboutPage =
    selectedTabCount > 0 &&
    /\b(esta pagina|essa pagina|nesta pagina|nessa pagina|site|aba|conteudo|tela|workspace|resuma|analise|verifique|extraia|liste|encontre)\b/.test(
      text,
    );

  const requiresDetailedReport =
    /\b(analise|analisar|audite|auditar|revisao|relatorio|mapeie|mapear|inspecione|inspecionar|extraia|extrair|resuma|resumir|liste|listar|evidencias|workspace|cards|sidebar|navegacao)\b/.test(
      text,
    );

  const usesBrowserAutomation =
    !greetingOnly &&
    (hasUrlOrDomain || hasBrowserCommand || asksAboutPage || (mentionsKnownWebTarget && hasBrowserCommand));

  return {
    usesBrowserAutomation,
    requiresDetailedReport: usesBrowserAutomation && requiresDetailedReport,
  };
}
