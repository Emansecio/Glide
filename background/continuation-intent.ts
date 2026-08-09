// Pure detection for the execution contract: a text-only (or post-tool narrative)
// turn must report a completed result, never promise / narrate future work.
// Kept free of `this`/Chrome APIs so the orchestration loop and unit tests share them.

const normalize = (value: unknown): string =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// Handing control back to the user — a confirmation request or a blocker report
// — is a valid stop, so it never counts as a broken promise.
export function textAwaitsUser(value: unknown): boolean {
  const text = typeof value === 'string' ? value.toLowerCase() : normalize(value);
  if (!text) return false;
  if (text.includes('?')) return true;
  const handoffMarkers = [
    'captcha',
    'login',
    'log in',
    'senha',
    'password',
    'autentic',
    'authenticat',
    'confirm',
    'confirma',
    'voce quer',
    'você quer',
    'deseja que',
    'posso prosseguir',
    'posso seguir',
    'preciso que voce',
    'preciso que você',
    'aguardo',
    'me avise',
    'let me know',
    'permiss',
  ];
  return handoffMarkers.some((marker) => text.includes(marker));
}

// Explicit future intent ("vou rolar…", "I'll scroll…").
export function textPromisesFurtherAction(value: unknown): boolean {
  const text = normalize(value);
  if (!text) return false;
  if (textAwaitsUser(text)) return false;
  // Lookbehind excludes negated futures ("não vou mais precisar…", "won't").
  const intentPatterns = [
    /(?<!n[ãa]o\s)\bvou\s+(?:agora\s+|ainda\s+)?[a-zçãõáéíóú]+/,
    /\bagora\s+vou\b/,
    /\bvamos\s+[a-zçãõáéíóú]+/,
    /\bem seguida\b/,
    /\bna sequ[eê]ncia\b/,
    /\bat[eé]\s+(?:completar|terminar|finalizar|concluir)\b/,
    /\bcontinuando\b/,
    /\bcontinuarei\b/,
    /\bcontinuar(?:ei)?\b/,
    /\bpr[oó]xim[oa]s?\s+passos?\b/,
    /\ba seguir\b/,
    /\bdepois\s+(?:disso|vou|clico|abro|rolo)\b/,
    /\bdeixa(?:r)?\s+eu\b/,
    /\bdeixe-me\b/,
    /\bpreciso\s+(?:agora\s+)?(?:clicar|abrir|rolar|extrair|navegar|coletar|buscar|encontrar)\b/,
    /\bvou\s+(?:fazer|executar|chamar)\b/,
    /\blet me\b/,
    /(?<!wo)\bi['’]?\s?(?:wi)?ll\b/,
    /\bi['’]?m going to\b/,
    /\bnext,?\s+i\b/,
    /\bproceed(?:ing)?\s+to\b/,
    /\bgoing to\s+(?:now\s+)?[a-z]+/,
    /\bi\s+will\s+(?:now\s+)?[a-z]+/,
    /\bthen\s+i(?:['’]ll|\s+will|\s+can)\b/,
  ];
  return intentPatterns.some((re) => re.test(text));
}

// Present-continuous / status narration that is not a finished result
// ("Abrindo o modal…", "Scrolling the list…", "Coletando nomes…").
export function textSignalsInProgressWork(value: unknown): boolean {
  const text = normalize(value);
  if (!text) return false;
  if (textAwaitsUser(text)) return false;
  // Strong past-result cues → not in-progress.
  if (
    /\b(?:pronto|conclu[ií]do|finalizado|lista completa|aqui est[aá]|here is|done\.|conclu[ií])\b/.test(text) &&
    !/\b(?:vou|will|abrindo|clicando|rolando|extraindo)\b/.test(text)
  ) {
    return false;
  }
  const patterns = [
    /\b(?:estou|t[oô])\s+(?:a\s+)?(?:abrir|clicar|rolar|extrair|navegar|coletar|buscar|encontrar|carregando|processando)/,
    /\b(?:abrindo|clicando|rolando|extraindo|navegando|coletando|carregando|processando|buscando|localizando)\b/,
    /\bem andamento\b/,
    /\bagora\s+(?:abro|clico|rolo|extraio|navego|busco)\b/,
    /\bworking on\b/,
    /\b(?:now\s+)?(?:opening|clicking|scrolling|extracting|navigating|collecting|loading|searching)\b/,
    /\bin progress\b/,
  ];
  return patterns.some((re) => re.test(text));
}

/** Force another model pass with tools when the text is not a finished result. */
export function shouldForceToolContinuation(value: unknown): boolean {
  return textPromisesFurtherAction(value) || textSignalsInProgressWork(value);
}
