import {
  GLIDE_BRIDGE_MESSAGE_TYPE,
  type GlideBridgeOp,
  type GlideBridgeRequest,
  type GlideBridgeResponse,
  isGlideBridgeResponse,
} from './content-bridge.js';

export type FrameProbeRequest = {
  frameIds: number[];
  op: GlideBridgeOp;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type FrameProbeResult = {
  frameId: number;
  response: GlideBridgeResponse;
};

type SendOptions = { timeoutMs?: number; signal?: AbortSignal; deadline?: number };

const NO_RECEIVER_PATTERN = /receiving end does not exist|could not establish connection/i;

const failure = (code: string, error: string, extra: Record<string, unknown> = {}): GlideBridgeResponse => ({
  success: false,
  code,
  error,
  ...extra,
});

export class BrowserBridgeClient {
  async send(
    tabId: number,
    frameId: number,
    op: GlideBridgeOp,
    payload: Record<string, unknown>,
    options: SendOptions = {},
  ): Promise<GlideBridgeResponse> {
    const signal = options.signal;
    if (signal?.aborted) {
      return failure('ABORTED', 'Bridge request aborted before dispatch.', {
        dispatched: false,
        outcomeCertainty: 'known_not_executed',
      });
    }

    const timeoutMs = Math.max(1, options.timeoutMs ?? 8000);
    const deadline = options.deadline ?? Date.now() + timeoutMs;
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs <= 0) {
      return failure('BRIDGE_TIMEOUT', 'Content bridge deadline expired.', {
        timedOut: true,
        dispatched: false,
        outcomeCertainty: 'known_not_executed',
      });
    }

    const request = {
      type: GLIDE_BRIDGE_MESSAGE_TYPE,
      op,
      payload,
    } satisfies GlideBridgeRequest;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, request, { frameId }),
        new Promise<GlideBridgeResponse>((resolve) => {
          timeoutId = setTimeout(
            () =>
              resolve(
                failure('BRIDGE_TIMEOUT', 'Content bridge deadline expired.', {
                  timedOut: true,
                  dispatched: true,
                  outcomeCertainty: 'unknown',
                }),
              ),
            remainingMs,
          );
        }),
        new Promise<GlideBridgeResponse>((resolve) => {
          if (!signal) return;
          abortListener = () =>
            resolve(
              failure('ABORTED', 'Bridge request aborted.', {
                dispatched: true,
                outcomeCertainty: 'unknown',
              }),
            );
          signal.addEventListener('abort', abortListener, { once: true });
        }),
      ]);
      if (!isGlideBridgeResponse(response)) {
        return failure('BRIDGE_UNAVAILABLE', 'Content bridge returned an invalid response.', {
          unavailable: true,
          dispatched: true,
          outcomeCertainty: 'unknown',
        });
      }
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Sem content script na aba/frame nada foi entregue: a ação certamente não executou. Marcar
      // como 'unknown' derrubava o run inteiro como "ação ambígua" no primeiro click/type.
      const noReceiver = NO_RECEIVER_PATTERN.test(message);
      return failure('BRIDGE_UNAVAILABLE', message, {
        unavailable: true,
        noReceiver,
        dispatched: !noReceiver,
        outcomeCertainty: noReceiver ? 'known_not_executed' : 'unknown',
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  async probeFrames(tabId: number, request: FrameProbeRequest): Promise<FrameProbeResult[]> {
    const timeoutMs = Math.max(1, request.timeoutMs ?? 8000);
    const deadline = Date.now() + timeoutMs;
    return Promise.all(
      request.frameIds.map(async (frameId) => ({
        frameId,
        response: await this.send(tabId, frameId, request.op, request.payload ?? {}, {
          timeoutMs,
          deadline,
          signal: request.signal,
        }),
      })),
    );
  }
}
