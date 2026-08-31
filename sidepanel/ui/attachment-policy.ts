export const ATTACHMENT_LIMITS = {
  textBytes: 2_000_000,
  imageBytes: 10_000_000,
  totalBytes: 24_000_000,
  maxImagePixels: 20_000_000,
} as const;

export type PendingAttachmentMeta = {
  kind: 'text' | 'image';
  byteSize?: number;
  text?: string;
  dataUrl?: string;
};

export type FileLike = {
  name: string;
  type?: string;
  size: number;
  text?: () => unknown;
  arrayBuffer?: () => unknown;
};

export type AttachmentDecision = {
  accepted: boolean;
  kind: 'text' | 'image';
  reason?: string;
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const TEXT_EXTENSIONS = new Set([
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
const MAX_TEXT_FILES = 6;
const MAX_IMAGES = 4;

function extensionFor(file: FileLike): string {
  return file.name.split('.').pop()?.toLowerCase() || '';
}

function kindFor(file: FileLike): 'text' | 'image' {
  const extension = extensionFor(file);
  return IMAGE_MIME.test(file.type || '') || IMAGE_EXTENSIONS.has(extension) ? 'image' : 'text';
}

function isSupportedText(file: FileLike): boolean {
  const mime = file.type || '';
  return TEXT_EXTENSIONS.has(extensionFor(file)) || mime.startsWith('text/') || mime === 'application/json' || !mime;
}

function existingBytes(item: PendingAttachmentMeta): number {
  if (Number.isFinite(item.byteSize)) return Math.max(0, Number(item.byteSize));
  if (item.text) return new TextEncoder().encode(item.text).length;
  if (item.dataUrl) return Math.floor(item.dataUrl.length * 0.75);
  return 0;
}

export function validateAttachmentBatch(existing: PendingAttachmentMeta[], files: FileLike[]): AttachmentDecision[] {
  let total = existing.reduce((sum, item) => sum + existingBytes(item), 0);
  let textCount = existing.filter((item) => item.kind === 'text').length;
  let imageCount = existing.filter((item) => item.kind === 'image').length;

  return files.map((file) => {
    const kind = kindFor(file);
    const size = Math.max(0, Number(file.size || 0));
    if (kind === 'text' && !isSupportedText(file)) {
      return { accepted: false, kind, reason: `${file.name}: tipo não suportado. Use texto ou imagem.` };
    }
    if (kind === 'text' && size > ATTACHMENT_LIMITS.textBytes) {
      return { accepted: false, kind, reason: `${file.name}: arquivo de texto excede 2 MB.` };
    }
    if (kind === 'image' && size > ATTACHMENT_LIMITS.imageBytes) {
      return { accepted: false, kind, reason: `${file.name}: imagem excede 10 MB.` };
    }
    if (kind === 'text' && textCount >= MAX_TEXT_FILES) {
      return { accepted: false, kind, reason: `Máximo de ${MAX_TEXT_FILES} arquivos de texto por mensagem.` };
    }
    if (kind === 'image' && imageCount >= MAX_IMAGES) {
      return { accepted: false, kind, reason: `Máximo de ${MAX_IMAGES} imagens por mensagem.` };
    }
    if (total + size > ATTACHMENT_LIMITS.totalBytes) {
      return { accepted: false, kind, reason: `${file.name}: anexos excedem limite total de 24 MB.` };
    }
    total += size;
    if (kind === 'image') imageCount += 1;
    else textCount += 1;
    return { accepted: true, kind };
  });
}
