export type HistoryPersistenceMode = 'full' | 'redacted' | 'off';

const REDACTED = (length: number) => `<redacted:${length} chars>`;

const SENSITIVE_KEY_RE = /apikey|api_key|token|secret|password|authorization|credential|cookie|csrftoken|set-cookie/i;

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function safeOrigin(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function redactSensitiveRecord(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = typeof value === 'string' ? REDACTED(value.length) : '[redacted]';
      continue;
    }
    if (typeof value === 'string' && (value.startsWith('data:') || value.length > 4000)) {
      out[key] = REDACTED(value.length);
      continue;
    }
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      out[key] = '[omitted]';
      continue;
    }
    out[key] = value;
  }
  return out;
}

function redactFillFormFields(fields: unknown): unknown {
  if (!Array.isArray(fields)) return undefined;
  return fields.slice(0, 20).map((field) => {
    if (!field || typeof field !== 'object') return { field: '[invalid]' };
    const row = field as Record<string, unknown>;
    const text = typeof row.text === 'string' ? row.text : '';
    return {
      selector: typeof row.selector === 'string' ? row.selector : undefined,
      hasText: Boolean(text),
      textLength: text.length,
      text: text ? '[redacted]' : undefined,
      checked: typeof row.checked === 'boolean' ? row.checked : undefined,
      option: row.option ? '[redacted]' : undefined,
    };
  });
}

/**
 * Allowlist-oriented sanitizer for persisted tool-call arguments.
 * Runtime execution still sees the raw args; only the stored copy is redacted.
 */
export function sanitizeToolCallForPersistence(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  mode: HistoryPersistenceMode = 'redacted',
): Record<string, unknown> {
  const source = args && typeof args === 'object' ? cloneRecord(args) : {};
  if (mode === 'full') return source;
  if (mode === 'off') return { _omitted: true };

  switch (toolName) {
    case 'type':
    case 'pressKey':
      return {
        selector: source.selector,
        ref: source.ref,
        key: source.key,
        textLength: typeof source.text === 'string' ? source.text.length : 0,
        text: typeof source.text === 'string' ? '[redacted]' : undefined,
      };
    case 'fillForm':
      return {
        fields: redactFillFormFields(source.fields),
        submit: source.submit,
        submitSelector: source.submitSelector,
      };
    case 'httpRequest':
      return {
        method: source.method || 'GET',
        origin: safeOrigin(source.url),
        headers: source.headers ? '[redacted]' : undefined,
        body: typeof source.body === 'string' ? REDACTED(source.body.length) : undefined,
      };
    case 'clipboard':
      return {
        action: source.action || source.mode || source.operation,
      };
    case 'executeScript': {
      const code = typeof source.code === 'string' ? source.code : '';
      return {
        codeLength: code.length,
        codeHash: code ? shortHash(code) : undefined,
        world: source.world,
        timeoutMs: source.timeoutMs,
      };
    }
    case 'setInputFiles':
      return {
        selector: source.selector,
        name: source.name || source.fileName,
        type: source.type || source.mimeType,
        size: source.size || source.byteLength,
      };
    case 'screenshot':
    case 'annotatedScreenshot':
    case 'elementScreenshot':
      return {
        selector: source.selector,
        ref: source.ref,
        tabId: source.tabId,
      };
    default:
      return redactSensitiveRecord(source);
  }
}

export function resolveHistoryPersistenceMode(raw: unknown): HistoryPersistenceMode {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (value === 'full' || value === 'off') return value;
  return 'redacted';
}
