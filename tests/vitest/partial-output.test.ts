import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { createMessage, normalizeConversationHistory } from '../../ai/message-schema.js';
import { sanitizeMessageForPersistence } from '../../ai/persist-serialization.js';
import '../../sidepanel/ui/panel-streaming.js';
import { SidePanelUI } from '../../sidepanel/ui/panel-ui.js';

function partialHarness(content: string) {
  const dom = new JSDOM('<div class="message assistant"><div class="stream-main-text"></div></div>');
  vi.stubGlobal('document', dom.window.document);
  const container = dom.window.document.querySelector('.message') as HTMLElement;
  const ui: any = {
    displayHistory: [],
    finishStreamingMessage: vi.fn(() => (content ? { container, renderedContent: content } : null)),
    buildAssistantHeaderHtml: vi.fn((meta: string) => `<span>${meta}</span>`),
    bindAssistantActions: vi.fn(),
    getLastUserMessageText: () => 'matching user',
    persistHistory: vi.fn(),
    updateChatEmptyState: vi.fn(),
  };
  ui.finalizePartialStreamingMessage = (SidePanelUI.prototype as any).finalizePartialStreamingMessage;
  return { ui, container };
}

describe('partial assistant output', () => {
  it.each(['stopped', 'failed', 'interrupted'] as const)('persists non-empty %s stream once', (reason) => {
    const { ui, container } = partialHarness('partial report');
    expect(ui.finalizePartialStreamingMessage(reason)).toBe(true);
    expect(ui.displayHistory).toHaveLength(1);
    expect(ui.displayHistory[0].meta).toEqual({ finishReason: reason, partial: true });
    expect(container.textContent).toContain('Interrompida');
    expect(ui.persistHistory).toHaveBeenCalledTimes(1);
  });

  it('does not create an entry for empty stream', () => {
    const { ui } = partialHarness('');
    expect(ui.finalizePartialStreamingMessage('stopped')).toBe(false);
    expect(ui.displayHistory).toHaveLength(0);
  });

  it('preserves partial metadata through persistence and restore normalization', () => {
    const message = createMessage({
      role: 'assistant',
      content: 'partial',
      meta: { finishReason: 'interrupted', partial: true },
    });
    const stored = sanitizeMessageForPersistence(message);
    const restored = normalizeConversationHistory(stored ? [stored] : []);
    expect(restored[0]?.meta).toEqual({ finishReason: 'interrupted', partial: true });
  });
});
