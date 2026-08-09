/**
 * Pure graders for live model correctness checks.
 * Kept free of network so unit tests can exercise the same rubrics.
 */

export type CorrectnessCase = {
  id: string;
  /** Short label for logs */
  name: string;
  /** User message sent to the model */
  prompt: string;
  /** Optional system message */
  system?: string;
  maxOutputTokens?: number;
  /**
   * Returns null when the response passes; otherwise a short failure reason.
   * Graders should be tolerant of light formatting (markdown, trailing period).
   */
  grade: (text: string) => string | null;
};

const normalize = (text: string) =>
  String(text || '')
    .replace(/\r\n/g, '\n')
    .trim();

const collapseWs = (text: string) => normalize(text).replace(/\s+/g, ' ');

/** First non-empty line, stripped of common markdown fences / bullets. */
export const firstContentLine = (text: string): string => {
  const lines = normalize(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^```/.test(line));
  return (lines[0] || '').replace(/^[-*•]\s+/, '').replace(/^["'`]+|["'`]+$/g, '');
};

export const extractJsonObject = (text: string): Record<string, unknown> | null => {
  const raw = normalize(text);
  // Prefer fenced ```json blocks
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const MODEL_CORRECTNESS_CASES: CorrectnessCase[] = [
  {
    id: 'exact-token',
    name: 'Exact token reply',
    prompt: 'Reply with exactly this token and nothing else: GLIDE_PING',
    maxOutputTokens: 32,
    grade: (text) => {
      const body = collapseWs(text);
      if (body === 'GLIDE_PING' || body.includes('GLIDE_PING')) return null;
      return `expected GLIDE_PING, got: ${body.slice(0, 120)}`;
    },
  },
  {
    id: 'arithmetic',
    name: 'Simple arithmetic',
    prompt:
      'What is 17 + 25? Reply with only the numeric answer (digits only). No words, no punctuation, no explanation.',
    maxOutputTokens: 16,
    grade: (text) => {
      const line = firstContentLine(text).replace(/[^\d-]/g, '');
      if (line === '42') return null;
      // Allow the number anywhere if the model adds a short prefix
      if (/\b42\b/.test(collapseWs(text))) return null;
      return `expected 42, got: ${collapseWs(text).slice(0, 120)}`;
    },
  },
  {
    id: 'json-object',
    name: 'Structured JSON object',
    prompt:
      'Return ONLY a JSON object (no markdown fence if possible) with exactly these keys: ' +
      '{"status":"ok","n":3,"label":"glide"}. Do not add extra keys or prose.',
    maxOutputTokens: 80,
    grade: (text) => {
      const obj = extractJsonObject(text);
      if (!obj) return `no JSON object found in: ${collapseWs(text).slice(0, 120)}`;
      if (obj.status !== 'ok') return `status expected "ok", got ${JSON.stringify(obj.status)}`;
      if (obj.n !== 3 && obj.n !== '3') return `n expected 3, got ${JSON.stringify(obj.n)}`;
      if (String(obj.label).toLowerCase() !== 'glide') {
        return `label expected "glide", got ${JSON.stringify(obj.label)}`;
      }
      return null;
    },
  },
  {
    id: 'language-pt',
    name: 'Portuguese yes/no',
    prompt:
      'Responda em português com uma única palavra: sim ou não. ' +
      'Pergunta: o céu é azul durante um dia claro de sol? Apenas a palavra, sem pontuação.',
    maxOutputTokens: 24,
    grade: (text) => {
      const line = firstContentLine(text)
        .toLowerCase()
        .replace(/[^\p{L}]/gu, '');
      if (line === 'sim' || line.startsWith('sim')) return null;
      if (/\bsim\b/i.test(collapseWs(text))) return null;
      return `expected "sim", got: ${collapseWs(text).slice(0, 120)}`;
    },
  },
  {
    id: 'no-tools-chat',
    name: 'Direct chat without tool markup',
    system: 'You are a chat assistant. Answer briefly. Do not call tools. Do not emit XML or function-call markup.',
    prompt: 'In one short sentence, what is the capital of France?',
    maxOutputTokens: 64,
    grade: (text) => {
      const body = collapseWs(text);
      if (!body) return 'empty response';
      if (/<\s*(tool|function)_call/i.test(text)) return 'response contains tool_call markup';
      if (/\btool_calls\b/i.test(text) && /\{/.test(text)) return 'response looks like tool_calls JSON';
      if (!/paris/i.test(body)) return `expected Paris mentioned, got: ${body.slice(0, 120)}`;
      return null;
    },
  },
];

export type CaseResult = {
  id: string;
  name: string;
  pass: boolean;
  reason?: string;
  latencyMs: number;
  responsePreview: string;
};

export type CorrectnessReport = {
  model: string;
  endpoint: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: CaseResult[];
};

export function summarizeCorrectness(
  results: CaseResult[],
  meta: { model: string; endpoint: string },
): CorrectnessReport {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  return {
    model: meta.model,
    endpoint: meta.endpoint,
    total: results.length,
    passed,
    failed,
    passRate: results.length ? passed / results.length : 0,
    results,
  };
}

/** Minimum pass rate for the live suite to succeed (override via GLIDE_CORRECTNESS_MIN_PASS). */
export function resolveMinPassRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.GLIDE_CORRECTNESS_MIN_PASS);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  // Default: 80% — small models may miss strict formatting occasionally.
  return 0.8;
}
