import type { RunCheckpoint } from './run-types.js';

export type RunRecoveryDecision = 'resume' | 'confirm' | 'discard';
export const MAX_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function recoverCheckpoint(
  checkpoint: RunCheckpoint,
  options: { committedContextRevision: number; now?: number },
): RunRecoveryDecision {
  const now = options.now ?? Date.now();
  if (now - checkpoint.updatedAt > MAX_CHECKPOINT_AGE_MS || checkpoint.updatedAt > now + 60_000) {
    return 'discard';
  }
  if (
    checkpoint.phase === 'action_in_flight' ||
    checkpoint.phase === 'ambiguous' ||
    checkpoint.inFlightAction?.state === 'in_flight' ||
    checkpoint.inFlightAction?.state === 'ambiguous'
  ) {
    return 'confirm';
  }
  if (checkpoint.contextRevision !== options.committedContextRevision) return 'discard';
  if (checkpoint.phase === 'model' || checkpoint.phase === 'committing' || checkpoint.phase === 'starting') {
    return 'resume';
  }
  return 'discard';
}

export function buildRecoveryExecutionNote(checkpoint: RunCheckpoint): string {
  const action = checkpoint.lastCommittedActionId
    ? ` Last committed action: ${checkpoint.lastCommittedActionId}. Do not repeat it unless fresh observation proves it is required.`
    : '';
  return `<execution_state>Run resumed after service-worker restart.${action}</execution_state>`;
}
