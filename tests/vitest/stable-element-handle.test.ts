/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginElementSnapshot, createElementHandle, resolveSnapshotHandle } from '../../content/element-snapshot.js';
import {
  type StableElementHandle,
  fingerprintElement,
  resolveElementHandle,
  verifyElementHandle,
} from '../../tools/stable-element-handle.js';

const makeHandle = (element: Element, selector: string): StableElementHandle => ({
  version: 1,
  snapshotId: 'snap-1',
  ref: 'e1',
  tabId: 9,
  frameId: 2,
  selector,
  fingerprint: fingerprintElement(element),
  domRevision: 4,
});

describe('stable element handles', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div><button>First</button><button>Target</button></div>';
  });

  it('captures identity-bearing fingerprint fields', () => {
    const target = document.querySelectorAll('button')[1];
    target.setAttribute('role', 'button');
    target.setAttribute('data-testid', 'save');

    expect(fingerprintElement(target)).toEqual({
      tag: 'button',
      role: 'button',
      accessibleName: 'Target',
      testId: 'save',
    });
  });

  it('fails closed when ordinal selector retargets after insertion', () => {
    const target = document.querySelectorAll('button')[1];
    const handle = makeHandle(target, 'button:nth-of-type(2)');
    target.parentElement?.insertAdjacentHTML('afterbegin', '<button>Inserted</button>');

    const resolved = resolveElementHandle(handle, document, 5);

    expect(resolved).toMatchObject({ ok: false, code: 'STALE_ELEMENT_HANDLE' });
    if (!resolved.ok) expect(resolved.candidates.length).toBeGreaterThan(0);
  });

  it('accepts same fingerprint across benign DOM revision changes', () => {
    const target = document.querySelectorAll('button')[1];
    const handle = makeHandle(target, 'button:nth-of-type(2)');

    expect(verifyElementHandle(handle, target, 7)).toMatchObject({ ok: true, refreshed: true });
  });

  it('resolves a handle through Glide shadow selector syntax', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.querySelector<HTMLElement>('#host');
    const shadow = host?.attachShadow({ mode: 'open' });
    if (!shadow) throw new Error('Shadow root fixture unavailable.');
    shadow.innerHTML = '<button id="save">Target</button>';
    const target = shadow.querySelector('#save');
    if (!target) throw new Error('Shadow target fixture unavailable.');
    const handle = makeHandle(target, '#host >>> #save');

    const resolved = resolveElementHandle(handle, document, 4, { tabId: 9, frameId: 2 });

    expect(resolved).toMatchObject({ ok: true });
    if (resolved.ok) expect(resolved.element).toBe(target);
  });

  it('returns refreshed candidates when snapshot expires', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const target = document.querySelectorAll('button')[1];
    target.id = 'save';
    const snapshot = beginElementSnapshot();
    const handle = createElementHandle(target, { tabId: 9, frameId: 2 }, '#save', 'e2', snapshot);
    now.mockReturnValue(62_000);

    const resolved = resolveSnapshotHandle(handle, { tabId: 9, frameId: 2 });

    expect(resolved).toMatchObject({ ok: false, code: 'STALE_ELEMENT_HANDLE' });
    if (resolved && !resolved.ok)
      expect(resolved.candidates).toContainEqual(expect.objectContaining({ selector: '#save' }));
    now.mockRestore();
  });

  it('rejects handle used in another frame', () => {
    const target = document.querySelectorAll('button')[1];
    const handle = makeHandle(target, 'button:nth-of-type(2)');

    expect(resolveElementHandle(handle, document, 4, { tabId: 9, frameId: 3 })).toMatchObject({
      ok: false,
      code: 'STALE_ELEMENT_HANDLE',
    });
  });
});
