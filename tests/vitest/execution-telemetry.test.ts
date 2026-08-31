import { describe, expect, it } from 'vitest';
import { ExecutionTelemetryBuffer, type ToolTelemetry } from '../../background/execution-telemetry.js';

const event = (index: number, overrides: Partial<ToolTelemetry> = {}): ToolTelemetry => ({
  runId: `run-${index}`,
  actionId: `action-${index}`,
  tool: 'click',
  tabId: 7,
  frameId: 0,
  queueMs: 1,
  executeMs: 2,
  verifyMs: 3,
  totalMs: 6,
  resultBytes: 12,
  recoveryStage: 'none',
  checkpointPhase: 'model',
  contextRevision: index,
  ...overrides,
});

describe('ExecutionTelemetryBuffer', () => {
  it('keeps only latest 200 events', () => {
    const buffer = new ExecutionTelemetryBuffer();
    for (let index = 0; index < 250; index += 1) buffer.append(event(index));

    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(200);
    expect(snapshot[0].runId).toBe('run-50');
    expect(snapshot.at(-1)?.runId).toBe('run-249');
  });

  it('projects onto bounded fields and omits user content and credentials', () => {
    const buffer = new ExecutionTelemetryBuffer();
    buffer.append({
      ...event(1),
      args: { text: 'CANARY_TYPED', password: 'CANARY_PASSWORD' },
      url: 'https://example.test/path?token=CANARY_QUERY',
      text: 'CANARY_TEXT',
      result: { body: 'CANARY_BODY', screenshot: 'CANARY_SCREENSHOT' },
      credentials: 'CANARY_CREDENTIALS',
    } as ToolTelemetry);

    const serialized = JSON.stringify(buffer.snapshot());
    for (const canary of [
      'CANARY_TYPED',
      'CANARY_PASSWORD',
      'CANARY_QUERY',
      'CANARY_TEXT',
      'CANARY_BODY',
      'CANARY_SCREENSHOT',
      'CANARY_CREDENTIALS',
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(Object.keys(buffer.snapshot()[0]).sort()).toEqual(
      [
        'actionId',
        'checkpointPhase',
        'contextRevision',
        'executeMs',
        'frameId',
        'queueMs',
        'recoveryStage',
        'resultBytes',
        'runId',
        'tabId',
        'tool',
        'totalMs',
        'verifyMs',
      ].sort(),
    );
  });

  it('clamps duration and byte metrics to finite nonnegative values', () => {
    const buffer = new ExecutionTelemetryBuffer();
    buffer.append(
      event(1, {
        queueMs: Number.NaN,
        executeMs: -2,
        verifyMs: Number.POSITIVE_INFINITY,
        totalMs: -1,
        resultBytes: Number.NEGATIVE_INFINITY,
        contextRevision: -3,
      }),
    );

    expect(buffer.snapshot()[0]).toMatchObject({
      queueMs: 0,
      executeMs: 0,
      verifyMs: 0,
      totalMs: 0,
      resultBytes: 0,
      contextRevision: 0,
    });
  });

  it('returns defensive snapshots', () => {
    const buffer = new ExecutionTelemetryBuffer();
    buffer.append(event(1));
    const first = buffer.snapshot();
    first[0].tool = 'changed';
    first.push(event(2));

    expect(buffer.snapshot()).toEqual([event(1)]);
  });
});
