/** Run-scoped session tombstones — predecessor finally must not clear successor marks. */
export class SessionTombstoneRegistry {
  private tombstones = new Map<string, string>();

  mark(sessionId: string, runId: string): void {
    if (!sessionId) return;
    this.tombstones.set(sessionId, runId);
  }

  isTombstoned(sessionId: string): boolean {
    return this.tombstones.has(sessionId);
  }

  clearForRun(runId: string): void {
    for (const [sessionId, ownerRunId] of this.tombstones) {
      if (ownerRunId === runId) {
        this.tombstones.delete(sessionId);
      }
    }
  }
}

/** Monotonic per-session generation — stale compaction must not overwrite newer context. */
export class SessionGenerationRegistry {
  private generations = new Map<string, number>();

  bump(sessionId: string): number {
    const next = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, next);
    return next;
  }

  get(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  matches(sessionId: string, generation: number): boolean {
    return this.get(sessionId) === generation;
  }

  delete(sessionId: string): void {
    this.generations.delete(sessionId);
  }
}

/** Serialize compaction per session without blocking unrelated sessions. */
export class SessionCompactionQueue {
  private tails = new Map<string, Promise<void>>();

  run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.tails.set(
      sessionId,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }
}

/** Compare-before-remove sentinel tokens for chrome.storage.session. */
export class ActiveRunSentinelRegistry {
  private tokens = new Map<string, string>();

  remember(runId: string, token: string): void {
    this.tokens.set(runId, token);
  }

  forget(runId: string): void {
    this.tokens.delete(runId);
  }

  expectedToken(runId: string): string | undefined {
    return this.tokens.get(runId);
  }
}

export function createSentinelToken(runId: string): string {
  return `${runId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}
