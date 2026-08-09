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
