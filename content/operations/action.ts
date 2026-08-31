import { resolveSnapshotHandle } from '../element-snapshot.js';
import {
  CLICKABLE_SELECTOR,
  INTERACTIVE_SELECTOR,
  deepQuerySelector,
  dismissOpenModal,
  highlightElementOverlay,
  isVisible,
  listOpenDialogs,
  performHover,
  performMouseAction,
  performRichClick,
  pressKeyOnTarget,
  resolveInteractiveTarget,
  resolveReadPageRef,
  scrollPage,
  waitForNewDialog,
} from '../dom-interact.js';

export type ContentOperation = (payload: Record<string, unknown>) => Promise<unknown> | unknown;

export const resolveOperationTarget = (
  payload: Record<string, unknown>,
  selectorSet = INTERACTIVE_SELECTOR,
): { element?: HTMLElement; failure?: Record<string, unknown> } => {
  if (payload.handle) {
    const resolved = resolveSnapshotHandle(payload.handle, {
      tabId: Number(payload.__glideTabId),
      frameId: Number(payload.__glideFrameId),
    });
    if (resolved && !resolved.ok) return { failure: resolved };
    if (resolved?.ok) return { element: resolved.element as HTMLElement };
  }
  const selector = String(payload.selector || '').trim();
  if (!selector) return { failure: { success: false, code: 'INVALID_SELECTOR', error: 'Missing selector.' } };
  const element = resolveInteractiveTarget(selector, selectorSet);
  if (!element) {
    return {
      failure: { success: false, code: 'ELEMENT_NOT_FOUND', error: `Element not found: ${selector}` },
    };
  }
  return { element };
};

const click: ContentOperation = async (payload) => {
  const target = resolveOperationTarget(payload, CLICKABLE_SELECTOR);
  if (target.failure) return target.failure;
  const element = target.element as HTMLElement;
  if ((element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true') {
    return { success: false, code: 'ELEMENT_DISABLED', error: 'Target element is disabled.' };
  }
  const before = listOpenDialogs().length;
  const result = performRichClick(element);
  if (!result.success || payload.waitForDialog === false) return result;
  const openedDialog = await waitForNewDialog(before, 320);
  return { ...result, openedDialog: openedDialog || undefined, dialogOpen: Boolean(openedDialog) };
};

const hover: ContentOperation = (payload) => {
  const target = resolveOperationTarget(payload);
  return target.failure || performHover(target.element as HTMLElement);
};

const mouse: ContentOperation = (payload) => {
  const target = resolveOperationTarget(payload);
  if (target.failure) return target.failure;
  const result = performMouseAction(target.element as HTMLElement, String(payload.action || ''));
  return result || { success: false, code: 'MOUSE_ACTION_FAILED', error: 'Mouse action failed.' };
};

const pressKey: ContentOperation = (payload) => {
  const target = payload.handle ? resolveOperationTarget(payload) : null;
  if (target?.failure) return target.failure;
  const selector = target?.element ? String((payload.handle as { selector?: string }).selector || '') : String(payload.selector || '');
  return pressKeyOnTarget(
    String(payload.key || ''),
    selector || undefined,
    Array.isArray(payload.modifiers) ? payload.modifiers.map(String) : undefined,
  );
};

const scroll: ContentOperation = (payload) =>
  scrollPage(
    String(payload.direction || 'down'),
    typeof payload.amount === 'number' ? payload.amount : 600,
    typeof payload.selector === 'string' ? payload.selector : undefined,
    typeof payload.strategy === 'string' ? payload.strategy : 'auto',
  );

const dismissModal: ContentOperation = () => dismissOpenModal();

const highlightElement: ContentOperation = (payload) => {
  const target = payload.handle
    ? resolveOperationTarget(payload)
    : payload.selector
      ? { element: deepQuerySelector<HTMLElement>(String(payload.selector)) || undefined }
      : { element: resolveReadPageRef(String(payload.ref || ''), 'auto', true) || undefined };
  if (target.failure) return target.failure;
  if (!target.element || !isVisible(target.element)) {
    return { success: false, code: 'ELEMENT_NOT_FOUND', error: 'Highlight target not found.' };
  }
  target.element.scrollIntoView({ block: 'center', inline: 'center' });
  return highlightElementOverlay(target.element, {
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
    label: typeof payload.ref === 'string' ? payload.ref : undefined,
  });
};

export const actionOperations = {
  click,
  hover,
  mouse,
  pressKey,
  scroll,
  dismissModal,
  highlightElement,
} satisfies Record<string, ContentOperation>;
