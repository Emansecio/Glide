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
const isPrivateOrLoopbackHost = (hostname: string): boolean => {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    // FQDN com ponto final (`localhost.`, `x.local.`) resolve igual ao nome sem ponto.
    .replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // Nomes de rede local: `.local` (mDNS/Bonjour) resolve para impressoras, NAS e
  // roteadores da LAN; `.internal` e `.home.arpa` são reservados para uso interno.
  // Sem isto, `http://router.local/` passava pelo guard e o agente podia dirigir o
  // navegador (com os cookies e a posição de rede do usuário) a um painel interno.
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (host === 'local' || host === 'internal') return true;
  // IPv6 loopback, unspecified, link-local (fe80::/10) and unique-local (fc00::/7).
  if (host === '::1' || host === '::') return true;
  // Prefixos só valem para literais IPv6; sem `:` bloqueariam domínios como febraban.org.br.
  if (host.includes(':')) {
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb'))
      return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
  }
  // IPv4-mapped IPv6. `new URL()` canoniza `::ffff:169.254.169.254` para a forma
  // HEX `::ffff:a9fe:a9fe`, então testar só o sufixo decimal (host.slice(7))
  // deixava passar loopback/metadata/RFC1918 disfarçados. Reconstruímos o IPv4 a
  // partir de QUALQUER forma do sufixo; o que não for IPv4 mapeado reconhecível é
  // bloqueado por precaução.
  let ipv4 = host;
  if (host.startsWith('::ffff:')) {
    const suffix = host.slice(7);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(suffix)) {
      ipv4 = suffix;
    } else {
      const groups = suffix.split(':');
      if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
        const hi = Number.parseInt(groups[0], 16);
        const lo = Number.parseInt(groups[1], 16);
        ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      } else {
        // Sufixo IPv4-mapped não reconhecido: trata como privado (fail-closed).
        return true;
      }
    }
  }
  const match = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // CGNAT (100.64.0.0/10): faixa de operadora, não roteável na internet pública —
    // alcança equipamentos do provedor/rede compartilhada.
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 192.0.0.0/24 (protocol assignments) e 198.18.0.0/15 (benchmarking).
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
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
