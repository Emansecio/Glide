/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('rejects handle used in another frame', () => {
    const target = document.querySelectorAll('button')[1];
    const handle = makeHandle(target, 'button:nth-of-type(2)');

    expect(resolveElementHandle(handle, document, 4, { tabId: 9, frameId: 3 })).toMatchObject({
      ok: false,
      code: 'STALE_ELEMENT_HANDLE',
    });
  });
});
