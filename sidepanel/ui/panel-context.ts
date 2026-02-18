import { SidePanelUI } from './panel-ui.js';

const CONTEXT_USAGE_DEBOUNCE_MS = 350;

(SidePanelUI.prototype as any).estimateContextContentChars = function estimateContextContentChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    return value.reduce((total, part) => total + this.estimateContextContentChars(part), 0);
  }
  if (typeof value === 'object') {
    const part = value as Record<string, unknown>;
    if (typeof part.text === 'string') return part.text.length;
    if (typeof part.content === 'string') return part.content.length;
    if (part.output !== undefined) return this.estimateContextContentChars(part.output);
    if ((part as { value?: unknown }).value !== undefined) {
      return this.estimateContextContentChars((part as { value?: unknown }).value);
    }
    try {
      return JSON.stringify(value).length;
    } catch {
      return String(value).length;
    }
  }
  return String(value).length;
};

(SidePanelUI.prototype as any).estimateContextMessageChars = function estimateContextMessageChars(message: any): number {
  if (!message || typeof message !== 'object') return 0;
  let total = this.estimateContextContentChars(message.content);
  if (typeof message.thinking === 'string') {
    total += message.thinking.length;
  }
  if (Array.isArray(message.toolCalls)) {
    try {
      total += JSON.stringify(message.toolCalls).length;
    } catch {
      // no-op
    }
  }
  return total;
};

(SidePanelUI.prototype as any).applyContextUsageFromChars = function applyContextUsageFromChars(chars: number) {
  const baseTokens = this.estimateBaseContextTokens();
  const estimated = baseTokens + Math.ceil(Math.max(0, chars) / 4);
  const approxTokens = Math.max(estimated, this.sessionTokensUsed || 0);
  const maxContextTokens = this.getConfiguredContextLimit();
  const percent = Math.min(100, Math.round((approxTokens / maxContextTokens) * 100));
  this.contextUsage = { approxTokens, maxContextTokens, percent };
  this.updateActivityState();
};

(SidePanelUI.prototype as any).recomputeContextCharCount = function recomputeContextCharCount() {
  const history = Array.isArray(this.contextHistory) ? this.contextHistory : [];
  let total = 0;
  for (const message of history) {
    total += this.estimateContextMessageChars(message);
  }
  this.contextCharCount = total;
  this.contextTrackedMessageCount = history.length;
  return total;
};

(SidePanelUI.prototype as any).scheduleContextUsageRecompute = function scheduleContextUsageRecompute({ force = false } = {}) {
  if (this.contextUsageDebounceTimerId) {
    window.clearTimeout(this.contextUsageDebounceTimerId);
    this.contextUsageDebounceTimerId = null;
  }

  if (force) {
    const chars = this.recomputeContextCharCount();
    this.applyContextUsageFromChars(chars);
    return;
  }

  this.contextUsageDebounceTimerId = window.setTimeout(() => {
    this.contextUsageDebounceTimerId = null;
    const chars = this.recomputeContextCharCount();
    this.applyContextUsageFromChars(chars);
  }, CONTEXT_USAGE_DEBOUNCE_MS);
};

(SidePanelUI.prototype as any).invalidateContextUsageCache = function invalidateContextUsageCache() {
  this.contextCharCount = 0;
  this.contextTrackedMessageCount = 0;
  this.scheduleContextUsageRecompute();
};

(SidePanelUI.prototype as any).bumpContextUsageWithMessages = function bumpContextUsageWithMessages(messages: any[] = []) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const historySize = Array.isArray(this.contextHistory) ? this.contextHistory.length : 0;
  if (this.contextTrackedMessageCount > historySize) {
    this.scheduleContextUsageRecompute();
    return;
  }
  for (const message of messages) {
    this.contextCharCount += this.estimateContextMessageChars(message);
    this.contextTrackedMessageCount += 1;
  }
};

(SidePanelUI.prototype as any).updateContextUsage = function updateContextUsage(actualTokens: number | null = null) {
  if (actualTokens !== null && actualTokens > 0) {
    if (this.contextUsageDebounceTimerId) {
      window.clearTimeout(this.contextUsageDebounceTimerId);
      this.contextUsageDebounceTimerId = null;
    }
    this.sessionTokensUsed = Math.max(this.sessionTokensUsed || 0, actualTokens);
    const maxContextTokens = this.getConfiguredContextLimit();
    const percent = Math.min(100, Math.round((this.sessionTokensUsed / maxContextTokens) * 100));
    this.contextUsage = {
      approxTokens: this.sessionTokensUsed,
      maxContextTokens,
      percent,
    };
    this.updateActivityState();
    return;
  }

  const history = Array.isArray(this.contextHistory) ? this.contextHistory : [];
  if (this.contextTrackedMessageCount > history.length) {
    this.scheduleContextUsageRecompute();
    return;
  }

  if (this.contextTrackedMessageCount < history.length) {
    for (let i = this.contextTrackedMessageCount; i < history.length; i += 1) {
      this.contextCharCount += this.estimateContextMessageChars(history[i]);
    }
    this.contextTrackedMessageCount = history.length;
  }

  this.applyContextUsageFromChars(this.contextCharCount);
};

(SidePanelUI.prototype as any).getConfiguredContextLimit = function getConfiguredContextLimit() {
  const active = this.configs[this.currentConfig] || {};
  const configured = active.contextLimit || Number.parseInt(this.elements.contextLimit?.value) || 200000;
  return configured;
};

(SidePanelUI.prototype as any).estimateBaseContextTokens = function estimateBaseContextTokens() {
  const active = this.configs[this.currentConfig] || {};
  const prompt = active.systemPrompt || this.getDefaultSystemPrompt();
  const promptTokens = Math.ceil((prompt?.length || 0) / 4);
  const toolBudget = 1200;
  return promptTokens + toolBudget;
};
