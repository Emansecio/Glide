export type ToolExecutionContext = {
  runId: string;
  sessionId: string;
  lockedTabId: number | null;
  signal: AbortSignal;
  deadlineAt: number;
};

export const isToolContextAborted = (context?: ToolExecutionContext | null): boolean =>
  Boolean(context?.signal.aborted);

export const abortedToolResult = (message = 'Run was stopped before the tool finished.') => ({
  success: false,
  code: 'RUN_ABORTED',
  error: message,
});

export async function sleepWithSignal(ms: number, signal?: AbortSignal | null): Promise<boolean> {
  const waitMs = Math.max(0, ms);
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return true;
  }
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const timer = setTimeout(finish, waitMs);
    const onAbort = () => finish(false);
    function finish(completed = true) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
