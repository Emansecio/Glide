import { describe, expect, it } from 'vitest';
import { canApplyCompactionResult } from '../../background/context-transaction.js';

async function simulatePendingCompaction(options: { abort?: boolean; sourceRevision?: number; currentRevision?: number }) {
  const controller = new AbortController();
  let resolveSummary!: () => void;
  const pending = new Promise<void>((resolve) => {
    resolveSummary = resolve;
  });
  const effects = { deleted: 0, created: 0, committed: 0, emitted: 0 };
  const work = pending.then(() => {
    if (
      !canApplyCompactionResult({
        abortSignal: controller.signal,
        runOwned: true,
        tombstoned: false,
        generationMatches: true,
        sourceRevision: options.sourceRevision ?? 2,
        currentRevision: options.currentRevision ?? 2,
      })
    ) {
      return;
    }
    effects.deleted += 1;
    effects.created += 1;
    effects.committed += 1;
    effects.emitted += 1;
  });
  if (options.abort) controller.abort();
  resolveSummary();
  await work;
  return effects;
}

describe('compaction transaction guard', () => {
  it('discards summary resolved after abort without storage or runtime effects', async () => {
    expect(await simulatePendingCompaction({ abort: true })).toEqual({ deleted: 0, created: 0, committed: 0, emitted: 0 });
  });

  it('discards summary from a stale source revision identically', async () => {
    expect(await simulatePendingCompaction({ sourceRevision: 2, currentRevision: 3 })).toEqual({
      deleted: 0,
      created: 0,
      committed: 0,
      emitted: 0,
    });
  });

  it('allows current owned non-aborted compaction result', async () => {
    expect(await simulatePendingCompaction({})).toEqual({ deleted: 1, created: 1, committed: 1, emitted: 1 });
  });
});
