/** Monotonic per-run sequence numbers for runtime push ordering. */
export class RunEventSequencer {
  private seqByRun = new Map<string, number>();

  next(runId: string): number {
    const next = (this.seqByRun.get(runId) ?? 0) + 1;
    this.seqByRun.set(runId, next);
    return next;
  }

  drop(runId: string): void {
    this.seqByRun.delete(runId);
  }
}
