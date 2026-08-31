import type { RunTerminalReason } from './run-types.js';

export function resolveRunTerminalReason(input: {
  awaitsUser?: boolean;
  stopped?: boolean;
  ambiguous?: boolean;
  failed?: boolean;
  interrupted?: boolean;
}): RunTerminalReason {
  if (input.ambiguous) return 'ambiguous_action';
  if (input.stopped) return 'stopped';
  if (input.interrupted) return 'interrupted';
  if (input.failed) return 'failed';
  if (input.awaitsUser) return 'awaiting_user';
  return 'completed';
}
