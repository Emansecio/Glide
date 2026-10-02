/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressKeyOnTarget } from '../../content/dom-interact.js';

describe('pressKeyOnTarget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fills legacy code/keyCode/which so keyCode-based handlers fire', () => {
    document.body.innerHTML = '<input id="q" />';
    const seen: Array<{ code: string; keyCode: number; which: number }> = [];
    document.getElementById('q')?.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      seen.push({ code: e.code, keyCode: e.keyCode, which: e.which });
    });
    pressKeyOnTarget('Enter', '#q');
    expect(seen).toEqual([{ code: 'Enter', keyCode: 13, which: 13 }]);
  });

  it('submits the enclosing form on Enter in a text input', () => {
    document.body.innerHTML = '<form id="f"><input id="q" type="search" /></form>';
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    document.getElementById('f')?.addEventListener('submit', onSubmit);
    const result = pressKeyOnTarget('Enter', '#q');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, defaultAction: 'submit' });
  });

  it('does not submit when the page handled keydown itself', () => {
    document.body.innerHTML = '<form id="f"><input id="q" /></form>';
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    document.getElementById('f')?.addEventListener('submit', onSubmit);
    document.getElementById('q')?.addEventListener('keydown', (event) => event.preventDefault());
    const result = pressKeyOnTarget('Enter', '#q');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('defaultAction');
  });

  it('does not submit when the page cancelled keypress or the input is disabled', () => {
    document.body.innerHTML = '<form id="f"><input id="q" /><input id="d" disabled /></form>';
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    document.getElementById('f')?.addEventListener('submit', onSubmit);
    const q = document.getElementById('q');
    q?.addEventListener('keypress', (event) => event.preventDefault());
    pressKeyOnTarget('Enter', '#q');
    pressKeyOnTarget('Enter', '#d');
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('clicks a button on Enter and Space, but not on a textarea Enter', () => {
    document.body.innerHTML = '<button id="b">go</button><textarea id="t"></textarea>';
    const onClick = vi.fn();
    document.getElementById('b')?.addEventListener('click', onClick);
    pressKeyOnTarget('Enter', '#b');
    pressKeyOnTarget(' ', '#b');
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(pressKeyOnTarget('Enter', '#t')).not.toHaveProperty('defaultAction');
  });
});
