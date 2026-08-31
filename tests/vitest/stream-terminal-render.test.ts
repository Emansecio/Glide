import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { digestMarkdownSource } from '../../sidepanel/ui/markdown-render-defer.js';
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
