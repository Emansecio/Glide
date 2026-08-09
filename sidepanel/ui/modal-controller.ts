export type ModalController = {
  open: () => Promise<void>;
  close: () => void;
  toggle: () => Promise<void>;
  isOpen: () => boolean;
  root: HTMLElement;
};

export type ModalControllerOptions = {
  root: HTMLElement | null;
  closeButtons?: Array<HTMLElement | null | undefined>;
  backdrop?: HTMLElement | null;
  onOpen?: () => void | Promise<void>;
  onClose?: () => void;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const createModalController = (options: ModalControllerOptions): ModalController | null => {
  const { root, closeButtons = [], backdrop, onOpen, onClose } = options;
  if (!root) return null;

  let previouslyFocused: HTMLElement | null = null;

  const isOpen = () => !root.classList.contains('hidden');

  const focusFirstElement = () => {
    const first = root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    first?.focus();
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (!isOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const open = async () => {
    if (isOpen()) return;
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await onOpen?.();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    focusFirstElement();
  };

  const close = () => {
    if (!isOpen()) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    onClose?.();
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
    previouslyFocused = null;
  };

  const toggle = async () => {
    if (isOpen()) {
      close();
      return;
    }
    await open();
  };

  for (const button of closeButtons) {
    button?.addEventListener('click', close);
  }
  backdrop?.addEventListener('click', close);
  root.addEventListener('keydown', handleKeydown);

  return { open, close, toggle, isOpen, root };
};
