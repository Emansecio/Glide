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
  | 'findElement'
  | 'readPage'
  | 'getElementBox'
  | 'selectOption'
  | 'setChecked'
  | 'highlightElement';

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

const RECOVERABLE_BRIDGE_CODES = new Set(['ELEMENT_NOT_FOUND', 'BRIDGE_UNSUPPORTED', 'WAIT_TIMEOUT']);

/** Bridge ops that mutate page state — never fall through to inject after timeout/unavailable. */
export const MUTATIVE_BRIDGE_OPS = new Set<GlideBridgeOp>([
  'click',
  'type',
  'pressKey',
  'selectOption',
  'setChecked',
  'mouse',
  'hover',
  'scroll',
  'dismissModal',
]);

export const isMutativeBridgeOp = (op: GlideBridgeOp): boolean => MUTATIVE_BRIDGE_OPS.has(op);

export const shouldFallbackFromBridge = (response: GlideBridgeResponse): boolean =>
  response.success === false && typeof response.code === 'string' && RECOVERABLE_BRIDGE_CODES.has(response.code);

export const sendGlideBridge = async (
  tabId: number,
  op: GlideBridgeOp,
  payload: Record<string, unknown> = {},
  timeoutMs = 8000,
  options: { frameId?: number } = {},
): Promise<GlideBridgeResponse | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const request = {
      type: GLIDE_BRIDGE_MESSAGE_TYPE,
      op,
      payload,
    } satisfies GlideBridgeRequest;
    const sendPromise =
      typeof options.frameId === 'number'
        ? chrome.tabs.sendMessage(tabId, request, { frameId: options.frameId })
        : chrome.tabs.sendMessage(tabId, request);
    const response = await Promise.race([
      sendPromise,
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
