import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import '../../sidepanel/ui/panel-streaming.js';
import { SidePanelUI } from '../../sidepanel/ui/panel-ui.js';

describe('message layout contracts', () => {
  it('preserves user line breaks and bounds Markdown media/tables', () => {
    const css = readFileSync('sidepanel/styles/chat.css', 'utf8');
    expect(css).toMatch(/\.message\.user \.message-content\s*\{[^}]*white-space:\s*pre-wrap/s);
    expect(css).toMatch(/\.markdown-body img\s*\{[^}]*max-width:\s*100%[^}]*height:\s*auto/s);
    expect(css).toMatch(/\.markdown-table-scroll\s*\{[^}]*overflow-x:\s*auto/s);
  });

  it('places streaming assistant inside connected current turn', () => {
    const dom = new JSDOM('<main id="messages"><div class="chat-turn"><div class="message user"></div></div></main>');
    vi.stubGlobal('document', dom.window.document);
    const messages = dom.window.document.querySelector('#messages') as HTMLElement;
    const turn = dom.window.document.querySelector('.chat-turn') as HTMLElement;
    const ui: any = {
      streamingState: null,
      clearStreamingRenderTimers: vi.fn(),
      lastChatTurn: turn,
      elements: { chatMessages: messages, thinkingPanel: null },
      buildAssistantHeaderHtml: () => '<span class="assistant-name">Glide</span>',
      updateExecutionDetailsHeader: vi.fn(),
      updateThinkingPanel: vi.fn(),
      scrollToBottom: vi.fn(),
    };
    (SidePanelUI.prototype as any).startStreamingMessage.call(ui);
    expect(turn.querySelector('.message.assistant')).toBeTruthy();
    // Cabeçalho desde o início: inserido só no fim, deslocava a resposta inteira.
    expect(turn.querySelector('.message.assistant > .message-header')).toBeTruthy();
    expect(messages.children).toHaveLength(1);
  });
});
