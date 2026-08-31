import { describe, expect, it } from 'vitest';
import { VisionInbox } from '../../background/vision-inbox.js';

describe('VisionInbox', () => {
  it('delivers successful descriptions exactly once without action failure', () => {
    const inbox = new VisionInbox();
    inbox.publish('run-1', { tool: 'screenshot', description: 'Save dialog is open.', source: 'screenshot' });
    expect(inbox.hasPending('run-1')).toBe(true);
    expect(inbox.consume('run-1')).toEqual([
      { tool: 'screenshot', description: 'Save dialog is open.', source: 'screenshot' },
    ]);
    expect(inbox.consume('run-1')).toEqual([]);
  });

  it('discards late descriptions after terminal', () => {
    const inbox = new VisionInbox();
    inbox.terminal('run-1');
    inbox.publish('run-1', { tool: 'screenshot', description: 'late', source: 'screenshot' });
    expect(inbox.hasPending('run-1')).toBe(false);
  });

  it('bounds descriptions and queue length', () => {
    const inbox = new VisionInbox({ maxItemsPerRun: 2, maxDescriptionChars: 8 });
    inbox.publish('run-1', { tool: 'a', description: '123456789', source: 'recovery' });
    inbox.publish('run-1', { tool: 'b', description: 'second', source: 'screenshot' });
    inbox.publish('run-1', { tool: 'c', description: 'third', source: 'screenshot' });
    expect(inbox.consume('run-1')).toEqual([
      { tool: 'b', description: 'second', source: 'screenshot' },
      { tool: 'c', description: 'third', source: 'screenshot' },
    ]);
  });
});
