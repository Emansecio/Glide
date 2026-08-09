import { SidePanelUI } from './panel-ui.js';

export type ComposerDensity = 'tight' | 'compact' | 'normal';

export const getComposerDensity = (composerWidth: number): ComposerDensity => {
  if (composerWidth <= 420) return 'tight';
  if (composerWidth <= 560) return 'compact';
  return 'normal';
};

// Reusable element for escapeHtmlBasic (avoids creating DOM element per call)
let escapeHelperDiv: HTMLDivElement | null = null;

SidePanelUI.prototype.safeJsonStringify = function safeJsonStringify(value: any) {
  try {
    if (value === undefined) return '';
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
};

SidePanelUI.prototype.truncateText = function truncateText(text: string, limit = 1200) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
};

export const escapeHtmlBasic = (text: string) => {
  if (text == null) return '';
  // Fast path: use string replacement for common cases
  if (!/[&<>"']/.test(text)) return text;
  // Use cached div for edge cases (e.g., special chars not in map)
  if (!escapeHelperDiv) {
    escapeHelperDiv = document.createElement('div');
  }
  escapeHelperDiv.textContent = text;
  return escapeHelperDiv.innerHTML;
};

export const escapeHtml = (text: string) => escapeHtmlBasic(text).replace(/\n/g, '<br>');

SidePanelUI.prototype.escapeHtmlBasic = escapeHtmlBasic;

SidePanelUI.prototype.escapeHtml = escapeHtml;

SidePanelUI.prototype.escapeAttribute = function escapeAttribute(value: string) {
  return this.escapeHtmlBasic(value).replace(/"/g, '&quot;');
};

SidePanelUI.prototype.downloadJsonFile = function downloadJsonFile(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};
