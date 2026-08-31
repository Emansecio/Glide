export type PlanStatus = 'pending' | 'running' | 'done' | 'blocked';
export type PlanStatusProvenance = 'model' | 'manual';

export const PLAN_STATUSES = ['pending', 'running', 'done', 'blocked'] as const;

const PLAN_STATUS_SET = new Set<PlanStatus>(PLAN_STATUSES);

export type PlanStep = {
  id: string;
  title: string;
  status: PlanStatus;
  /** Manual status remains authoritative until another acknowledged manual update. */
  statusProvenance?: PlanStatusProvenance;
  notes?: string;
};

export type RunPlan = {
  /** Stable identity for versioned panel acknowledgements. Optional on legacy payloads. */
  planId?: string;
  /** Monotonic authoritative revision. Legacy payloads begin at version 1. */
  version?: number;
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
};

type PlanStepInput = {
  id?: string;
  title?: string;
  status?: string;
  notes?: string;
};

type NormalizedPlanStepInput = Omit<PlanStep, 'id'> & { requestedId?: string };

export function normalizePlanStatus(value: unknown): PlanStatus {
  if (typeof value !== 'string') return 'pending';
  const lowered = value.trim().toLowerCase();
  return PLAN_STATUS_SET.has(lowered as PlanStatus) ? (lowered as PlanStatus) : 'pending';
}

function normalizePlanStepInputs(input: unknown, maxSteps: number): NormalizedPlanStepInput[] {
  const rawSteps = Array.isArray(input) ? input : [];
  const normalized: NormalizedPlanStepInput[] = [];

  for (const step of rawSteps) {
    let requestedId: string | undefined;
    let title = '';
    let status: PlanStatus = 'pending';
    let notes: string | undefined;

    if (typeof step === 'string') {
      title = step.trim();
    } else if (step && typeof step === 'object') {
      const candidate = step as PlanStepInput;
      if (typeof candidate.id === 'string' && candidate.id.trim()) requestedId = candidate.id.trim();
      if (typeof candidate.title === 'string') title = candidate.title.trim();
      status = normalizePlanStatus(candidate.status);
      if (typeof candidate.notes === 'string' && candidate.notes.trim()) notes = candidate.notes.trim();
    }

    if (!title) continue;
    normalized.push({ title, status, ...(requestedId ? { requestedId } : {}), ...(notes ? { notes } : {}) });
    if (normalized.length >= maxSteps) break;
  }

  return normalized;
}

function nextStepId(reservedIds: Set<string>, startAt = 1): string {
  let sequence = startAt;
  while (reservedIds.has(`step-${sequence}`)) sequence += 1;
  return `step-${sequence}`;
}

export function normalizePlanSteps(input: unknown, options: { maxSteps?: number } = {}): PlanStep[] {
  const drafts = normalizePlanStepInputs(input, options.maxSteps ?? 8);
  const reservedIds = new Set<string>();
  return drafts.map(({ requestedId, ...step }) => {
    const id = requestedId && !reservedIds.has(requestedId) ? requestedId : nextStepId(reservedIds);
    reservedIds.add(id);
    return { id, ...step };
  });
}

export function buildRunPlan(
  stepsInput: unknown,
  options: { existingPlan?: RunPlan | null; now?: number; maxSteps?: number; planId?: string } = {},
): RunPlan {
  const now = options.now ?? Date.now();
  const existing = options.existingPlan;
  const drafts = normalizePlanStepInputs(stepsInput, options.maxSteps ?? 8);
  const reservedIds = new Set(existing?.steps.map((step) => step.id) ?? []);
  const assignedIds = new Set<string>();
  const matchedPriorIds = new Set<string>();
  const titleKey = (title: string): string => title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

  const steps = drafts.map(({ requestedId, ...draft }) => {
    const priorById = requestedId
      ? existing?.steps.find((candidate) => candidate.id === requestedId && !matchedPriorIds.has(candidate.id))
      : undefined;
    const prior =
      priorById ||
      existing?.steps.find(
        (candidate) => !matchedPriorIds.has(candidate.id) && titleKey(candidate.title) === titleKey(draft.title),
      );
    if (prior) matchedPriorIds.add(prior.id);

    let id = prior?.id || requestedId;
    if (!id || assignedIds.has(id) || (reservedIds.has(id) && !prior)) {
      id = nextStepId(new Set([...reservedIds, ...assignedIds]));
    }
    assignedIds.add(id);
    reservedIds.add(id);
    const preserveManualStatus = prior?.statusProvenance === 'manual';
    return {
      id,
      ...draft,
      status: preserveManualStatus || prior?.status === 'done' ? prior?.status || draft.status : draft.status,
      statusProvenance: preserveManualStatus ? ('manual' as const) : ('model' as const),
    };
  });

  const createdAt = existing?.createdAt ?? now;
  return {
    planId: existing?.planId || options.planId || `plan-${now}-${Math.random().toString(36).slice(2, 8)}`,
    version: Math.max(1, Number(existing?.version || 0) + (existing ? 1 : 1)),
    steps,
    createdAt,
    updatedAt: now,
  };
}
