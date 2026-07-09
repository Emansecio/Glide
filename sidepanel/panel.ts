import './ui/panel-modules.js';
import { loadPanelLayout } from './ui/layout-loader.js';
import { SidePanelUI } from './ui/panel-ui.js';

const init = async () => {
  await loadPanelLayout();
  const ui = new SidePanelUI();
  // Expose for debugging
  (window as any).sidePanelUI = ui;
};

const renderInitError = (error: unknown) => {
  // A failed/aborted template fetch must not leave a silently blank panel.
  const message = error instanceof Error ? error.message : String(error);
  const body = document.body;
  if (!body) return;
  const banner = document.createElement('div');
  banner.setAttribute('role', 'alert');
  banner.style.cssText =
    'padding:16px;margin:12px;border-radius:8px;background:#fdecea;color:#611a15;font:14px system-ui;';
  banner.textContent = `Falha ao carregar o painel: ${message}. Recarregue a extensão.`;
  body.prepend(banner);
};

void init().catch((error) => {
  console.error('Panel initialization failed:', error);
  renderInitError(error);
});
