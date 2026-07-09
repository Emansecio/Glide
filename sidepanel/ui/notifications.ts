import { escapeHtml } from './panel-helpers.js';

export const clearErrorBanner = () => {
  document.querySelectorAll('.error-banner').forEach((el) => el.remove());
};

export const showErrorBanner = (message: string) => {
  clearErrorBanner();

  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.innerHTML = `
    <svg class="error-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    </svg>
    <span class="error-text">${escapeHtml(message)}</span>
    <button class="error-dismiss" title="Fechar">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  `;

  const dismissButton = banner.querySelector('.error-dismiss');
  dismissButton?.addEventListener('click', () => banner.remove());
  document.body.appendChild(banner);

  setTimeout(() => banner.remove(), 8000);
};

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
