export type VisionContextItem = {
  tool: string;
  description: string;
  source: 'recovery' | 'screenshot';
};

export class VisionInbox {
  private items = new Map<string, VisionContextItem[]>();
  private terminalRuns = new Set<string>();
  private maxItemsPerRun: number;
  private maxDescriptionChars: number;

  constructor(options: { maxItemsPerRun?: number; maxDescriptionChars?: number } = {}) {
    this.maxItemsPerRun = options.maxItemsPerRun ?? 3;
    this.maxDescriptionChars = options.maxDescriptionChars ?? 2000;
  }

  publish(runId: string, item: VisionContextItem): void {
    if (!runId || this.terminalRuns.has(runId)) return;
    const description = String(item.description || '')
      .trim()
      .slice(0, this.maxDescriptionChars);
    if (!description) return;
    const list = this.items.get(runId) || [];
    list.push({ ...item, description });
    while (list.length > this.maxItemsPerRun) list.shift();
    this.items.set(runId, list);
  }

  consume(runId: string): VisionContextItem[] {
    const list = this.items.get(runId) || [];
    this.items.delete(runId);
    return list.map((item) => ({ ...item }));
  }

  hasPending(runId: string): boolean {
    return (this.items.get(runId)?.length || 0) > 0;
  }

  terminal(runId: string): void {
    if (!runId) return;
    this.items.delete(runId);
    this.terminalRuns.add(runId);
    if (this.terminalRuns.size > 32) {
      const oldest = this.terminalRuns.values().next().value;
      if (oldest) this.terminalRuns.delete(oldest);
    }
  }
}

export function buildVisualContextMessage(items: VisionContextItem[]): string {
  const lines = items.map((item) => `- ${item.tool} (${item.source}): ${item.description}`);
  return `<visual_context>\n${lines.join('\n')}\n</visual_context>`;
}
