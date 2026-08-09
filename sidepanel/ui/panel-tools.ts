import { dedupeThinking } from '../../ai/message-utils.js';
import {
  clearErrorBanner,
  clearWarningBanner,
  showErrorBanner,
  showSuccessToast,
  showWarningBanner,
} from './notifications.js';
import { getComposerDensity } from './panel-helpers.js';
import { SidePanelUI } from './panel-ui.js';
import { type ToolLogBufferEntry, appendCappedToolLogBuffer, updateToolLogBufferResult } from './tool-log-buffer.js';
import {
  buildToolIconSvg,
  formatPressKeyPreview,
  formatWaitPreview,
  getToolPresentation,
} from './tool-presentations.js';

const EXECUTION_STEP_ORDER = ['navigation', 'fill', 'action', 'validation'] as const;

const VISION_TOOL_NAMES = new Set(['screenshot', 'annotatedScreenshot', 'elementScreenshot']);

const NAV_TARGET_TOOLS = new Set(['navigate', 'navigateHistory', 'openTab', 'focusTab']);

type ExecutionStepKey = (typeof EXECUTION_STEP_ORDER)[number];

type ExecutionStepSummary = {
  key: ExecutionStepKey;
  label: string;
  count: number;
  status: 'pending' | 'ok' | 'error';
};

type ExecutionTurnSummary = {
  key: string;
  runId: string;
  turnId: string;
  startedAt: number;
  completedAt: number | null;
  technicalStepCount: number;
  hasErrors: boolean;
  steps: Record<ExecutionStepKey, ExecutionStepSummary>;
};

SidePanelUI.prototype.getExecutionSummariesStore = function getExecutionSummariesStore() {
  if (!this.executionTurnSummaries) {
    this.executionTurnSummaries = new Map();
  }
  return this.executionTurnSummaries as Map<string, ExecutionTurnSummary>;
};

SidePanelUI.prototype.buildExecutionTurnKey = function buildExecutionTurnKey(
  runId?: string | null,
  turnId?: string | null,
) {
  if (!runId || !turnId) return '';
  return `${runId}:${turnId}`;
};

SidePanelUI.prototype.createExecutionTurnSummary = function createExecutionTurnSummary(
  key: string,
  runId: string,
  turnId: string,
  timestamp?: number,
) {
  const startedAt = Number(timestamp || Date.now());
  const makeStep = (stepKey: ExecutionStepKey, label: string): ExecutionStepSummary => ({
    key: stepKey,
    label,
    count: 0,
    status: 'pending',
  });
  return {
    key,
    runId,
    turnId,
    startedAt,
    completedAt: null,
    technicalStepCount: 0,
    hasErrors: false,
    steps: {
      navigation: makeStep('navigation', 'Navegação'),
      fill: makeStep('fill', 'Preenchimento'),
      action: makeStep('action', 'Ação'),
      validation: makeStep('validation', 'Validação'),
    },
  } as ExecutionTurnSummary;
};

SidePanelUI.prototype.ensureExecutionTurnSummary = function ensureExecutionTurnSummary(message: any) {
  const runId = String(message?.runId || '');
  const turnId = String(message?.turnId || '');
  const key = this.buildExecutionTurnKey(runId, turnId);
  if (!key) return null;

  const store = this.getExecutionSummariesStore();
  let summary = store.get(key) || null;
  if (!summary) {
    summary = this.createExecutionTurnSummary(key, runId, turnId, message?.timestamp);
    store.set(key, summary);
  }
  return summary;
};

SidePanelUI.prototype.mapToolToExecutionStep = function mapToolToExecutionStep(toolName: string) {
  const name = String(toolName || '').trim();
  if (!name) return null;
  if (['navigate', 'openTab', 'focusTab', 'switchTab', 'groupTabs', 'navigateHistory'].includes(name))
    return 'navigation';
  if (['type', 'pressKey', 'selectOption', 'fillForm'].includes(name)) return 'fill';
  if (['click'].includes(name)) return 'action';
  if (['getContent', 'screenshot'].includes(name)) return 'validation';
  return null;
};

SidePanelUI.prototype.trackExecutionTurnStart = function trackExecutionTurnStart(message: any) {
  const summary = this.ensureExecutionTurnSummary(message);
  if (!summary) return;
  this.activeExecutionTurnKey = summary.key;
  if (this.streamingState) {
    this.streamingState.executionTurnKey = summary.key;
  }
  this.updateExecutionDetailsHeader(summary, { completed: false });
};

SidePanelUI.prototype.trackExecutionToolResult = function trackExecutionToolResult(message: any) {
  const summary = this.ensureExecutionTurnSummary(message);
  if (!summary) return;

  summary.technicalStepCount += 1;
  const result = message?.result || {};
  const success = !(result?.success === false || result?.error);
  if (!success) {
    summary.hasErrors = true;
  }

  const category = this.mapToolToExecutionStep(message?.tool) as ExecutionStepKey | null;
  if (category) {
    const step = summary.steps[category];
    step.count += 1;
    if (success) {
      step.status = 'ok';
    } else if (step.status !== 'ok') {
      step.status = 'error';
    }
  }

  this.activeExecutionTurnKey = summary.key;
  this.updateExecutionDetailsHeader(summary, { completed: false });
};

SidePanelUI.prototype.consumeExecutionTurnSummary = function consumeExecutionTurnSummary(
  runId?: string | null,
  turnId?: string | null,
) {
  const store = this.getExecutionSummariesStore();
  const explicitKey = this.buildExecutionTurnKey(runId, turnId);
  const key = explicitKey || this.activeExecutionTurnKey || this.streamingState?.executionTurnKey || '';
  if (!key) return null;

  const summary = store.get(key) || null;
  if (!summary) return null;
  store.delete(key);
  this.activeExecutionTurnKey = null;
  summary.completedAt = Date.now();
  return summary;
};

SidePanelUI.prototype.formatExecutionDuration = function formatExecutionDuration(durationMs: number) {
  const ms = Math.max(0, Number(durationMs || 0));
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
};

SidePanelUI.prototype.sweepInFlightToolContainers = function sweepInFlightToolContainers(
  options: { error?: boolean } = {},
) {
  this.stopToolDurationTimer();
  const isError = options.error === true;
  const now = Date.now();

  for (const entry of this.toolCallViews.values()) {
    for (const view of [entry.inline, entry.log]) {
      const container = view?.container as HTMLElement | undefined;
      if (!container?.classList.contains('running')) continue;
      container.classList.remove('running');
      container.classList.add(isError ? 'error' : 'success');
      const start = Number.parseInt(container.dataset.start || '0', 10);
      const dur = start ? now - start : 0;
      if (view.statusEl) {
        view.statusEl.textContent = isError ? 'Erro' : dur > 0 ? this.formatExecutionDuration(dur) : 'Concluído';
      }
    }
  }

  this.runningToolViewIds.clear();
  // toolCallViews cresce pela sessão inteira (limpo só em reset/histórico) e
  // segura refs de DOM de ferramentas concluídas. Poda em fim de run — aqui
  // nada mais está running e o resumo do turno já foi consumido.
  const MAX_TOOL_VIEW_ENTRIES = 300;
  let toDelete = this.toolCallViews.size - MAX_TOOL_VIEW_ENTRIES;
  for (const oldId of this.toolCallViews.keys()) {
    if (toDelete <= 0) break;
    this.toolCallViews.delete(oldId);
    toDelete -= 1;
  }
};

SidePanelUI.prototype.tickRunningToolDurations = function tickRunningToolDurations() {
  const now = Date.now();

  // Itera só os ids running (auto-limpante): antes varria o toolCallViews
  // inteiro — que cresce pela sessão — a cada evento de tool e a cada 1s.
  for (const entryId of Array.from(this.runningToolViewIds)) {
    const entry = this.toolCallViews.get(entryId);
    let stillRunning = false;
    for (const view of [entry?.inline, entry?.log]) {
      const container = view?.container as HTMLElement | undefined;
      if (!container?.classList.contains('running')) continue;
      stillRunning = true;
      const start = Number.parseInt(container.dataset.start || '0', 10);
      if (!start || !view.statusEl) continue;
      const formatted = this.formatExecutionDuration(now - start);
      if (view.statusEl.textContent !== formatted) {
        view.statusEl.textContent = formatted;
      }
    }
    if (!stillRunning) this.runningToolViewIds.delete(entryId);
  }

  if (this.runningToolViewIds.size === 0) {
    this.stopToolDurationTimer();
  }
};

SidePanelUI.prototype.ensureToolDurationTimer = function ensureToolDurationTimer() {
  if (this._toolDurationTimerId != null) return;
  this._toolDurationTimerId = window.setInterval(() => this.tickRunningToolDurations(), 1000);
};

SidePanelUI.prototype.stopToolDurationTimer = function stopToolDurationTimer() {
  if (this._toolDurationTimerId != null) {
    window.clearInterval(this._toolDurationTimerId);
    this._toolDurationTimerId = null;
  }
};

SidePanelUI.prototype.ensureStreamingExecutionDetailsVisible = function ensureStreamingExecutionDetailsVisible() {
  const details = this.streamingState?.executionDetailsEl as HTMLDetailsElement | null;
  if (!details) return;
  details.classList.remove('hidden');
};

SidePanelUI.prototype.updateExecutionDetailsHeader = function updateExecutionDetailsHeader(
  summary?: ExecutionTurnSummary | null,
  options: { completed?: boolean } = {},
  container?: HTMLElement | null,
) {
  const source = container || (this.streamingState?.container as HTMLElement | null);
  const details = source?.querySelector('.execution-details') as HTMLDetailsElement | null;
  const titleEl = source?.querySelector('.execution-details-title') as HTMLElement | null;
  const metaEl = source?.querySelector('.execution-details-meta') as HTMLElement | null;
  if (!details || !titleEl || !metaEl) return;

  const hasSteps = Boolean(summary && summary.technicalStepCount > 0);
  details.classList.toggle('hidden', !hasSteps);
  if (!hasSteps) return;

  const total = summary?.technicalStepCount || 0;
  const completed = options.completed === true;
  const endedAt = completed ? summary?.completedAt || Date.now() : Date.now();
  const duration = this.formatExecutionDuration(Math.max(0, endedAt - (summary?.startedAt || endedAt)));
  const actionsLabel = `${total} ${total === 1 ? 'ação' : 'ações'}`;

  titleEl.textContent = completed ? 'Ações do agente' : 'Trabalhando…';
  titleEl.classList.toggle('shimmer', !completed);
  details.classList.toggle('working', !completed);

  if (completed) {
    metaEl.textContent = summary?.hasErrors
      ? `${actionsLabel} · com erro · ${duration}`
      : `${actionsLabel} · ${duration}`;
    metaEl.classList.toggle('has-error', Boolean(summary?.hasErrors));
  } else {
    metaEl.textContent = actionsLabel;
    metaEl.classList.remove('has-error');
  }
};

SidePanelUI.prototype.finalizeExecutionDetails = function finalizeExecutionDetails(
  summary?: ExecutionTurnSummary | null,
  container?: HTMLElement | null,
) {
  const source = container || (this.streamingState?.container as HTMLElement | null);
  const details = source?.querySelector('.execution-details') as HTMLDetailsElement | null;
  if (!details) return;
  if (!summary || summary.technicalStepCount === 0) {
    details.classList.add('hidden');
    details.open = false;
    return;
  }
  details.classList.remove('hidden');
  details.open = false;
  this.updateExecutionDetailsHeader(summary, { completed: true }, source);
};

SidePanelUI.prototype.buildExecutionSemanticRows = function buildExecutionSemanticRows(
  summary?: ExecutionTurnSummary | null,
) {
  if (!summary) return [] as Array<{ label: string; count: number; status: string; description: string }>;
  const descriptions: Record<ExecutionStepKey, string> = {
    navigation: 'Acessou a página alvo',
    fill: 'Preencheu os campos solicitados',
    action: 'Executou a ação principal',
    validation: 'Leu e validou o retorno da página',
  };
  const rows: Array<{ label: string; count: number; status: string; description: string }> = [];
  for (const key of EXECUTION_STEP_ORDER) {
    const step = summary.steps[key];
    if (!step || step.count <= 0) continue;
    rows.push({
      label: step.label,
      count: step.count,
      status: step.status,
      description: descriptions[key],
    });
  }
  return rows;
};

SidePanelUI.prototype.buildExecutionChipsHtml = function buildExecutionChipsHtml(
  rows: Array<{ label: string; count: number; status: string; description: string }>,
) {
  if (!rows.length) return '';
  const chips = rows
    .map((row) => {
      const countLabel = row.count > 1 ? ` ×${row.count}` : '';
      return `
        <span class="execution-chip ${row.status}" title="${this.escapeHtml(row.description)}">
          <span class="chip-dot"></span>${this.escapeHtml(row.label)}${countLabel}
        </span>
      `;
    })
    .join('');
  return `
    <div class="execution-human-title">Resumo da execução</div>
    <div class="execution-chip-row">${chips}</div>
  `;
};

SidePanelUI.prototype.renderExecutionSemanticSummary = function renderExecutionSemanticSummary(
  summary?: ExecutionTurnSummary | null,
  container?: HTMLElement | null,
) {
  const source = container || (this.streamingState?.container as HTMLElement | null);
  const target = source?.querySelector('.execution-human-summary') as HTMLElement | null;
  if (!target) return;

  const rows = this.buildExecutionSemanticRows(summary);
  if (!rows.length) {
    target.classList.add('hidden');
    target.innerHTML = '';
    return;
  }

  target.innerHTML = this.buildExecutionChipsHtml(rows);
  target.classList.remove('hidden');
};

SidePanelUI.prototype.formatToolErrorMessage = function formatToolErrorMessage(toolName: string, result: any) {
  const code = String(result?.code || '');
  if (code === 'NO_EXECUTABLE_TAB') {
    return `${toolName}: Nenhuma aba web acessivel (http/https) foi encontrada. Abra o site alvo e tente novamente.`;
  }
  if (code === 'TAB_INACCESSIBLE') {
    return `${toolName}: A aba selecionada é restrita e não pode ser automatizada.`;
  }
  return `${toolName}: ${result?.error || 'Falha na execução da ferramenta'}`;
};

SidePanelUI.prototype.resolveErrorBannerAction = function resolveErrorBannerAction(details?: {
  action?: string;
  code?: string;
}) {
  if (details?.action === 'open_settings') {
    return { label: 'Configurações', onClick: () => this.openSettingsPanel() };
  }
  const code = String(details?.code || '');
  if (code === 'NO_EXECUTABLE_TAB') {
    return {
      label: 'Abrir aba',
      onClick: () => {
        void chrome.tabs.create({ active: true });
      },
    };
  }
  return undefined;
};

SidePanelUI.prototype.resolveToolErrorBannerAction = function resolveToolErrorBannerAction(result: any) {
  const code = String(result?.code || '');
  if (code === 'NO_EXECUTABLE_TAB') {
    return {
      label: 'Abrir aba',
      onClick: () => {
        void chrome.tabs.create({ active: true });
      },
    };
  }
  return undefined;
};

SidePanelUI.prototype.formatTargetTabLabel = function formatTargetTabLabel(url: string) {
  try {
    const parsed = new URL(url);
    const compact = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    const prefix = `Aba: ${compact}`;
    return prefix.length > 40 ? `${prefix.slice(0, 39)}…` : prefix;
  } catch {
    const prefix = `Aba: ${url}`;
    return prefix.length > 40 ? `${prefix.slice(0, 39)}…` : prefix;
  }
};

SidePanelUI.prototype.updateStatusTargetDisplay = function updateStatusTargetDisplay() {
  const el = this.elements.statusTarget as HTMLElement | null;
  if (!el) return;
  const label = this._runTargetTabLabel || '';
  if (el.textContent !== label) {
    el.textContent = label;
  }
  el.classList.toggle('hidden', !label);
};

SidePanelUI.prototype.clearRunTargetTab = function clearRunTargetTab() {
  if (!this._runTargetTabLabel) {
    this.updateStatusTargetDisplay();
    return;
  }
  this._runTargetTabLabel = null;
  this.updateStatusTargetDisplay();
};

SidePanelUI.prototype.updateRunTargetTab = async function updateRunTargetTab(toolName: string, result: any) {
  if (!NAV_TARGET_TOOLS.has(toolName)) return;
  if (!result || result.success === false || result.error) return;

  const runGeneration = this.activeRunId;

  let url = typeof result.url === 'string' ? result.url : '';
  if (!url && typeof result.tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(result.tabId);
      url = tab.url || '';
    } catch {
      url = '';
    }
  }
  if (!url) return;
  if (runGeneration !== this.activeRunId || !this.elements.composer?.classList.contains('running')) {
    return;
  }

  const label = this.formatTargetTabLabel(url);
  if (this._runTargetTabLabel !== label) {
    this._runTargetTabLabel = label;
    this.updateStatusTargetDisplay();
  }
};

SidePanelUI.prototype.buildToolStepDetailsSummary = function buildToolStepDetailsSummary(result: any) {
  const isError = result && (result.error || result.success === false);
  if (isError) {
    const errorText = String(result?.error || result?.message || 'Falha na ferramenta');
    return this.truncateText(errorText, 300);
  }
  const displayResult = this.sanitizeToolResultForDisplay(result);
  const preview =
    (typeof result?.message === 'string' && result.message) ||
    (typeof result?.summary === 'string' && result.summary) ||
    this.safeJsonStringify(displayResult);
  return this.truncateText(String(preview || 'Concluído'), 300);
};

SidePanelUI.prototype.appendToolStepDetails = function appendToolStepDetails(container: HTMLElement, result: any) {
  const isError = result && (result.error || result.success === false);
  const parent = container.parentElement;
  if (!parent) return;

  const entryId = container.dataset.id || '';
  let detailsEl = container.nextElementSibling as HTMLDetailsElement | null;
  if (detailsEl && !detailsEl.classList.contains('tool-step-details')) {
    detailsEl = null;
  }
  if (!detailsEl && entryId) {
    detailsEl = parent.querySelector(`details.tool-step-details[data-for="${entryId}"]`) as HTMLDetailsElement | null;
  }

  const summaryText = this.buildToolStepDetailsSummary(result);
  if (!summaryText) return;

  if (!detailsEl) {
    detailsEl = document.createElement('details');
    detailsEl.className = 'tool-step-details';
    if (entryId) detailsEl.dataset.for = entryId;
    const summary = document.createElement('summary');
    summary.textContent = isError ? 'Erro' : 'Resultado';
    const body = document.createElement('div');
    body.className = 'tool-step-details-body';
    detailsEl.append(summary, body);
    parent.insertBefore(detailsEl, container.nextSibling);
  }

  const bodyEl = detailsEl.querySelector('.tool-step-details-body') as HTMLElement | null;
  const summaryEl = detailsEl.querySelector('summary') as HTMLElement | null;
  if (summaryEl && summaryEl.textContent !== (isError ? 'Erro' : 'Resultado')) {
    summaryEl.textContent = isError ? 'Erro' : 'Resultado';
  }
  if (bodyEl && bodyEl.textContent !== summaryText) {
    bodyEl.textContent = summaryText;
  }
  if (isError && !detailsEl.open) {
    detailsEl.open = true;
  }
};

SidePanelUI.prototype.displayToolExecution = function displayToolExecution(
  toolName: string,
  args: any,
  result: any,
  toolCallId: string | null = null,
  runtimeMeta: { runId?: string; turnId?: string; timestamp?: number } | null = null,
) {
  if (runtimeMeta?.runId && runtimeMeta?.turnId && this.streamingState) {
    this.streamingState.executionTurnKey = this.buildExecutionTurnKey(runtimeMeta.runId, runtimeMeta.turnId);
  }
  const entryId = toolCallId || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let entry = this.toolCallViews.get(entryId);

  if (!entry) {
    entry = { inline: null, log: null };
    this.toolCallViews.set(entryId, entry);

    if (this.streamingState?.eventsEl) {
      if (this.currentPlan) {
        this.ensurePlanBlock();
      }
      this.ensureStreamingExecutionDetailsVisible?.();
      const inlineEntry = this.createToolTreeItem(entryId, toolName, args);
      entry.inline = inlineEntry;
      this.streamingState.eventsEl.appendChild(inlineEntry.container);
      this.streamingState.lastEventType = 'tool';
    }

    if (this.elements.toolLog) {
      if (this.activityPanelOpen) {
        const logEntry = this.createToolTreeItem(entryId, toolName, args);
        entry.log = logEntry;
        this.elements.toolLog.appendChild(logEntry.container);
      } else {
        this.toolLogBuffer = appendCappedToolLogBuffer(this.toolLogBuffer, {
          entryId,
          toolName,
          args,
          result: undefined,
          startedAt: Date.now(),
        });
      }
    }

    if (this.shouldAutoScroll() && this.isNearBottom) {
      this.scrollToBottom();
    }
  }

  if (result === null || result === undefined) {
    this.ensureToolDurationTimer();
    this.tickRunningToolDurations();
  }

  if (result !== null && result !== undefined) {
    this.updateToolMessage(entry, result);
    const isError = result && (result.error || result.success === false);
    if (isError) {
      const action = this.resolveToolErrorBannerAction(result);
      this.showErrorBanner(this.formatToolErrorMessage(toolName, result), { action });
    }
    if (!entry.log && this.toolLogBuffer.length > 0) {
      this.toolLogBuffer = updateToolLogBufferResult(this.toolLogBuffer, entryId, result);
    }
    if (this.shouldAutoScroll() && this.isNearBottom) {
      this.scrollToBottom();
    }
  }
  this.updateActivityToggle();
};

SidePanelUI.prototype.updateToolMessage = function updateToolMessage(entry: any, result: any) {
  if (!entry) return;

  if (entry.inline || entry.log) {
    if (entry.inline) {
      this.updateToolTreeItem(entry.inline, result);
    }
    if (entry.log) {
      const isTreeItem = entry.log.container?.classList?.contains('tool-tree-item');
      if (isTreeItem) {
        this.updateToolTreeItem(entry.log, result);
      } else {
        this.updateToolLogEntry(entry.log, result);
      }
    }
    return;
  }

  this.updateToolLogEntry(entry, result);
};

SidePanelUI.prototype.sanitizeToolResultForDisplay = function sanitizeToolResultForDisplay(value: any, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return this.truncateText(value, 1400);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const maxItems = depth === 0 ? 20 : 10;
    return value.slice(0, maxItems).map((item) => this.sanitizeToolResultForDisplay(item, depth + 1));
  }

  if (typeof value !== 'object') return String(value);
  if (depth >= 2) return '[omitted]';

  const source = value as Record<string, any>;
  const keys = Object.keys(source);
  const maxFields = depth === 0 ? 24 : 12;
  const sanitized: Record<string, unknown> = {};

  for (const key of keys.slice(0, maxFields)) {
    const raw = source[key];
    if (typeof raw === 'string' && key.toLowerCase().includes('dataurl')) {
      sanitized[`${key}Length`] = raw.length;
      sanitized[key] = '<omitted>';
      continue;
    }
    sanitized[key] = this.sanitizeToolResultForDisplay(raw, depth + 1);
  }

  if (keys.length > maxFields) {
    sanitized.truncatedFieldCount = keys.length - maxFields;
  }

  return sanitized;
};

SidePanelUI.prototype.updateToolLogEntry = function updateToolLogEntry(entry: any, result: any) {
  if (!entry) return;
  const isError = result && (result.error || result.success === false);
  const displayResult = this.sanitizeToolResultForDisplay(result);

  if (entry.details) {
    entry.details.classList.remove('running', 'success', 'error');
    entry.details.classList.add(isError ? 'error' : 'success');
    if (entry.statusEl) entry.statusEl.textContent = isError ? 'Erro' : 'Concluido';

    if (entry.resultEl) {
      const resultText = this.truncateText(this.safeJsonStringify(displayResult), 2000);
      entry.resultEl.textContent = resultText || (isError ? 'Falha na ferramenta' : 'Concluido');
    }

    if (entry.previewEl) {
      const preview = isError ? result?.error || 'Falha na ferramenta' : result?.message || result?.summary || '';
      if (preview) {
        entry.previewEl.textContent = this.truncateText(String(preview), 120);
      }
    }

    if (isError) {
      entry.details.open = true;
    }
    return;
  }

  if (entry.container) {
    entry.container.classList.remove('running', 'success', 'error');
    entry.container.classList.add(isError ? 'error' : 'success');
  }
  if (entry.statusEl) entry.statusEl.textContent = isError ? 'Erro' : 'Concluido';

  if (entry.resultEl) {
    const resultText = this.truncateText(this.safeJsonStringify(displayResult), 2000);
    entry.resultEl.textContent = resultText || (isError ? 'Falha na ferramenta' : 'Concluido');
  }

  if (entry.previewEl) {
    const preview = isError ? result?.error || 'Falha na ferramenta' : result?.message || result?.summary || '';
    if (preview) {
      entry.previewEl.textContent = this.truncateText(String(preview), 120);
    }
  }

  if (isError && entry.container) {
    entry.container.classList.add('expanded');
    if (entry.toggleBtn) {
      entry.toggleBtn.textContent = 'Ocultar';
    }
  }

  if (this.elements.toolLog && this.activityPanelOpen) {
    this.scrollToolLogToBottom();
  }
};

SidePanelUI.prototype.showErrorBanner = showErrorBanner;

SidePanelUI.prototype.showWarningBanner = showWarningBanner;

SidePanelUI.prototype.clearRunIncompleteBanner = clearWarningBanner;

SidePanelUI.prototype.clearWarningBanner = clearWarningBanner;

SidePanelUI.prototype.clearErrorBanner = clearErrorBanner;

SidePanelUI.prototype.showSuccessToast = showSuccessToast;

/**
 * Ponto ÚNICO de verdade do estado ocupado do composer. Antes, cada caminho de
 * sucesso/erro repetia as mesmas 4 linhas (e o caminho de erro esquecia alguma),
 * o que travava o botão de envio com spinner. Também alterna enviar/parar e
 * marca aria-busy para leitores de tela.
 */
SidePanelUI.prototype.setComposerBusy = function setComposerBusy(busy: boolean) {
  const composer = this.elements.composer as HTMLElement | null;
  const sendBtn = this.elements.sendBtn as HTMLButtonElement | null;
  const stopBtn = this.elements.stopBtn as HTMLButtonElement | null;

  composer?.classList.toggle('running', busy);
  composer?.setAttribute('aria-busy', busy ? 'true' : 'false');

  if (sendBtn) {
    sendBtn.classList.toggle('hidden', busy);
    sendBtn.classList.toggle('loading', busy);
    if (busy || this.stoppingRun) sendBtn.setAttribute('disabled', 'true');
    else sendBtn.removeAttribute('disabled');
  }
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !busy);
    stopBtn.disabled = false;
  }
  if (!busy) {
    this.clearRunTargetTab?.();
  }
  this.syncAssistantActionButtons?.();
};

SidePanelUI.prototype.fetchExecutionEvents = async function fetchExecutionEvents() {
  const response = await chrome.runtime.sendMessage({ type: 'get_execution_events' });
  if (!response?.success) {
    throw new Error(response?.error || 'Falha ao obter logs de execução.');
  }
  return Array.isArray(response.events) ? response.events : [];
};

SidePanelUI.prototype.exportExecutionLog = async function exportExecutionLog() {
  const exportBtn = this.elements.exportExecutionLogBtn as HTMLButtonElement | null;
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exportando...';
  }

  try {
    const events = await this.fetchExecutionEvents();
    const payload = {
      exportedAt: new Date().toISOString(),
      currentSessionId: this.sessionId,
      totalEvents: events.length,
      events,
    };

    this.downloadJsonFile(
      payload,
      `Glide-execution-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
    );
    this.showSuccessToast(`Log exportado (${events.length} eventos)`);
  } catch (error) {
    const errorMessage = error?.message || 'Falha ao exportar log de execução.';
    this.showErrorBanner(errorMessage);
    this.updateStatus('Falha ao exportar log', 'error');
  } finally {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.textContent = 'Exportar log';
    }
  }
};

SidePanelUI.prototype.getArgsPreview = function getArgsPreview(args: any) {
  if (!args) return '';
  if (args.url) {
    try {
      const parsed = new URL(String(args.url));
      const compact = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
      return compact.substring(0, 42) + (compact.length > 42 ? '…' : '');
    } catch {
      return String(args.url).substring(0, 42);
    }
  }
  if (args.text) return `"${args.text.substring(0, 26)}${args.text.length > 26 ? '…' : ''}"`;
  if (args.condition) {
    return formatWaitPreview(String(args.condition), args.selector ? String(args.selector) : undefined, args.idleMs);
  }
  if (args.selector) return args.selector.substring(0, 32);
  if (args.key) {
    return formatPressKeyPreview(
      String(args.key),
      Array.isArray(args.modifiers) ? args.modifiers.map(String) : undefined,
    );
  }
  if (args.direction) return args.direction;
  if (args.type) return args.type;
  return '';
};

SidePanelUI.prototype.createToolTreeItem = function createToolTreeItem(entryId: string, toolName: string, args: any) {
  const container = document.createElement('div');
  container.className = 'tool-tree-item tool-step running';
  container.dataset.id = entryId;
  this.runningToolViewIds.add(entryId);
  container.dataset.start = String(Date.now());
  container.dataset.tool = String(toolName || '');
  if (VISION_TOOL_NAMES.has(String(toolName || ''))) {
    container.classList.add('tool-step--vision');
  }

  const presentation = getToolPresentation(toolName);
  const argsPreview = this.getArgsPreview(args);

  container.innerHTML = `
    <span class="tool-step-icon">${buildToolIconSvg(presentation.icon)}</span>
    <div class="tool-step-body">
      <span class="tool-step-label">${this.escapeHtml(presentation.running)}</span>
      ${argsPreview ? `<span class="tool-step-target">${this.escapeHtml(argsPreview)}</span>` : ''}
    </div>
    <span class="tool-tree-meta tool-step-meta"></span>
  `;

  return {
    container,
    statusEl: container.querySelector('.tool-tree-meta'),
    labelEl: container.querySelector('.tool-step-label'),
  };
};

SidePanelUI.prototype.updateToolTreeItem = function updateToolTreeItem(entry: any, result: any) {
  if (!entry?.container) return;
  const isError = result && (result.error || result.success === false);
  entry.container.classList.remove('running', 'success', 'error');
  entry.container.classList.add(isError ? 'error' : 'success');

  const start = Number.parseInt(entry.container.dataset.start || '0', 10);
  const dur = start ? Date.now() - start : 0;

  if (entry.labelEl && !isError) {
    const presentation = getToolPresentation(entry.container.dataset.tool || '');
    entry.labelEl.textContent = presentation.done;
  }

  if (entry.statusEl) {
    if (isError) {
      entry.statusEl.textContent = 'Erro';
    } else {
      entry.statusEl.textContent = dur > 0 ? this.formatExecutionDuration(dur) : 'Concluído';
    }
  }
  this.appendToolStepDetails(entry.container, result);
  this.tickRunningToolDurations();
};

/**
 * Densidade memorizada.
 *
 * A densidade só depende da LARGURA do composer, que muda quando o usuário
 * arrasta a borda do painel — raro. Mas updateActivityState roda a cada tick do
 * cronômetro de "Thinking" (1×/s), a cada evento de ferramenta e a cada troca de
 * status. Ler `clientWidth` ali e escrever `dataset`/`textContent` logo abaixo é
 * leitura-depois-de-escrita: invalida o layout e força o navegador a recalculá-lo
 * na hora, várias vezes por segundo, durante o run inteiro.
 *
 * Aqui a medição fica em cache e só é refeita quando o ResizeObserver marca a
 * largura como suja.
 */
SidePanelUI.prototype.invalidateComposerDensity = function invalidateComposerDensity() {
  this._composerDensity = null;
};

SidePanelUI.prototype.getComposerDensityCached = function getComposerDensityCached() {
  if (this._composerDensity) return this._composerDensity;
  const composerWidth = this.elements.composer?.clientWidth || window.innerWidth || 0;
  this._composerDensity = getComposerDensity(composerWidth);
  return this._composerDensity;
};

SidePanelUI.prototype.updateActivityState = function updateActivityState() {
  if (!this.elements.statusMeta) return;
  const density = this.getComposerDensityCached();
  // Escrever o mesmo valor num dataset ainda suja o elemento; comparar antes é
  // de graça e evita invalidação de estilo à toa.
  if (this.elements.composer && this.elements.composer.dataset.density !== density) {
    this.elements.composer.dataset.density = density;
  }
  const labels: string[] = [];
  if (this.pendingToolCount > 0) {
    if (density === 'tight') {
      labels.push(`${this.pendingToolCount} exec.`);
    } else if (density === 'compact') {
      labels.push(`${this.pendingToolCount} ação${this.pendingToolCount > 1 ? 'ões' : ''}`);
    } else {
      labels.push(`${this.pendingToolCount} ação${this.pendingToolCount > 1 ? 'ões' : ''} em execução`);
    }
  }
  if (this.isStreaming) {
    labels.push(density === 'tight' ? 'streaming' : density === 'compact' ? 'em streaming' : 'Resposta em streaming');
  }
  if (this.contextUsage && this.contextUsage.maxContextTokens) {
    const used = Math.max(0, this.contextUsage.approxTokens || 0);
    const max = Math.max(1, this.contextUsage.maxContextTokens || 0);
    const usedLabel = used >= 10000 ? `${(used / 1000).toFixed(1)}k` : `${used}`;
    const maxLabel = max >= 10000 ? `${(max / 1000).toFixed(0)}k` : `${max}`;
    labels.push(density === 'tight' ? `Ctx ${usedLabel}/${maxLabel}` : `Contexto ~ ${usedLabel} / ${maxLabel}`);
  }
  // Tokens do turno já aparecem no cabeçalho da própria mensagem; repetir aqui
  // só fazia os dois textos disputarem ~150px e saírem truncados. O título
  // guarda a versão completa para quem quiser passar o mouse.
  const usageLabel = this.buildUsageLabel(this.lastUsage);
  const sessionLabel = this.buildSessionUsageLabel();
  const full = [...labels, usageLabel, sessionLabel].filter(Boolean).join(' · ');
  if (density === 'tight' && labels.length > 1) {
    labels.splice(1);
  }
  if (labels.length > 0) {
    const text = labels.join(' · ');
    // Reescrever textContent idêntico ainda dispara invalidação de layout no
    // ancestral. Durante o streaming este texto passa segundos sem mudar.
    if (this.elements.statusMeta.textContent !== text) {
      this.elements.statusMeta.textContent = text;
    }
    if (this.elements.statusMeta.title !== full) {
      this.elements.statusMeta.title = full;
    }
    this.elements.statusMeta.classList.remove('hidden');
  } else {
    if (this.elements.statusMeta.textContent !== '') {
      this.elements.statusMeta.textContent = '';
    }
    this.elements.statusMeta.removeAttribute('title');
    this.elements.statusMeta.classList.add('hidden');
  }
  // Reaproveita a densidade já resolvida: pedi-la de novo aqui, depois das
  // escritas acima, é o que reintroduziria o layout forçado.
  this.updateActivityToggle(density);
  this.updateSessionUsageDisplay();
};

SidePanelUI.prototype.updateActivityToggle = function updateActivityToggle(knownDensity?: string) {
  const toggle = this.elements.activityToggleBtn;
  if (!toggle) return;
  const density = knownDensity || this.getComposerDensityCached();
  const toolCount = this.toolCallViews.size;
  const hasThinking = Boolean(this.latestThinking);
  const segments: string[] = [];
  if (toolCount > 0) {
    if (density === 'tight') {
      segments.push(`${toolCount}f`);
    } else {
      segments.push(`${toolCount} ferramenta${toolCount === 1 ? '' : 's'}`);
    }
  }
  if (hasThinking) {
    segments.push(density === 'tight' ? 'rac' : 'raciocinio');
  }
  if (this.activeToolName) {
    const toolLabel = getToolPresentation(this.activeToolName).running;
    if (density === 'tight') {
      segments.push(toolLabel.length > 10 ? `${toolLabel.slice(0, 8)}…` : toolLabel);
    } else if (density === 'compact') {
      segments.push(toolLabel.length > 16 ? `${toolLabel.slice(0, 14)}…` : toolLabel);
    } else {
      segments.push(toolLabel);
    }
  }
  const prefix = density === 'tight' ? 'Atv' : density === 'compact' ? 'Ativ.' : 'Atividade';
  const activityLabel = segments.length ? `${prefix} | ${segments.join(' | ')}` : prefix;
  if (toggle.getAttribute('title') !== activityLabel) {
    toggle.setAttribute('title', activityLabel);
    toggle.setAttribute('aria-label', activityLabel);
  }
  const hasActiveWork = this.pendingToolCount > 0 || this.isStreaming;
  toggle.classList.toggle('active', hasActiveWork);
};

SidePanelUI.prototype.toggleActivityPanel = function toggleActivityPanel(force?: boolean) {
  const shouldOpen = typeof force === 'boolean' ? force : !this.activityPanelOpen;
  this.activityPanelOpen = shouldOpen;
  if (this.elements.activityPanel) {
    const activityPanel = this.elements.activityPanel as HTMLElement;
    const activeElement = document.activeElement;
    const shouldRestoreFocus =
      !shouldOpen && activeElement instanceof HTMLElement && activityPanel.contains(activeElement);
    this.elements.activityPanel.classList.toggle('open', shouldOpen);
    activityPanel.toggleAttribute('inert', !shouldOpen);
    this.elements.activityPanel.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
    if (shouldRestoreFocus) {
      window.requestAnimationFrame(() => this.elements.activityToggleBtn?.focus());
    }
  }
  this.elements.activityToggleBtn?.classList.toggle('open', shouldOpen);
  this.elements.activityToggleBtn?.setAttribute('aria-expanded', String(shouldOpen));
  this.elements.activityToggleBtn?.setAttribute(
    'aria-label',
    shouldOpen ? 'Fechar painel de atividade' : 'Abrir painel de atividade',
  );
  this.elements.chatInterface?.classList.toggle('activity-open', shouldOpen);
  if (shouldOpen) {
    this.flushToolLogBuffer();
    this.scrollToolLogToBottom();
  }
};

SidePanelUI.prototype.flushToolLogBuffer = function flushToolLogBuffer() {
  if (!this.elements.toolLog || this.toolLogBuffer.length === 0) return;

  const fragment = document.createDocumentFragment();
  for (const buffered of this.toolLogBuffer as ToolLogBufferEntry[]) {
    const logEntry = this.createToolTreeItem(buffered.entryId, buffered.toolName, buffered.args);
    logEntry.container.dataset.start = String(buffered.startedAt);
    const viewEntry = this.toolCallViews.get(buffered.entryId);
    if (viewEntry) {
      viewEntry.log = logEntry;
    }
    if (buffered.result !== undefined) {
      this.updateToolTreeItem(logEntry, buffered.result);
    } else {
      this.ensureToolDurationTimer();
    }
    fragment.appendChild(logEntry.container);
  }
  this.elements.toolLog.appendChild(fragment);
  this.toolLogBuffer = [];
  this.tickRunningToolDurations();
};

SidePanelUI.prototype.updateThinkingPanel = function updateThinkingPanel(thinking: string | null, isStreaming = false) {
  const panel = this.elements.thinkingPanel;
  if (!panel) return;
  const content = thinking ? thinking.trim() : '';
  if (content) {
    const cleaned = dedupeThinking(content);
    this.latestThinking = cleaned;
    panel.textContent = cleaned;
    panel.classList.remove('empty');
  } else {
    if (!isStreaming) {
      this.latestThinking = null;
    }
    panel.textContent = isStreaming ? 'Raciocinando...' : 'Sem raciocinio capturado ainda.';
    panel.classList.add('empty');
  }
  panel.classList.toggle('streaming', isStreaming);
};

SidePanelUI.prototype.resetActivityPanel = function resetActivityPanel() {
  this.stopToolDurationTimer();
  this.toolLogBuffer = [];
  if (this.elements.toolLog) {
    this.elements.toolLog.innerHTML = '';
  }
  if (this.elements.chatMessages) {
    const tree = this.elements.chatMessages.querySelector('.tool-tree');
    if (tree) tree.remove();
  }
  this.latestThinking = null;
  this.activeToolName = null;
  this.activeExecutionTurnKey = null;
  this._runTargetTabLabel = null;
  this.updateStatusTargetDisplay();
  this.updateThinkingPanel(null, false);
  this.updateActivityToggle();
};

SidePanelUI.prototype.scrollToolLogToBottom = function scrollToolLogToBottom() {
  if (!this.elements.toolLog) return;
  if (this._toolLogScrollRafId) return;
  this._toolLogScrollRafId = requestAnimationFrame(() => {
    this._toolLogScrollRafId = 0;
    const toolLog = this.elements.toolLog;
    if (!toolLog) return;
    const target = toolLog.scrollHeight;
    if (toolLog.scrollTop !== target) {
      toolLog.scrollTop = target;
    }
  });
};
