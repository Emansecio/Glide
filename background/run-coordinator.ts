import type { RunCheckpointStore } from './run-checkpoint-store.js';
import type { RunCheckpoint, RunMeta, RunPhase, RunResumeInput, RunState, RunTerminalReason } from './run-types.js';

const TERMINAL_PHASES = new Set<RunPhase>(['awaiting_user', 'completed', 'failed', 'stopped', 'ambiguous']);

const ALLOWED_TRANSITIONS = Object.freeze({
  starting: ['model', 'failed', 'stopped', 'ambiguous'],
  model: ['model', 'action_prepared', 'committing', 'awaiting_user', 'completed', 'failed', 'stopped'],
  action_prepared: ['action_in_flight', 'failed', 'stopped'],
  action_in_flight: ['committing', 'ambiguous', 'failed', 'stopped'],
  committing: ['model', 'action_prepared', 'awaiting_user', 'completed', 'failed', 'stopped'],
  awaiting_user: [],
  completed: [],
  failed: [],
  stopped: [],
  ambiguous: [],
} satisfies Record<RunPhase, readonly RunPhase[]>);

const TERMINAL_PHASE_BY_REASON: Record<RunTerminalReason, RunPhase> = {
  completed: 'completed',
  awaiting_user: 'awaiting_user',
  stopped: 'stopped',
  failed: 'failed',
  interrupted: 'failed',
  ambiguous_action: 'ambiguous',
};

const cloneState = (state: RunState): RunState => ({
  ...state,
  selectedTabIds: [...state.selectedTabIds],
  request: { ...state.request },
  ...(state.inFlightAction ? { inFlightAction: { ...state.inFlightAction } } : {}),
});

export type CheckpointPersistenceFailureHandler = (state: RunState) => void;

export class RunCoordinator {
  private states = new Map<string, RunState>();
  private persistenceFailureNotified = new Set<string>();

  constructor(
    private checkpointStore?: RunCheckpointStore,
    private onPersistenceFailure?: CheckpointPersistenceFailureHandler,
  ) {}

  private toCheckpoint(state: RunState): RunCheckpoint {
    return { version: 1, ...cloneState(state) };
  }

  async persist(runId: string): Promise<boolean> {
    const state = this.states.get(runId);
    if (!state || !this.checkpointStore) return false;
    await this.checkpointStore.write(this.toCheckpoint(state));
    const available = this.checkpointStore.isResumeEnabled();
    if (!available && !this.persistenceFailureNotified.has(runId)) {
      this.persistenceFailureNotified.add(runId);
      try {
        this.onPersistenceFailure?.(cloneState(state));
      } catch {
        // Warning delivery must not turn checkpoint degradation into a run failure.
      }
    }
    return available;
  }

  async clear(runId: string): Promise<void> {
    const state = this.states.get(runId);
    try {
      await this.checkpointStore?.clear(runId);
    } finally {
      if (state && TERMINAL_PHASES.has(state.phase)) {
        this.states.delete(runId);
        this.persistenceFailureNotified.delete(runId);
      }
    }
  }

  async recordAction(entry: RunState['inFlightAction']): Promise<boolean> {
    if (!entry) return false;
    const state = this.states.get(entry.runId);
    if (!state) return false;
    if (entry.state === 'prepared') {
      if (state.phase !== 'action_prepared') this.transition(entry.runId, 'action_prepared');
      this.states.set(entry.runId, { ...this.states.get(entry.runId)!, inFlightAction: { ...entry } });
    } else if (entry.state === 'in_flight') {
      if (this.states.get(entry.runId)?.phase !== 'action_in_flight') {
        this.transition(entry.runId, 'action_in_flight');
      }
      this.states.set(entry.runId, { ...this.states.get(entry.runId)!, inFlightAction: { ...entry } });
    } else if (entry.state === 'committed') {
      if (this.states.get(entry.runId)?.phase !== 'committing') this.transition(entry.runId, 'committing');
      this.states.set(entry.runId, {
        ...this.states.get(entry.runId)!,
        lastCommittedActionId: entry.actionId,
        inFlightAction: undefined,
      });
    } else if (entry.state === 'ambiguous') {
      this.states.set(entry.runId, { ...state, inFlightAction: { ...entry } });
      this.terminal(entry.runId, 'ambiguous_action');
    }
    return this.persist(entry.runId);
  }

  updateContextRevision(runId: string, contextRevision: number): RunState {
    const state = this.states.get(runId);
    if (!state) throw new Error(`Unknown run ${runId}.`);
    if (!Number.isInteger(contextRevision) || contextRevision <= state.contextRevision) {
      throw new Error(`Context revision must advance beyond ${state.contextRevision}.`);
    }
    const updated: RunState = { ...state, contextRevision, updatedAt: Date.now() };
    this.states.set(runId, updated);
    return cloneState(updated);
  }

  start(meta: RunMeta, input: RunResumeInput): RunState {
    if (this.states.has(meta.runId)) throw new Error(`Run ${meta.runId} already exists.`);
    const now = Date.now();
    const state: RunState = {
      ...meta,
      ...input,
      selectedTabIds: [...input.selectedTabIds],
      request: { ...input.request },
      phase: 'starting',
      startedAt: now,
      updatedAt: now,
    };
    this.states.set(meta.runId, state);
    return cloneState(state);
  }

  transition(runId: string, next: RunPhase): RunState {
    const state = this.states.get(runId);
    if (!state) throw new Error(`Unknown run ${runId}.`);
    const allowed = ALLOWED_TRANSITIONS[state.phase] as readonly RunPhase[];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid run transition: ${state.phase} -> ${next}.`);
    }
    const updated: RunState = { ...state, phase: next, updatedAt: Date.now() };
    this.states.set(runId, updated);
    return cloneState(updated);
  }

  terminal(runId: string, reason: RunTerminalReason): RunState {
    const state = this.states.get(runId);
    if (!state) throw new Error(`Unknown run ${runId}.`);
    const phase = TERMINAL_PHASE_BY_REASON[reason];
    const next = state.phase === phase && TERMINAL_PHASES.has(phase) ? state : this.transition(runId, phase);
    const terminal = { ...next, terminalReason: reason, updatedAt: Date.now() };
    this.states.set(runId, terminal);
    return cloneState(terminal);
  }

  get(runId: string): RunState | null {
    const state = this.states.get(runId);
    return state ? cloneState(state) : null;
  }

  /** Test-only runtime-retention introspection. */
  size(): number {
    return this.states.size;
  }
}
