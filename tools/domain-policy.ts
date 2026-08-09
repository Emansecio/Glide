/**
 * Domain allowlist + same-origin helpers shared by httpRequest and CSRF extraction.
 * Mirrors background.ts parseAllowedDomains / isUrlAllowed logic for tool-layer checks.
 */

export function parseAllowedDomains(value = ''): string[] {
  return String(value)
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isUrlAllowedByDomains(url: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return allowlist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/** True when two http(s) URLs share scheme, hostname, and port. */
export function isSameOriginUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
  } catch {
    return false;
  }
}

/** True when redirect target differs in origin from the current request URL. */
export function isCrossOriginRedirect(fromUrl: string, toUrl: string): boolean {
  return !isSameOriginUrl(fromUrl, toUrl);
}
