import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserBridgeClient } from '../../tools/browser-bridge-client.js';

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('awaited content bridge replacement for injected function registry', () => {
  it('awaits one explicit-frame bridge dispatch without installing a global registry', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, clicked: true });
    (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { sendMessage } };

    const result = await new BrowserBridgeClient().send(9, 3, 'click', { selector: '#save' });

    expect(result).toEqual({ success: true, clicked: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      9,
      { type: 'glide_bridge', op: 'click', payload: { selector: '#save' } },
      { frameId: 3 },
    );
    expect((globalThis as Record<string, unknown>).__glideFnRegistry).toBeUndefined();
  });
});
