/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../sidepanel/ui/panel-plan.js';
import { SidePanelUI } from '../../sidepanel/ui/panel-ui.js';
import type { RunPlan } from '../../types/plan.js';

const plan = (statuses: Array<'pending' | 'done'>): RunPlan => ({
  planId: 'plan-1',
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  steps: statuses.map((status, index) => ({ id: `step-${index + 1}`, title: `Etapa ${index + 1}`, status })),
});

function harness() {
  document.body.innerHTML = `
    <div id="planDrawer" class="plan-drawer hidden">
      <button id="planDrawerToggle" aria-expanded="true"></button>
      <span id="planStepCount"></span><span id="planCurrentStep"></span>
      <div id="planDrawerContent"><ol id="planChecklist"></ol></div>
    </div>`;
  const byId = (id: string) => document.getElementById(id);
  const ui: any = Object.create(SidePanelUI.prototype);
  ui.elements = {
    planDrawer: byId('planDrawer'),
    planDrawerToggle: byId('planDrawerToggle'),
    planDrawerContent: byId('planDrawerContent'),
    planChecklist: byId('planChecklist'),
    planStepCount: byId('planStepCount'),
    planCurrentStep: byId('planCurrentStep'),
  };
  ui.pendingPlanStepIds = new Set();
  ui.isNearBottom = false;
  ui.scrollToBottom = vi.fn();
  return ui;
}

describe('plan drawer', () => {
  let ui: any;
  beforeEach(() => {
    ui = harness();
  });

  const collapsed = () => ui.elements.planDrawer.classList.contains('collapsed');

  it('opens expanded and names each checkbox after its step', () => {
    ui.renderPlanDrawer(plan(['done', 'pending']));
    expect(ui.elements.planDrawer.classList.contains('hidden')).toBe(false);
    expect(collapsed()).toBe(false);
    const labels = Array.from(document.querySelectorAll('.plan-checklist-checkbox')).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Etapa 1', 'Etapa 2']);
    expect(ui.elements.planCurrentStep.textContent).toBe('Etapa 2');
  });

  it('keeps a user collapse across plan updates', () => {
    ui.renderPlanDrawer(plan(['pending', 'pending']));
    ui.togglePlanDrawer();
    ui.renderPlanDrawer(plan(['done', 'pending']));
    expect(collapsed()).toBe(true);
    expect(ui.elements.planDrawerContent.hasAttribute('hidden')).toBe(true);
  });

  it('collapses for the answer unless the user chose to keep it open', () => {
    ui.renderPlanDrawer(plan(['pending', 'pending']));
    ui.collapsePlanDrawerForAnswer();
    expect(collapsed()).toBe(true);

    ui.togglePlanDrawer();
    ui.collapsePlanDrawerForAnswer();
    expect(collapsed()).toBe(false);
  });

  it('collapses when every step is done and re-expands for a new plan', () => {
    ui.renderPlanDrawer(plan(['done', 'done']));
    expect(collapsed()).toBe(true);
    expect(ui.elements.planStepCount.textContent).toBe('2 etapas · concluído');

    ui.clearPlan();
    ui.renderPlanDrawer(plan(['pending']));
    expect(collapsed()).toBe(false);
  });

  it('leaves step nodes in place across updates so their animations do not restart', () => {
    ui.renderPlanDrawer(plan(['pending', 'pending']));
    const checklist = ui.elements.planChecklist as HTMLElement;
    const before = Array.from(checklist.children);
    const insertBefore = vi.spyOn(checklist, 'insertBefore');
    ui.renderPlanDrawer(plan(['done', 'pending']));
    expect(insertBefore).not.toHaveBeenCalled();
    expect(Array.from(checklist.children)).toEqual(before);
    expect(ui.elements.planDrawer.style.getPropertyValue('--plan-progress')).toBe('0.5');
  });

  it('paints a manual toggle before the service worker answers and reverts on rejection', async () => {
    const current = { ...plan(['pending', 'pending']), planId: 'plan-1', version: 1 };
    ui.currentPlan = current;
    ui.updateStatus = vi.fn();
    ui.applyPlanUpdate = vi.fn();
    let answer: (value: unknown) => void = () => {};
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(() => new Promise((resolve) => (answer = resolve))) },
    });
    ui.renderPlanDrawer(current);
    const first = () => document.querySelector('.plan-checklist-item') as HTMLElement;

    const toggled = ui.togglePlanStep(0);
    expect(first().classList.contains('completed')).toBe(true);
    expect(current.steps[0].status).toBe('pending');

    answer({ planId: 'plan-1', version: 1, accepted: false, error: 'não' });
    await toggled;
    expect(first().classList.contains('completed')).toBe(false);
    expect(ui.updateStatus).toHaveBeenCalledWith('não', 'warning');
    vi.unstubAllGlobals();
  });

  it('keeps the reader at the bottom when the drawer changes height', () => {
    ui.renderPlanDrawer(plan(['pending']));
    ui.isNearBottom = true;
    ui.togglePlanDrawer();
    expect(ui.scrollToBottom).toHaveBeenCalledWith({ force: true });
  });
});
