/** Delimiters for model-facing serialization of untrusted tool/page data. */
export const UNTRUSTED_CONTENT_START = '<untrusted-content';
export const UNTRUSTED_CONTENT_END = '</untrusted-content>';

export function wrapUntrustedContent(body: string, source = 'tool-result'): string {
  const safeSource = String(source || 'tool-result')
    .replace(/[^\w.-]/g, '_')
    .slice(0, 64);
  const text = String(body ?? '');
  return `${UNTRUSTED_CONTENT_START} source="${safeSource}">\n${text}\n${UNTRUSTED_CONTENT_END}`;
}
