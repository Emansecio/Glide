import type { SidePanelElements } from './panel-elements.js';

export type ModelPickerBindContext = {
  elements: SidePanelElements;
  handleModelSelectChange: () => void;
  toggleModelMenu: (focus?: 'first' | 'last' | 'selected') => void;
  isModelMenuOpen?: () => boolean;
  moveModelMenuFocus: (direction: number) => void;
  closeModelMenu: (options?: { focusTrigger?: boolean }) => void;
  selectModelOptionByElement: (option: HTMLElement) => void;
  /** Esc sem menu aberto interrompe o run em andamento. */
  requestStopRun?: () => void | Promise<void>;
  _documentClickHandler?: ((event: Event) => void) | null;
  _documentKeydownHandler?: ((event: KeyboardEvent) => void) | null;
};

export const bindModelPicker = (ui: ModelPickerBindContext) => {
  const { elements } = ui;

  elements.modelSelect?.addEventListener('change', () => ui.handleModelSelectChange());
  elements.modelSelectTrigger?.addEventListener('click', (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    ui.toggleModelMenu();
  });
  elements.modelSelectTrigger?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      ui.toggleModelMenu('selected');
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (ui.isModelMenuOpen?.()) {
        ui.moveModelMenuFocus(1);
      } else {
        ui.toggleModelMenu('first');
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (ui.isModelMenuOpen?.()) {
        ui.moveModelMenuFocus(-1);
      } else {
        ui.toggleModelMenu('last');
      }
      return;
    }
    if (event.key === 'Escape' && ui.isModelMenuOpen?.()) {
      event.preventDefault();
      ui.closeModelMenu({ focusTrigger: true });
    }
  });
  elements.modelSelectMenu?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      ui.closeModelMenu({ focusTrigger: true });
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      ui.moveModelMenuFocus(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      ui.moveModelMenuFocus(-1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      const target = event.target as HTMLElement | null;
      const option = target?.closest('.model-option') as HTMLElement | null;
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      ui.selectModelOptionByElement(option);
    }
  });

  ui._documentClickHandler = (event: Event) => {
    const target = event.target as HTMLElement | null;
    const withinSelector = target?.closest('.model-picker');
    if (!withinSelector) {
      ui.closeModelMenu();
    }
  };
  ui._documentKeydownHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    // Esc primeiro fecha o menu aberto; se não havia menu e há execução em
    // andamento, Esc é o atalho de PARAR (mesma ação do botão no composer).
    const menuWasOpen = !ui.elements.modelSelectMenu?.classList.contains('hidden');
    ui.closeModelMenu();
    if (!menuWasOpen && ui.elements.composer?.classList.contains('running')) {
      void ui.requestStopRun?.();
    }
  };
  document.addEventListener('click', ui._documentClickHandler);
  document.addEventListener('keydown', ui._documentKeydownHandler);
};
