import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserBridgeClient } from '../../tools/browser-bridge-client.js';

type ChromeMock = { tabs: { sendMessage: ReturnType<typeof vi.fn> } };

const installChrome = (sendMessage: ReturnType<typeof vi.fn>) => {
  (globalThis as unknown as { chrome: ChromeMock }).chrome = { tabs: { sendMessage } };
};

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('BrowserBridgeClient', () => {
  it('routes requests to one explicit frame', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, count: 1 });
    installChrome(sendMessage);

    const response = await new BrowserBridgeClient().send(12, 7, 'findElement', { query: 'Save' });

    expect(response).toMatchObject({ success: true, count: 1 });
    expect(sendMessage).toHaveBeenCalledWith(
      12,
      { type: 'glide_bridge', op: 'findElement', payload: { query: 'Save' } },
      { frameId: 7 },
    );
  });

  it('returns typed bridge-unavailable result', async () => {
    installChrome(vi.fn().mockRejectedValue(new Error('Receiving end does not exist')));

    await expect(new BrowserBridgeClient().send(1, 0, 'findElement', {})).resolves.toMatchObject({
      success: false,
      code: 'BRIDGE_UNAVAILABLE',
      unavailable: true,
    });
  });

  it('honors abort without dispatching', async () => {
    const sendMessage = vi.fn();
    installChrome(sendMessage);
    const controller = new AbortController();
    controller.abort();

    await expect(
      new BrowserBridgeClient().send(1, 0, 'click', { selector: '#save' }, { signal: controller.signal }),
    ).resolves.toMatchObject({ success: false, code: 'ABORTED' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('shares one deadline across frame probes', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockImplementation(
      (_tabId: number, _request: unknown, options: { frameId: number }) =>
        new Promise((resolve) => setTimeout(() => resolve({ success: true, matched: false }), options.frameId * 40)),
    );
    installChrome(sendMessage);

    const pending = new BrowserBridgeClient().probeFrames(3, {
      frameIds: [1, 2, 3],
      op: 'findElement',
      payload: { query: 'Save' },
      timeoutMs: 70,
    });
    await vi.advanceTimersByTimeAsync(71);
    const results = await pending;

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ frameId: 1, response: { success: true } });
    expect(results[1]).toMatchObject({ frameId: 2, response: { success: false, code: 'BRIDGE_TIMEOUT' } });
    expect(results[2]).toMatchObject({ frameId: 3, response: { success: false, code: 'BRIDGE_TIMEOUT' } });
  });
});
