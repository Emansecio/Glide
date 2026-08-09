import { SidePanelUI } from './panel-ui.js';

SidePanelUI.prototype.renderMarkdown = function renderMarkdown(text: string) {
  if (!text) return '';

  const esc = (value = '') => this.escapeHtmlBasic(value);
  const escapeAttr = (value = '') => this.escapeAttribute(value);
  const hasScheme = (value = '') => /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(String(value).trim());
  const sanitizeUrl = (value = '', options: { allowMailto?: boolean } = {}) => {
    let raw = String(value || '').trim();
    if (!raw) return null;
    // www.example.com → https://www.example.com (common model output without scheme)
    if (!hasScheme(raw) && /^www\./i.test(raw)) {
      raw = `https://${raw}`;
    }
    if (!hasScheme(raw)) return null;
    try {
      const parsed = new URL(raw);
      const allowed = options.allowMailto ? ['http:', 'https:', 'mailto:'] : ['http:', 'https:'];
      if (!allowed.includes(parsed.protocol.toLowerCase())) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  };

  let working = String(text).replace(/\r\n/g, '\n');
  const codeBlocks: string[] = [];
  // Token opaco: evita colisão se o texto do usuário contiver "@@CODE_BLOCK_0@@".
  const codeBlockToken = `@@CB_${Math.random().toString(36).slice(2, 10)}_`;
  const codeBlockRegex = /```(\w+)?\n?([\s\S]*?)```/g;
  working = working.replace(codeBlockRegex, (_: string, lang = '', body = '') => {
    const placeholder = `${codeBlockToken}${codeBlocks.length}@@`;
    const languageClass = lang ? ` class="language-${escapeAttr(lang.toLowerCase())}"` : '';
    codeBlocks.push(`<pre><code${languageClass}>${esc(body)}</code></pre>`);
    return placeholder;
  });

  const applyInline = (value = '') => {
    let html = esc(value);
    // Links, images and inline code are stashed as placeholders BEFORE the
    // emphasis passes run, so `*`/`_` inside a URL (e.g. Foo_bar_baz) can no
    // longer inject <em>/<strong> into an href and break the link.
    const inlineStash: string[] = [];
    const stash = (replacement: string) => {
      const token = `@@ML${inlineStash.length}@@`;
      inlineStash.push(replacement);
      return token;
    };
    // A URL é capturada de um texto já escapado por esc(); reverter as três
    // entidades que esc() produz (& < >) antes de sanitizar, senão `?a=1&b=2`
    // chega como `?a=1&amp;b=2` e o link aponta para a URL errada.
    const decodeEscapedUrl = (value: string) =>
      value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_: string, alt: string, url: string) => {
      const safeUrl = sanitizeUrl(decodeEscapedUrl(url));
      if (!safeUrl) return alt || '';
      // `alt` já está escapado (html = esc(value)); não re-aplicar escapeAttr.
      return stash(`<img alt="${alt}" src="${escapeAttr(safeUrl)}">`);
    });
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_: string, label: string, url: string) => {
      const safeUrl = sanitizeUrl(decodeEscapedUrl(url), { allowMailto: true });
      if (!safeUrl) return label;
      return stash(`<a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    });
    // `code` já vem escapado (html = esc(value) no início); NÃO re-escapar, senão
    // `a &amp; b` viraria `a &amp;amp; b` e exibiria a entidade crua.
    html = html.replace(/`([^`]+)`/g, (_: string, code: string) => stash(`<code>${code}</code>`));
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    html = html.replace(/(?<!\*)\*(?!\s)(.+?)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/(?<!_)_(?!\s)(.+?)_(?!_)/g, '<em>$1</em>');
    html = html.replace(/@@ML(\d+)@@/g, (_, indexStr) => {
      const index = Number.parseInt(indexStr, 10);
      return inlineStash[index] ?? `@@ML${indexStr}@@`;
    });
    return html;
  };

  const lines = working.split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) {
      blocks.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      blocks.push('</ol>');
      inOl = false;
    }
  };

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${applyInline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      closeLists();
      continue;
    }

    const placeholderMatch = trimmed.match(
      new RegExp(`^${codeBlockToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)@@$`),
    );
    if (placeholderMatch) {
      flushParagraph();
      closeLists();
      blocks.push(trimmed);
      continue;
    }

    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      flushParagraph();
      closeLists();
      blocks.push('<hr>');
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      closeLists();
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${applyInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    if (/^\s*>\s*/.test(line)) {
      flushParagraph();
      closeLists();
      blocks.push(`<blockquote>${applyInline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      if (inOl) {
        blocks.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        blocks.push('<ul>');
        inUl = true;
      }
      blocks.push(`<li>${applyInline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph();
      if (inUl) {
        blocks.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        blocks.push('<ol>');
        inOl = true;
      }
      blocks.push(`<li>${applyInline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  closeLists();

  let html = blocks.join('');
  codeBlocks.forEach((block, index) => {
    const placeholder = `${codeBlockToken}${index}@@`;
    html = html.split(placeholder).join(block);
  });

  return html;
};
