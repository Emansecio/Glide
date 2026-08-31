export type SelectorCandidate = {
  selector: string;
  score: number;
  reason: string;
  unique: boolean;
};

const normalize = (value: string | null | undefined): string =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const escapeCss = (value: string): string => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
};

const selectorMatchesOnly = (root: Document | ShadowRoot | Element, selector: string, element: Element): boolean => {
  try {
    const matches = root.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
};

const accessibleName = (element: Element): string => {
  const aria = element.getAttribute('aria-label');
  if (aria) return aria;
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const owner = element.ownerDocument;
    const text = labelledBy
      .split(/\s+/)
      .map((id) => owner.getElementById(id)?.textContent || '')
      .join(' ');
    if (text.trim()) return text;
  }
  if (element instanceof HTMLInputElement && element.labels?.length) {
    return Array.from(element.labels)
      .map((label) => label.textContent || '')
      .join(' ');
  }
  return element.textContent || '';
};

const scoreField = (field: string, query: string, base: number, reason: string) => {
  if (!field) return { matched: false, score: 0, reason: '' };
  if (field === query) return { matched: true, score: base, reason: `exact ${reason}` };
  if (field.includes(query)) return { matched: true, score: base - 20, reason: `${reason} contains query` };
  if (field.length >= 3 && query.includes(field)) {
    return { matched: true, score: base - 35, reason: `query contains ${reason}` };
  }
  return { matched: false, score: 0, reason: '' };
};

const levenshtein = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
};

export function matchesElementQuery(
  element: Element,
  query: string,
  fuzzy: boolean,
): { matched: boolean; score: number; reason: string } {
  const needle = normalize(query);
  if (!needle) return { matched: false, score: 0, reason: 'empty query' };
  const fields: Array<[string, number, string]> = [
    [normalize(accessibleName(element)), 120, 'accessible name'],
    [normalize(element.getAttribute('title')), 105, 'title'],
    [normalize(element.getAttribute('placeholder')), 100, 'placeholder'],
    [normalize(element.getAttribute('data-testid')), 95, 'data-testid'],
    [normalize(element.getAttribute('name')), 90, 'name'],
    [normalize(element.id), 85, 'id'],
  ];
  let best = { matched: false, score: 0, reason: 'no matching field' };
  for (const [field, base, reason] of fields) {
    const result = scoreField(field, needle, base, reason);
    if (result.score > best.score) best = result;
  }
  if (best.matched || !fuzzy || needle.length < 5) return best;
  for (const [field, base, reason] of fields) {
    if (!field || field.length > 40 || Math.abs(field.length - needle.length) > 3) continue;
    const distance = levenshtein(field, needle);
    const threshold = needle.length <= 8 ? 1 : needle.length <= 15 ? 2 : 3;
    if (distance <= threshold && base - 45 - distance > best.score) {
      best = { matched: true, score: base - 45 - distance, reason: `fuzzy ${reason}` };
    }
  }
  return best;
}

const stableClasses = (element: Element): string[] =>
  Array.from(element.classList).filter(
    (name) => /^[a-z][a-z0-9_-]{2,40}$/i.test(name) && !/[0-9]{5,}/.test(name) && !/^x[a-z0-9]{4,}$/i.test(name),
  );

export function buildUniqueSelector(
  element: Element,
  root: Document | ShadowRoot | Element = element.ownerDocument,
): SelectorCandidate {
  const candidates: Array<Omit<SelectorCandidate, 'unique'>> = [];
  if (element.id) candidates.push({ selector: `#${escapeCss(element.id)}`, score: 120, reason: 'unique id' });
  for (const [attribute, score] of [
    ['data-testid', 115],
    ['name', 110],
    ['aria-label', 105],
    ['placeholder', 100],
  ] as const) {
    const value = element.getAttribute(attribute);
    if (value) {
      candidates.push({
        selector: `[${attribute}="${escapeCss(value)}"]`,
        score,
        reason: `unique ${attribute}`,
      });
    }
  }
  const role = element.getAttribute('role');
  const aria = element.getAttribute('aria-label');
  if (role && aria) {
    candidates.push({
      selector: `[role="${escapeCss(role)}"][aria-label="${escapeCss(aria)}"]`,
      score: 98,
      reason: 'unique role and accessible name',
    });
  }
  const classes = stableClasses(element);
  for (let count = 1; count <= Math.min(3, classes.length); count += 1) {
    candidates.push({
      selector: classes
        .slice(0, count)
        .map((name) => `.${escapeCss(name)}`)
        .join(''),
      score: 90 - count,
      reason: 'unique stable class combination',
    });
  }
  for (const candidate of candidates) {
    if (selectorMatchesOnly(root, candidate.selector, element)) return { ...candidate, unique: true };
  }

  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current !== root) {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    const siblings = parent
      ? Array.from(parent.children).filter((sibling) => sibling.tagName === current?.tagName)
      : [];
    const index = siblings.indexOf(current) + 1;
    segments.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    const selector = segments.join(' > ');
    if (selectorMatchesOnly(root, selector, element)) {
      return { selector, score: 50, reason: 'scoped structural fallback', unique: true };
    }
    current = parent;
  }
  const fallback = segments.join(' > ') || element.tagName.toLowerCase();
  return {
    selector: fallback,
    score: 0,
    reason: 'non-unique structural fallback',
    unique: selectorMatchesOnly(root, fallback, element),
  };
}
