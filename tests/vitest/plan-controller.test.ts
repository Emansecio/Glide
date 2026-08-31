import { describe, expect, it } from 'vitest';
import { applyManualPlanUpdate } from '../../background/plan-controller.js';
import { buildRunPlan } from '../../types/plan.js';
import { validateRuntimeMessage } from '../../types/runtime-messages.js';

const plan = () =>
  buildRunPlan([{ title: 'first' }, { title: 'second' }], {
    now: 100,
    planId: 'plan-1',
  });

describe('manual plan controller', () => {
  it('rejects stale versions with canonical plan', () => {
    const current = plan();
    const result = applyManualPlanUpdate(current, {
      planId: 'plan-1',
      version: 0,
      stepId: 'step-1',
      status: 'done',
    });
    expect(result.accepted).toBe(false);
    expect(result.plan).toBe(current);
    expect(result.error?.toLowerCase()).toContain('versão');
  });

  it('advances version only after valid sequential completion', () => {
    const current = plan();
    const blocked = applyManualPlanUpdate(current, {
      planId: 'plan-1',
      version: 1,
      stepId: 'step-2',
      status: 'done',
    });
    expect(blocked.accepted).toBe(false);

    const accepted = applyManualPlanUpdate(current, {
      planId: 'plan-1',
      version: 1,
      stepId: 'step-1',
      status: 'done',
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.plan.version).toBe(2);
    expect(accepted.plan.steps[0].status).toBe('done');
    expect(current.steps[0].status).toBe('pending');
  });

  it('preserves acknowledged completion across later model replacement', () => {
    const acknowledged = applyManualPlanUpdate(plan(), {
      planId: 'plan-1',
      version: 1,
      stepId: 'step-1',
      status: 'done',
    }).plan;
    const replacement = buildRunPlan([{ title: 'first', status: 'pending' }, { title: 'second' }], {
      existingPlan: acknowledged,
      now: 200,
    });
    expect(replacement.steps[0].status).toBe('done');
    expect(replacement.version).toBe(3);
  });

  it('keeps stable step identity when model prepends and reorders steps', () => {
    const acknowledged = applyManualPlanUpdate(plan(), {
      planId: 'plan-1',
      version: 1,
      stepId: 'step-1',
      status: 'done',
    }).plan;
    const replacement = buildRunPlan(
      [{ title: 'new prerequisite' }, { title: 'second' }, { title: 'first', status: 'pending' }],
      { existingPlan: acknowledged, now: 200 },
    );

    expect(replacement.steps.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: 'step-3', title: 'new prerequisite' },
      { id: 'step-2', title: 'second' },
      { id: 'step-1', title: 'first' },
    ]);
    expect(replacement.steps[2].status).toBe('done');
  });

  it('accepts versioned plan acknowledgements in runtime schema', () => {
    const result = validateRuntimeMessage({
      schemaVersion: 2,
      type: 'plan_update_ack',
      runId: 'run-1',
      sessionId: 'session-1',
      timestamp: 1,
      planId: 'plan-1',
      version: 2,
      accepted: true,
      plan: { ...plan(), version: 2 },
    });
    expect(result.ok).toBe(true);
  });
});
