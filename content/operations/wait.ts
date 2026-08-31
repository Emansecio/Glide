import { deepQuerySelector, isVisible, listOpenDialogs, sleep } from '../dom-interact.js';
import type { ContentOperation } from './action.js';

const wait: ContentOperation = async (payload) => {
  const condition = String(payload.condition || 'time').toLowerCase();
  if (condition === 'time') {
    const ms = typeof payload.ms === 'number' ? Math.max(0, payload.ms) : 500;
    await sleep(ms);
    return { success: true, condition, ms };
  }
  const timeoutMs = typeof payload.timeoutMs === 'number' ? Math.max(1, payload.timeoutMs) : 5000;
  const selector = String(payload.selector || '');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition === 'dialog' || condition === 'modal') {
      const dialogs = listOpenDialogs();
      if (dialogs.length) return { success: true, condition: 'dialog', dialogs };
    } else {
      const element = deepQuerySelector<HTMLElement>(selector);
      const visible = Boolean(element && isVisible(element));
      if ((condition === 'hidden' && !visible) || (condition !== 'hidden' && visible)) {
        return { success: true, condition, selector };
      }
    }
    await sleep(100);
  }
  return {
    success: false,
    code: 'WAIT_TIMEOUT',
    error: `Wait condition not met: ${condition}`,
    observed: { selector, visible: Boolean(deepQuerySelector<HTMLElement>(selector)) },
  };
};

export const waitOperations = { wait } satisfies Record<string, ContentOperation>;
