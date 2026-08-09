import './ui/panel-modules.js';
import { loadPanelLayout } from './ui/layout-loader.js';
import { SidePanelUI } from './ui/panel-ui.js';
import { bindThemeToggle, initTheme } from './ui/theme.js';

// Antes de qualquer await: o tema salvo precisa valer já no primeiro layout,
// senão o painel abre no tema do sistema e troca na frente do usuário.
initTheme();

const init = async () => {
  await loadPanelLayout();
  bindThemeToggle();
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
  // Tokens em vez de cor fixa: este aviso também precisa funcionar no escuro.
  banner.style.cssText =
    'padding:16px;margin:12px;border-radius:10px;background:var(--error-muted,#fdecea);color:var(--error,#611a15);border:1px solid var(--border,transparent);font:14px system-ui;';
  banner.textContent = `Falha ao carregar o painel: ${message}. Recarregue a extensão.`;
  body.prepend(banner);
};

void init().catch((error) => {
  console.error('Panel initialization failed:', error);
  renderInitError(error);
});
