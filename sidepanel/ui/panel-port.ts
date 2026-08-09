import { PANEL_PORT_NAME } from '../../background/runtime-push.js';

export const PORT_RECONNECT_INITIAL_MS = 250;
export const PORT_RECONNECT_MAX_MS = 2000;

export function computePortReconnectDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return PORT_RECONNECT_MAX_MS;
  const delay = PORT_RECONNECT_INITIAL_MS * 2 ** attempt;
  return Math.min(delay, PORT_RECONNECT_MAX_MS);
}

export type PanelPortConnection = {
  disconnect: () => void;
  ensureConnected: () => void;
};

export type PanelPortOptions = {
  /** When false after disconnect, the port stays down until ensureConnected(). */
  shouldReconnect?: () => boolean;
};

/**
 * SW→panel event push channel. Request/response traffic stays on sendMessage.
 * Reconnects lazily: only while a run is active, or after ensureConnected().
 */
export function connectPanelPort(
  onMessage: (message: unknown) => void,
  options: PanelPortOptions = {},
): PanelPortConnection {
  let port: chrome.runtime.Port | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const attach = () => {
    if (disposed) return;
    if (port) return;
    port = chrome.runtime.connect({ name: PANEL_PORT_NAME });
    reconnectAttempt = 0;
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (disposed) return;
      if (options.shouldReconnect?.()) {
        scheduleReconnect();
      }
    });
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer) return;
    if (!options.shouldReconnect?.()) return;
    const delay = computePortReconnectDelayMs(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attach();
    }, delay);
  };

  attach();

  return {
    ensureConnected: () => {
      if (disposed || port) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      attach();
    },
    disconnect: () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
      port = null;
    },
  };
}
