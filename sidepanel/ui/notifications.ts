import { escapeHtml } from './panel-helpers.js';

export type BannerSeverity = 'error' | 'warning';

export type BannerOptions = {
  /** Botão de ação opcional (ex.: "Abrir Configurações") ao lado da mensagem. */
  action?: { label: string; onClick: () => void };
  /** Sobrescreve o tempo de auto-remoção. 0 = não remove sozinho. */
  timeoutMs?: number;
};

const SEVERITY_CLASS: Record<BannerSeverity, string> = {
  // Mantemos os nomes de classe existentes: `.error-banner` (borda vermelha) e
  // `.run-incomplete-banner` (borda âmbar) já estão estilizados em utilities.css.
  error: 'error-banner',
  warning: 'run-incomplete-banner',
};

const DEFAULT_TIMEOUT: Record<BannerSeverity, number> = {
  error: 12000,
  warning: 6000,
};

const ICON: Record<BannerSeverity, string> = {
  error: `<svg class="error-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    </svg>`,
  warning: '<span class="run-incomplete-dot" aria-hidden="true"></span>',
};

/**
 * Container dos avisos. Vive NO FLUXO, acima do composer (ver main.html): como
 * overlay fixo no canto, o banner cobria o botão de enviar e a gaveta do plano
 * exatamente quando o usuário precisava agir sobre o aviso. O fallback no body
 * só existe para o caso do template não ter carregado.
 */
const getBannerStack = (): HTMLElement => {
  let stack = document.getElementById('bannerStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'bannerStack';
    stack.className = 'banner-stack banner-stack--floating';
    document.body.appendChild(stack);
  }
  return stack;
};

/** Saída curta (a entrada vem do @starting-style no CSS). */
const EXIT_MS = 130;

const dismissBanner = (banner: HTMLElement) => {
  banner.classList.add('leaving');
  setTimeout(() => banner.remove(), EXIT_MS);
};

const clearBySeverity = (severity: BannerSeverity) => {
  document.querySelectorAll(`.${SEVERITY_CLASS[severity]}`).forEach((el) => el.remove());
};

export const clearErrorBanner = () => clearBySeverity('error');

export const clearWarningBanner = () => clearBySeverity('warning');

export const showBanner = (message: string, severity: BannerSeverity = 'error', options: BannerOptions = {}) => {
  // Só substitui um banner da MESMA severidade: um aviso informativo não pode
  // apagar o erro que o usuário ainda não leu (e vice-versa).
  clearBySeverity(severity);

  const banner = document.createElement('div');
  banner.className = SEVERITY_CLASS[severity];
  // Erro interrompe o leitor de tela; aviso entra na fila educadamente.
  banner.setAttribute('role', severity === 'error' ? 'alert' : 'status');
  banner.setAttribute('aria-live', severity === 'error' ? 'assertive' : 'polite');

  const actionHtml = options.action
    ? `<button type="button" class="banner-action">${escapeHtml(options.action.label)}</button>`
    : '';

  banner.innerHTML = `
    ${ICON[severity]}
    <span class="error-text">${escapeHtml(message)}</span>
    ${actionHtml}
    <button type="button" class="error-dismiss" title="Fechar" aria-label="Fechar aviso">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  `;

  let autoRemoveTimeout: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    if (autoRemoveTimeout !== null) {
      clearTimeout(autoRemoveTimeout);
      autoRemoveTimeout = null;
    }
    dismissBanner(banner);
  };

  banner.querySelector('.error-dismiss')?.addEventListener('click', close);
  if (options.action) {
    banner.querySelector('.banner-action')?.addEventListener('click', () => {
      options.action?.onClick();
      close();
    });
  }

  getBannerStack().appendChild(banner);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT[severity];
  if (timeoutMs > 0) {
    autoRemoveTimeout = setTimeout(close, timeoutMs);
  }
  return banner;
};

export const showErrorBanner = (message: string, options: BannerOptions = {}) => showBanner(message, 'error', options);

export const showWarningBanner = (message: string, options: BannerOptions = {}) =>
  showBanner(message, 'warning', options);

export const showSuccessToast = (message: string, duration = 3000) => {
  document.querySelectorAll('.success-toast').forEach((el) => {
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 150);
  });

  const toast = document.createElement('div');
  toast.className = 'success-toast';
  toast.setAttribute('role', 'status');
  toast.innerHTML = `
    <svg class="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
    <span class="toast-text">${escapeHtml(message)}</span>
    <button type="button" class="toast-dismiss" title="Fechar" aria-label="Fechar">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  `;

  let autoRemoveTimeout: ReturnType<typeof setTimeout> | null = null;
  const dismissBtn = toast.querySelector('.toast-dismiss');
  const closeToast = () => {
    if (autoRemoveTimeout !== null) {
      clearTimeout(autoRemoveTimeout);
      autoRemoveTimeout = null;
    }
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 150);
  };
  dismissBtn?.addEventListener('click', closeToast);

  document.body.appendChild(toast);

  autoRemoveTimeout = setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 150);
    }
  }, duration);
};
