import { describe, expect, it } from 'vitest';
import {
  ACTIVE_RUN_CHECKPOINT_KEY,
  RunCheckpointSessionStore,
} from '../../background/run-checkpoint-store.js';
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
});
