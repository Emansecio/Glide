export type AbortTimeoutResult<T> = {
  result: T | null;
  timedOut: boolean;
  error: unknown | null;
};

export async function withAbortTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<AbortTimeoutResult<T>> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const result = await fn(abortController.signal);
    return { result, timedOut: false, error: null };
  } catch (error) {
    const timedOut = abortController.signal.aborted;
    return { result: null, timedOut, error };
  } finally {
    clearTimeout(timeoutId);
  }
}
