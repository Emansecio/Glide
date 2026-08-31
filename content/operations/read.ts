import { beginElementSnapshot, createElementHandle } from '../element-snapshot.js';
import {
  deepQuerySelector,
  extractPageStructure,
  findElementsByQuery,
  listOpenDialogs,
  readPageInventory,
} from '../dom-interact.js';
import type { ContentOperation } from './action.js';

const targetFrom = (payload: Record<string, unknown>) => ({
  tabId: Number(payload.__glideTabId),
  frameId: Number(payload.__glideFrameId),
});

const withHandles = <T extends { selector: string; ref?: string }>(
  entries: T[],
  payload: Record<string, unknown>,
  refFor: (entry: T, index: number) => string,
) => {
  const snapshot = beginElementSnapshot();
  const target = targetFrom(payload);
  return {
    snapshotId: snapshot.id,
    entries: entries.map((entry, index) => {
      const element = deepQuerySelector(entry.selector);
      return {
        ...entry,
        ...(element ? { handle: createElementHandle(element, target, entry.selector, refFor(entry, index), snapshot) } : {}),
      };
    }),
  };
};

const findElement: ContentOperation = (payload) => {
  const result = findElementsByQuery({
    query: String(payload.query || ''),
    typeFilter: String(payload.type || 'any'),
    maxResults: typeof payload.maxResults === 'number' ? payload.maxResults : 5,
    fuzzy: payload.fuzzy !== false,
    scope: String(payload.scope || 'auto'),
    deep: payload.deep === true,
  });
  if (!result.success) return result;
  const handled = withHandles(result.candidates, payload, (_entry, index) => `e${index + 1}`);
  return { ...result, snapshotId: handled.snapshotId, candidates: handled.entries };
};

const readPage: ContentOperation = (payload) => {
  const result = readPageInventory(
    typeof payload.maxItems === 'number' ? payload.maxItems : 40,
    payload.interactiveOnly !== false,
    String(payload.scope || 'auto') as 'auto' | 'page' | 'dialog',
  );
  const handled = withHandles(result.elements, payload, (entry) => entry.ref || 'e');
  return { ...result, snapshotId: handled.snapshotId, elements: handled.entries };
};

const bodyText = (maxChars: number) => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let output = '';
  for (let node = walker.nextNode(); node && output.length < maxChars * 2; node = walker.nextNode()) {
    const tag = (node as Text).parentElement?.tagName;
    if (!['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag || '')) output += node.nodeValue || '';
  }
  return output.replace(/\s+/g, ' ').trim().slice(0, maxChars);
};

const getContent: ContentOperation = (payload) => {
  const mode = String(payload.mode || payload.type || 'text').toLowerCase();
  if (mode === 'dialogs' || mode === 'modals') return { success: true, mode: 'dialogs', dialogs: listOpenDialogs() };
  if (mode === 'structure' && !payload.selector) {
    return extractPageStructure(
      document.body,
      typeof payload.maxChars === 'number' ? payload.maxChars : 8000,
      typeof payload.maxItems === 'number' ? payload.maxItems : 40,
    );
  }
  if (mode !== 'text' || payload.selector) {
    return { success: false, code: 'BRIDGE_UNSUPPORTED', error: 'Unsupported bridge content mode.' };
  }
  return {
    success: true,
    mode: 'text',
    text: bodyText(typeof payload.maxChars === 'number' ? payload.maxChars : 8000),
  };
};

export const readOperations = { findElement, readPage, getContent } satisfies Record<string, ContentOperation>;
