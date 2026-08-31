import { describe, expect, it } from 'vitest';
import { actionOperations } from '../../content/operations/action.js';
import { formOperations } from '../../content/operations/form.js';
import { readOperations } from '../../content/operations/read.js';
import { waitOperations } from '../../content/operations/wait.js';

const operations = { ...actionOperations, ...formOperations, ...readOperations, ...waitOperations };

describe('canonical content operation parity', () => {
  it.each([
    'click',
    'hover',
    'type',
    'pressKey',
    'scroll',
    'findElement',
    'getContent',
    'readPage',
    'wait',
    'selectOption',
    'setChecked',
    'dismissModal',
    'highlightElement',
  ])('registers %s in source-normal bridge modules', (name) => {
    expect(operations[name as keyof typeof operations]).toBeTypeOf('function');
  });

  it('records browser-tools source baseline for bundle comparison', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile('tools/browser-tools.ts', 'utf8'));
    console.info(`BrowserTools source baseline: ${source.length} characters`);
    expect(source.length).toBeGreaterThan(100_000);
  });
});
