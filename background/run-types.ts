export type RunPhase =
  | 'starting'
  | 'model'
  | 'action_prepared'
  | 'action_in_flight'
  | 'committing'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'ambiguous';

export type RunTerminalReason =
  | 'completed'
  | 'awaiting_user'
  | 'stopped'
  | 'failed'
  | 'interrupted'
  | 'ambiguous_action';

export type RunMeta = {
  runId: string;
  sessionId: string;
  turnId: string;
  resumedFromRunId?: string;
};

export type RunRequestEnvelope = {
  message: string;
  panelTabId?: number;
};

export type RunResumeInput = {
  contextRevision: number;
  selectedTabIds: number[];
  request: RunRequestEnvelope;
  resumedFromRunId?: string;
};

export type ActionJournalState = 'prepared' | 'in_flight' | 'committed' | 'ambiguous';

export type ActionJournalEntry = {
  actionId: string;
  runId: string;
  toolCallId?: string;
  tool: string;
  argsDigest: string;
  target?: Record<string, unknown>;
  state: ActionJournalState;
  resultDigest?: string;
  startedAt: number;
  completedAt?: number;
};

export type RunState = RunMeta &
  RunResumeInput & {
    phase: RunPhase;
    terminalReason?: RunTerminalReason;
    lastCommittedActionId?: string;
    inFlightAction?: ActionJournalEntry;
    startedAt: number;
    updatedAt: number;
  };

export type RunCheckpoint = Omit<RunState, 'request'> & {
  version: 1;
  request: RunRequestEnvelope;
};
