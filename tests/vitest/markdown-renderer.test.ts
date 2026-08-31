import { describe, expect, it } from 'vitest';
import { ContextTransactionStore } from '../../background/context-transaction.js';
import { renderMarkdownToHtml } from '../../sidepanel/ui/markdown-renderer.js';
import { emitFrontierTrace } from '../evals/frontier-trace.js';

describe('renderMarkdownToHtml', () => {
  it('renders CommonMark and GFM structures', () => {
    const source = [
      '# Heading',
      '',
      '- outer',
      '  - inner',
      '- [x] shipped',
      '',
      '10. tenth',
      '',
      '> quote with `code`',
      '',
      '| a\\|b | c |',
      '| --- | --- |',
      '| x | y |',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');

    const result = renderMarkdownToHtml(source);

    expect(result.fallback).toBe(false);
    expect(result.html).toContain('<h1>Heading</h1>');
    expect(result.html).toMatch(/<ul>[\s\S]*<ul>[\s\S]*inner/);
    expect(result.html).toContain('type="checkbox"');
    expect(result.html).toContain('<ol start="10">');
    expect(result.html).toContain('<blockquote>');
    expect(result.html).toContain('<code>code</code>');
    expect(result.html).toContain('<div class="markdown-table-scroll"><table>');
    expect(result.html).toContain('a|b');
    expect(result.html).toContain('<code class="language-ts">');
  });

  it('opens safe links and images while rejecting unsafe protocols', () => {
    const result = renderMarkdownToHtml(
      '[safe](https://example.com) [mail](mailto:a@example.com) [bad](javascript:alert(1)) ![img](https://example.com/a.png) ![bad](data:text/html,x)',
    );

    expect(result.html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(result.html).toContain('href="mailto:a@example.com"');
    expect(result.html).not.toContain('href="javascript:');
    expect(result.html).toContain('<img src="https://example.com/a.png" alt="img">');
    expect(result.html).not.toContain('src="data:');
  });

  it('closes rejected links around nested inline markup', () => {
    const result = renderMarkdownToHtml('[**bad**](ftp://example.com)');

    expect(result.html).toContain('<span><strong>bad</strong></span>');
    expect(result.html).not.toContain('</a>');
  });

  it('escapes raw HTML', () => {
    const result = renderMarkdownToHtml('<script>alert(1)</script>');
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.html).not.toContain('<script>');
  });

  it('emits long-markdown eval trace from render and context commit', () => {
    const source = `# Report\n\n${'evidence '.repeat(3_000)}`;
    const rendered = renderMarkdownToHtml(source);
    const store = new ContextTransactionStore();
    const commit = store.commit({
      sessionId: 'long-markdown-session',
      runId: 'long-markdown-run',
      turnId: 'long-markdown-turn',
      sourceRevision: 0,
      messages: [{ role: 'assistant', content: source }],
      compacted: false,
      contextUsage: {},
    });
    expect(rendered.fallback).toBe(false);
    expect(rendered.html.length).toBeGreaterThan(source.length);
    const eventId = `${commit.runId}:${commit.turnId}`;
    emitFrontierTrace('long-markdown', {
      events: [{ id: eventId, kind: 'context_commit' }],
      mutations: [],
      actionAttempts: [],
      contextRevisions: [commit.revision],
      terminalReason: rendered.fallback ? 'failed' : 'completed',
      expectedTerminalReason: 'completed',
    });
  });

  it('falls back to escaped plain text for malformed runtime input', () => {
    const malformed = {
      toString: () => {
        throw new Error('malformed');
      },
    } as unknown as string;
    const result = renderMarkdownToHtml(malformed);
    expect(result.fallback).toBe(true);
    if (!result.fallback) throw new Error('expected fallback');
    expect(result.error).toContain('malformed');
    expect(result.html).toContain('<p>');
  });
});
