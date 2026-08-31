export type ToolTelemetry = {
  runId: string;
  actionId?: string;
  tool: string;
  tabId?: number;
  frameId?: number;
  queueMs: number;
  executeMs: number;
  verifyMs: number;
  totalMs: number;
  resultBytes: number;
  recoveryStage: string;
  checkpointPhase: string;
  contextRevision: number;
};

const MAX_TOOL_TELEMETRY_EVENTS = 200;
const MAX_IDENTIFIER_LENGTH = 80;

const boundedNumber = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
};

const boundedInteger = (value: unknown) => Math.floor(boundedNumber(value));
const boundedIdentifier = (value: unknown) => String(value ?? '').slice(0, MAX_IDENTIFIER_LENGTH);

const normalizeTelemetry = (event: ToolTelemetry): ToolTelemetry => ({
  runId: boundedIdentifier(event.runId),
  ...(event.actionId ? { actionId: boundedIdentifier(event.actionId) } : {}),
  tool: boundedIdentifier(event.tool),
  ...(typeof event.tabId === 'number' && Number.isInteger(event.tabId) && event.tabId >= 0
    ? { tabId: event.tabId }
    : {}),
  ...(typeof event.frameId === 'number' && Number.isInteger(event.frameId) && event.frameId >= 0
    ? { frameId: event.frameId }
    : {}),
  queueMs: boundedNumber(event.queueMs),
  executeMs: boundedNumber(event.executeMs),
  verifyMs: boundedNumber(event.verifyMs),
  totalMs: boundedNumber(event.totalMs),
  resultBytes: boundedInteger(event.resultBytes),
  recoveryStage: boundedIdentifier(event.recoveryStage),
  checkpointPhase: boundedIdentifier(event.checkpointPhase),
  contextRevision: boundedInteger(event.contextRevision),
});

/** In-memory, content-free projection used by persisted execution diagnostics. */
export class ExecutionTelemetryBuffer {
  private events: ToolTelemetry[] = [];

  append(event: ToolTelemetry): void {
    this.events.push(normalizeTelemetry(event));
    if (this.events.length > MAX_TOOL_TELEMETRY_EVENTS) {
      this.events = this.events.slice(-MAX_TOOL_TELEMETRY_EVENTS);
    }
  }

  snapshot(): ToolTelemetry[] {
    return this.events.map((event) => ({ ...event }));
  }
}
