import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  digestMarkdownSource,
  findMarkdownCommitBoundary,
  findStreamingTable,
} from '../../sidepanel/ui/markdown-render-defer.js';
import '../../sidepanel/ui/panel-streaming.js';
import { SidePanelUI } from '../../sidepanel/ui/panel-ui.js';

function harness() {
  const dom = new JSDOM('<main><div id="target"></div></main>');
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  const target = dom.window.document.querySelector('#target') as HTMLElement;
  const ui: any = {
    pendingMarkdownIdleHandle: null,
    pendingMarkdownRender: null,
    markdownRenderToken: 0,
    renderMarkdown: vi.fn((value: string) => `<p>${value}</p>`),
    shouldAutoScroll: () => false,
    isNearBottom: false,
    scrollToBottom: vi.fn(),
  };
  for (const name of [
    'cancelPendingMarkdownRender',
    'hasPendingMarkdownRender',
    'scheduleDeferredMarkdownRender',
    'reconcileTerminalMarkdownRender',
  ]) {
    ui[name] = (SidePanelUI.prototype as any)[name];
  }
  return { ui, target };
}

describe('terminal deferred Markdown reconciliation', () => {
  beforeEach(() => vi.useFakeTimers());

  it('keeps one pending parse for equivalent final content and finalizes metadata', () => {
    const { ui, target } = harness();
    const finalized = vi.fn();
    const source = `# report\n${'x'.repeat(500)}`;
    ui.scheduleDeferredMarkdownRender(target, source);

    ui.reconcileTerminalMarkdownRender(target, source.replace(/\r\n/g, '\n'), finalized);
    vi.runAllTimers();

    expect(ui.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(finalized).toHaveBeenCalledTimes(1);
    expect(ui.pendingMarkdownRender).toBeNull();
  });

  it('invalidates changed final content and schedules only newest parse', () => {
    const { ui, target } = harness();
    const first = `old ${'x'.repeat(500)}`;
    const final = `new ${'y'.repeat(500)}`;
    ui.scheduleDeferredMarkdownRender(target, first);

    ui.reconcileTerminalMarkdownRender(target, final);
    vi.runAllTimers();

    expect(ui.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(ui.renderMarkdown).toHaveBeenCalledWith(final);
    expect(target.innerHTML).toContain('new');
  });

  it('cancels safely when target detaches', () => {
    const { ui, target } = harness();
    ui.scheduleDeferredMarkdownRender(target, `report ${'x'.repeat(500)}`);
    target.remove();
    vi.runAllTimers();
    expect(ui.renderMarkdown).not.toHaveBeenCalled();
    expect(ui.pendingMarkdownRender).toBeNull();
  });

  it('normalizes line endings in source digest', () => {
    expect(digestMarkdownSource('a\r\nb')).toBe(digestMarkdownSource('a\nb'));
  });
});

describe('incremental streaming markdown', () => {
  it('commits only blocks closed by a blank line outside code fences', () => {
    expect(findMarkdownCommitBoundary('open paragraph')).toBe(-1);
    expect(findMarkdownCommitBoundary('first\n\nsecond')).toBe('first\n\n'.length);
    expect(findMarkdownCommitBoundary('```js\na\n\nb')).toBe(-1);
    const fenced = '```js\na\n\nb\n```\n\ntail';
    expect(findMarkdownCommitBoundary(fenced)).toBe(fenced.indexOf('tail'));
    const mixed = '~~~\n```\n\n~~~\n\nrest';
    expect(findMarkdownCommitBoundary(mixed)).toBe(mixed.indexOf('rest'));
    expect(findMarkdownCommitBoundary('a\n\nb\n\nc', 3)).toBe('a\n\nb\n\n'.length);
  });

  it('renders finished blocks once and keeps the open tail as plain text', () => {
    const { ui, target } = harness();
    ui.flushStreamingTextRender = (SidePanelUI.prototype as any).flushStreamingTextRender;
    ui.streamingState = { textEventEl: target, textBuffer: '', textPendingBuffer: '' };
    const push = (chunk: string) => {
      ui.streamingState.textBuffer += chunk;
      ui.streamingState.textPendingBuffer += chunk;
      ui.flushStreamingTextRender();
    };

    push('**23 pedidos** atrasa');
    expect(ui.renderMarkdown).not.toHaveBeenCalled();
    expect(target.textContent).toBe('**23 pedidos** atrasa');

    push('dos.\n\nTrês deles');
    expect(ui.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(ui.renderMarkdown).toHaveBeenCalledWith('**23 pedidos** atrasados.\n\n');
    expect(target.querySelector('.stream-md-committed')?.innerHTML).toContain('<p>');
    expect(target.lastChild?.textContent).toBe('Três deles');

    push(' passaram.');
    expect(ui.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(target.lastChild?.textContent).toBe('Três deles passaram.');
  });

  it('recognises a table only once its divider line confirms it', () => {
    expect(findStreamingTable('texto comum')).toBeNull();
    expect(findStreamingTable('| a | b')).toEqual({ source: '', lines: 0 });
    expect(findStreamingTable('| a | b |\n|--')).toEqual({ source: '', lines: 1 });
    expect(findStreamingTable('| a | b |\nnão é divisor')).toBeNull();
    expect(findStreamingTable('| a | b |\n|---|---|\n| 1 | 2 |\n| 3')).toEqual({
      source: '| a | b |\n|---|---|\n| 1 | 2 |\n',
      lines: 3,
    });
    expect(findStreamingTable('| a | b |\n|---|---|\nfim da tabela\n')).toBeNull();
  });

  it('draws a streaming table row by row and never shows its raw syntax', () => {
    const { ui, target } = harness();
    ui.flushStreamingTextRender = (SidePanelUI.prototype as any).flushStreamingTextRender;
    ui.renderMarkdown = vi.fn((source: string) => {
      const [head, , ...rows] = source.trim().split('\n');
      const body = rows.length ? `<tbody>${rows.map((row) => `<tr><td>${row}</td></tr>`).join('')}</tbody>` : '';
      return `<table><thead><tr><th>${head}</th></tr></thead>${body}</table>`;
    });
    ui.streamingState = { textEventEl: target, textBuffer: '', textPendingBuffer: '' };
    const push = (chunk: string) => {
      ui.streamingState.textBuffer += chunk;
      ui.streamingState.textPendingBuffer += chunk;
      ui.flushStreamingTextRender();
    };

    push('| Pedido | Atra');
    expect(target.textContent).toBe('');
    push('so |\n|---|---|\n| #1 | 2 dias |\n| #2');
    const firstRow = target.querySelector('.stream-md-live tbody tr');
    expect(target.querySelectorAll('.stream-md-live tbody tr')).toHaveLength(1);
    expect(target.textContent).not.toContain('---');

    push(' | 1 dia |\n');
    expect(target.querySelectorAll('.stream-md-live tbody tr')).toHaveLength(2);
    expect(target.querySelector('.stream-md-live tbody tr')).toBe(firstRow);

    push('\nFim.');
    expect(target.querySelector('.stream-md-live')).toBeNull();
    expect(target.querySelector('.stream-md-committed table')).toBeTruthy();
    expect(target.lastChild?.textContent).toBe('Fim.');
  });

  it('folds faded chunks back into the tail text so spans do not pile up', () => {
    const { ui, target } = harness();
    ui.flushStreamingTextRender = (SidePanelUI.prototype as any).flushStreamingTextRender;
    ui.streamingState = { textEventEl: target, textBuffer: '', textPendingBuffer: '' };
    const now = vi.spyOn(performance, 'now');
    for (const [index, chunk] of ['um ', 'dois ', 'três'].entries()) {
      now.mockReturnValue(index * 1000);
      ui.streamingState.textBuffer += chunk;
      ui.streamingState.textPendingBuffer = chunk;
      ui.flushStreamingTextRender();
    }
    expect(target.textContent).toBe('um dois três');
    expect(target.querySelectorAll('.stream-chunk')).toHaveLength(1);
    now.mockRestore();
  });
});
