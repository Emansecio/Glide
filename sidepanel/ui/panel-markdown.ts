import { renderMarkdownToHtml } from './markdown-renderer.js';
import { SidePanelUI } from './panel-ui.js';

SidePanelUI.prototype.renderMarkdown = function renderMarkdown(text: string) {
  return renderMarkdownToHtml(text).html;
};
