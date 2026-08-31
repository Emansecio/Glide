import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import '../../sidepanel/ui/panel-chat.js';
import { SidePanelUI } from '../../sidepanel/ui/panel-ui.js';

function makeHeader(document: Document): HTMLElement {
  const header = document.createElement('div');
  header.innerHTML = '<button class="assistant-copy-btn"></button><button class="assistant-edit-btn"></button>';
  return header;
}

describe('assistant actions', () => {
  it('binds edit to matching user turn instead of latest user', () => {
    const dom = new JSDOM('<textarea></textarea><main></main>');
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('Event', dom.window.Event);
    const input = dom.window.document.querySelector('textarea') as HTMLTextAreaElement;
    const ui: any = {
      elements: { userInput: input, composer: null },
      displayHistory: [{ role: 'user', content: 'latest user' }],
      pendingToolCount: 0,
      isStreaming: false,
      showSuccessToast: vi.fn(),
      showErrorBanner: vi.fn(),
      syncAssistantActionButtons: vi.fn(),
      getLastUserMessageText: (SidePanelUI.prototype as any).getLastUserMessageText,
    };
    const bind = (SidePanelUI.prototype as any).bindAssistantActions;
    const headers = ['first user', 'second user', 'third user'].map((user, index) => {
      const header = makeHeader(dom.window.document);
      dom.window.document.querySelector('main')?.appendChild(header);
      bind.call(ui, header, `answer ${index + 1}`, user);
      return header;
    });

    (headers[0].querySelector('.assistant-edit-btn') as HTMLButtonElement).click();
    expect(input.value).toBe('first user');
  });

  it('copies source after detached history nodes are restored', async () => {
    const dom = new JSDOM('<textarea></textarea><main></main>');
    vi.stubGlobal('document', dom.window.document);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const ui: any = {
      elements: { userInput: dom.window.document.querySelector('textarea'), composer: null },
      pendingToolCount: 0,
      isStreaming: false,
      showSuccessToast: vi.fn(),
      showErrorBanner: vi.fn(),
      syncAssistantActionButtons: vi.fn(),
    };
    const header = makeHeader(dom.window.document);
    (SidePanelUI.prototype as any).bindAssistantActions.call(ui, header, '# restored', 'user');
    dom.window.document.querySelector('main')?.appendChild(header);

    (header.querySelector('.assistant-copy-btn') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('# restored');
  });
});
