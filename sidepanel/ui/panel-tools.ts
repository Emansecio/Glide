import { dedupeThinking } from '../../ai/message-utils.js';
import { SidePanelUI } from './panel-ui.js';

const EXECUTION_STEP_ORDER = ['navigation', 'fill', 'action', 'validation'] as const;

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

(SidePanelUI.prototype as any).getExecutionSummariesStore = function getExecutionSummariesStore() {
  if (!this.executionTurnSummaries) {
    this.executionTurnSummaries = new Map();
  }
  return this.executionTurnSummaries as Map<string, ExecutionTurnSummary>;
};

(SidePanelUI.prototype as any).buildExecutionTurnKey = function buildExecutionTurnKey(
  runId?: string | null,
  turnId?: string | null,
) {
  if (!runId || !turnId) return '';
  return `${runId}:${turnId}`;
};

(SidePanelUI.prototype as any).createExecutionTurnSummary = function createExecutionTurnSummary(
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
      navigation: makeStep('navigation', 'Navegacao'),
      fill: makeStep('fill', 'Preenchimento'),
      action: makeStep('action', 'Acao'),
      validation: makeStep('validation', 'Validacao'),
    },
  } as ExecutionTurnSummary;
};

(SidePanelUI.prototype as any).ensureExecutionTurnSummary = function ensureExecutionTurnSummary(message: any) {
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

(SidePanelUI.prototype as any).mapToolToExecutionStep = function mapToolToExecutionStep(toolName: string) {
  const name = String(toolName || '').trim();
  if (!name) return null;
  if (['navigate', 'openTab', 'focusTab', 'switchTab', 'groupTabs'].includes(name)) return 'navigation';
  if (['type', 'pressKey'].includes(name)) return 'fill';
  if (['click'].includes(name)) return 'action';
  if (['getContent', 'screenshot'].includes(name)) return 'validation';
  return null;
};

(SidePanelUI.prototype as any).trackExecutionTurnStart = function trackExecutionTurnStart(message: any) {
  const summary = this.ensureExecutionTurnSummary(message);
  if (!summary) return;
  this.activeExecutionTurnKey = summary.key;
  if (this.streamingState) {
    this.streamingState.executionTurnKey = summary.key;
  }
  this.updateExecutionDetailsHeader(summary, { completed: false });
};

(SidePanelUI.prototype as any).trackExecutionToolResult = function trackExecutionToolResult(message: any) {
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

(SidePanelUI.prototype as any).consumeExecutionTurnSummary = function consumeExecutionTurnSummary(
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

(SidePanelUI.prototype as any).formatExecutionDuration = function formatExecutionDuration(durationMs: number) {
  const ms = Math.max(0, Number(durationMs || 0));
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
};

(SidePanelUI.prototype as any).ensureStreamingExecutionDetailsVisible = function ensureStreamingExecutionDetailsVisible() {
  const details = this.streamingState?.executionDetailsEl as HTMLDetailsElement | null;
  if (!details) return;
  details.classList.remove('hidden');
};

(SidePanelUI.prototype as any).updateExecutionDetailsHeader = function updateExecutionDetailsHeader(
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
  titleEl.textContent = `Ver detalhes tecnicos da execucao (${total} passo${total === 1 ? '' : 's'})`;

  const completed = options.completed === true;
  const endedAt = completed ? summary?.completedAt || Date.now() : Date.now();
  const duration = this.formatExecutionDuration(Math.max(0, endedAt - (summary?.startedAt || endedAt)));
  const statusLabel = summary?.hasErrors ? 'Com erro' : completed ? 'Concluido' : 'Em execucao';
  metaEl.textContent = `${statusLabel} em ${duration}`;
};

(SidePanelUI.prototype as any).finalizeExecutionDetails = function finalizeExecutionDetails(
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

(SidePanelUI.prototype as any).buildExecutionSemanticRows = function buildExecutionSemanticRows(
  summary?: ExecutionTurnSummary | null,
) {
  if (!summary) return [] as Array<{ label: string; count: number; status: string; description: string }>;
  const descriptions: Record<ExecutionStepKey, string> = {
    navigation: 'Acessou a pagina alvo',
    fill: 'Preencheu os campos solicitados',
    action: 'Executou a acao principal',
    validation: 'Leu e validou o retorno da pagina',
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

(SidePanelUI.prototype as any).renderExecutionSemanticSummary = function renderExecutionSemanticSummary(
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

  const items = rows
    .map((row, index) => {
      const statusLabel = row.status === 'error' ? 'Erro' : row.status === 'ok' ? 'OK' : 'Pendente';
      return `
        <li class="execution-human-item ${row.status}">
          <span class="execution-human-index">${index + 1}.</span>
          <span class="execution-human-text">
            <strong>${this.escapeHtml(row.label)}:</strong> ${this.escapeHtml(row.description)}
            <span class="execution-human-meta">(${row.count}x, ${statusLabel})</span>
          </span>
        </li>
      `;
    })
    .join('');

  target.innerHTML = `
    <div class="execution-human-title">Plano de Execucao</div>
    <ol class="execution-human-list">${items}</ol>
  `;
  target.classList.remove('hidden');
};

(SidePanelUI.prototype as any).formatToolErrorMessage = function formatToolErrorMessage(
  toolName: string,
  result: any,
) {
  const code = String(result?.code || '');
  if (code === 'NO_EXECUTABLE_TAB') {
    return `${toolName}: Nenhuma aba web acessivel (http/https) foi encontrada. Abra o site alvo e tente novamente.`;
  }
  if (code === 'TAB_INACCESSIBLE') {
    return `${toolName}: A aba selecionada e restrita e nao pode ser automatizada.`;
  }
  return `${toolName}: ${result?.error || 'Falha na execucao da ferramenta'}`;
};

(SidePanelUI.prototype as any).displayToolExecution = function displayToolExecution(
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
      const logEntry = this.createToolTreeItem(entryId, toolName, args);
      entry.log = logEntry;
      this.elements.toolLog.appendChild(logEntry.container);
    }

    this.scrollToBottom();
  }

  if (result !== null && result !== undefined) {
    this.updateToolMessage(entry, result);
    const isError = result && (result.error || result.success === false);
    if (isError) {
      this.showErrorBanner(this.formatToolErrorMessage(toolName, result));
    }
  }
  this.updateActivityToggle();
};

(SidePanelUI.prototype as any).updateToolMessage = function updateToolMessage(entry: any, result: any) {
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

(SidePanelUI.prototype as any).sanitizeToolResultForDisplay = function sanitizeToolResultForDisplay(
  value: any,
  depth = 0,
) {
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

(SidePanelUI.prototype as any).updateToolLogEntry = function updateToolLogEntry(entry: any, result: any) {
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

  if (this.elements.toolLog) {
    this.scrollToolLogToBottom();
  }
};

(SidePanelUI.prototype as any).showErrorBanner = function showErrorBanner(message: string) {
  document.querySelectorAll('.error-banner').forEach((el) => el.remove());

  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.innerHTML = `
    <svg class="error-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    </svg>
    <span class="error-text">${this.escapeHtml(message)}</span>
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

(SidePanelUI.prototype as any).clearRunIncompleteBanner = function clearRunIncompleteBanner() {
  document.querySelectorAll('.run-incomplete-banner').forEach((el) => el.remove());
};

(SidePanelUI.prototype as any).clearErrorBanner = function clearErrorBanner() {
  document.querySelectorAll('.error-banner').forEach((el) => el.remove());
};

(SidePanelUI.prototype as any).showSuccessToast = function showSuccessToast(message: string, duration = 3000) {
  // Remover toasts existentes
  document.querySelectorAll('.success-toast').forEach((el) => {
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 150);
  });

  const toast = document.createElement('div');
  toast.className = 'success-toast';
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
    <span class="toast-text">${this.escapeHtml(message)}</span>
    <button class="toast-dismiss" title="Fechar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  `;

  const dismissBtn = toast.querySelector('.toast-dismiss');
  dismissBtn?.addEventListener('click', () => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 150);
  });

  document.body.appendChild(toast);

  // Auto-remove
  const autoRemoveTimeout = setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 150);
    }
  }, duration);

  // Limpar timeout se manualmente fechado
  dismissBtn?.addEventListener('click', () => clearTimeout(autoRemoveTimeout));
};

(SidePanelUI.prototype as any).fetchExecutionEvents = async function fetchExecutionEvents() {
  const response = await chrome.runtime.sendMessage({ type: 'get_execution_events' });
  if (!response?.success) {
    throw new Error(response?.error || 'Falha ao obter logs de execucao.');
  }
  return Array.isArray(response.events) ? response.events : [];
};

(SidePanelUI.prototype as any).exportExecutionLog = async function exportExecutionLog() {
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

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `Glide-execution-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.showSuccessToast(`Log exportado (${events.length} eventos)`);
  } catch (error) {
    const errorMessage = error?.message || 'Falha ao exportar log de execucao.';
    this.showErrorBanner(errorMessage);
    this.updateStatus('Falha ao exportar log', 'error');
  } finally {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.textContent = 'Exportar log';
    }
  }
};

(SidePanelUI.prototype as any).getArgsPreview = function getArgsPreview(args: any) {
  if (!args) return '';
  if (args.url) return args.url.substring(0, 30) + (args.url.length > 30 ? '...' : '');
  if (args.text) return `"${args.text.substring(0, 20)}${args.text.length > 20 ? '...' : ''}"`;
  if (args.selector) return args.selector.substring(0, 25);
  if (args.key) return args.key;
  if (args.direction) return args.direction;
  if (args.type) return args.type;
  return '';
};

(SidePanelUI.prototype as any).createToolTreeItem = function createToolTreeItem(
  entryId: string,
  toolName: string,
  args: any,
) {
  const container = document.createElement('div');
  container.className = 'tool-tree-item running';
  container.dataset.id = entryId;
  container.dataset.start = String(Date.now());

  const argsPreview = this.getArgsPreview(args);

  container.innerHTML = `
    <span class="tool-tree-status"></span>
    <div class="tool-tree-content">
      <div class="tool-tree-header">
        <span class="tool-tree-name">${this.escapeHtml(toolName || 'ferramenta')}</span>
        <span class="tool-tree-args">${this.escapeHtml(argsPreview || '')}</span>
      </div>
      <span class="tool-tree-meta">Executando</span>
    </div>
  `;

  return {
    container,
    statusEl: container.querySelector('.tool-tree-meta'),
  };
};

(SidePanelUI.prototype as any).updateToolTreeItem = function updateToolTreeItem(entry: any, result: any) {
  if (!entry?.container) return;
  const isError = result && (result.error || result.success === false);
  entry.container.classList.remove('running', 'success', 'error');
  entry.container.classList.add(isError ? 'error' : 'success');

  const start = Number.parseInt(entry.container.dataset.start || '0', 10);
  const dur = start ? Date.now() - start : 0;

  if (entry.statusEl) {
    if (isError) {
      entry.statusEl.textContent = 'Erro';
    } else {
      entry.statusEl.textContent = dur > 0 ? `${dur}ms` : 'Concluido';
    }
  }
};

(SidePanelUI.prototype as any).updateActivityState = function updateActivityState() {
  if (!this.elements.statusMeta) return;
  const composerWidth = this.elements.composer?.clientWidth || window.innerWidth || 0;
  const density = composerWidth <= 420 ? 'tight' : composerWidth <= 560 ? 'compact' : 'normal';
  if (this.elements.composer) {
    this.elements.composer.dataset.density = density;
  }
  const labels: string[] = [];
  if (this.pendingToolCount > 0) {
    if (density === 'tight') {
      labels.push(`${this.pendingToolCount} exec.`);
    } else if (density === 'compact') {
      labels.push(`${this.pendingToolCount} acao${this.pendingToolCount > 1 ? 'es' : ''}`);
    } else {
      labels.push(`${this.pendingToolCount} acao${this.pendingToolCount > 1 ? 'es' : ''} em execucao`);
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
  let usageLabel = this.buildUsageLabel(this.lastUsage);
  if (usageLabel && density !== 'normal') {
    usageLabel = usageLabel.replace(/^Tokens\s+/i, 'Tok ');
  }
  if (usageLabel) {
    labels.push(usageLabel);
  }
  if (density === 'tight' && labels.length > 2) {
    labels.splice(2);
  }
  if (labels.length > 0) {
    this.elements.statusMeta.textContent = labels.join(' | ');
    this.elements.statusMeta.classList.remove('hidden');
  } else {
    this.elements.statusMeta.textContent = '';
    this.elements.statusMeta.classList.add('hidden');
  }
  this.updateActivityToggle();
};

(SidePanelUI.prototype as any).updateActivityToggle = function updateActivityToggle() {
  const toggle = this.elements.activityToggleBtn;
  if (!toggle) return;
  const composerWidth = this.elements.composer?.clientWidth || window.innerWidth || 0;
  const density = composerWidth <= 420 ? 'tight' : composerWidth <= 560 ? 'compact' : 'normal';
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
    if (density === 'tight') {
      segments.push(`${this.activeToolName.slice(0, 8)}...`);
    } else if (density === 'compact') {
      segments.push(`${this.activeToolName.slice(0, 14)}...`);
    } else {
      segments.push(`${this.activeToolName}...`);
    }
  }
  const prefix = density === 'tight' ? 'Atv' : density === 'compact' ? 'Ativ.' : 'Atividade';
  const activityLabel = segments.length ? `${prefix} | ${segments.join(' | ')}` : prefix;
  toggle.setAttribute('title', activityLabel);
  toggle.setAttribute('aria-label', activityLabel);
  const hasActiveWork = this.pendingToolCount > 0 || this.isStreaming;
  toggle.classList.toggle('active', hasActiveWork);
};

(SidePanelUI.prototype as any).toggleActivityPanel = function toggleActivityPanel(force?: boolean) {
  const shouldOpen = typeof force === 'boolean' ? force : !this.activityPanelOpen;
  this.activityPanelOpen = shouldOpen;
  if (this.elements.activityPanel) {
    this.elements.activityPanel.classList.toggle('open', shouldOpen);
    this.elements.activityPanel.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
  }
  this.elements.activityToggleBtn?.classList.toggle('open', shouldOpen);
  this.elements.chatInterface?.classList.toggle('activity-open', shouldOpen);
  if (shouldOpen) {
    this.scrollToolLogToBottom();
  }
};

(SidePanelUI.prototype as any).updateThinkingPanel = function updateThinkingPanel(
  thinking: string | null,
  isStreaming = false,
) {
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

(SidePanelUI.prototype as any).resetActivityPanel = function resetActivityPanel() {
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
  this.updateThinkingPanel(null, false);
  this.updateActivityToggle();
};

(SidePanelUI.prototype as any).scrollToolLogToBottom = function scrollToolLogToBottom() {
  if (!this.elements.toolLog) return;
  this.elements.toolLog.scrollTop = this.elements.toolLog.scrollHeight;
};
