import { BROWSER_ACTION_TOOLS } from './service-config.js';

export type FailureAction = {
  toolName: string;
  args?: Record<string, unknown>;
  tabId?: number | null;
  url?: string | null;
};

/** Browser actions that count toward identical-failure stopping — excludes polling `wait`. */
export const FAILURE_TRACKED_TOOLS = new Set<string>(BROWSER_ACTION_TOOLS.filter((tool) => tool !== 'wait'));

export const isFailureTrackedTool = (toolName: string): boolean => FAILURE_TRACKED_TOOLS.has(toolName);

const normalizePart = (value: unknown) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export const buildFailureSignature = ({ toolName, args = {}, tabId, url }: FailureAction): string => {
  const target = args.selector ?? args.query ?? args.url ?? args.key ?? args.direction ?? '';
  return [normalizePart(toolName).toLowerCase(), normalizePart(target), tabId ?? 'none', normalizePart(url)].join('|');
};

export type FailureRecord = {
  signature: string;
  count: number;
  repeated: boolean;
  code?: 'REPEATED_FAILURE';
};

export class FailureRecoveryTracker {
  private readonly counts = new Map<string, number>();

  constructor(private readonly repeatLimit = 3) {}

  recordFailure(action: FailureAction): FailureRecord {
    const signature = buildFailureSignature(action);
    const count = (this.counts.get(signature) || 0) + 1;
    this.counts.set(signature, count);
    const repeated = count >= this.repeatLimit;
    return {
      signature,
      count,
      repeated,
      ...(repeated ? { code: 'REPEATED_FAILURE' as const } : {}),
    };
  }

  reset() {
    this.counts.clear();
  }
}

export const shouldForceFailedToolContinuation = ({
  hasFailedTools,
  awaitingVerification,
  alreadyUsed,
}: {
  hasFailedTools: boolean;
  awaitingVerification: boolean;
  alreadyUsed: boolean;
}) => decideFailedToolOutcome({ hasFailedTools, awaitingVerification, alreadyUsed }) === 'continue';

export type FailedToolOutcome = 'complete' | 'continue' | 'fail';

export const decideFailedToolOutcome = ({
  hasFailedTools,
  awaitingVerification,
  alreadyUsed,
}: {
  hasFailedTools: boolean;
  awaitingVerification: boolean;
  alreadyUsed: boolean;
}): FailedToolOutcome => {
  if (!hasFailedTools || !awaitingVerification) return 'complete';
  return alreadyUsed ? 'fail' : 'continue';
};

export const advanceFailedToolRecovery = ({
  hasFailedTools,
  awaitingVerification,
  continuationUsed,
}: {
  hasFailedTools: boolean;
  awaitingVerification: boolean;
  continuationUsed: boolean;
}): { outcome: FailedToolOutcome; continuationUsed: boolean } => {
  const activeContinuationUsed = awaitingVerification ? continuationUsed : false;
  const outcome = decideFailedToolOutcome({
    hasFailedTools,
    awaitingVerification,
    alreadyUsed: activeContinuationUsed,
  });
  return {
    outcome,
    continuationUsed: outcome === 'continue' ? true : activeContinuationUsed,
  };
};

export type FailedToolResult = {
  success: false;
  code: 'TOOL_EXECUTION_ERROR';
  error: string;
};

export const normalizeThrownToolError = (error: unknown): FailedToolResult => ({
  success: false,
  code: 'TOOL_EXECUTION_ERROR',
  error: error instanceof Error ? error.message || 'Tool execution failed' : String(error || 'Tool execution failed'),
});

const boundedFailureText = (value: unknown, limit: number): string => {
  const text = normalizePart(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
};

export type TerminalToolFailure = {
  message: string;
  details: {
    code: 'BROWSER_RECOVERY_EXHAUSTED';
    tool: string;
    toolCode?: string;
    nextHint?: string;
    recordInTranscript: true;
    transcriptMessage: string;
  };
};

export const buildTerminalToolFailure = (
  toolName: unknown,
  result: Record<string, unknown> = {},
): TerminalToolFailure => {
  const tool = boundedFailureText(toolName, 80) || 'ferramenta do navegador';
  const error = boundedFailureText(result.error, 400) || 'A ferramenta falhou sem informar um motivo.';
  const toolCode = boundedFailureText(result.code, 80);
  const nextHint = boundedFailureText(result.nextHint ?? result.hint, 300);
  const message = `Não consegui concluir a automação: "${tool}" falhou após a tentativa de recuperação — ${error}`;

  return {
    message,
    details: {
      code: 'BROWSER_RECOVERY_EXHAUSTED',
      tool,
      ...(toolCode ? { toolCode } : {}),
      ...(nextHint ? { nextHint } : {}),
      recordInTranscript: true,
      transcriptMessage: message,
    },
  };
};
