export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export const TAB_ID_PROP = { type: 'number', description: 'Optional tab id.' } as const;

export const RETRIES_PROP = {
  type: 'number',
  description: 'Optional retry attempts for dynamic pages (1-5).',
} as const;

export const SELECTOR_PROP = (description: string) => ({ type: 'string', description }) as const;

export const FRAME_URL_PROP = {
  type: 'string',
  description:
    'Optional iframe URL substring (case-insensitive) to run inside a child frame. Omit to use the top document.',
} as const;

export const FRAME_SELECTOR_PROP = {
  type: 'string',
  description:
    'Optional CSS selector of an <iframe> in the top document; its src is resolved and matched against frame URLs.',
} as const;

export const FRAME_TARGET_PROPS = {
  frameUrl: FRAME_URL_PROP,
  frameSelector: FRAME_SELECTOR_PROP,
} as const;

export const ACTION_POSTCONDITION_PROP = {
  type: 'object',
  description: 'Optional expected state verified after action executes once.',
  properties: {
    kind: {
      type: 'string',
      enum: ['url_changed', 'visible', 'hidden', 'checked', 'text_contains'],
    },
    from: { type: 'string' },
    selector: { type: 'string' },
    value: { type: 'boolean' },
    text: { type: 'string' },
  },
} as const;

export const ELEMENT_HANDLE_PROP = {
  type: 'object',
  description: 'Optional snapshot-scoped stable element handle returned by readPage or findElement.',
  properties: {
    version: { type: 'number' },
    snapshotId: { type: 'string' },
    ref: { type: 'string' },
    tabId: { type: 'number' },
    frameId: { type: 'number' },
    selector: { type: 'string' },
    fingerprint: { type: 'object' },
    domRevision: { type: 'number' },
  },
} as const;

export const defineTool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required?: string[],
): ToolDefinition => ({
  name,
  description,
  input_schema: {
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  },
});
