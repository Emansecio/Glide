import { ATTACHMENT_LIMITS, validateAttachmentBatch } from './attachment-policy.js';
import { SidePanelUI } from './panel-ui.js';

export type PendingAttachment = {
  id: string;
  kind: 'text' | 'image';
  name: string;
  mime: string;
  sizeLabel: string;
  /** Full text for text attachments (truncated). */
  text?: string;
  /** data:image/...;base64,... for image attachments. */
  dataUrl?: string;
  /** Short preview for chips / bubbles. */
  previewUrl?: string;
  /** Original file bytes used by batch budget policy. */
  byteSize?: number;
};

const MAX_TEXT_FILES = 6;
const MAX_IMAGES = 4;
const MAX_TEXT_CHARS = 12_000;
const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.82;
const TEXT_EXTS = new Set([
  'md',
  'txt',
  'csv',
  'json',
  'log',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'html',
  'xml',
  'yml',
  'yaml',
]);
const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i;

function attachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

async function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** Downscale + re-encode to JPEG data URL for lighter multimodal payloads. */
export async function compressImageBlob(
  blob: Blob,
  maxEdge = MAX_IMAGE_EDGE,
  quality = JPEG_QUALITY,
): Promise<{
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
}> {
  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Invalid image'));
      img.src = objectUrl;
    });
    if (img.width * img.height > ATTACHMENT_LIMITS.maxImagePixels) {
      throw new Error(`Imagem excede ${ATTACHMENT_LIMITS.maxImagePixels.toLocaleString()} pixels.`);
    }

    let { width, height } = img;
    const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { dataUrl: await readAsDataUrl(blob), mime: blob.type || 'image/png', width: img.width, height: img.height };
    }
    ctx.drawImage(img, 0, 0, width, height);
    const preferPng = blob.type === 'image/png' && width * height < 900_000;
    return {
      dataUrl: preferPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality),
      mime: preferPng ? 'image/png' : 'image/jpeg',
      width,
      height,
    };
  } finally {
    img.onload = null;
    img.onerror = null;
    img.src = '';
    URL.revokeObjectURL(objectUrl);
  }
}

SidePanelUI.prototype.ensureAttachmentsState = function ensureAttachmentsState() {
  if (!Array.isArray(this.pendingAttachments)) {
    this.pendingAttachments = [] as PendingAttachment[];
  }
  return this.pendingAttachments as PendingAttachment[];
};

SidePanelUI.prototype.countAttachmentsByKind = function countAttachmentsByKind(kind: 'text' | 'image') {
  return this.ensureAttachmentsState().filter((a: PendingAttachment) => a.kind === kind).length;
};

SidePanelUI.prototype.renderPendingAttachments = function renderPendingAttachments() {
  const bar = this.elements.attachmentsBar as HTMLElement | null;
  if (!bar) return;
  const list = this.ensureAttachmentsState() as PendingAttachment[];
  if (!list.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = list
    .map((att) => {
      if (att.kind === 'image') {
        const thumb = att.previewUrl || att.dataUrl || '';
        return `
          <div class="attachment-chip attachment-chip--image" data-att-id="${this.escapeAttribute(att.id)}" title="${this.escapeAttribute(att.name)}">
            <img class="attachment-thumb" src="${this.escapeAttribute(thumb)}" alt="" />
            <span class="attachment-chip-meta">
              <span class="attachment-chip-name">${this.escapeHtmlBasic(att.name)}</span>
              <span class="attachment-chip-size">${this.escapeHtmlBasic(att.sizeLabel)}</span>
            </span>
            <button type="button" class="attachment-chip-remove" data-att-remove="${this.escapeAttribute(att.id)}" title="Remover" aria-label="Remover anexo">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>`;
      }
      return `
        <div class="attachment-chip attachment-chip--file" data-att-id="${this.escapeAttribute(att.id)}" title="${this.escapeAttribute(att.name)}">
          <svg class="attachment-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="attachment-chip-meta">
            <span class="attachment-chip-name">${this.escapeHtmlBasic(att.name)}</span>
            <span class="attachment-chip-size">${this.escapeHtmlBasic(att.sizeLabel)}</span>
          </span>
          <button type="button" class="attachment-chip-remove" data-att-remove="${this.escapeAttribute(att.id)}" title="Remover" aria-label="Remover anexo">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>`;
    })
    .join('');

  bar.querySelectorAll('[data-att-remove]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = (btn as HTMLElement).getAttribute('data-att-remove') || '';
      this.removePendingAttachment?.(id);
    });
  });
};

SidePanelUI.prototype.removePendingAttachment = function removePendingAttachment(id: string) {
  const list = this.ensureAttachmentsState() as PendingAttachment[];
  this.pendingAttachments = list.filter((a) => a.id !== id);
  this.renderPendingAttachments();
};

SidePanelUI.prototype.clearPendingAttachments = function clearPendingAttachments() {
  this.pendingAttachments = [];
  this.renderPendingAttachments();
};

SidePanelUI.prototype.addPendingAttachment = function addPendingAttachment(att: PendingAttachment) {
  const list = this.ensureAttachmentsState() as PendingAttachment[];
  if (att.kind === 'image' && this.countAttachmentsByKind('image') >= MAX_IMAGES) {
    this.showErrorBanner?.(`Máximo de ${MAX_IMAGES} imagens por mensagem.`);
    return false;
  }
  if (att.kind === 'text' && this.countAttachmentsByKind('text') >= MAX_TEXT_FILES) {
    this.showErrorBanner?.(`Máximo de ${MAX_TEXT_FILES} arquivos de texto por mensagem.`);
    return false;
  }
  list.push(att);
  this.renderPendingAttachments();
  return true;
};

SidePanelUI.prototype.addImageFromBlob = async function addImageFromBlob(
  blob: Blob,
  name = 'print.png',
  prevalidated = false,
) {
  try {
    if (!prevalidated) {
      const decision = validateAttachmentBatch(this.ensureAttachmentsState(), [
        { name, type: blob.type, size: blob.size },
      ])[0];
      if (!decision.accepted) {
        this.showErrorBanner?.(decision.reason || 'Anexo rejeitado.');
        return false;
      }
    }
    const compressed = await compressImageBlob(blob);
    const att: PendingAttachment = {
      id: attachmentId(),
      kind: 'image',
      name,
      mime: compressed.mime,
      sizeLabel: `${compressed.width}×${compressed.height}`,
      dataUrl: compressed.dataUrl,
      previewUrl: compressed.dataUrl,
      byteSize: blob.size,
    };
    if (this.addPendingAttachment(att)) {
      this.updateStatus?.('Print anexado', 'success');
      return true;
    }
  } catch (error) {
    console.warn('[Glide] Failed to attach image:', error);
    this.showErrorBanner?.('Não foi possível anexar a imagem.');
  }
  return false;
};

SidePanelUI.prototype.handleFileSelection = async function handleFileSelection(event: Event) {
  const input = event.target as HTMLInputElement | null;
  if (!input) return;
  const files = Array.from(input.files || []) as File[];
  input.value = '';
  if (!files.length) return;

  const decisions = validateAttachmentBatch(this.ensureAttachmentsState(), files);
  for (const [index, file] of files.entries()) {
    const decision = decisions[index];
    if (!decision.accepted) {
      this.showErrorBanner?.(decision.reason || `${file.name}: anexo rejeitado.`);
      continue;
    }
    const mime = file.type || '';
    const ext = fileExt(file.name);

    if (decision.kind === 'image') {
      await this.addImageFromBlob(file, file.name || 'image.png', true);
      continue;
    }

    if (!TEXT_EXTS.has(ext) && mime && !mime.startsWith('text/') && mime !== 'application/json') {
      this.showErrorBanner?.(`Tipo não suportado: ${file.name}. Use texto ou imagem (png/jpg/webp).`);
      continue;
    }

    try {
      const raw = await file.text();
      const trimmed =
        raw.length > MAX_TEXT_CHARS
          ? `${raw.slice(0, MAX_TEXT_CHARS)}\n\n… (truncado em ${MAX_TEXT_CHARS} caracteres)`
          : raw;
      const att: PendingAttachment = {
        id: attachmentId(),
        kind: 'text',
        name: file.name || 'arquivo.txt',
        mime: mime || 'text/plain',
        sizeLabel: formatBytes(file.size),
        text: trimmed,
        byteSize: file.size,
      };
      this.addPendingAttachment(att);
    } catch (error) {
      console.warn('[Glide] Failed to read file:', file.name, error);
      this.showErrorBanner?.(`Falha ao ler ${file.name}.`);
    }
  }
  this.elements.userInput?.focus();
};

/**
 * Ctrl/Cmd+V: if clipboard has an image, attach it (do not paste binary garbage into textarea).
 */
SidePanelUI.prototype.handleComposerPaste = async function handleComposerPaste(event: ClipboardEvent) {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.kind === 'file' && IMAGE_MIME.test(item.type));
  if (!imageItem) return; // let default paste handle text

  event.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await this.addImageFromBlob(file, `print-${stamp}.png`);
};

/** Build multimodal content for the model (text + images). */
SidePanelUI.prototype.buildAttachmentModelContent = function buildAttachmentModelContent(
  userText: string,
  attachments: PendingAttachment[],
): string | Array<Record<string, unknown>> {
  const textBlocks: string[] = [];
  if (userText.trim()) textBlocks.push(userText.trim());

  const images: string[] = [];
  for (const att of attachments) {
    if (att.kind === 'text' && att.text) {
      textBlocks.push(`<attached_file name="${att.name}">\n${att.text}\n</attached_file>`);
    } else if (att.kind === 'image' && att.dataUrl) {
      images.push(att.dataUrl);
      textBlocks.push(`[Imagem anexada: ${att.name}]`);
    }
  }

  const combinedText = textBlocks.join('\n\n');
  if (!images.length) return combinedText || userText;

  const parts: Array<Record<string, unknown>> = [];
  if (combinedText) parts.push({ type: 'text', text: combinedText });
  for (const dataUrl of images) {
    parts.push({ type: 'image', image: dataUrl });
  }
  return parts;
};

/** Human-readable display body (no huge base64 dumps). */
SidePanelUI.prototype.buildAttachmentDisplayHtml = function buildAttachmentDisplayHtml(
  userText: string,
  attachments: PendingAttachment[],
): string {
  const parts: string[] = [];
  if (userText.trim()) {
    parts.push(`<div class="message-content">${this.escapeHtml(userText.trim())}</div>`);
  }
  if (attachments.length) {
    const chips = attachments
      .map((att) => {
        if (att.kind === 'image') {
          const src = att.previewUrl || att.dataUrl || '';
          return `<div class="message-attachment message-attachment--image">
            <img src="${this.escapeAttribute(src)}" alt="${this.escapeAttribute(att.name)}" />
            <span>${this.escapeHtmlBasic(att.name)}</span>
          </div>`;
        }
        const preview = (att.text || '').slice(0, 280);
        return `<div class="message-attachment message-attachment--file">
          <div class="message-attachment-title">${this.escapeHtmlBasic(att.name)} · ${this.escapeHtmlBasic(att.sizeLabel)}</div>
          <pre class="message-attachment-preview">${this.escapeHtml(preview)}${(att.text || '').length > 280 ? '…' : ''}</pre>
        </div>`;
      })
      .join('');
    parts.push(`<div class="message-attachments">${chips}</div>`);
  }
  return parts.join('') || `<div class="message-content"></div>`;
};
