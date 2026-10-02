/** Delimiters for model-facing serialization of untrusted tool/page data. */
const UNTRUSTED_CONTENT_START = '<untrusted-content';
const UNTRUSTED_CONTENT_END = '</untrusted-content>';

/** Neutraliza tags de envelope dentro do corpo: página não pode fechar o bloco e injetar instruções. */
export function neutralizeUntrustedEnvelope(text: string): string {
  return text.replace(/<(\/?)(untrusted[-_](?:content|tool_output|data_policy))/gi, '&lt;$1$2');
}

export function wrapUntrustedContent(body: string, source = 'tool-result'): string {
  const safeSource = String(source || 'tool-result')
    .replace(/[^\w.-]/g, '_')
    .slice(0, 64);
  const text = neutralizeUntrustedEnvelope(String(body ?? ''));
  return `${UNTRUSTED_CONTENT_START} source="${safeSource}">\n${text}\n${UNTRUSTED_CONTENT_END}`;
}
