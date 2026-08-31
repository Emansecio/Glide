import { GLIDE_BRIDGE_MESSAGE_TYPE, type GlideBridgeOp, type GlideBridgeResponse } from '../tools/content-bridge.js';
import { actionOperations } from './operations/action.js';
import { formOperations } from './operations/form.js';
import { readOperations } from './operations/read.js';
import { waitOperations } from './operations/wait.js';

const BRIDGE_FLAG = '__glide_bridge_installed__';
type BridgeHandler = (payload: Record<string, unknown>) => Promise<unknown> | unknown;

const bridgeHandlers: Record<GlideBridgeOp, BridgeHandler> = {
  ping: () => ({ success: true, bridge: true }),
  ...actionOperations,
  ...formOperations,
  ...readOperations,
  ...waitOperations,
};

const asResponse = (result: unknown): GlideBridgeResponse =>
  ({
    bridge: true,
    ...(result && typeof result === 'object' ? (result as Record<string, unknown>) : { success: true, result }),
  }) as GlideBridgeResponse;

export const installGlideBridge = () => {
  const globalWindow = window as unknown as Record<string, boolean>;
  if (globalWindow[BRIDGE_FLAG]) return;
  globalWindow[BRIDGE_FLAG] = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== GLIDE_BRIDGE_MESSAGE_TYPE) return false;
    const op = String(message.op || '') as GlideBridgeOp;
    const handler = bridgeHandlers[op];
    if (!handler) {
      sendResponse({ success: false, bridge: true, code: 'BRIDGE_UNSUPPORTED', error: `Unknown bridge op: ${op}` });
      return true;
    }
    const payload = {
      ...((message.payload || {}) as Record<string, unknown>),
      __glideTabId: sender.tab?.id ?? -1,
      __glideFrameId: sender.frameId ?? 0,
    };
    void Promise.resolve(handler(payload))
      .then((result) => sendResponse(asResponse(result)))
      .catch((error) =>
        sendResponse({
          success: false,
          bridge: true,
          code: 'BRIDGE_OPERATION_FAILED',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  });
};
