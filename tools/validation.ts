export const clampInt = (
  value: number,
  min: number,
  max: number,
  mode: 'round' | 'floor' | 'trunc' = 'round',
): number => {
  let normalized: number;
  if (mode === 'floor') normalized = Math.floor(value);
  else if (mode === 'trunc') normalized = Math.trunc(value);
  else normalized = Math.round(value);
  return Math.max(min, Math.min(max, normalized));
};

/** Parse unknown input to an int clamped to [min, max], or fallback. */
export const clampIntUnknown = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export function isHttpUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

export type HttpUrlValidation = { ok: true; url: string } | { ok: false; error: string; hint?: string };

// Blocks navigation to loopback, link-local and RFC1918 private hosts so a
// model cannot drive the browser (carrying the user's ambient network position
// and cookies) at internal admin panels or the cloud metadata endpoint.
export const isPrivateOrLoopbackHost = (hostname: string): boolean => {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // IPv6 loopback, unspecified, link-local (fe80::/10) and unique-local (fc00::/7).
  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
  if (host.startsWith('fc') || host.startsWith('fd')) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — fall through to the IPv4 test below.
  const ipv4 = host.startsWith('::ffff:') ? host.slice(7) : host;
  const match = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
};

export const requireHttpUrl = (url: string, context = 'URL'): HttpUrlValidation => {
  const trimmed = String(url || '').trim();
  if (!trimmed) {
    return { ok: false, error: `${context} cannot be empty.` };
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      ok: false,
      error: `Invalid URL for ${context}: "${trimmed}". Only http(s) URLs are supported.`,
      hint: 'Use an https:// URL (for searches, use a search engine URL with query params).',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: `Invalid URL for ${context}: "${trimmed}".`,
      hint: 'Provide a well-formed absolute http(s) URL.',
    };
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      error: `Blocked ${context}: "${trimmed}" targets a loopback/private/link-local host.`,
      hint: 'Navigation to internal, localhost or metadata addresses is not allowed.',
    };
  }
  return { ok: true, url: trimmed };
};
