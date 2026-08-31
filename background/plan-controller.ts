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
  if (update.status === 'pending') {
    for (let cursor = index + 1; cursor < next.steps.length; cursor += 1) {
      if (next.steps[cursor].status === 'done') next.steps[cursor].status = 'pending';
    }
  }
  return decision(next, true);
}
