export type DirectBrowserAction = {
  toolName: 'navigate';
  args: { url: string };
  finalText: string;
};

const KNOWN_TARGETS: Record<string, string> = {
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
  youtube: 'https://www.youtube.com/',
  gmail: 'https://mail.google.com/',
  google: 'https://www.google.com/',
  twitter: 'https://twitter.com/',
  x: 'https://x.com/',
  linkedin: 'https://www.linkedin.com/',
  whatsapp: 'https://web.whatsapp.com/',
  tiktok: 'https://www.tiktok.com/',
  github: 'https://github.com/',
};

function normalizeCommandText(text: unknown): string {
  return Array.from(String(text || '').normalize('NFD'))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join('')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrlCandidate(value: string): string {
  const trimmed = value.trim().replace(/[),.;!?]+$/g, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function extractUrl(text: string): string {
  const urlMatch = text.match(/https?:\/\/[^\s)]+/i);
  if (urlMatch?.[0]) return normalizeUrlCandidate(urlMatch[0]);

  const domainMatch = text.match(/\b(?:www\.)?[a-z0-9-]+\.(?:com(?:\.br)?|net|org|io|ai|dev|app|br)\b/i);
  if (domainMatch?.[0]) return normalizeUrlCandidate(domainMatch[0]);

  return '';
}

export function resolveDirectBrowserAction(text: unknown): DirectBrowserAction | null {
  const normalized = normalizeCommandText(text);
  if (!normalized) return null;

  const wantsOpen =
    /\b(abra|abrir|abre|acesse|acessa|navegue|navegar|entre|entrar|va para|ir para|open|go to|navigate)\b/.test(
      normalized,
    );
  if (!wantsOpen) return null;

  // Only fire for a SINGLE pure "open <target>" command. Anything with a second
  // clause, an interaction verb (incl. typos like "cliquye"), or a sub-page/profile
  // reference must go to the agent loop instead of a bare homepage navigate.
  const hasFollowUpAction =
    /\b(cliqu\w*|clic\w*|click\w*|toque|tap|preench\w*|digit\w*|type|escrev\w*|pesquis\w*|procur\w*|busc\w*|search|logar|login|perfil|profile|conta|account|mensage\w*|message\w*|dm|story|stories|postar|publicar|post|coment\w*|comment\w*|curtir|like|seguir|follow|config\w*|settings|feed|notific\w*|role|rolar|scroll|extrai\w*|resum\w*|list\w*|analis\w*|verific\w*|encontr\w*|selecion\w*)\b/.test(
      normalized,
    );
  const hasSecondClause = /\b(e|entao|depois|and|then)\s+\S/.test(normalized);
  if (hasFollowUpAction || hasSecondClause) return null;

  const url = extractUrl(normalized) || Object.entries(KNOWN_TARGETS).find(([name]) => normalized.includes(name))?.[1];
  if (!url) return null;

  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // keep the URL as the visible target
  }

  return {
    toolName: 'navigate',
    args: { url },
    finalText: `Abri ${host}.`,
  };
}
