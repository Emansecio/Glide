/** Per-run abort controllers — manual tools and agent runs never share a signal. */
export class RunAbortRegistry {
  private controllers = new Map<string, AbortController>();

  create(runId: string): AbortController {
    this.dispose(runId);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller;
  }

  getSignal(runId: string): AbortSignal | undefined {
    return this.controllers.get(runId)?.signal;
  }

  isAborted(runId: string): boolean {
    return this.controllers.get(runId)?.signal.aborted === true;
  }

  abort(runId: string): void {
    this.controllers.get(runId)?.abort();
  }

  dispose(runId: string): void {
    this.controllers.delete(runId);
  }
}
