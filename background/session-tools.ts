import type { ToolDefinition } from '../tools/tool-schema.js';

export type SessionToolsOptions = {
  includeOrchestrator?: boolean;
  includePlanTools?: boolean;
  includeSubagentComplete?: boolean;
  lockedTabId?: number | null;
  enableScreenshots?: boolean;
  lockedTabAllowlist?: ReadonlySet<string>;
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

const SUBAGENT_COMPLETE_TOOL: ToolDefinition = {
  name: 'subagent_complete',
  description: 'Sub-agent calls this when finished to return a summary payload.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      data: { type: 'object' },
    },
    required: ['summary'],
  },
};

const ORCHESTRATOR_TOOLS: ToolDefinition[] = [
  {
    name: 'spawn_subagent',
    description: 'Start a focused sub-agent with its own goal and prompt.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'System prompt for the sub-agent',
        },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task list for the sub-agent',
        },
        goal: {
          type: 'string',
          description: 'Single goal string if tasks not provided',
        },
      },
    },
  },
  SUBAGENT_COMPLETE_TOOL,
];

export const buildSessionTools = (options: SessionToolsOptions): ToolDefinition[] => {
  const {
    browserToolDefinitions,
    lockedTabId = null,
    enableScreenshots = true,
    lockedTabAllowlist,
    includePlanTools = true,
    includeOrchestrator = false,
    includeSubagentComplete = false,
  } = options;

  let tools = [...browserToolDefinitions];

  if (typeof lockedTabId === 'number' && lockedTabAllowlist) {
    tools = tools.filter((tool) => lockedTabAllowlist.has(tool.name));
  }
  if (enableScreenshots === false) {
    tools = tools.filter((tool) => tool.name !== 'screenshot');
  }
  if (includePlanTools) {
    tools = tools.concat(PLAN_TOOLS);
  }
  if (includeOrchestrator) {
    tools = tools.concat(ORCHESTRATOR_TOOLS);
  } else if (includeSubagentComplete) {
    tools = tools.concat([SUBAGENT_COMPLETE_TOOL]);
  }
  return tools;
};
