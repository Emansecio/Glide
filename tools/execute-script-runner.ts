/**
 * Helpers for the executeScript tool.
 *
 * Page CSP on sites like Instagram blocks `new Function` / `eval` in the MAIN
 * world. Extension-injected code in the ISOLATED world is not subject to page
 * CSP, so that is the default execution world.
 *
 * `runUserScriptInPage` is intentionally self-contained (no outer closures) so
 * chrome.scripting.executeScript can serialize and inject it as `func`.
 * It is async so chrome.scripting waits when user code returns a Promise
 * (fetch pagination loops, etc.).
 */

export type ExecuteScriptWorld = 'ISOLATED' | 'MAIN';

export type ExecuteScriptInjectionResult =
  | {
      ok: true;
      value: unknown;
      valueType: string;
      serializedAs?: 'json' | 'string' | 'null';
      awaited?: boolean;
    }
  | {
      ok: false;
      error: string;
      phase: 'compile' | 'runtime' | 'serialize';
      cspLikely?: boolean;
    };

/** True when the error looks like page CSP blocking eval / new Function. */
export function isCspEvalError(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('content security policy') ||
    m.includes('unsafe-eval') ||
    m.includes('refused to evaluate') ||
    m.includes('eval is disabled') ||
    (m.includes('csp') && (m.includes('eval') || m.includes('script')))
  );
}

/**
 * Build a Function body from user code. Accepts either a statement list with
 * `return`, or a bare expression (auto-wrapped as `return (expr)`).
 * Top-level `await` is wrapped in an async IIFE so fetch loops work.
 */
export function buildExecutableBody(code: string): string {
  const body = String(code || '').trim();
  if (!body) return 'return undefined;';

  // Already an async IIFE the model wrote — leave as-is (ensure return).
  if (/^\s*return\s*\(\s*async\s*\(/.test(body) || /^\s*\(\s*async\s*\(/.test(body)) {
    if (/\breturn\b/.test(body)) return body;
    return `return ${body}`;
  }

  const hasAwait = /\bawait\b/.test(body);
  if (hasAwait) {
    // new Function cannot be async itself; wrap so top-level await is valid.
    if (/\breturn\b/.test(body)) {
      return `return (async () => { ${body} })();`;
    }
    return `return (async () => { ${body} })();`;
  }

  if (/\breturn\b/.test(body)) return body;
  // Statements / multi-line — run as-is (caller should use return for a value).
  if (
    body.includes(';') ||
    body.includes('\n') ||
    /^(var|let|const|if|for|while|switch|try|class|function|async|do|throw|with)\b/.test(body)
  ) {
    return body;
  }
  // Bare expression / call / assignment — return its value.
  return `return (${body});`;
}

function looksLikePromise(value: unknown): value is Promise<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Runs inside the tab (serialized by chrome.scripting.executeScript).
 * Must stay free of closures over outer scope — duplicate helpers inline.
 * Returns a Promise so chrome.scripting waits for async user code.
 */
export async function runUserScriptInPage(source: string): Promise<ExecuteScriptInjectionResult> {
  // Inline buildExecutableBody (must stay self-contained for chrome.scripting).
  const raw = String(source || '').trim() || 'return undefined;';
  let withReturn = raw;
  if (!/^\s*return\s*\(\s*async\s*\(/.test(raw) && !/^\s*\(\s*async\s*\(/.test(raw)) {
    if (/\bawait\b/.test(raw)) {
      withReturn = `return (async () => { ${raw} })();`;
    } else if (/\breturn\b/.test(raw)) {
      withReturn = raw;
    } else if (
      raw.includes(';') ||
      raw.includes('\n') ||
      /^(var|let|const|if|for|while|switch|try|class|function|async|do|throw|with)\b/.test(raw)
    ) {
      withReturn = raw;
    } else {
      withReturn = `return (${raw});`;
    }
  } else if (!/\breturn\b/.test(raw)) {
    withReturn = `return ${raw}`;
  }

  const cspLikely = (message: string) => {
    const m = String(message || '').toLowerCase();
    return (
      m.includes('content security policy') ||
      m.includes('unsafe-eval') ||
      m.includes('refused to evaluate') ||
      m.includes('eval is disabled') ||
      (m.includes('csp') && (m.includes('eval') || m.includes('script')))
    );
  };

  let fn: (...args: never[]) => unknown;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(withReturn) as (...args: never[]) => unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      phase: 'compile',
      cspLikely: cspLikely(message),
    };
  }

  let value: unknown;
  let awaited = false;
  try {
    value = fn();
    if (looksLikePromise(value)) {
      value = await value;
      awaited = true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      phase: 'runtime',
      cspLikely: cspLikely(message),
    };
  }

  if (value === undefined) {
    return { ok: true, value: null, valueType: 'undefined', serializedAs: 'null', awaited };
  }

  const limited = truncateExecuteScriptValue(value);
  return {
    ok: true,
    value: limited.value,
    valueType: typeof value,
    serializedAs: limited.serializedAs,
    awaited,
    ...(limited.truncated ? { truncated: true } : {}),
  };
}

export function resolveExecuteScriptWorld(raw: unknown): ExecuteScriptWorld {
  const v = String(raw || '')
    .trim()
    .toUpperCase();
  return v === 'MAIN' ? 'MAIN' : 'ISOLATED';
}

/** Default / max timeout for executeScript (pagination loops need headroom). */
export const EXECUTE_SCRIPT_DEFAULT_TIMEOUT_MS = 60000;
export const EXECUTE_SCRIPT_MAX_TIMEOUT_MS = 120000;
export const EXECUTE_SCRIPT_MIN_TIMEOUT_MS = 1000;
/** Cap serialized executeScript results to avoid unbounded JSON buffering. */
export const EXECUTE_SCRIPT_MAX_RESULT_CHARS = 100_000;

export function truncateExecuteScriptValue(
  value: unknown,
  maxChars: number = EXECUTE_SCRIPT_MAX_RESULT_CHARS,
): { value: unknown; truncated: boolean; serializedAs: 'json' | 'string' | 'null' } {
  if (value === undefined || value === null) {
    return { value: null, truncated: false, serializedAs: 'null' };
  }
  try {
    let json = JSON.stringify(value);
    if (json.length <= maxChars) {
      return { value: JSON.parse(json) as unknown, truncated: false, serializedAs: 'json' };
    }
    json = json.slice(0, maxChars);
    return {
      value: `${json}…[truncated]`,
      truncated: true,
      serializedAs: 'string',
    };
  } catch {
    const text = String(value);
    if (text.length <= maxChars) {
      return { value: text, truncated: false, serializedAs: 'string' };
    }
    return {
      value: `${text.slice(0, maxChars)}…[truncated]`,
      truncated: true,
      serializedAs: 'string',
    };
  }
}

/** MAIN→ISOLATED retry is safe only for pre-execution compile/CSP failures. */
export function shouldAllowMainToIsolatedFallback(outcome: {
  ok: false;
  phase?: string;
  timedOut?: boolean;
  cspLikely?: boolean;
  error?: string;
}): boolean {
  if (outcome.ok !== false || outcome.timedOut) return false;
  if (outcome.phase !== 'compile') return false;
  return Boolean(outcome.cspLikely) || isCspEvalError(String(outcome.error || ''));
}

export function resolveExecuteScriptTimeoutMs(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return EXECUTE_SCRIPT_DEFAULT_TIMEOUT_MS;
  return Math.min(EXECUTE_SCRIPT_MAX_TIMEOUT_MS, Math.max(EXECUTE_SCRIPT_MIN_TIMEOUT_MS, Math.round(n)));
}
