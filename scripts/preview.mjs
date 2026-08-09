/**
 * Harness de preview da interface — só para desenvolvimento.
 *
 * Monta os templates reais + o CSS real numa página estática, com conteúdo
 * falso, para dar para ver e ajustar a UI sem recarregar a extensão no Chrome a
 * cada mudança de CSS. Nada disso entra no pacote: escreve em dist/sidepanel/,
 * que o build limpa a cada execução.
 *
 *   node scripts/preview.mjs        (depois de um build)
 *   npm run preview
 *
 * Abra dist/sidepanel/preview-split.html para ver claro e escuro lado a lado.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcPanel = path.join(rootDir, 'sidepanel');
const outPanel = path.join(rootDir, 'dist', 'sidepanel');

const read = (relative) => fs.readFileSync(path.join(srcPanel, relative), 'utf8');

const ICON_SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
  <symbol id="icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </symbol>
</svg>`;

const GLYPH = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true">
  <path d="M18.88 16.82A8.4 8.4 0 1 1 18.69 6.92" stroke="currentColor" stroke-width="2.9" stroke-linecap="round"/>
  <circle cx="12" cy="12" r="2.9" fill="currentColor"/></svg>`;

const toolIcon = (paths) =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

/** Uma conversa de exemplo que exercita os estados que mais aparecem. */
const DEMO_CONVERSATION = `
<div class="chat-turn">
  <div class="message user">
    <div class="message-content">Abre o painel de pedidos e me diz quantos estão pendentes de envio hoje.</div>
  </div>
</div>

<div class="chat-turn">
  <div class="message assistant">
    <div class="message-header assistant-header">
      <span class="assistant-glyph">${GLYPH}</span>
      <span class="assistant-name">Glide</span>
      <span class="message-meta-inline">4.2s · 1.8k tok</span>
    </div>
    <div class="message-content markdown-body">
      <div class="execution-human-summary">
        <div class="execution-human-title">Resumo da execução</div>
        <div class="execution-chip-row">
          <span class="execution-chip success"><span class="chip-dot"></span>navegou ×2</span>
          <span class="execution-chip success"><span class="chip-dot"></span>leu página</span>
          <span class="execution-chip"><span class="chip-dot"></span>extraiu dados</span>
        </div>
      </div>
      <details class="execution-details" open>
        <summary class="execution-details-summary">
          <svg class="execution-details-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          <span class="execution-details-title">3 etapas</span>
          <span class="execution-details-meta">4.2s</span>
        </summary>
        <div class="stream-events">
          <div class="tool-step tool-tree-item success">
            <span class="tool-step-icon">${toolIcon('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>')}</span>
            <div class="tool-step-body">
              <span class="tool-step-label">Navegou até a página</span>
              <span class="tool-step-target">app.exemplo.com/pedidos</span>
            </div>
            <span class="tool-tree-meta tool-step-meta">1.1s</span>
          </div>
          <div class="tool-step tool-tree-item success">
            <span class="tool-step-icon">${toolIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>')}</span>
            <div class="tool-step-body">
              <span class="tool-step-label">Leu o conteúdo da página</span>
              <span class="tool-step-target">tabela#orders · 148 linhas</span>
            </div>
            <span class="tool-tree-meta tool-step-meta">0.6s</span>
          </div>
          <div class="tool-step tool-tree-item running">
            <span class="tool-step-icon">${toolIcon('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>')}</span>
            <div class="tool-step-body">
              <span class="tool-step-label">Filtrando por status</span>
              <span class="tool-step-target">status = "pendente"</span>
            </div>
            <span class="tool-tree-meta tool-step-meta">2.5s</span>
          </div>
        </div>
      </details>
      <p><strong>23 pedidos</strong> estão pendentes de envio hoje. Três deles passaram do prazo:</p>
      <ul>
        <li><code>#4821</code> — atrasado há 2 dias</li>
        <li><code>#4833</code> — atrasado há 1 dia</li>
        <li><code>#4840</code> — vence hoje às 18h</li>
      </ul>
      <p>Quer que eu <a href="#">abra o primeiro</a> para revisar o endereço?</p>
    </div>
  </div>
</div>

<div class="chat-turn">
  <div class="message user">
    <div class="message-content">Sim, e me manda um resumo em markdown depois.</div>
  </div>
</div>

<div class="chat-turn">
  <div class="message assistant streaming">
    <div class="message-header assistant-header">
      <span class="assistant-glyph">${GLYPH}</span>
      <span class="assistant-name">Glide</span>
    </div>
    <div class="message-content streaming-content markdown-body">
      <details class="execution-details working" open>
        <summary class="execution-details-summary">
          <svg class="execution-details-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          <span class="execution-details-title shimmer">Trabalhando…</span>
          <span class="execution-details-meta">1.4s</span>
        </summary>
        <div class="stream-events">
          <div class="plan-block">
            <div class="plan-header"><span class="plan-title">Plan</span><span class="plan-meta">1/3</span></div>
            <ol class="plan-steps">
              <li class="done">Abrir o pedido #4821</li>
              <li class="running">Conferir endereço de entrega</li>
              <li>Escrever o resumo</li>
            </ol>
          </div>
          <div class="tool-step tool-tree-item running">
            <span class="tool-step-icon">${toolIcon('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>')}</span>
            <div class="tool-step-body">
              <span class="tool-step-label">Abrindo o pedido</span>
              <span class="tool-step-target">/pedidos/4821</span>
            </div>
            <span class="tool-tree-meta tool-step-meta">1.4s</span>
          </div>
        </div>
      </details>
      <div class="stream-main-text stream-event-text">Abri o pedido #4821. O endereço está</div>
    </div>
  </div>
</div>`;

const DEMO_ATTACHMENTS = `
<span class="attachment-chip attachment-chip--file">
  <svg class="attachment-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
  <span class="attachment-chip-meta">
    <span class="attachment-chip-name">pedidos-atrasados.csv</span>
    <span class="attachment-chip-size">4.2 KB</span>
  </span>
  <button class="attachment-chip-remove" type="button" aria-label="Remover">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </button>
</span>`;

const DEMO_MODEL_MENU = `
<div class="model-group">
  <div class="model-group-label">Anthropic</div>
  <div class="model-group-items">
    <button class="model-option selected" role="option" aria-selected="true">
      <span class="model-option-name">Claude Sonnet 5</span>
      <span class="model-option-meta">200k ctx · rápido</span>
    </button>
    <button class="model-option" role="option">
      <span class="model-option-name">Claude Opus 5</span>
      <span class="model-option-meta">200k ctx · profundo</span>
    </button>
  </div>
</div>
<div class="model-group">
  <div class="model-group-label">Local</div>
  <div class="model-group-items">
    <button class="model-option" role="option">
      <span class="model-option-name">qwen3:14b</span>
      <span class="model-option-meta">ollama · 32k ctx</span>
    </button>
  </div>
</div>`;

const DEMO_PLAN = `
<li class="plan-checklist-item completed">
  <button class="plan-checklist-checkbox checked" disabled>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
  </button>
  <div class="plan-checklist-content"><div class="plan-checklist-title">Abrir o painel de pedidos</div></div>
</li>
<li class="plan-checklist-item current">
  <button class="plan-checklist-checkbox" disabled></button>
  <div class="plan-checklist-content">
    <div class="plan-checklist-title">Conferir endereço de entrega</div>
    <div class="plan-checklist-notes">Comparar com o cadastro do cliente</div>
  </div>
</li>
<li class="plan-checklist-item">
  <button class="plan-checklist-checkbox" disabled></button>
  <div class="plan-checklist-content"><div class="plan-checklist-title">Escrever o resumo em markdown</div></div>
</li>`;

/** JS mínimo só para o preview ficar navegável (não é o código do painel). */
const PREVIEW_SCRIPT = `
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

const view = params.get('view') || 'chat';
const $ = (sel) => document.querySelector(sel);

if (view === 'empty') {
  $('#chatMessages').innerHTML = '';
  $('#attachmentsBar').classList.add('hidden');
  $('#planDrawer').classList.add('hidden');
} else {
  $('#chatEmptyState').style.display = 'none';
}

if (view === 'sidebar' || view === 'settings' || view === 'history') {
  $('#sidebar').classList.remove('closed');
  $('#sidebarBackdrop').classList.add('visible');
} else {
  $('#sidebar').classList.add('closed');
}

if (view === 'settings' || view === 'history') {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  document.querySelectorAll('.right-panel-content').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== view));
}

if (view === 'menu') $('#modelSelectMenu').classList.remove('hidden');

// Interações suficientes para clicar em volta e ver as transições.
$('#openSidebarBtn')?.addEventListener('click', () => {
  $('#sidebar').classList.remove('closed');
  $('#sidebarBackdrop').classList.add('visible');
});
const closeSidebar = () => {
  $('#sidebar').classList.add('closed');
  $('#sidebarBackdrop').classList.remove('visible');
};
$('#closeSidebarBtn')?.addEventListener('click', closeSidebar);
$('#sidebarBackdrop')?.addEventListener('click', closeSidebar);

$('#modelSelectTrigger')?.addEventListener('click', () => {
  const menu = $('#modelSelectMenu');
  const open = menu.classList.toggle('hidden');
  $('#modelSelectTrigger').setAttribute('aria-expanded', String(!open));
});

$('#activityToggleBtn')?.addEventListener('click', () => {
  $('#activityToggleBtn').classList.toggle('active');
  $('#activityPanel').classList.toggle('open');
});
$('#activityCloseBtn')?.addEventListener('click', () => {
  $('#activityToggleBtn').classList.remove('active');
  $('#activityPanel').classList.remove('open');
});

$('#planDrawerToggle')?.addEventListener('click', () => $('#planDrawer').classList.toggle('collapsed'));

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    const target = item.dataset.view;
    document.querySelectorAll('.right-panel-content').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.panel !== target);
    });
  });
});

// Tema: espelha o theme.ts (ciclo claro → escuro → sistema, dois controles em
// sincronia), sem persistência — o preview sempre abre do zero.
const CYCLE = ['light', 'dark', 'system'];
let mode = document.documentElement.dataset.theme || 'light';

const syncTheme = () => {
  document.querySelectorAll('.theme-icon').forEach((i) => i.classList.add('hidden'));
  document.querySelector('.theme-icon-' + mode)?.classList.remove('hidden');
  document.querySelectorAll('[data-theme-mode]').forEach((segment) => {
    const active = segment.dataset.themeMode === mode;
    segment.classList.toggle('active', active);
    segment.setAttribute('aria-checked', String(active));
  });
};

const setMode = (next) => {
  mode = next;
  document.documentElement.classList.add('theme-transition');
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = mode;
  syncTheme();
  setTimeout(() => document.documentElement.classList.remove('theme-transition'), 260);
};

syncTheme();
$('#themeToggleBtn')?.addEventListener('click', () => setMode(CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]));
document.querySelectorAll('[data-theme-mode]').forEach((segment) => {
  segment.addEventListener('click', () => setMode(segment.dataset.themeMode));
});
`;

const buildPreview = () => {
  const sidebarShell = read('templates/sidebar-shell.html');
  const main = read('templates/main.html');
  const history = read('templates/panels/history.html');
  const settings = read('templates/panels/settings.html').replace(
    /<div id="settingsTabGeneral"[^>]*><\/div>/,
    read('templates/panels/settings-general.html'),
  );

  const app = `${sidebarShell}\n${main}`
    .replace(
      '<div id="chatMessages" class="chat-messages"></div>',
      `<div id="chatMessages" class="chat-messages">${DEMO_CONVERSATION}</div>`,
    )
    .replace(
      '<div id="attachmentsBar" class="attachments-bar hidden" aria-live="polite"></div>',
      `<div id="attachmentsBar" class="attachments-bar" aria-live="polite">${DEMO_ATTACHMENTS}</div>`,
    )
    .replace(
      '<div id="modelSelectMenu" class="model-dropdown hidden" role="listbox"></div>',
      `<div id="modelSelectMenu" class="model-dropdown hidden" role="listbox">${DEMO_MODEL_MENU}</div>`,
    )
    .replace('<div id="planDrawer" class="plan-drawer hidden">', '<div id="planDrawer" class="plan-drawer">')
    .replace(
      '<ol class="plan-checklist" id="planChecklist"></ol>',
      `<ol class="plan-checklist" id="planChecklist">${DEMO_PLAN}</ol>`,
    )
    .replace(
      '<span class="plan-drawer-count" id="planStepCount">0 etapas</span>',
      '<span class="plan-drawer-count" id="planStepCount">1/3 etapas</span>',
    )
    .replace('<span id="modelSelectValue">Selecionar modelo</span>', '<span id="modelSelectValue">Sonnet 5</span>')
    .replace(
      '<span id="statusText" class="status-text">Pronto</span>',
      '<span id="statusText" class="status-text">Executando · 3 ferramentas</span>',
    )
    .replace(
      '<span id="statusMeta" class="status-meta"></span>',
      '<span id="statusMeta" class="status-meta">Ctx 12k/200k</span>',
    )
    .replace(
      '<span id="statusDot" class="status-dot" aria-hidden="true"></span>',
      '<span id="statusDot" class="status-dot active" aria-hidden="true"></span>',
    );

  const demoHistory = ['Pedidos pendentes de envio', 'Extrair tabela de preços', 'Preencher formulário de cadastro']
    .map(
      (title, index) => `
      <div class="history-item">
        <div class="history-item-main">
          <div class="history-title">${title}</div>
          <div class="history-meta">
            <span>${index === 0 ? 'agora' : `há ${index * 2}h`}</span>
            <span class="history-meta-dot">·</span>
            <span>${6 + index * 4} msgs</span>
          </div>
        </div>
        <button class="history-delete" type="button" aria-label="Excluir">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>`,
    )
    .join('');

  const panels = `${history.replace(
    '<div id="historyItems" class="history-items"></div>',
    `<div id="historyItems" class="history-items">${demoHistory}</div>`,
  )}\n${settings}`;

  const page = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Glide V2 — preview</title>
  <link rel="stylesheet" href="panel.css" />
</head>
<body>
  ${ICON_SPRITE}
  <div id="appRoot" class="app-container">
    ${app.replace('<div id="rightPanelPanels" class="right-panel-panels"></div>', `<div id="rightPanelPanels" class="right-panel-panels">${panels}</div>`)}
  </div>
  <div id="modalRoot"></div>
  <script>${PREVIEW_SCRIPT}</script>
</body>
</html>`;

  const split = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Glide V2 — claro e escuro</title>
  <style>
    body { margin: 0; display: flex; gap: 1px; background: #8a8a8f; font: 12px system-ui; height: 100vh; }
    figure { margin: 0; flex: 1; display: flex; flex-direction: column; }
    figcaption { padding: 6px 10px; background: #1c1c1f; color: #fff; letter-spacing: .04em; text-transform: uppercase; }
    iframe { flex: 1; width: 100%; border: 0; }
  </style>
</head>
<body>
  <figure><figcaption>claro</figcaption><iframe src="preview.html?theme=light&view=chat"></iframe></figure>
  <figure><figcaption>escuro</figcaption><iframe src="preview.html?theme=dark&view=chat"></iframe></figure>
</body>
</html>`;

  fs.mkdirSync(outPanel, { recursive: true });
  fs.writeFileSync(path.join(outPanel, 'preview.html'), page);
  fs.writeFileSync(path.join(outPanel, 'preview-split.html'), split);

  console.log('preview → dist/sidepanel/preview.html');
  console.log('          ?theme=light|dark  ?view=chat|empty|sidebar|settings|menu');
  console.log('split   → dist/sidepanel/preview-split.html');
};

buildPreview();
