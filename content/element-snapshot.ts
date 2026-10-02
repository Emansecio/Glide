import {
  type HandleResolution,
  type StableElementHandle,
  findRefreshedHandleCandidates,
  fingerprintElement,
  isStableElementHandle,
  resolveElementHandle,
} from '../tools/stable-element-handle.js';

const SNAPSHOT_TTL_MS = 60_000;
const SNAPSHOT_LIMIT = 8;
const REVISION_THROTTLE_MS = 50;

type Snapshot = { id: string; createdAt: number; revision: number };
const snapshots: Snapshot[] = [];
let domRevision = 0;
let observer: MutationObserver | null = null;
let revisionTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotSequence = 0;

const ensureRevisionObserver = () => {
  if (observer || typeof MutationObserver === 'undefined' || !document.documentElement) return;
  observer = new MutationObserver(() => {
    if (revisionTimer) return;
    revisionTimer = setTimeout(() => {
      domRevision += 1;
      revisionTimer = null;
    }, REVISION_THROTTLE_MS);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
};

const pruneSnapshots = (now: number) => {
  while (snapshots.length > 0 && now - snapshots[0].createdAt > SNAPSHOT_TTL_MS) snapshots.shift();
  while (snapshots.length >= SNAPSHOT_LIMIT) snapshots.shift();
};

// A subtree observer with attributes + characterData costs CPU on busy pages for as long
// as it is connected. Handles are only valid while their snapshot lives (SNAPSHOT_TTL_MS),
// so once every snapshot has expired nothing reads domRevision and the observer can go.
const scheduleIdleDisconnect = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    pruneSnapshots(Date.now());
    if (snapshots.length > 0) {
      scheduleIdleDisconnect();
      return;
    }
    observer?.disconnect();
    observer = null;
    // Mutations stop being counted here; advance the revision so no pre-idle state reads as current.
    domRevision += 1;
  }, SNAPSHOT_TTL_MS + 1000);
};

const getDomRevision = () => {
  ensureRevisionObserver();
  return domRevision;
};

export const beginElementSnapshot = (): Snapshot => {
  ensureRevisionObserver();
  scheduleIdleDisconnect();
  const now = Date.now();
  pruneSnapshots(now);
  snapshotSequence += 1;
  const snapshot = {
    id: `${now.toString(36)}-${snapshotSequence.toString(36)}`,
    createdAt: now,
    revision: domRevision,
  };
  snapshots.push(snapshot);
  return snapshot;
};

export const createElementHandle = (
  element: Element,
  target: { tabId: number; frameId: number },
  selector: string,
  ref: string,
  snapshot: Snapshot,
): StableElementHandle => ({
  version: 1,
  snapshotId: snapshot.id,
  ref,
  tabId: target.tabId,
  frameId: target.frameId,
  selector,
  fingerprint: fingerprintElement(element),
  domRevision: snapshot.revision,
});

export const resolveSnapshotHandle = (
  value: unknown,
  target: { tabId: number; frameId: number },
): HandleResolution | null => {
  if (!isStableElementHandle(value)) return null;
  pruneSnapshots(Date.now());
  if (!snapshots.some((snapshot) => snapshot.id === value.snapshotId)) {
    return {
      ok: false,
      code: 'STALE_ELEMENT_HANDLE',
      error: 'Handle snapshot expired.',
      candidates: findRefreshedHandleCandidates(value, document),
    };
  }
  return resolveElementHandle(value, document, getDomRevision(), target);
};
