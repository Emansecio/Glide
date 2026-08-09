import type { ToolDefinition } from '../tools/tool-schema.js';
import { SCREENSHOT_TOOLS } from './service-config.js';
import { getToolPermissionCategory, isToolCategoryAllowed } from './tool-permissions.js';

export type SessionToolsOptions = {
  includePlanTools?: boolean;
  lockedTabId?: number | null;
  enableScreenshots?: boolean;
  lockedTabAllowlist?: ReadonlySet<string>;
  /** When set, drop tools whose permission category is denied (schema matches runtime). */
  toolPermissions?: Record<string, unknown>;
  browserToolDefinitions: ToolDefinition[];
};

const PLAN_TOOLS: ToolDefinition[] = [
  {
    name: 'set_plan',
    description:
      'Set a checklist of concrete action steps to complete the task. Each step should be a single specific action (e.g., "Navigate to example.com", "Click the login button", "Extract product prices"). Avoid headers, phases, or abstract descriptions. Keep to 3-6 actionable steps. Mark steps done via update_plan as you complete them.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short action description (e.g., "Search for user profile", "Extract contact info")',
              },
              status: {
                type: 'string',
                enum: ['pending', 'done'],
                description: 'Step status - pending or done',
              },
            },
            required: ['title'],
          },
          description: 'Ordered list of 3-6 concrete action steps. Each step = one tool call or logical action.',
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'update_plan',
    description: 'Mark a plan step as done after completing it. Call this after each step you finish.',
    input_schema: {
      type: 'object',
      properties: {
        step_index: {
          type: 'number',
          description: 'Zero-based index of the step to mark done (0 = first step)',
        },
        status: {
          type: 'string',
          enum: ['done', 'pending', 'blocked'],
          description: 'New status for the step (defaults to "done")',
        },
      },
      required: ['step_index'],
    },
  },
];

export const buildSessionTools = (options: SessionToolsOptions): ToolDefinition[] => {
  const {
    browserToolDefinitions,
    lockedTabId = null,
    enableScreenshots = true,
    lockedTabAllowlist,
    toolPermissions,
    includePlanTools = true,
  } = options;

  let tools = [...browserToolDefinitions];

  if (typeof lockedTabId === 'number' && lockedTabAllowlist) {
    tools = tools.filter((tool) => lockedTabAllowlist.has(tool.name));
  }
  if (enableScreenshots === false) {
    tools = tools.filter((tool) => !SCREENSHOT_TOOLS.has(tool.name));
  }
  if (toolPermissions) {
    tools = tools.filter((tool) => {
      const category = getToolPermissionCategory(tool.name);
      return isToolCategoryAllowed(category, toolPermissions);
    });
  }
  if (includePlanTools) {
    tools = tools.concat(PLAN_TOOLS);
  }
  return tools;
};
