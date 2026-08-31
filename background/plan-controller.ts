import type { PlanStatus, RunPlan } from '../types/plan.js';

export type ManualPlanUpdate = {
  planId: string;
  version: number;
  stepId: string;
  status: PlanStatus;
};

export type PlanUpdateDecision = {
  planId: string;
  version: number;
  accepted: boolean;
  plan: RunPlan;
  error?: string;
};

export type ModelPlanUpdate = {
  stepIndex: number;
  status: PlanStatus;
};

export type ModelPlanUpdateDecision = {
  plan: RunPlan;
  applied: boolean;
  protectedByManualState: boolean;
  error?: string;
};

function canonicalVersion(plan: RunPlan): number {
  return Math.max(1, Number(plan.version || 1));
}

function decision(plan: RunPlan, accepted: boolean, error?: string): PlanUpdateDecision {
  const version = canonicalVersion(plan);
  return {
    planId: String(plan.planId || ''),
    version,
    accepted,
    plan,
    ...(error ? { error } : {}),
  };
}

/** Applies one panel checklist mutation without changing input plan. */
export function applyManualPlanUpdate(plan: RunPlan, update: ManualPlanUpdate): PlanUpdateDecision {
  const planId = String(plan.planId || '');
  const version = canonicalVersion(plan);
  if (!planId || update.planId !== planId) {
    return decision(plan, false, 'Plano não corresponde ao plano ativo.');
  }
  if (!Number.isInteger(update.version) || update.version !== version) {
    return decision(plan, false, 'Versão desatualizada; estado canônico restaurado.');
  }
  const index = plan.steps.findIndex((step) => step.id === update.stepId);
  if (index < 0) return decision(plan, false, 'Etapa não encontrada no plano ativo.');
  if (update.status !== 'done' && update.status !== 'pending') {
    return decision(plan, false, 'Status manual inválido.');
  }
  if (update.status === 'done' && !plan.steps.slice(0, index).every((step) => step.status === 'done')) {
    return decision(plan, false, 'Conclua as etapas anteriores primeiro.');
  }

  const next: RunPlan = {
    ...plan,
    version: version + 1,
    updatedAt: Date.now(),
    steps: plan.steps.map((step) => ({ ...step })),
  };
  next.steps[index].status = update.status;
  next.steps[index].statusProvenance = 'manual';
  if (update.status === 'pending') {
    for (let cursor = index + 1; cursor < next.steps.length; cursor += 1) {
      if (next.steps[cursor].status === 'done') {
        next.steps[cursor].status = 'pending';
        next.steps[cursor].statusProvenance = 'manual';
      }
    }
  }
  return decision(next, true);
}

/** Applies model progress without overriding an acknowledged manual status. */
export function applyModelPlanUpdate(
  plan: RunPlan,
  update: ModelPlanUpdate,
  now = Date.now(),
): ModelPlanUpdateDecision {
  if (!Number.isInteger(update.stepIndex) || update.stepIndex < 0 || update.stepIndex >= plan.steps.length) {
    return {
      plan,
      applied: false,
      protectedByManualState: false,
      error: `Invalid step_index: ${update.stepIndex}.`,
    };
  }

  const current = plan.steps[update.stepIndex];
  if (current.status === update.status) {
    return { plan, applied: false, protectedByManualState: false };
  }
  if (current.statusProvenance === 'manual') {
    return { plan, applied: false, protectedByManualState: true };
  }

  const next: RunPlan = {
    ...plan,
    version: canonicalVersion(plan) + 1,
    updatedAt: now,
    steps: plan.steps.map((step) => ({ ...step })),
  };
  next.steps[update.stepIndex].status = update.status;
  next.steps[update.stepIndex].statusProvenance = 'model';
  return { plan: next, applied: true, protectedByManualState: false };
}
