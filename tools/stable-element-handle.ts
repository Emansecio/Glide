export type ElementFingerprint = {
  tag: string;
  role?: string;
  accessibleName?: string;
  testId?: string;
  inputType?: string;
};

export type StableElementHandle = {
  version: 1;
  snapshotId: string;
  ref: string;
  tabId: number;
  frameId: number;
  selector: string;
  fingerprint: ElementFingerprint;
  domRevision: number;
};

export type HandleVerification =
  | { ok: true; refreshed: boolean }
  | { ok: false; code: 'STALE_ELEMENT_HANDLE'; reason: string };

const normalizedName = (element: Element): string =>
  String(
    element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      (element as HTMLInputElement).placeholder ||
      element.textContent ||
      '',
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

export const fingerprintElement = (element: Element): ElementFingerprint => {
  const role = element.getAttribute('role') || undefined;
  const accessibleName = normalizedName(element) || undefined;
  const testId = element.getAttribute('data-testid') || undefined;
  const inputType = element instanceof HTMLInputElement ? String(element.type || 'text').toLowerCase() : undefined;
  return {
    tag: element.tagName.toLowerCase(),
    ...(role ? { role } : {}),
    ...(accessibleName ? { accessibleName } : {}),
    ...(testId ? { testId } : {}),
    ...(inputType ? { inputType } : {}),
  };
};

export const isStableElementHandle = (value: unknown): value is StableElementHandle => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<StableElementHandle>;
  return (
    row.version === 1 &&
    typeof row.snapshotId === 'string' &&
    typeof row.ref === 'string' &&
    typeof row.tabId === 'number' &&
    typeof row.frameId === 'number' &&
    typeof row.selector === 'string' &&
    Boolean(row.fingerprint && typeof row.fingerprint.tag === 'string') &&
    typeof row.domRevision === 'number'
  );
};

export function verifyElementHandle(
  handle: StableElementHandle,
  element: Element,
  currentRevision: number,
): HandleVerification {
  const actual = fingerprintElement(element);
  for (const key of ['tag', 'role', 'accessibleName', 'testId', 'inputType'] as const) {
    if (handle.fingerprint[key] !== actual[key]) {
      return { ok: false, code: 'STALE_ELEMENT_HANDLE', reason: `Fingerprint mismatch: ${key}.` };
    }
  }
  return { ok: true, refreshed: currentRevision !== handle.domRevision };
}

export type HandleResolution =
  | { ok: true; element: Element; verification: Extract<HandleVerification, { ok: true }> }
  | {
      ok: false;
      code: 'STALE_ELEMENT_HANDLE';
      error: string;
      candidates: Array<{ selector: string; fingerprint: ElementFingerprint }>;
    };

const refreshedCandidates = (handle: StableElementHandle, root: ParentNode) => {
  const candidates: Array<{ selector: string; fingerprint: ElementFingerprint }> = [];
  const escapedName = handle.fingerprint.accessibleName;
  for (const element of Array.from(root.querySelectorAll(handle.fingerprint.tag)).slice(0, 80)) {
    const fingerprint = fingerprintElement(element);
    if (escapedName && fingerprint.accessibleName !== escapedName) continue;
    const selector = element.id ? `#${CSS.escape(element.id)}` : handle.fingerprint.testId
      ? `[data-testid="${CSS.escape(handle.fingerprint.testId)}"]`
      : handle.selector;
    candidates.push({ selector, fingerprint });
    if (candidates.length >= 8) break;
  }
  return candidates;
};

export function resolveElementHandle(
  handle: StableElementHandle,
  root: ParentNode,
  currentRevision: number,
  target?: { tabId: number; frameId: number },
): HandleResolution {
  if (target && (handle.tabId !== target.tabId || handle.frameId !== target.frameId)) {
    return {
      ok: false,
      code: 'STALE_ELEMENT_HANDLE',
      error: 'Handle belongs to another tab or frame.',
      candidates: refreshedCandidates(handle, root),
    };
  }
  let element: Element | null = null;
  try {
    element = root.querySelector(handle.selector);
  } catch {
    element = null;
  }
  if (!element) {
    return {
      ok: false,
      code: 'STALE_ELEMENT_HANDLE',
      error: 'Handle selector no longer resolves.',
      candidates: refreshedCandidates(handle, root),
    };
  }
  const verification = verifyElementHandle(handle, element, currentRevision);
  if (!verification.ok) {
    return {
      ok: false,
      code: verification.code,
      error: verification.reason,
      candidates: refreshedCandidates(handle, root),
    };
  }
  return { ok: true, element, verification };
}
