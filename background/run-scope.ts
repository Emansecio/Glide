export type RunScope = 'parent' | 'subagent';

export const PARENT_ONLY_TOOLS = new Set(['set_plan', 'update_plan', 'spawn_subagent']);

export const isSubagentScope = (scope: RunScope | undefined): boolean => scope === 'subagent';
