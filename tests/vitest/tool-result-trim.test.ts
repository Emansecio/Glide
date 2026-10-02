import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { trimOldToolResults } from '../../ai/tool-result-trim.js';

const toolMessage = (id: string, chars: number): ModelMessage =>
  ({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'getContent',
        output: { type: 'json', value: { text: 'x'.repeat(chars) } },
      },
    ],
  }) as ModelMessage;

const outputOf = (message: ModelMessage) =>
  (message.content as Array<{ output: { type: string; value: unknown } }>)[0].output;

describe('trimOldToolResults', () => {
  it('leaves messages untouched below the budget', () => {
    const messages = [toolMessage('a', 1000), toolMessage('b', 1000)];
    expect(trimOldToolResults(messages, { maxTotalChars: 10_000 })).toBe(messages);
  });

  it('trims only the oldest results when over budget and keeps the recent ones intact', () => {
    const messages = Array.from({ length: 10 }, (_, i) => toolMessage(`t${i}`, 50_000));
    const trimmed = trimOldToolResults(messages, { maxTotalChars: 200_000, keepRecent: 3 });
    expect(trimmed).not.toBe(messages);
    expect(outputOf(trimmed[0]).type).toBe('text');
    expect(String(outputOf(trimmed[0]).value)).toContain('trimmed');
    for (const message of trimmed.slice(-3)) expect(outputOf(message).type).toBe('json');
    // Não muta a entrada (o cache do passe reutiliza o array original).
    expect(outputOf(messages[0]).type).toBe('json');
    const total = trimmed.reduce((sum, m) => sum + JSON.stringify(outputOf(m)).length, 0);
    expect(total).toBeLessThan(10 * 50_000);
  });

  it('never trims the most recent keepRecent results even if still over budget', () => {
    const messages = Array.from({ length: 4 }, (_, i) => toolMessage(`t${i}`, 100_000));
    const trimmed = trimOldToolResults(messages, { maxTotalChars: 1000, keepRecent: 4 });
    expect(trimmed).toBe(messages);
  });

  it('trims in batches (hysteresis) so the cached prefix does not change on every step', () => {
    const messages: ModelMessage[] = [];
    let previous: string[] = [];
    const changedPerStep: number[] = [];
    for (let step = 0; step < 14; step += 1) {
      messages.push(toolMessage(`t${step}`, 60_000));
      const trimmed = trimOldToolResults(messages, { maxTotalChars: 300_000, keepRecent: 2 });
      const now = trimmed.map((message) => JSON.stringify(message));
      changedPerStep.push(now.filter((text, i) => previous[i] !== undefined && text !== previous[i]).length);
      previous = now;
    }
    // Sem histerese todo step após estourar alteraria ao menos uma mensagem antiga.
    expect(changedPerStep.filter((n) => n === 0).length).toBeGreaterThan(3);
  });

  it('counts images as a small fixed cost and keeps the error type of trimmed results', () => {
    const image = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'img',
          toolName: 'screenshot',
          output: { type: 'content', value: [{ type: 'media', data: 'A'.repeat(300_000), mediaType: 'image/png' }] },
        },
      ],
    } as ModelMessage;
    // 3 imagens de 300k chars de base64 não devem disparar o trim sozinhas.
    expect(trimOldToolResults([image, image, image], { maxTotalChars: 100_000, keepRecent: 0 })).toHaveLength(3);
    const errorResult = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'err',
          toolName: 'getContent',
          output: { type: 'error-text', value: 'x'.repeat(50_000) },
        },
      ],
    } as ModelMessage;
    const trimmed = trimOldToolResults([errorResult, toolMessage('a', 50_000), toolMessage('b', 50_000)], {
      maxTotalChars: 60_000,
      keepRecent: 1,
    });
    expect(outputOf(trimmed[0]).type).toBe('error-text');
  });
});
