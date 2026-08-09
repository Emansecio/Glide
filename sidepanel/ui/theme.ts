/**
 * Tema claro/escuro.
 *
 * Todos os tokens de cor usam light-dark() (styles/base.css), então trocar de
 * tema é trocar `color-scheme` no :root — nenhuma variável precisa ser
 * reescrita em JS. Aqui só decidimos qual dos três modos está valendo.
 *
 * Persistência em localStorage e não em chrome.storage de propósito: a leitura
 * é síncrona, o que permite aplicar o tema antes do primeiro paint. Com storage
 * assíncrono o painel abriria claro e piscaria para escuro.
 *
 * Dois controles falam com o mesmo estado: o ícone no cabeçalho da gaveta
 * (cíclico, para quem já sabe onde está) e o segmentado em Configurações
 * (rotulado, para quem está procurando). Os dois se mantêm em sincronia.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'glide.theme';

/** Claro é o padrão da V2 — o painel não acompanha o sistema até você mandar. */
const DEFAULT_MODE: ThemeMode = 'light';

/** Claro → escuro → sistema, nessa ordem: o primeiro clique leva ao escuro. */
const CYCLE: ThemeMode[] = ['light', 'dark', 'system'];

const LABELS: Record<ThemeMode, string> = {
  light: 'Tema: claro',
  dark: 'Tema: escuro',
  system: 'Tema: acompanha o sistema',
};

const isThemeMode = (value: unknown): value is ThemeMode => value === 'system' || value === 'light' || value === 'dark';

const readStoredTheme = (): ThemeMode => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemeMode(stored) ? stored : DEFAULT_MODE;
  } catch {
    // Armazenamento bloqueado: cai no padrão em vez de herdar o sistema.
    return DEFAULT_MODE;
  }
};

const persistTheme = (mode: ThemeMode) => {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Sem persistência a troca ainda vale para a sessão atual.
  }
};

const applyTheme = (mode: ThemeMode) => {
  const root = document.documentElement;
  if (mode === 'system') {
    root.removeAttribute('data-theme');
    return;
  }
  root.dataset.theme = mode;
};

/** Aplica o tema salvo. Deve rodar antes de montar o layout (evita o flash). */
export const initTheme = () => {
  applyTheme(readStoredTheme());
};

let currentMode: ThemeMode = DEFAULT_MODE;
const syncers: Array<(mode: ThemeMode) => void> = [];

const setMode = (next: ThemeMode) => {
  currentMode = next;
  persistTheme(next);

  // A classe de transição vive só durante a troca: fora dela, nenhuma parte da
  // interface paga o custo de animar cor em toda mudança de estado.
  const root = document.documentElement;
  root.classList.add('theme-transition');
  applyTheme(next);
  for (const sync of syncers) sync(next);
  window.setTimeout(() => root.classList.remove('theme-transition'), 260);
};

/** Ícone cíclico no cabeçalho da gaveta. */
const bindToggleButton = () => {
  const button = document.getElementById('themeToggleBtn');
  if (!button) return;

  syncers.push((mode) => {
    button.title = LABELS[mode];
    button.setAttribute('aria-label', `${LABELS[mode]}. Clique para alternar.`);
    // forEach e não for..of: o tsconfig do projeto não inclui DOM.Iterable.
    button.querySelectorAll<HTMLElement>('.theme-icon').forEach((icon) => {
      icon.classList.add('hidden');
    });
    button.querySelector<HTMLElement>(`.theme-icon-${mode}`)?.classList.remove('hidden');
  });

  button.addEventListener('click', () => {
    setMode(CYCLE[(CYCLE.indexOf(currentMode) + 1) % CYCLE.length]);
  });
};

/** Segmentado rotulado em Configurações. */
const bindSegmentedControl = () => {
  const group = document.getElementById('themeSegmented');
  if (!group) return;

  const segments = group.querySelectorAll<HTMLButtonElement>('[data-theme-mode]');

  syncers.push((mode) => {
    segments.forEach((segment) => {
      const active = segment.dataset.themeMode === mode;
      segment.classList.toggle('active', active);
      segment.setAttribute('aria-checked', String(active));
      segment.tabIndex = active ? 0 : -1;
    });
  });

  segments.forEach((segment) => {
    segment.addEventListener('click', () => {
      const next = segment.dataset.themeMode;
      if (isThemeMode(next)) setMode(next);
    });
    segment.addEventListener('keydown', (event: KeyboardEvent) => {
      const currentIndex = Array.from(segments).indexOf(segment);
      if (currentIndex < 0) return;
      let nextIndex = currentIndex;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % segments.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
        nextIndex = (currentIndex - 1 + segments.length) % segments.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = segments.length - 1;
      if (nextIndex === currentIndex) return;
      event.preventDefault();
      const next = segments[nextIndex];
      next.focus();
      const nextMode = next.dataset.themeMode;
      if (isThemeMode(nextMode)) setMode(nextMode);
    });
  });
};

/** Liga os controles. Só pode rodar depois que os templates carregaram. */
export const bindThemeToggle = () => {
  currentMode = readStoredTheme();
  bindToggleButton();
  bindSegmentedControl();
  for (const sync of syncers) sync(currentMode);
};
