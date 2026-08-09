import type { PlanStep, RunPlan } from '../../types/plan.js';
import { SidePanelUI } from './panel-ui.js';

const PLAN_CHECKBOX_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';

const syncPlanStepItem = (li: HTMLLIElement, step: PlanStep, index: number, steps: PlanStep[]) => {
  const isDone = step.status === 'done';
  const isBlocked = step.status === 'blocked';
  const previousStepsDone = steps.slice(0, index).every((s) => s.status === 'done');
  const canCheck = !isDone && previousStepsDone && !isBlocked;
  const isCurrent = !isDone && previousStepsDone && !isBlocked;

  li.dataset.stepIndex = String(index);
  li.dataset.stepId = step.id;
  li.classList.toggle('completed', isDone);
  li.classList.toggle('current', isCurrent);
  li.classList.toggle('blocked', isBlocked);

  let btn = li.querySelector('[data-action="toggle-step"]') as HTMLButtonElement | null;
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'plan-checklist-checkbox';
    btn.dataset.action = 'toggle-step';
    btn.innerHTML = PLAN_CHECKBOX_SVG;
    li.insertBefore(btn, li.firstChild);
  }

  btn.dataset.stepIndex = String(index);
  btn.classList.toggle('checked', isDone);
  btn.toggleAttribute('disabled', !canCheck && !isDone);
  btn.setAttribute('role', 'checkbox');
  btn.setAttribute('aria-checked', isDone ? 'true' : 'false');
  const titleText = isDone ? 'Concluido' : canCheck ? 'Marcar como concluido' : 'Conclua as etapas anteriores primeiro';
  if (btn.title !== titleText) {
    btn.title = titleText;
  }

  let content = li.querySelector('.plan-checklist-content') as HTMLElement | null;
  if (!content) {
    content = document.createElement('div');
    content.className = 'plan-checklist-content';
    li.appendChild(content);
  }

  let titleEl = content.querySelector('.plan-checklist-title') as HTMLElement | null;
  if (!titleEl) {
    titleEl = document.createElement('div');
    titleEl.className = 'plan-checklist-title';
    content.appendChild(titleEl);
  }
  if (titleEl.textContent !== step.title) {
    titleEl.textContent = step.title;
  }

  let notesEl = content.querySelector('.plan-checklist-notes') as HTMLElement | null;
  if (step.notes) {
    if (!notesEl) {
      notesEl = document.createElement('div');
      notesEl.className = 'plan-checklist-notes';
      content.appendChild(notesEl);
    }
    if (notesEl.textContent !== step.notes) {
      notesEl.textContent = step.notes;
    }
  } else if (notesEl) {
    notesEl.remove();
  }
};

const createPlanStepItem = (step: PlanStep, index: number, steps: PlanStep[]): HTMLLIElement => {
  const li = document.createElement('li');
  li.className = 'plan-checklist-item';
  syncPlanStepItem(li, step, index, steps);
  return li;
};

/**
 * Initialize plan drawer event listeners
 */
SidePanelUI.prototype.setupPlanDrawer = function setupPlanDrawer() {
  this.elements.planDrawerToggle?.addEventListener('click', (e: MouseEvent) => {
    // Don't toggle if clicking on action buttons
    if ((e.target as HTMLElement).closest('.plan-drawer-actions')) return;
    this.togglePlanDrawer();
  });

  this.elements.planClearBtn?.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    this.clearPlan();
  });
};

/**
 * Toggle the plan drawer collapsed state
 */
SidePanelUI.prototype.togglePlanDrawer = function togglePlanDrawer() {
  const drawer = this.elements.planDrawer as HTMLElement | null;
  if (!drawer) return;
  const collapsed = drawer.classList.toggle('collapsed');
  this.elements.planDrawerToggle?.setAttribute('aria-expanded', String(!collapsed));
  this.elements.planDrawerContent?.toggleAttribute('hidden', collapsed);
};

/**
 * Show the plan drawer
 */
SidePanelUI.prototype.showPlanDrawer = function showPlanDrawer() {
  this.elements.planDrawer?.classList.remove('hidden');
  this.elements.planDrawer?.classList.remove('collapsed');
  this.elements.planDrawerToggle?.setAttribute('aria-expanded', 'true');
  this.elements.planDrawerContent?.removeAttribute('hidden');
};

/**
 * Hide the plan drawer
 */
SidePanelUI.prototype.hidePlanDrawer = function hidePlanDrawer() {
  this.elements.planDrawer?.classList.add('hidden');
  this.elements.planDrawerToggle?.setAttribute('aria-expanded', 'false');
  this.elements.planDrawerContent?.setAttribute('hidden', '');
};

/**
 * Clear the current plan
 */
SidePanelUI.prototype.clearPlan = function clearPlan() {
  this.currentPlan = null;
  this.hidePlanDrawer();
  if (this.elements.planChecklist) {
    this.elements.planChecklist.innerHTML = '';
  }
};

/**
 * Render the plan to the drawer
 */
SidePanelUI.prototype.renderPlanDrawer = function renderPlanDrawer(plan: RunPlan) {
  if (!plan || !plan.steps || plan.steps.length === 0) {
    this.hidePlanDrawer();
    return;
  }

  const steps = plan.steps;
  const completedCount = steps.reduce((c, s) => c + (s.status === 'done' ? 1 : 0), 0);
  const totalCount = steps.length;

  // Update step count
  if (this.elements.planStepCount) {
    const countText =
      completedCount === totalCount ? `${totalCount} etapas - concluido` : `${completedCount}/${totalCount} etapas`;
    if (this.elements.planStepCount.textContent !== countText) {
      this.elements.planStepCount.textContent = countText;
    }
  }

  // Render checklist (diff by step id — preserve nodes, update in place)
  if (this.elements.planChecklist) {
    const checklist = this.elements.planChecklist;
    const existingById = new Map<string, HTMLLIElement>();
    for (const child of checklist.querySelectorAll('li[data-step-id]')) {
      const id = (child as HTMLLIElement).dataset.stepId;
      if (id) existingById.set(id, child as HTMLLIElement);
    }

    const seenIds = new Set<string>();
    for (const [index, step] of steps.entries()) {
      seenIds.add(step.id);
      let li = existingById.get(step.id);
      if (!li) {
        li = createPlanStepItem(step, index, steps);
      } else {
        syncPlanStepItem(li, step, index, steps);
      }
      checklist.appendChild(li);
    }

    for (const [id, li] of existingById) {
      if (!seenIds.has(id)) {
        li.remove();
      }
    }

    if (!this._planChecklistClickBound) {
      this.elements.planChecklist.addEventListener('click', (e: Event) => {
        const target = (e.target as HTMLElement | null)?.closest('[data-action="toggle-step"]');
        if (!target) return;
        e.stopPropagation();
        const index = Number.parseInt((target as HTMLElement).dataset.stepIndex || '0', 10);
        this.togglePlanStep(index);
      });
      this._planChecklistClickBound = true;
    }
  }

  this.showPlanDrawer();
};

/**
 * Toggle a plan step's completion status
 */
SidePanelUI.prototype.togglePlanStep = function togglePlanStep(index: number) {
  if (!this.currentPlan || !this.currentPlan.steps[index]) return;

  const step = this.currentPlan.steps[index];
  const previousStepsDone = this.currentPlan.steps
    .slice(0, index)
    .every((s: { status: string }) => s.status === 'done');

  // Can only toggle if previous steps are done
  if (!previousStepsDone && step.status !== 'done') {
    this.updateStatus('Conclua as etapas anteriores primeiro', 'warning');
    return;
  }

  // Toggle the step
  if (step.status === 'done') {
    // Unchecking - also uncheck all subsequent steps
    for (let i = index; i < this.currentPlan.steps.length; i++) {
      if (this.currentPlan.steps[i].status === 'done') {
        this.currentPlan.steps[i].status = 'pending';
      }
    }
  } else {
    step.status = 'done';
  }

  this.currentPlan.updatedAt = Date.now();
  this.renderPlanDrawer(this.currentPlan);
};
