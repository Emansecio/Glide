export const deepQuerySelector = <T extends Element = HTMLElement>(
  query: string,
  root: ParentNode = document,
): T | null => {
  if (!query) return null;
  if (!query.includes('>>>')) {
    try {
      return root.querySelector<T>(query);
    } catch {
      return null;
    }
  }
  const parts = query
    .split('>>>')
    .map((part) => part.trim())
    .filter(Boolean);
  let current: ParentNode = root;
  for (let index = 0; index < parts.length; index += 1) {
    let next: Element | null = null;
    try {
      next = current.querySelector(parts[index]);
    } catch {
      return null;
    }
    if (!next) return null;
    if (index === parts.length - 1) return next as T;
    const shadow = (next as HTMLElement).shadowRoot;
    if (!shadow) return null;
    current = shadow;
  }
  return null;
};
