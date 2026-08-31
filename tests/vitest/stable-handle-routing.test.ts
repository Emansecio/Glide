import { describe, expect, it, vi } from 'vitest';
import { BrowserTools } from '../../tools/browser-tools.js';
import type { StableElementHandle } from '../../tools/stable-element-handle.js';

const handle: StableElementHandle = {
  version: 1,
  snapshotId: 'snapshot-1',
  ref: 'e1',
  tabId: 7,
  frameId: 2,
  selector: '#target',
  fingerprint: { tag: 'button', accessibleName: 'Original' },
  domRevision: 1,
};

const resolvedTab = {
  ok: true as const,
  resolution: {
    tabId: 7,
    tab: { id: 7, url: 'https://example.com/' },
    requestedTabId: 7,
    fallbackUsed: false,
  },
};

type BrowserToolsInternals = {
  runInTab: (...args: unknown[]) => Promise<Record<string, unknown>>;
  prepareFrameInjection: (...args: unknown[]) => Promise<{
    ok: true;
    runOptions: { frameId: number };
    frameMeta: { targetFrameId: number; targetFrameUrl: string };
  }>;
  bridgeClient: {
    send: (...args: unknown[]) => Promise<Record<string, unknown>>;
  };
};

const internalsOf = (tools: BrowserTools) => tools as unknown as BrowserToolsInternals;

const installResolvedTab = (tools: BrowserTools) => {
  vi.spyOn(tools, 'resolveExecutableTab').mockResolvedValue(resolvedTab);
};

describe('stable handle routing', () => {
  it('fails closed when handle verification bridge is disabled', async () => {
    const tools = new BrowserTools();
    installResolvedTab(tools);
    tools.setUseContentBridge(false);
    const runInTab = vi.spyOn(internalsOf(tools), 'runInTab').mockResolvedValue({ success: true });

    const result = await tools.executeTool('click', {
      selector: handle.selector,
      handle,
      tabId: 7,
      waitForDialog: false,
    });

    expect(result).toMatchObject({
      success: false,
      code: 'BRIDGE_UNAVAILABLE',
      outcomeCertainty: 'known_not_executed',
    });
    expect(runInTab).not.toHaveBeenCalled();
  });

  it('routes handle plus frameUrl through resolved bridge frame', async () => {
    const tools = new BrowserTools();
    installResolvedTab(tools);
    const internals = internalsOf(tools);
    vi.spyOn(internals, 'prepareFrameInjection').mockResolvedValue({
      ok: true,
      runOptions: { frameId: 5 },
      frameMeta: { targetFrameId: 5, targetFrameUrl: 'https://example.com/child' },
    });
    const send = vi.spyOn(internals.bridgeClient, 'send').mockResolvedValue({
      success: false,
      code: 'STALE_ELEMENT_HANDLE',
      error: 'Handle belongs to another frame.',
    });
    const runInTab = vi.spyOn(internals, 'runInTab').mockResolvedValue({ success: true });

    const result = await tools.type({
      selector: handle.selector,
      handle,
      text: 'do not type',
      frameUrl: '/child',
    });

    expect(send).toHaveBeenCalledWith(
      7,
      5,
      'type',
      expect.objectContaining({ handle, text: 'do not type' }),
      expect.any(Object),
    );
    expect(result).toMatchObject({ success: false, code: 'STALE_ELEMENT_HANDLE', targetFrameId: 5 });
    expect(runInTab).not.toHaveBeenCalled();
  });

  it('routes handle plus frameSelector through resolved bridge frame', async () => {
    const tools = new BrowserTools();
    installResolvedTab(tools);
    const internals = internalsOf(tools);
    vi.spyOn(internals, 'prepareFrameInjection').mockResolvedValue({
      ok: true,
      runOptions: { frameId: 2 },
      frameMeta: { targetFrameId: 2, targetFrameUrl: 'https://example.com/child' },
    });
    const send = vi.spyOn(internals.bridgeClient, 'send').mockResolvedValue({
      success: false,
      code: 'STALE_ELEMENT_HANDLE',
      error: 'Handle fingerprint changed.',
    });
    const runInTab = vi.spyOn(internals, 'runInTab').mockResolvedValue({ success: true });

    const result = await tools.selectOption({
      selector: handle.selector,
      handle,
      label: 'Replacement',
      frameSelector: '#child-frame',
    });

    expect(send).toHaveBeenCalledWith(
      7,
      2,
      'selectOption',
      expect.objectContaining({ handle, label: 'Replacement' }),
      expect.any(Object),
    );
    expect(result).toMatchObject({ success: false, code: 'STALE_ELEMENT_HANDLE', targetFrameId: 2 });
    expect(runInTab).not.toHaveBeenCalled();
  });
});
