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

export const createModalController = (options: ModalControllerOptions): ModalController | null => {
  const { root, closeButtons = [], backdrop, onOpen, onClose } = options;
  if (!root) return null;

  const isOpen = () => !root.classList.contains('hidden');

  const open = async () => {
    if (isOpen()) return;
    await onOpen?.();
    root.classList.remove('hidden');
  };

  const close = () => {
    if (!isOpen()) return;
    root.classList.add('hidden');
    onClose?.();
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

  return { open, close, toggle, isOpen, root };
};
