import { SidePanelUI } from './panel-ui.js';

(SidePanelUI.prototype as any).addSubagent = function addSubagent(id: string, name: string, tasks: any) {
  this.subagents.set(id, {
    name: name || `Sub-${this.subagents.size + 1}`,
    tasks,
    status: 'running',
    messages: [],
  });
  this.renderAgentNav();
};

(SidePanelUI.prototype as any).updateSubagentStatus = function updateSubagentStatus(id: string, status: string) {
  const agent = this.subagents.get(id);
  if (agent) {
    agent.status = status;
    this.renderAgentNav();
  }
};

(SidePanelUI.prototype as any).renderAgentNav = function renderAgentNav() {
  const agentNav = this.elements.agentNav as HTMLElement | null;
  if (!agentNav) return;

  if (this.subagents.size === 0) {
    this.hideAgentNav();
    return;
  }

  const createNavItem = (options: {
    id: string;
    label: string;
    isMain?: boolean;
    statusClass?: string;
    active?: boolean;
  }) => {
    const item = document.createElement('div');
    item.className = [
      'agent-nav-item',
      options.isMain ? 'main-agent' : 'sub-agent',
      options.statusClass || '',
      options.active ? 'active' : '',
    ]
      .filter(Boolean)
      .join(' ');
    item.dataset.agent = options.id;

    const status = document.createElement('span');
    status.className = 'agent-status';
    const label = document.createElement('span');
    label.textContent = options.label;

    item.append(status, label);
    return item;
  };

  agentNav.classList.remove('hidden');
  agentNav.innerHTML = '';
  agentNav.appendChild(
    createNavItem({
      id: 'main',
      label: 'Main',
      isMain: true,
      active: this.activeAgent === 'main',
    }),
  );

  this.subagents.forEach((agent: any, id: string) => {
    const statusClass = agent.status === 'running' ? 'running' : agent.status === 'completed' ? 'completed' : 'error';
    const safeName = String(agent?.name || `Sub-${this.subagents.size + 1}`);
    agentNav.appendChild(
      createNavItem({
        id,
        label: safeName,
        statusClass,
        active: this.activeAgent === id,
      }),
    );
  });

  agentNav.querySelectorAll('.agent-nav-item').forEach((item: Element) => {
    item.addEventListener('click', () => {
      const agentId = (item as HTMLElement).dataset.agent;
      this.switchAgent(agentId);
    });
  });
};

(SidePanelUI.prototype as any).switchAgent = function switchAgent(agentId: string) {
  this.activeAgent = agentId;
  this.renderAgentNav();
};

(SidePanelUI.prototype as any).hideAgentNav = function hideAgentNav() {
  if (this.elements.agentNav) {
    this.elements.agentNav.classList.add('hidden');
  }
};
