/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../sidepanel/ui/panel-history.js';
import { SidePanelUI } from '../../sidepanel/ui/panel-ui.js';

const sessions = [
  { id: 's1', title: 'Pedidos pendentes de envio', updatedAt: Date.now(), messageCount: 6 },
  { id: 's2', title: 'Extrair tabela de preços', updatedAt: Date.now(), messageCount: 1 },
];

function harness() {
  document.body.innerHTML = `
    <div id="historyPanel"><input id="historySearch" /><div id="historyItems"></div>
    <button id="clearHistoryBtn">Limpar histórico</button></div>`;
  const ui: any = Object.create(SidePanelUI.prototype);
  ui.elements = {
    historyPanel: document.getElementById('historyPanel'),
    historyItems: document.getElementById('historyItems'),
    historySearch: document.getElementById('historySearch'),
    clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  };
  ui.historyListLoadToken = 0;
  ui._cachedChatSessionsIndex = sessions;
  ui.ensureHistoryStorageMigrated = vi.fn().mockResolvedValue(undefined);
  ui.escapeHtml = (value: string) => value;
  ui.escapeAttribute = (value: string) => value;
  ui.loadSessionById = vi.fn();
  ui.deleteSession = vi.fn().mockResolvedValue(undefined);
  return ui;
}

const visibleTitles = () =>
  Array.from(document.querySelectorAll<HTMLElement>('.history-item'))
    .filter((item) => !item.hidden)
    .map((item) => item.querySelector('.history-title')?.textContent);

describe('history panel', () => {
  let ui: any;
  beforeEach(async () => {
    vi.useFakeTimers();
    ui = harness();
    await ui.loadHistoryList();
  });
  afterEach(() => vi.useRealTimers());

  it('uses a middle dot and singular/plural message counts', () => {
    const metas = Array.from(document.querySelectorAll('.history-meta')).map((m) =>
      m.textContent?.replace(/\s+/g, ' '),
    );
    expect(metas[0]).toContain('· 6 mensagens');
    expect(metas[1]).toContain('· 1 mensagem');
  });

  it('filters by title ignoring accents and case', () => {
    ui.elements.historySearch.value = 'PRECOS';
    ui.filterHistoryList();
    expect(visibleTitles()).toEqual(['Extrair tabela de preços']);

    ui.elements.historySearch.value = 'nada disso';
    ui.filterHistoryList();
    expect(visibleTitles()).toEqual([]);
    expect(document.querySelector('.history-search-empty')?.textContent).toBe('Nenhuma conversa encontrada.');
  });

  it('deletes only after the undo window and can be undone', () => {
    (document.querySelector('.history-delete') as HTMLButtonElement).click();
    expect(document.querySelector('.history-undo-text')?.textContent).toBe('Conversa excluída');
    (document.querySelector('.history-undo') as HTMLButtonElement).click();
    vi.advanceTimersByTime(10_000);
    expect(ui.deleteSession).not.toHaveBeenCalled();
    expect(visibleTitles()).toHaveLength(2);

    (document.querySelector('.history-delete') as HTMLButtonElement).click();
    vi.advanceTimersByTime(5_000);
    expect(ui.deleteSession).toHaveBeenCalledWith('s1');
    expect(document.querySelectorAll('.history-item')).toHaveLength(1);
  });

  it('commits pending deletions when the panel closes', () => {
    (document.querySelector('.history-delete') as HTMLButtonElement).click();
    ui.flushPendingHistoryDeletes();
    expect(ui.deleteSession).toHaveBeenCalledWith('s1');
  });

  it('asks for a second click before clearing everything', async () => {
    const btn = ui.elements.clearHistoryBtn as HTMLButtonElement;
    ui.historyWriteQueue = { run: vi.fn().mockResolvedValue(undefined) };
    await ui.clearAllHistory();
    expect(btn.classList.contains('confirming')).toBe(true);
    expect(ui.historyWriteQueue.run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4_000);
    expect(btn.classList.contains('confirming')).toBe(false);
    expect(btn.textContent).toBe('Limpar histórico');

    await ui.clearAllHistory();
    await ui.clearAllHistory();
    expect(ui.historyWriteQueue.run).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe('Limpar histórico');
  });
});
