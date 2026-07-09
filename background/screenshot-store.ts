const SCREENSHOT_KEY_PREFIX = 'glideScreenshot:';
const INDEX_KEY = 'glideScreenshotIndex';
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
/** Hard cap on retained screenshots (FIFO after age prune). */
export const MAX_SCREENSHOT_COUNT = 6;
/** Approximate cap on total stored dataURL characters (~5MB). */
export const MAX_SCREENSHOT_TOTAL_BYTES = 5 * 1024 * 1024;

type StoredScreenshot = {
  dataUrl: string;
  storedAt: number;
};

export type ScreenshotIndexEntry = {
  id: string;
  storedAt: number;
  bytes: number;
};

export const buildScreenshotStorageKey = (screenshotId: string) => `${SCREENSHOT_KEY_PREFIX}${screenshotId}`;

export const createScreenshotId = () => `ss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Pure prune planner — no Chrome APIs. Used by the store and unit tests.
 * Drops expired entries first, then FIFO until count/byte caps fit.
 */
export function planScreenshotPrune(
  entries: ScreenshotIndexEntry[],
  now = Date.now(),
  options: {
    maxAgeMs?: number;
    maxCount?: number;
    maxBytes?: number;
  } = {},
): { keep: ScreenshotIndexEntry[]; removeIds: string[] } {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxCount = options.maxCount ?? MAX_SCREENSHOT_COUNT;
  const maxBytes = options.maxBytes ?? MAX_SCREENSHOT_TOTAL_BYTES;

  const removeIds: string[] = [];
  const keep: ScreenshotIndexEntry[] = [];

  for (const entry of entries) {
    if (!entry?.id) continue;
    if (!entry.storedAt || now - entry.storedAt > maxAgeMs) {
      removeIds.push(entry.id);
      continue;
    }
    keep.push(entry);
  }

  while (keep.length > maxCount) {
    const oldest = keep.shift();
    if (!oldest) break;
    removeIds.push(oldest.id);
  }

  let totalBytes = keep.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
  while (keep.length > 0 && totalBytes > maxBytes) {
    const oldest = keep.shift();
    if (!oldest) break;
    removeIds.push(oldest.id);
    totalBytes -= oldest.bytes || 0;
  }

  return { keep, removeIds };
}

const readIndex = async (): Promise<ScreenshotIndexEntry[]> => {
  const stored = await chrome.storage.session.get([INDEX_KEY]);
  const raw = stored?.[INDEX_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ScreenshotIndexEntry =>
      Boolean(entry && typeof entry === 'object' && typeof entry.id === 'string'),
  );
};

const writeIndex = async (entries: ScreenshotIndexEntry[]) => {
  await chrome.storage.session.set({ [INDEX_KEY]: entries });
};

const removeScreenshotKeys = async (ids: string[]) => {
  if (!ids.length) return;
  const keys = ids.map((id) => buildScreenshotStorageKey(id));
  await chrome.storage.session.remove(keys);
};

export const storeScreenshotDataUrl = async (dataUrl: string, screenshotId = createScreenshotId()) => {
  const key = buildScreenshotStorageKey(screenshotId);
  const storedAt = Date.now();
  const bytes = typeof dataUrl === 'string' ? dataUrl.length : 0;
  await chrome.storage.session.set({
    [key]: {
      dataUrl,
      storedAt,
    },
  });

  const index = await readIndex();
  index.push({ id: screenshotId, storedAt, bytes });
  const { keep, removeIds } = planScreenshotPrune(index, storedAt);
  if (removeIds.length > 0) {
    await removeScreenshotKeys(removeIds);
  }
  await writeIndex(keep);
  return screenshotId;
};

export const readScreenshotDataUrl = async (screenshotId: string) => {
  const key = buildScreenshotStorageKey(screenshotId);
  const stored = await chrome.storage.session.get([key]);
  const entry = stored?.[key] as StoredScreenshot | undefined;
  return typeof entry?.dataUrl === 'string' ? entry.dataUrl : null;
};

/**
 * Age + count + byte prune using the small index key only — never `get(null)`.
 */
export const pruneScreenshotStore = async (maxAgeMs = DEFAULT_MAX_AGE_MS) => {
  const index = await readIndex();
  const { keep, removeIds } = planScreenshotPrune(index, Date.now(), { maxAgeMs });
  if (removeIds.length > 0) {
    await removeScreenshotKeys(removeIds);
  }
  if (removeIds.length > 0 || keep.length !== index.length) {
    await writeIndex(keep);
  }
};
