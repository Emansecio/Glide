import { SidePanelUI } from './panel-ui.js';

// Reusable element for escapeHtmlBasic (avoids creating DOM element per call)
let escapeHelperDiv: HTMLDivElement | null = null;

// HTML entities map for fast string-based escaping
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

(SidePanelUI.prototype as any).safeJsonStringify = function safeJsonStringify(value: any) {
  try {
    if (value === undefined) return '';
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
};

(SidePanelUI.prototype as any).truncateText = function truncateText(text: string, limit = 1200) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
};

(SidePanelUI.prototype as any).escapeHtmlBasic = function escapeHtmlBasic(text: string) {
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

(SidePanelUI.prototype as any).escapeHtml = function escapeHtml(text: string) {
  return this.escapeHtmlBasic(text).replace(/\n/g, '<br>');
};

(SidePanelUI.prototype as any).escapeAttribute = function escapeAttribute(value: string) {
  return this.escapeHtmlBasic(value).replace(/"/g, '&quot;');
};
