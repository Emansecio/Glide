export const GLIDE_BRIDGE_MESSAGE_TYPE = 'glide_bridge' as const;

export type GlideBridgeOp =
  | 'ping'
  | 'click'
  | 'type'
  | 'wait'
  | 'getContent'
  | 'dismissModal'
  | 'hover'
  | 'mouse'
  | 'pressKey'
  | 'scroll'
  | 'findElement';

export type GlideBridgeRequest = {
  type: typeof GLIDE_BRIDGE_MESSAGE_TYPE;
  op: GlideBridgeOp;
  payload?: Record<string, unknown>;
};

export type GlideBridgeResponse = {
  success: boolean;
  bridge?: boolean;
  error?: string;
  code?: string;
  [key: string]: unknown;
};

export const isGlideBridgeResponse = (value: unknown): value is GlideBridgeResponse =>
  Boolean(value && typeof value === 'object' && 'success' in (value as Record<string, unknown>));

export const sendGlideBridge = async (
  tabId: number,
  op: GlideBridgeOp,
  payload: Record<string, unknown> = {},
  timeoutMs = 8000,
): Promise<GlideBridgeResponse | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: GLIDE_BRIDGE_MESSAGE_TYPE,
        op,
        payload,
      } satisfies GlideBridgeRequest),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!isGlideBridgeResponse(response)) return null;
    return response;
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

export const isBridgeAvailable = async (tabId: number, timeoutMs = 1500) => {
  const response = await sendGlideBridge(tabId, 'ping', {}, timeoutMs);
  return Boolean(response?.success && response.bridge);
};
