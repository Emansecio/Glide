import { describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_LIMITS, validateAttachmentBatch } from '../../sidepanel/ui/attachment-policy.js';

describe('attachment policy', () => {
  it('rejects oversized text before any read method can run', () => {
    const text = vi.fn(() => {
      throw new Error('must not read');
    });
    const decisions = validateAttachmentBatch(
      [],
      [{ name: 'huge.txt', type: 'text/plain', size: ATTACHMENT_LIMITS.textBytes + 1, text }],
    );
    expect(decisions[0].accepted).toBe(false);
    expect(decisions[0].reason).toContain('2 MB');
    expect(text).not.toHaveBeenCalled();
  });

  it('rejects oversized image before decoding', () => {
    const arrayBuffer = vi.fn(() => {
      throw new Error('must not decode');
    });
    const decisions = validateAttachmentBatch(
      [],
      [{ name: 'huge.png', type: 'image/png', size: ATTACHMENT_LIMITS.imageBytes + 1, arrayBuffer }],
    );
    expect(decisions[0].accepted).toBe(false);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('accepts files until total budget then rejects only exceeding additions', () => {
    const existing = [{ kind: 'text' as const, byteSize: 22_000_000 }];
    const decisions = validateAttachmentBatch(existing, [
      { name: 'ok.txt', type: 'text/plain', size: 1_000_000 },
      { name: 'over.txt', type: 'text/plain', size: 2_000_000 },
      { name: 'later.txt', type: 'text/plain', size: 500_000 },
    ]);
    expect(decisions.map((item) => item.accepted)).toEqual([true, false, true]);
    expect(decisions[1].reason).toContain('24 MB');
  });
});
