export type ActionPostcondition =
  | { kind: 'url_changed'; from?: string }
  | { kind: 'visible'; selector: string }
  | { kind: 'hidden'; selector: string }
  | { kind: 'checked'; selector: string; value: boolean }
  | { kind: 'text_contains'; selector?: string; text: string };

export type PostconditionObservation = {
  url?: string;
  visible?: boolean;
  checked?: boolean;
  text?: string;
  [key: string]: unknown;
};

export type TimedActionPostcondition = ActionPostcondition & { durationMs: number };

const matches = (condition: ActionPostcondition, observed: PostconditionObservation): boolean => {
  if (condition.kind === 'url_changed') {
    return typeof condition.from === 'string' && Boolean(observed.url && observed.url !== condition.from);
  }
  if (condition.kind === 'visible') return observed.visible === true;
  if (condition.kind === 'hidden') return observed.visible === false;
  if (condition.kind === 'checked') return observed.checked === condition.value;
  return String(observed.text || '').includes(condition.text);
};

export async function verifyActionPostcondition(
  condition: ActionPostcondition,
  observe: () => Promise<PostconditionObservation> | PostconditionObservation,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    deadline?: number;
    signal?: AbortSignal;
    baselineUrl?: string;
  } = {},
): Promise<
  | { verified: true; postcondition: TimedActionPostcondition; evidence: PostconditionObservation }
  | {
      verified: false;
      code: 'POSTCONDITION_FAILED';
      postcondition: TimedActionPostcondition;
      observed: PostconditionObservation;
    }
> {
  const resolvedCondition: ActionPostcondition =
    condition.kind === 'url_changed' && condition.from === undefined && options.baselineUrl !== undefined
      ? { ...condition, from: options.baselineUrl }
      : condition;
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const withDuration = (): TimedActionPostcondition => ({
    ...resolvedCondition,
    durationMs: Math.max(0, (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt),
  });
  const deadline = options.deadline ?? Date.now() + Math.max(1, options.timeoutMs ?? 3000);
  const pollMs = Math.max(10, options.pollMs ?? 100);
  let observed: PostconditionObservation = {};
  do {
    if (options.signal?.aborted) break;
    observed = await observe();
    if (matches(resolvedCondition, observed)) {
      return { verified: true, postcondition: withDuration(), evidence: observed };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  } while (Date.now() <= deadline);
  return { verified: false, code: 'POSTCONDITION_FAILED', postcondition: withDuration(), observed };
}
