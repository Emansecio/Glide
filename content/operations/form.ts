import { deepQuerySelector, isVisible, selectOptionOnTarget, setCheckedOnTarget } from '../dom-interact.js';
import {
  type ContentOperation,
  captureDomPostconditionBaseline,
  evaluateDomPostcondition,
  resolveOperationTarget,
} from './action.js';

const applyText = (element: HTMLElement, text: string) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.disabled || element.readOnly) {
      return { success: false, code: 'ELEMENT_DISABLED', error: 'Field is disabled or readonly.' };
    }
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value === text
      ? { success: true, strategy: 'bridge-type' }
      : { success: false, code: 'VALUE_NOT_APPLIED', error: 'Field did not retain typed value.' };
  }
  if (element.isContentEditable) {
    // Editores Lexical/Draft/Slate (DMs, Slack, Gmail) ignoram `textContent`: o estado interno
    // fica vazio e o envio falha. `insertText` passa pelo pipeline normal de edição do navegador.
    let strategy = 'bridge-type';
    try {
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const done = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
      if (done) strategy = 'bridge-type-exec';
    } catch {
      // execCommand indisponível: cai no caminho direto abaixo.
    }
    if (strategy === 'bridge-type') {
      element.textContent = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    }
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    return normalize(element.textContent || '') === normalize(text)
      ? { success: true, strategy }
      : { success: false, code: 'VALUE_NOT_APPLIED', error: 'Editable field did not retain typed text.' };
  }
  return { success: false, code: 'NOT_EDITABLE', error: 'Target is not editable.' };
};

const type: ContentOperation = async (payload) => {
  const postconditionBaselineUrl = captureDomPostconditionBaseline(payload);
  const target = resolveOperationTarget(payload, 'input, textarea, [contenteditable="true"], [role="textbox"]');
  if (target.failure) return target.failure;
  const element = target.element as HTMLElement;
  if (!isVisible(element)) return { success: false, code: 'ELEMENT_NOT_FOUND', error: 'Field is not visible.' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  const result = applyText(element, String(payload.text ?? ''));
  if (!result.success) return result;
  const verification = await evaluateDomPostcondition(payload, postconditionBaselineUrl);
  return { ...result, ...(verification || {}) };
};

const selectOption: ContentOperation = async (payload) => {
  const postconditionBaselineUrl = captureDomPostconditionBaseline(payload);
  const target = payload.handle ? resolveOperationTarget(payload) : null;
  if (target?.failure) return target.failure;
  const selector = target?.element
    ? String((payload.handle as { selector?: string }).selector || '')
    : String(payload.selector || '');
  const result = await selectOptionOnTarget(selector, {
    ...(payload.value !== undefined ? { value: String(payload.value) } : {}),
    ...(payload.label !== undefined ? { label: String(payload.label) } : {}),
    ...(payload.index !== undefined ? { index: Number(payload.index) } : {}),
  });
  if (!result.success) return result;
  const verification = await evaluateDomPostcondition(payload, postconditionBaselineUrl);
  return { ...result, ...(verification || {}) };
};

const setChecked: ContentOperation = (payload) => {
  const selector = String(payload.selector || '');
  if (!deepQuerySelector(selector)) {
    return { success: false, code: 'ELEMENT_NOT_FOUND', error: `Checkbox not found: ${selector}` };
  }
  return setCheckedOnTarget(selector, payload.checked === true);
};

export const formOperations = { type, selectOption, setChecked } satisfies Record<string, ContentOperation>;
