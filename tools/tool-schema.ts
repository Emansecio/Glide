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
