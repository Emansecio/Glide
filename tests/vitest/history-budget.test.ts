import { describe, expect, it } from 'vitest';
import { ContextTransactionStore } from '../../background/context-transaction.js';
import { fitSessionToBudget, measureStoredBytes } from '../../sidepanel/ui/history-budget.js';
import type { ChatSessionPayload } from '../../sidepanel/ui/history-storage.js';
import { emitFrontierTrace } from '../evals/frontier-trace.js';

function session(transcript: unknown[], contextTranscript?: unknown[]): ChatSessionPayload {
  return {
    schemaVersion: 1,
    id: 'session-1',
    startedAt: 1,
    updatedAt: 2,
    title: 'Long report',
    messageCount: transcript.length,
    transcript,
    contextTranscript,
  };
}

describe('history byte budgets', () => {
  it('preserves a 20k assistant report below 200 KiB', () => {
    const report = 'R'.repeat(20_000);
    const fitted = fitSessionToBudget(session([{ role: 'assistant', content: report }]), 200 * 1024);
    expect((fitted.transcript[0] as any).content).toHaveLength(20_000);
    expect((fitted.transcript[0] as any).meta?.truncation).toBeUndefined();
  });

  it('compacts oldest tool-heavy content before assistant report text', () => {
    const report = 'final '.repeat(3_000);
    const fitted = fitSessionToBudget(
      session([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: '1', name: 'readPage', args: { body: 'x'.repeat(60_000) } }],
        },
        { role: 'tool', toolCallId: '1', content: 'payload'.repeat(10_000) },
        { role: 'assistant', content: report },
      ]),
      32 * 1024,
    );
    expect(measureStoredBytes(fitted)).toBeLessThanOrEqual(32 * 1024);
    expect((fitted.transcript.at(-1) as any).content).toBe(report);
    expect(JSON.stringify(fitted.transcript.slice(0, 2))).toContain('compactado');
  });

  it('stores structured truncation metadata when text is final fallback', () => {
    const original = 'A'.repeat(80_000);
    const fitted = fitSessionToBudget(session([{ role: 'assistant', content: original }]), 12 * 1024);
    const message = fitted.transcript[0] as any;
    expect(measureStoredBytes(fitted)).toBeLessThanOrEqual(12 * 1024);
    expect(message.content.length).toBeLessThan(original.length);
    expect(message.meta.truncation).toMatchObject({
      originalChars: 80_000,
      reason: 'session_budget',
    });
    expect(message.meta.truncation.retainedChars).toBe(message.content.length);
  });

  it('preserves skewed distinct transcripts when whole session fits', () => {
    const display = 'D'.repeat(10_000);
    const context = 'C'.repeat(140_000);
    const input = session([{ role: 'assistant', content: display }], [{ role: 'assistant', content: context }]);
    expect(measureStoredBytes(input)).toBeLessThan(200 * 1024);

    const fitted = fitSessionToBudget(input, 200 * 1024);

    expect((fitted.transcript[0] as any).content).toBe(display);
    expect((fitted.contextTranscript?.[0] as any).content).toBe(context);
    expect((fitted.contextTranscript?.[0] as any).meta?.truncation).toBeUndefined();
  });

  it('emits history-restart eval trace from hydrated and committed context', () => {
    const stored = session([{ role: 'assistant', content: 'restored report' }]);
    const fitted = fitSessionToBudget(stored, 200 * 1024);
    const store = new ContextTransactionStore();
    store.hydrate('session-1', 6, fitted.transcript as any[]);
    const restored = store.read('session-1');
    const commit = store.commit({
      sessionId: 'session-1',
      runId: 'history-restart-run',
      turnId: 'history-restart-turn',
      sourceRevision: restored.revision,
      messages: [...restored.messages, { role: 'user', content: 'continue' }],
      compacted: false,
      contextUsage: {},
    });
    expect(restored.messages).toHaveLength(1);
    expect(commit.revision).toBe(7);
    emitFrontierTrace('history-restart', {
      events: [{ id: `${commit.runId}:${commit.turnId}`, kind: 'context_commit' }],
      mutations: [],
      actionAttempts: [],
      contextRevisions: [restored.revision, commit.revision],
      terminalReason: 'completed',
      expectedTerminalReason: 'completed',
    });
  });

  it('budgets display and distinct context transcripts independently', () => {
    const fitted = fitSessionToBudget(
      session(
        [{ role: 'assistant', content: 'display '.repeat(12_000) }],
        [{ role: 'assistant', content: 'context '.repeat(12_000) }],
      ),
      24 * 1024,
    );
    expect(fitted.transcript).toHaveLength(1);
    expect(fitted.contextTranscript).toHaveLength(1);
    expect((fitted.transcript[0] as any).meta.truncation).toBeTruthy();
    expect((fitted.contextTranscript?.[0] as any).meta.truncation).toBeTruthy();
    expect(measureStoredBytes(fitted)).toBeLessThanOrEqual(24 * 1024);
  });
});
