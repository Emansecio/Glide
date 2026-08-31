import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTools } from '../../tools/browser-tools.js';

type ListenerEvent<T> = {
  addListener(listener: T): void;
  removeListener(listener: T): void;
};

const event = <T>(): ListenerEvent<T> => {
  const listeners = new Set<T>();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('captureDownload outcome certainty', () => {
  it('marks direct-start timeout unknown after one download dispatch', async () => {
    vi.useFakeTimers();
    const download = vi.fn().mockResolvedValue(42);
    vi.stubGlobal('chrome', {
      downloads: {
        onCreated: event<(item: chrome.downloads.DownloadItem) => void>(),
        onChanged: event<(delta: chrome.downloads.DownloadDelta) => void>(),
        download,
        search: vi.fn().mockResolvedValue([]),
      },
    });
    const tools = new BrowserTools();
    vi.spyOn(tools, 'resolveExecutableTab').mockResolvedValue({
      ok: true,
      resolution: {
        tabId: 7,
        tab: { id: 7, url: 'https://example.com/' },
        requestedTabId: 7,
        fallbackUsed: false,
      },
    });

    const pending = tools.captureDownload({
      tabId: 7,
      url: 'https://example.com/report.csv',
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1001);
    const result = await pending;

    expect(download).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      code: 'DOWNLOAD_TIMEOUT',
      outcomeCertainty: 'unknown',
    });
  });
});
