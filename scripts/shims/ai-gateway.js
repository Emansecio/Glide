// Build-time shim for `@ai-sdk/gateway` in the service worker bundle.
// `ai` only reaches the Vercel AI Gateway when a model is given as a string id (global
// default provider). Glide always passes provider model objects, so the gateway client
// is dead weight; the error classes stay so `isInstance` checks keep working.
const unsupported = () => {
  throw new Error('Vercel AI Gateway is not bundled in Glide; pass a provider model object.');
};

export class GatewayError extends Error {
  static isInstance(error) {
    return error instanceof GatewayError;
  }
}

export class GatewayAuthenticationError extends GatewayError {
  static isInstance(error) {
    return error instanceof GatewayAuthenticationError;
  }
}

export const createGateway = unsupported;
export const gateway = new Proxy(unsupported, { get: unsupported, apply: unsupported });
