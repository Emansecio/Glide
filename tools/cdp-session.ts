/**
 * Opt-in Chrome DevTools Protocol (chrome.debugger).
 * Default off via toolPermissions.debugger — attach paints the yellow infobar.
 */

import { requireHttpUrl } from './validation.js';

const PROTOCOL = '1.3';
const attachedTabs = new Set<number>();
let detachHooked = false;

const lastError = (): string | null => {
  const err = chrome.runtime?.lastError;
  return err?.message ? String(err.message) : null;
};

const promisify = <T>(run: (cb: (value?: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => {
    run((value) => {
      const err = lastError();
      if (err) reject(new Error(err));
      else resolve(value as T);
    });
  });

const hookDetach = () => {
  if (detachHooked || !chrome.debugger?.onDetach) return;
  detachHooked = true;
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source?.tabId === 'number') attachedTabs.delete(source.tabId);
  });
};

export async function cdpAttach(tabId: number): Promise<Record<string, unknown>> {
  hookDetach();
  if (attachedTabs.has(tabId)) {
    return {
      success: true,
      tabId,
      alreadyAttached: true,
      hint: 'Debugger already attached. Use cdp({ action: "send", method, params }).',
    };
  }
  try {
    await promisify<void>((cb) => chrome.debugger.attach({ tabId }, PROTOCOL, cb as () => void));
    attachedTabs.add(tabId);
    return {
      success: true,
      tabId,
      protocol: PROTOCOL,
      hint: 'Attached. Chrome shows a debugger banner. Prefer page tools when enough; use Network/Runtime/Input via action:"send".',
    };
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    // Service worker restart clears our Set while Chrome still holds the session.
    if (/already attached|Another debugger is already attached/i.test(message)) {
      let ownedByGlide = false;
      try {
        const targets = await promisify<Array<{ tabId?: number; attached?: boolean; extensionId?: string }>>((cb) =>
          chrome.debugger.getTargets(cb as (result: unknown) => void),
        );
        ownedByGlide = (targets || []).some(
          (t) => t.tabId === tabId && t.attached !== false && t.extensionId === chrome.runtime.id,
        );
      } catch {
        ownedByGlide = false;
      }
      if (ownedByGlide) {
        attachedTabs.add(tabId);
        return {
          success: true,
          tabId,
          alreadyAttached: true,
          protocol: PROTOCOL,
          hint: 'Debugger session already active on this tab (recovered after worker restart).',
        };
      }
      return {
        success: false,
        error: message,
        hint: 'Another debugger (DevTools or extension) is attached. Detach it before using cdp.',
      };
    }
    return {
      success: false,
      error: message,
      hint: 'Enable toolPermissions.debugger and reload the extension. Cannot attach to chrome:// or Web Store pages.',
    };
  }
}

export async function cdpDetach(tabId: number): Promise<Record<string, unknown>> {
  // Only detach sessions this extension attached — never tear down DevTools or another extension.
  if (!attachedTabs.has(tabId)) {
    return { success: true, tabId, alreadyDetached: true, owned: false };
  }
  try {
    await promisify<void>((cb) => chrome.debugger.detach({ tabId }, cb as () => void));
    attachedTabs.delete(tabId);
    return { success: true, tabId, detached: true, owned: true };
  } catch (error) {
    attachedTabs.delete(tabId);
    const message = (error as Error)?.message || String(error);
    if (/not attached|No tab with given id|Cannot access|detached/i.test(message)) {
      return { success: true, tabId, alreadyDetached: true, owned: true };
    }
    return { success: false, error: message };
  }
}

/** Detach only tabs Glide attached (never third-party / DevTools sessions). */
export async function cdpDetachAll(): Promise<{ detached: number }> {
  const ids = new Set<number>(attachedTabs);
  let detached = 0;
  await Promise.all(
    [...ids].map(async (tabId) => {
      const result = await cdpDetach(tabId);
      if (result.success && result.detached) detached += 1;
    }),
  );
  attachedTabs.clear();
  return { detached };
}

/** Domains the agent may use via cdp send (opt-in debugger). Blocks arbitrary CDP surface. */
const CDP_ALLOWED_DOMAIN =
  /^(Network|Runtime|Page|Input|DOM|CSS|Overlay|Fetch|Emulation|Log|Performance|Security|Target|Browser)\./;

export async function cdpSend(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const trimmed = String(method || '').trim();
  if (!trimmed) {
    return { success: false, error: 'CDP method is required (e.g. Network.enable, Runtime.evaluate).' };
  }
  if (!CDP_ALLOWED_DOMAIN.test(trimmed)) {
    return {
      success: false,
      error: `CDP method not allowed: ${trimmed}`,
      hint: 'Allowed domains: Network, Runtime, Page, Input, DOM, CSS, Overlay, Fetch, Emulation, Log, Performance, Security, Target, Browser.',
    };
  }
  // Page.navigate can bypass requireHttpUrl on the navigate tool — re-check here.
  if (trimmed === 'Page.navigate') {
    const url = params && typeof (params as { url?: unknown }).url === 'string' ? String(params.url) : '';
    if (url) {
      const check = requireHttpUrl(url, 'cdp Page.navigate');
      if (!check.ok) {
        return { success: false, error: check.error, hint: check.hint };
      }
    }
  }
  if (!attachedTabs.has(tabId)) {
    const attached = await cdpAttach(tabId);
    if (!attached.success) return attached;
  }
  try {
    const result = await promisify<unknown>((cb) =>
      chrome.debugger.sendCommand({ tabId }, trimmed, params || {}, cb as (result?: unknown) => void),
    );
    return { success: true, tabId, method: trimmed, result: result ?? null };
  } catch (error) {
    return {
      success: false,
      tabId,
      method: trimmed,
      error: (error as Error)?.message || String(error),
      hint: 'Check method name/params. Enable domains first (e.g. Network.enable).',
    };
  }
}

export async function dispatchNativePointer(
  tabId: number,
  input: { action: 'hover' | 'drag'; from: { x: number; y: number }; to?: { x: number; y: number } },
): Promise<Record<string, unknown>> {
  const attached = await cdpAttach(tabId);
  if (!attached.success) return attached;
  try {
    const move = await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: input.from.x,
      y: input.from.y,
      button: 'none',
    });
    if (!move.success || input.action === 'hover') return move;
    const down = await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: input.from.x,
      y: input.from.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    if (!down.success) return down;
    const destination = input.to || input.from;
    const dragMove = await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: destination.x,
      y: destination.y,
      button: 'left',
      buttons: 1,
    });
    if (!dragMove.success) return dragMove;
    return cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: destination.x,
      y: destination.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await cdpDetach(tabId);
  }
}

export async function cdpCommand(
  tabId: number,
  action: string,
  method?: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const act = String(action || 'send')
    .toLowerCase()
    .trim();
  if (act === 'attach') return cdpAttach(tabId);
  if (act === 'detach') return cdpDetach(tabId);
  if (act === 'status') {
    return { success: true, tabId, attached: attachedTabs.has(tabId) };
  }
  return cdpSend(tabId, method || '', params);
}
