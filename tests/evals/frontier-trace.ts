import { type FrontierEvalTrace, hasTrustedFrontierEvidence } from './frontier-graders.js';

export const FRONTIER_TRACE_PREFIX = 'GLIDE_FRONTIER_TRACE ';

export function emitFrontierTrace(caseId: string, trace: FrontierEvalTrace): void {
  console.log(`${FRONTIER_TRACE_PREFIX}${JSON.stringify({ caseId, trace })}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function parseFrontierTraceOutput(output: string, caseId: string): FrontierEvalTrace {
  const candidates = output
    .split(/\r?\n/)
    .filter((line) => line.includes(FRONTIER_TRACE_PREFIX))
    .map((line) => line.slice(line.indexOf(FRONTIER_TRACE_PREFIX) + FRONTIER_TRACE_PREFIX.length));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.caseId !== caseId || !isRecord(parsed.trace)) continue;
    const trace = parsed.trace;
    if (
      !Array.isArray(trace.events) ||
      !Array.isArray(trace.mutations) ||
      !Array.isArray(trace.actionAttempts) ||
      !Array.isArray(trace.contextRevisions) ||
      !isRecord(trace.terminal)
    ) {
      throw new Error(`fixture trace missing required fields for ${caseId}`);
    }
    const typedTrace = trace as FrontierEvalTrace;
    if (!hasTrustedFrontierEvidence(typedTrace)) {
      throw new Error(`fixture trace contains untrusted evidence for ${caseId}`);
    }
    return typedTrace;
  }
  throw new Error(`fixture emitted no machine-readable trace for ${caseId}`);
}
