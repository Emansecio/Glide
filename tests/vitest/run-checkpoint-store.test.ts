import { describe, expect, it } from 'vitest';
import type { Message } from '../../ai/message-schema.js';
import { buildToolTurnMessages } from '../../ai/tool-history.js';
import {
  ACTIVE_RUN_CHECKPOINT_KEY,
  RUN_RECOVERY_CONTEXT_KEY,
  RunCheckpointSessionStore,
} from '../../background/run-checkpoint-store.js';
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

  it('disables resume after write failure without throwing', async () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const store = new RunCheckpointSessionStore(storage);
    await expect(store.write(checkpoint())).resolves.toBeUndefined();
    expect(store.isResumeEnabled()).toBe(false);
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
        messages,
      }),
    ).resolves.toBe(true);

    const restored = await store.readRecoveryContext('run-1');
    expect(restored?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const pairedCall = restored?.messages[1]?.toolCalls?.[0];
    const toolParts = restored?.messages[2]?.content as Array<{ toolCallId?: string }>;
    expect(pairedCall?.id).toBe('call-1');
    expect(toolParts[0]?.toolCallId).toBe(pairedCall?.id);
    const serialized = JSON.stringify(restored?.messages);
    expect(serialized).not.toContain('tool-result-secret');
    expect(serialized).not.toContain('tool-argument-secret');
    expect(serialized).not.toContain('data:image');
    expect(
      recoverCheckpoint(checkpoint(), { committedContextRevision: restored?.contextRevision ?? -1, now: 30 }),
    ).toBe('resume');
  });

  it('returns unavailable when sanitized recovery context exceeds its byte bound', async () => {
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
    expect(storage.data[RUN_RECOVERY_CONTEXT_KEY]).toBeUndefined();
  });
});
