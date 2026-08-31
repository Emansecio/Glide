import { describe, expect, it } from 'vitest';
import type { Message } from '../../ai/message-schema.js';
import { buildToolTurnMessages } from '../../ai/tool-history.js';
import { ActionJournal } from '../../background/action-journal.js';
import {
  ACTIVE_RUN_CHECKPOINT_KEY,
  RUN_RECOVERY_CONTEXT_KEY,
  RunCheckpointSessionStore,
} from '../../background/run-checkpoint-store.js';
import { RunCoordinator } from '../../background/run-coordinator.js';
import { recoverCheckpoint } from '../../background/run-recovery.js';
import type { RunCheckpoint } from '../../background/run-types.js';

class MemoryStorage {
  data: Record<string, unknown> = {};
  failWrites = false;
  async get(key: string | string[]) {
    const keys = Array.isArray(key) ? key : [key];
    return Object.fromEntries(keys.map((entry) => [entry, this.data[entry]]));
  }
  async set(values: Record<string, unknown>) {
    if (this.failWrites) throw new Error('quota');
    Object.assign(this.data, values);
  }
  async remove(key: string | string[]) {
    for (const entry of Array.isArray(key) ? key : [key]) delete this.data[entry];
  }
}

const checkpoint = (phase: RunCheckpoint['phase'] = 'model'): RunCheckpoint => ({
  version: 1,
  runId: 'run-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  phase,
  contextRevision: 3,
  selectedTabIds: [7],
  request: { message: 'continue', panelTabId: 2 },
  startedAt: 10,
  updatedAt: 20,
});

describe('RunCheckpointSessionStore', () => {
  it('round-trips bounded versioned checkpoints', async () => {
    const storage = new MemoryStorage();
    const store = new RunCheckpointSessionStore(storage);
    await store.write(checkpoint());
    expect(await store.readActive()).toEqual(checkpoint());
    expect(store.isResumeEnabled()).toBe(true);
  });

  it('rejects wrong versions and removes stale terminal checkpoints', async () => {
    const storage = new MemoryStorage();
    const store = new RunCheckpointSessionStore(storage);
    storage.data[ACTIVE_RUN_CHECKPOINT_KEY] = { ...checkpoint(), version: 9 };
    expect(await store.readActive()).toBeNull();

    storage.data[ACTIVE_RUN_CHECKPOINT_KEY] = checkpoint('completed');
    expect(await store.readActive()).toBeNull();
    expect(storage.data[ACTIVE_RUN_CHECKPOINT_KEY]).toBeUndefined();
  });

  it('disables resume and clears stale recovery state after write failure without throwing', async () => {
    const storage = new MemoryStorage();
    storage.data[ACTIVE_RUN_CHECKPOINT_KEY] = checkpoint();
    storage.data[RUN_RECOVERY_CONTEXT_KEY] = {
      version: 1,
      runId: 'run-1',
      sessionId: 'session-1',
      contextRevision: 3,
      messages: [{ role: 'user', content: 'stale context' }],
    };
    storage.failWrites = true;
    const store = new RunCheckpointSessionStore(storage);
    await expect(store.write({ ...checkpoint(), contextRevision: 4 })).resolves.toBeUndefined();
    expect(store.isResumeEnabled()).toBe(false);
    expect(storage.data[ACTIVE_RUN_CHECKPOINT_KEY]).toBeUndefined();
    expect(storage.data[RUN_RECOVERY_CONTEXT_KEY]).toBeUndefined();
  });

  it('prevents restart from resuming a stale safe checkpoint after an action-phase write failure', async () => {
    const storage = new MemoryStorage();
    const store = new RunCheckpointSessionStore(storage);
    const warnings: string[] = [];
    const coordinator = new RunCoordinator(store, (state) => warnings.push(state.runId));
    coordinator.start(
      { runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1' },
      {
        contextRevision: 3,
        selectedTabIds: [7],
        request: { message: 'continue', panelTabId: 2 },
      },
    );
    coordinator.transition('run-1', 'model');
    await store.writeRecoveryContext({
      version: 1,
      runId: 'run-1',
      sessionId: 'session-1',
      contextRevision: 3,
      messages: [{ role: 'user', content: 'continue' }],
    });
    expect(await coordinator.persist('run-1')).toBe(true);
    const safeCheckpoint = await store.readActive();
    expect(safeCheckpoint?.phase).toBe('model');
    expect(
      recoverCheckpoint(safeCheckpoint!, {
        committedContextRevision: 3,
        now: safeCheckpoint!.updatedAt,
      }),
    ).toBe('resume');

    storage.failWrites = true;
    const journal = new ActionJournal([], (entry) => coordinator.recordAction(entry));
    await journal.prepare({
      actionId: 'run-1:action:1',
      runId: 'run-1',
      toolCallId: 'call-1',
      tool: 'click',
      args: { selector: '#save' },
    });
    const inFlight = await journal.markInFlight('run-1:action:1');
    expect(inFlight.shouldDispatch).toBe(true);
    await journal.commit('run-1:action:1', { success: true });
    expect(warnings).toEqual(['run-1']);

    storage.failWrites = false;
    const restartedStore = new RunCheckpointSessionStore(storage);
    expect(await restartedStore.readActive()).toBeNull();
    expect(await restartedStore.readRecoveryContext('run-1')).toBeNull();
  });

  it('rejects unbounded or forbidden payload fields', async () => {
    const storage = new MemoryStorage();
    const store = new RunCheckpointSessionStore(storage, { maxBytes: 256 });
    await store.write({ ...checkpoint(), request: { message: 'x'.repeat(500) } });
    expect(store.isResumeEnabled()).toBe(false);
    expect(storage.data[ACTIVE_RUN_CHECKPOINT_KEY]).toBeUndefined();
  });

  it('persists sanitized paired tool history for safe resume', async () => {
    const storage = new MemoryStorage();
    const store = new RunCheckpointSessionStore(storage);
    const messages: Message[] = [
      { role: 'user', content: 'inspect page' },
      ...buildToolTurnMessages(
        'Done.',
        null,
        [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'getContent',
            output: {
              type: 'json',
              value: {
                ok: true,
                token: 'tool-result-secret',
                dataUrl: 'data:image/png;base64,SCREENSHOT',
              },
            },
          },
        ],
        [
          {
            toolCallId: 'call-1',
            toolName: 'getContent',
            input: { selector: '#main', password: 'tool-argument-secret' },
          },
        ],
      ),
    ];

    await expect(
      store.writeRecoveryContext({
        version: 1,
        runId: 'run-1',
        sessionId: 'session-1',
        contextRevision: 3,
        lastCommittedActionId: 'run-1:action:1',
        messages,
      }),
    ).resolves.toBe(true);

    const restored = await store.readRecoveryContext('run-1');
    expect(restored?.lastCommittedActionId).toBe('run-1:action:1');
    expect(restored?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const pairedCall = restored?.messages[1]?.toolCalls?.[0];
    const toolParts = restored?.messages[2]?.content as Array<{ toolCallId?: string }>;
    expect(pairedCall?.id).toBe('call-1');
    expect(toolParts[0]?.toolCallId).toBe(pairedCall?.id);
    const serialized = JSON.stringify(restored?.messages);
    expect(serialized).not.toContain('tool-result-secret');
    expect(serialized).not.toContain('tool-argument-secret');
    expect(serialized).not.toContain('data:image');
    expect(restored?.loss?.lossy).toBe(true);
    expect(restored?.loss?.reasons.map((reason) => reason.kind)).toEqual(
      expect.arrayContaining(['sensitive_redaction', 'binary_redaction']),
    );
    expect(
      recoverCheckpoint(
        { ...checkpoint(), lastCommittedActionId: 'run-1:action:1' },
        {
          committedContextRevision: restored?.contextRevision ?? -1,
          committedActionId: restored?.lastCommittedActionId,
          recoveryLoss: restored?.loss,
          now: 30,
        },
      ),
    ).toBe('discard');
  });

  it('preserves a complete long prompt while it fits the total recovery budget', async () => {
    const storage = new MemoryStorage();
    const store = new RunCheckpointSessionStore(storage);
    const prompt = `Long prompt: ${'instrução completa. '.repeat(1200)}`;

    expect(prompt.length).toBeGreaterThan(20_000);
    await expect(
      store.writeRecoveryContext({
        version: 1,
        runId: 'long-prompt-run',
        sessionId: 'session-1',
        contextRevision: 2,
        messages: [{ role: 'user', content: prompt }],
      }),
    ).resolves.toBe(true);

    const restored = await store.readRecoveryContext('long-prompt-run');
    expect(restored?.messages[0].content).toBe(prompt);
    expect(restored?.loss).toBeUndefined();
  });

  it('preserves a complete long tool result while it fits the total recovery budget', async () => {
    const storage = new MemoryStorage();
    const store = new RunCheckpointSessionStore(storage);
    const report = `Tool report: ${'linha detalhada. '.repeat(1400)}`;
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-long', name: 'getContent', args: { selector: '#report' } }],
      },
      {
        role: 'tool',
        toolCallId: 'call-long',
        content: [{ type: 'tool-result', toolCallId: 'call-long', output: { report } }],
      },
    ];

    expect(report.length).toBeGreaterThan(20_000);
    await expect(
      store.writeRecoveryContext({
        version: 1,
        runId: 'long-tool-run',
        sessionId: 'session-1',
        contextRevision: 2,
        messages,
      }),
    ).resolves.toBe(true);

    const restored = await store.readRecoveryContext('long-tool-run');
    expect(JSON.stringify(restored?.messages)).toContain(report);
    expect(restored?.loss).toBeUndefined();
  });

  it('stores structured total-budget loss and refuses automatic resume', async () => {
    const storage = new MemoryStorage();
    const store = new RunCheckpointSessionStore(storage, { maxRecoveryContextBytes: 4096 });
    await expect(
      store.writeRecoveryContext({
        version: 1,
        runId: 'oversize-run',
        sessionId: 'session-1',
        contextRevision: 3,
        messages: [{ role: 'user', content: 'x'.repeat(20_000) }],
      }),
    ).resolves.toBe(true);

    const restored = await store.readRecoveryContext('oversize-run');
    expect(restored?.messages).toEqual([]);
    expect(restored?.loss).toMatchObject({
      lossy: true,
      reasons: [{ kind: 'total_byte_limit', maxBytes: 4096 }],
    });
    expect(
      recoverCheckpoint(checkpoint(), {
        committedContextRevision: 3,
        recoveryLoss: restored?.loss,
        now: 30,
      }),
    ).toBe('discard');
    expect(store.isResumeEnabled()).toBe(true);
  });

  it('returns unavailable when even structured recovery metadata exceeds its byte bound', async () => {
    const storage = new MemoryStorage();
    const store = new RunCheckpointSessionStore(storage, { maxRecoveryContextBytes: 128 });
    const available = await store.writeRecoveryContext({
      version: 1,
      runId: 'run-1',
      sessionId: 'session-1',
      contextRevision: 3,
      messages: [{ role: 'user', content: 'x'.repeat(500) }],
    });
    expect(available).toBe(false);
    expect(store.isResumeEnabled()).toBe(false);
    expect(storage.data[ACTIVE_RUN_CHECKPOINT_KEY]).toBeUndefined();
    expect(storage.data[RUN_RECOVERY_CONTEXT_KEY]).toBeUndefined();
  });
});
