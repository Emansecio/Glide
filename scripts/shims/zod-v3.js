// Build-time shim for `zod/v3` in the service worker bundle.
// @ai-sdk/provider-utils imports only `ZodFirstPartyTypeKind` from zod/v3, to compare
// `_def.typeName` while converting user-supplied zod v3 schemas. Glide passes plain JSON
// schemas (`jsonSchema()`), and every member of that enum equals its own key
// (ZodString === 'ZodString'), so a key-echoing proxy is behaviour-identical.
export const ZodFirstPartyTypeKind = new Proxy(
  {},
  { get: (_target, key) => (typeof key === 'string' ? key : undefined) },
);
