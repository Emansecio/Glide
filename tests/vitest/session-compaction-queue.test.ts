import { describe, expect, it } from 'vitest';
import { SessionCompactionQueue } from '../../background/session-lifecycle.js';

describe('SessionCompactionQueue awaited legacy coverage', () => {
  it('serializes same-session work', async () => {
    const queue = new SessionCompactionQueue();
    const events: string[] = [];
    const first = queue.run('session-1', async () => {
      events.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push('first:end');
    });
    const second = queue.run('session-1', async () => {
      events.push('second');
    });

    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });
});
