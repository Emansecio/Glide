import { describe, expect, it } from 'vitest';
import { performHttpRequest } from '../../tools/http-request.js';

describe('performHttpRequest awaited legacy coverage', () => {
  it('rejects non-http and private hosts', async () => {
    const bad = await performHttpRequest({ url: 'file:///etc/passwd' });
    expect(bad.success).toBe(false);
    const privateHost = await performHttpRequest({ url: 'http://127.0.0.1/admin' });
    expect(privateHost.success).toBe(false);
  });

  it('returns body from mock fetch', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ users: [{ username: 'a' }], next_max_id: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const result = await performHttpRequest(
      {
        url: 'https://www.instagram.com/api/v1/friendships/1/followers/',
        headers: { 'X-IG-App-ID': '936619743392459' },
      },
      mockFetch as unknown as typeof fetch,
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(String(result.body || '')).toContain('next_max_id');
  });

  it('enforces allowedDomains on redirect hops', async () => {
    expect.assertions(3);
    let calls = 0;
    const mockFetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://evil.example.net/landing' },
        });
      }
      return new Response('nope', { status: 200 });
    };
    const result = await performHttpRequest(
      {
        url: 'https://allowed.example.com/start',
        allowedDomains: ['allowed.example.com'],
      },
      mockFetch as unknown as typeof fetch,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/allowlist|allowed.?domain/i);
    expect(calls).toBe(1);
  });

  it('rejects redirect to private host without following it', async () => {
    expect.assertions(4);
    let calls = 0;
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      expect(init?.redirect).toBe('manual');
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1/secret' },
        });
      }
      return new Response('should not fetch private', { status: 200 });
    };
    const result = await performHttpRequest(
      { url: 'https://example.com/open-redirect' },
      mockFetch as unknown as typeof fetch,
    );
    expect(result.success).toBe(false);
    expect(calls).toBe(1);
    expect(String(result.error || '')).toMatch(/block|127/i);
  });
});
