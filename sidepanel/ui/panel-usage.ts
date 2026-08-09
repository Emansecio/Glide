import type { UsagePayload, UsageStats } from './panel-types.js';
import { SidePanelUI } from './panel-ui.js';

SidePanelUI.prototype.formatTokenCount = function formatTokenCount(value: number) {
  if (!value || value <= 0) return '0';
  if (value >= 1000) {
    const precision = value >= 10000 ? 0 : 1;
    return `${(value / 1000).toFixed(precision)}k`;
  }
  return `${Math.round(value)}`;
};

SidePanelUI.prototype.normalizeUsage = function normalizeUsage(usage: UsagePayload | null) {
  if (!usage) return null;
  const inputTokens = Math.max(0, usage.inputTokens || 0);
  const outputTokens = Math.max(0, usage.outputTokens || 0);
  const totalTokens = Math.max(0, usage.totalTokens || inputTokens + outputTokens);
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens || 0);
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens } as UsageStats;
};

SidePanelUI.prototype.buildUsageLabel = function buildUsageLabel(usage: UsageStats | null) {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.inputTokens) {
    parts.push(`${this.formatTokenCount(usage.inputTokens)} in`);
  }
  if (usage.outputTokens) {
    parts.push(`${this.formatTokenCount(usage.outputTokens)} out`);
  }
  if (usage.cachedInputTokens) {
    // Prompt-cache hit: portion of input read from cache (~10% cost).
    parts.push(`${this.formatTokenCount(usage.cachedInputTokens)} cached`);
  }
  if (!parts.length && usage.totalTokens) {
    parts.push(`${this.formatTokenCount(usage.totalTokens)} total`);
  }
  return parts.length ? `Tokens ${parts.join(' / ')}` : '';
};

SidePanelUI.prototype.buildSessionUsageLabel = function buildSessionUsageLabel() {
  const totals = this.sessionTokenTotals;
  if (!totals?.inputTokens && !totals?.outputTokens) return '';
  const parts: string[] = [];
  if (totals.inputTokens) {
    parts.push(`${this.formatTokenCount(totals.inputTokens)} in`);
  }
  if (totals.outputTokens) {
    parts.push(`${this.formatTokenCount(totals.outputTokens)} out`);
  }
  return parts.length ? `Sessão: ${parts.join(' · ')}` : '';
};

SidePanelUI.prototype.updateSessionUsageDisplay = function updateSessionUsageDisplay() {
  const label = this.buildSessionUsageLabel();
  const footer = this.elements.sessionUsage as HTMLElement | null;
  if (footer) {
    if (footer.textContent !== label) {
      footer.textContent = label;
    }
    footer.classList.toggle('hidden', !label);
  }
};

SidePanelUI.prototype.buildMessageMeta = function buildMessageMeta(
  usage: UsageStats | null,
  modelLabel?: string | null,
) {
  const segments: string[] = [];
  const model = modelLabel?.trim();
  if (model) {
    segments.push(model);
  }
  const usageLabel = this.buildUsageLabel(usage);
  if (usageLabel) {
    segments.push(usageLabel);
  }
  return segments.join(' · ');
};

SidePanelUI.prototype.estimateUsageFromContent = function estimateUsageFromContent(content: string) {
  if (!content) return null;
  const tokens = Math.ceil(content.length / 4);
  if (!tokens) return null;
  return {
    inputTokens: 0,
    outputTokens: tokens,
    totalTokens: tokens,
  } as UsageStats;
};

SidePanelUI.prototype.getActiveModelLabel = function getActiveModelLabel() {
  return this.elements.modelSelect?.value || this.configs[this.currentConfig]?.model || '';
};

SidePanelUI.prototype.updateUsageStats = function updateUsageStats(usage: UsageStats | null) {
  if (!usage) return;
  this.lastUsage = usage;
  this.sessionTokenTotals = {
    inputTokens: this.sessionTokenTotals.inputTokens + usage.inputTokens,
    outputTokens: this.sessionTokenTotals.outputTokens + usage.outputTokens,
    totalTokens: this.sessionTokenTotals.totalTokens + usage.totalTokens,
  };
  this.updateSessionUsageDisplay();
  this.updateActivityState();
};
