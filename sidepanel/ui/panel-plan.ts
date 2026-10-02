import type { PlanStep, RunPlan } from '../../types/plan.js';
import { SidePanelUI } from './panel-ui.js';

const PLAN_CHECKBOX_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" pathLength="1"></polyline></svg>';

const setText = (el: HTMLElement | null | undefined, text: string) => {
  if (el && el.textContent !== text) el.textContent = text;
};

const createPlanStepItem = (): HTMLLIElement => {
  const li = document.createElement('li');
  li.className = 'plan-checklist-item';
  li.innerHTML = `<button type="button" class="plan-checklist-checkbox" data-action="toggle-step" role="checkbox">${PLAN_CHECKBOX_SVG}</button><div class="plan-checklist-content"><div class="plan-checklist-title"></div></div>`;
  return li;
};

/** `currentIndex` é a primeira etapa não concluída (-1 quando todas estão). */
const syncPlanStepItem = (li: HTMLLIElement, step: PlanStep, index: number, currentIndex: number, pending: boolean) => {
  const isDone = step.status === 'done';
  const isBlocked = step.status === 'blocked';
  const isCurrent = index === currentIndex && !isBlocked;

  li.dataset.stepId = step.id;
  li.classList.toggle('completed', isDone);
  li.classList.toggle('current', isCurrent);
  li.classList.toggle('blocked', isBlocked);
  li.classList.toggle('pending', pending);

  const btn = li.firstElementChild as HTMLButtonElement;
  btn.dataset.stepIndex = String(index);
  btn.classList.toggle('checked', isDone);
  btn.disabled = pending || (!isDone && !isCurrent);
  btn.toggleAttribute('aria-busy', pending);
  btn.setAttribute('aria-checked', String(isDone));
  if (btn.getAttribute('aria-label') !== step.title) btn.setAttribute('aria-label', step.title);
  const hint = isDone ? 'Concluído' : isCurrent ? 'Marcar como concluído' : 'Conclua as etapas anteriores primeiro';
  if (btn.title !== hint) btn.title = hint;

  const content = li.lastElementChild as HTMLElement;
  setText(content.firstElementChild as HTMLElement, step.title);
  let notesEl = content.querySelector('.plan-checklist-notes') as HTMLElement | null;
  if (!step.notes) {
    notesEl?.remove();
    return;
  }
  if (!notesEl) {
    notesEl = document.createElement('div');
    notesEl.className = 'plan-checklist-notes';
    content.appendChild(notesEl);
  }
  setText(notesEl, step.notes);
};

/**
 * Initialize plan drawer event listeners
 */
SidePanelUI.prototype.setupPlanDrawer = function setupPlanDrawer() {
  this.elements.planDrawerToggle?.addEventListener('click', () => this.togglePlanDrawer());

  this.elements.planClearBtn?.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    this.clearPlan();
  });

  this.elements.planChecklist?.addEventListener('click', (e: Event) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="toggle-step"]');
    if (!target) return;
    void this.togglePlanStep(Number.parseInt(target.dataset.stepIndex || '0', 10));
  });
};

const setPlanDrawerCollapsed = (ui: SidePanelUI, collapsed: boolean) => {
  const drawer = ui.elements.planDrawer as HTMLElement | null;
  if (!drawer) return;
  const stickBottom = ui.isNearBottom;
  drawer.classList.toggle('collapsed', collapsed);
  ui.elements.planDrawerToggle?.setAttribute('aria-expanded', String(!collapsed));
  ui.elements.planDrawerContent?.toggleAttribute('hidden', collapsed);
  // A gaveta cresce por cima da conversa: quem estava lendo o fim continua no fim.
  if (stickBottom) ui.scrollToBottom?.({ force: true });
};

/**
 * Toggle the plan drawer collapsed state
 */
SidePanelUI.prototype.togglePlanDrawer = function togglePlanDrawer() {
  const drawer = this.elements.planDrawer as HTMLElement | null;
  if (!drawer) return;
  this._planDrawerUserToggled = true;
  setPlanDrawerCollapsed(this, !drawer.classList.contains('collapsed'));
};

/**
 * Recolhe a gaveta quando a resposta começa a chegar — o cabeçalho recolhido
 * ainda mostra a etapa atual. Não sobrepõe uma escolha explícita do usuário.
 */
SidePanelUI.prototype.collapsePlanDrawerForAnswer = function collapsePlanDrawerForAnswer() {
  const drawer = this.elements.planDrawer as HTMLElement | null;
  if (!drawer || drawer.classList.contains('hidden') || this._planDrawerUserToggled) return;
  if (!drawer.classList.contains('collapsed')) setPlanDrawerCollapsed(this, true);
};

/**
 * Show the plan drawer. Expands only when it was hidden, so plan updates never
 * undo a collapse.
 */
SidePanelUI.prototype.showPlanDrawer = function showPlanDrawer() {
  const drawer = this.elements.planDrawer as HTMLElement | null;
  if (!drawer?.classList.contains('hidden')) return;
  drawer.classList.remove('hidden');
  this._planDrawerUserToggled = false;
  setPlanDrawerCollapsed(this, false);
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
  this.pendingPlanStepIds.clear();
  this.hidePlanDrawer();
  if (this.elements.planChecklist) {
    this.elements.planChecklist.innerHTML = '';
    delete this.elements.planChecklist.dataset.currentStep;
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
  const totalCount = steps.length;
  const currentIndex = steps.findIndex((step) => step.status !== 'done');
  const completedCount = steps.reduce((c, s) => c + (s.status === 'done' ? 1 : 0), 0);
  const allDone = completedCount === totalCount;
  const current = currentIndex >= 0 ? steps[currentIndex] : null;

  setText(
    this.elements.planStepCount,
    allDone ? `${totalCount} etapas · concluído` : `${completedCount}/${totalCount} etapas`,
  );
  const currentEl = this.elements.planCurrentStep as HTMLElement | null;
  if (currentEl && currentEl.textContent !== (current?.title || '')) {
    currentEl.textContent = current?.title || '';
    currentEl.title = current?.title || '';
  }

  const drawer = this.elements.planDrawer as HTMLElement | null;
  const progress = String(completedCount / totalCount);
  if (drawer && drawer.style.getPropertyValue('--plan-progress') !== progress) {
    drawer.style.setProperty('--plan-progress', progress);
  }
  drawer?.classList.toggle('all-done', allDone);

  // Diff por id de etapa: o nó é preservado e só muda de lugar se a ordem mudou.
  // Reanexar um nó que já está no lugar reinicia as animações CSS dele — a lista
  // inteira "piscava" a cada atualização do plano.
  const checklist = this.elements.planChecklist as HTMLOListElement | null;
  if (checklist) {
    const existingById = new Map<string, HTMLLIElement>();
    for (const child of Array.from(checklist.children) as HTMLLIElement[]) {
      const id = child.dataset.stepId;
      if (id && steps.some((step) => step.id === id)) existingById.set(id, child);
      else child.remove();
    }

    for (const [index, step] of steps.entries()) {
      const li = existingById.get(step.id) || createPlanStepItem();
      syncPlanStepItem(li, step, index, currentIndex, this.pendingPlanStepIds.has(step.id));
      if (checklist.children[index] !== li) checklist.insertBefore(li, checklist.children[index] || null);
    }

    // A etapa atual fica visível sem o usuário rolar a gaveta.
    const currentId = current?.id || '';
    if (checklist.dataset.currentStep !== currentId) {
      checklist.dataset.currentStep = currentId;
      if (currentIndex >= 0) checklist.children[currentIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  this.showPlanDrawer();
  if (allDone) this.collapsePlanDrawerForAnswer();
};

SidePanelUI.prototype.applyPlanUpdateAck = function applyPlanUpdateAck(ack: {
  planId: string;
  version: number;
  accepted: boolean;
  plan?: RunPlan;
  error?: string;
}) {
  if (ack.plan) {
    for (const step of ack.plan.steps) this.pendingPlanStepIds.delete(step.id);
    this.applyPlanUpdate(ack.plan);
  } else {
    this.pendingPlanStepIds.clear();
    if (this.currentPlan) this.renderPlanDrawer(this.currentPlan);
  }
  if (!ack.accepted) {
    this.updateStatus(ack.error || 'Atualização do plano rejeitada', 'warning');
  }
};

/**
 * Toggle a plan step's completion status. O clique pinta o novo estado na hora;
 * `currentPlan` só muda com a confirmação do service worker, então uma rejeição
 * volta ao estado confirmado só re-renderizando.
 */
SidePanelUI.prototype.togglePlanStep = async function togglePlanStep(index: number) {
  const plan = this.currentPlan;
  if (!plan || !plan.steps[index] || !plan.planId || !plan.version) return;

  const step = plan.steps[index];
  const previousStepsDone = plan.steps.slice(0, index).every((item) => item.status === 'done');
  if (!previousStepsDone && step.status !== 'done') {
    this.updateStatus('Conclua as etapas anteriores primeiro', 'warning');
    return;
  }
  if (this.pendingPlanStepIds.has(step.id)) return;

  const status = step.status === 'done' ? 'pending' : 'done';
  this.pendingPlanStepIds.add(step.id);
  this.renderPlanDrawer({ ...plan, steps: plan.steps.map((item) => (item === step ? { ...item, status } : item)) });
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'manual_plan_update',
      planId: plan.planId,
      version: plan.version,
      stepId: step.id,
      status,
      sessionId: this.sessionId,
      runId: this.activeRunId || undefined,
    });
    if (this.pendingPlanStepIds.has(step.id)) {
      this.applyPlanUpdateAck(
        response || {
          planId: plan.planId,
          version: plan.version,
          accepted: false,
          error: 'Sem confirmação do plano.',
        },
      );
    }
  } catch {
    this.pendingPlanStepIds.delete(step.id);
    if (this.currentPlan) this.renderPlanDrawer(this.currentPlan);
    this.updateStatus('Falha ao atualizar o plano', 'warning');
  }
};
