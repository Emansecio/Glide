// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { buildUniqueSelector, matchesElementQuery } from '../../content/selector-engine.js';

describe('selector engine', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not reverse-match one-character fields against unrelated phrases', () => {
    document.body.innerHTML = '<input id="c" aria-label="Choice"><button>Second action</button>';
    const input = document.querySelector('input')!;
    expect(matchesElementQuery(input, 'Second action', false).matched).toBe(false);
  });

  it('rejects duplicate stable classes', () => {
    document.body.innerHTML = '<section><button class="action">First</button><button class="action">Second action</button></section>';
    const secondAction = document.querySelectorAll('button')[1];
    const candidate = buildUniqueSelector(secondAction);
    expect(candidate.selector).not.toBe('.action');
    expect(document.querySelectorAll(candidate.selector)).toHaveLength(1);
  });

  it('prefers unique data-testid selectors', () => {
    document.body.innerHTML = '<button data-testid="save-action">Save</button>';
    expect(buildUniqueSelector(document.querySelector('button')!)).toMatchObject({
      selector: '[data-testid="save-action"]',
      unique: true,
    });
  });

  it('ranks exact accessible names above text containment', () => {
    document.body.innerHTML = '<button aria-label="Second action">Icon</button><button>Run Second action now</button>';
    const [named, containing] = Array.from(document.querySelectorAll('button'));
    expect(matchesElementQuery(named, 'Second action', false).score).toBeGreaterThan(
      matchesElementQuery(containing, 'Second action', false).score,
    );
  });

  it('builds a structural selector scoped to the supplied root', () => {
    document.body.innerHTML = '<div id="outside"><span>Other</span></div><div id="scope"><span>One</span><span>Two</span></div>';
    const scope = document.querySelector('#scope')!;
    const target = scope.querySelectorAll('span')[1];
    const candidate = buildUniqueSelector(target, scope);
    expect(candidate.unique).toBe(true);
    expect(scope.querySelector(candidate.selector)).toBe(target);
    expect(candidate.reason).toContain('structural');
  });
});
