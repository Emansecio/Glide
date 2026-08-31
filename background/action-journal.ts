import type { ActionJournalEntry } from './run-types.js';
import { VERIFICATION_EFFECT_TOOLS } from './service-config.js';

export const MUTATIVE_BROWSER_EFFECT_TOOLS = VERIFICATION_EFFECT_TOOLS;

const MUTATIVE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AMBIGUOUS_OUTCOME_CODES = new Set(['BRIDGE_TIMEOUT', 'SCRIPT_TIMEOUT', 'DOWNLOAD_TIMEOUT']);

export type ActionOutcomeCertainty = 'known_completed' | 'known_not_executed' | 'unknown';

export function isMutativeBrowserEffect(tool: string, args: Record<string, unknown> = {}): boolean {
  if (MUTATIVE_BROWSER_EFFECT_TOOLS.has(tool)) return true;
  if (tool === 'httpRequest') {
    return MUTATIVE_HTTP_METHODS.has(
      String(args.method || 'GET')
        .trim()
        .toUpperCase(),
    );
  }
  if (tool === 'captureDownload') {
    const directUrl = typeof args.url === 'string' && args.url.trim().length > 0;
    const trigger =
      args.trigger && typeof args.trigger === 'object' && !Array.isArray(args.trigger)
        ? (args.trigger as Record<string, unknown>)
        : null;
    const triggerSelector = typeof trigger?.selector === 'string' && trigger.selector.trim().length > 0;
    return directUrl || triggerSelector;
  }
  return false;
}

export function classifyActionOutcome(result: unknown): ActionOutcomeCertainty {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unknown';
  const record = result as Record<string, unknown>;
  if (
    record.outcomeCertainty === 'known_completed' ||
    record.outcomeCertainty === 'known_not_executed' ||
    record.outcomeCertainty === 'unknown'
  ) {
    return record.outcomeCertainty;
  }
  const code = String(record.code || '').toUpperCase();
  if (AMBIGUOUS_OUTCOME_CODES.has(code) || record.timedOut === true) return 'unknown';
  return 'known_completed';
}

export type PreparedAction = {
  actionId: string;
  runId: string;
  toolCallId?: string;
  tool: string;
  args: unknown;
  target?: Record<string, unknown>;
};

export type InFlightDecision = {
  entry: ActionJournalEntry;
  shouldDispatch: boolean;
};

type PersistEntry = (entry: ActionJournalEntry) => Promise<unknown> | unknown;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
};

export const digestActionValue = (value: unknown): string => {
  const text = JSON.stringify(stableValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const cloneEntry = (entry: ActionJournalEntry): ActionJournalEntry => ({
  ...entry,
  ...(entry.target ? { target: { ...entry.target } } : {}),
});

export class ActionJournal {
  private entries = new Map<string, ActionJournalEntry>();

  constructor(
    restoredEntries: ActionJournalEntry[] = [],
    private persistEntry?: PersistEntry,
  ) {
    for (const restored of restoredEntries) {
      const entry = cloneEntry(restored);
      if (entry.state === 'in_flight') entry.state = 'ambiguous';
      this.entries.set(entry.actionId, entry);
    }
  }

  get(actionId: string): ActionJournalEntry | null {
    const entry = this.entries.get(actionId);
    return entry ? cloneEntry(entry) : null;
  }

  private async save(entry: ActionJournalEntry): Promise<ActionJournalEntry> {
    this.entries.set(entry.actionId, entry);
    await this.persistEntry?.(cloneEntry(entry));
    return cloneEntry(entry);
  }

  async prepare(input: PreparedAction): Promise<ActionJournalEntry> {
    const existing = this.entries.get(input.actionId);
    if (existing) return cloneEntry(existing);
    return this.save({
      actionId: input.actionId,
      runId: input.runId,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      tool: input.tool,
      argsDigest: digestActionValue(input.args),
      ...(input.target ? { target: { ...input.target } } : {}),
      state: 'prepared',
      startedAt: Date.now(),
    });
  }

  async markInFlight(actionId: string): Promise<InFlightDecision> {
    const entry = this.entries.get(actionId);
    if (!entry) throw new Error(`Unknown action ${actionId}.`);
    if (entry.state !== 'prepared') return { entry: cloneEntry(entry), shouldDispatch: false };
    const saved = await this.save({ ...entry, state: 'in_flight' });
    return { entry: saved, shouldDispatch: true };
  }

  async commit(actionId: string, result: unknown): Promise<ActionJournalEntry> {
    const entry = this.entries.get(actionId);
    if (!entry) throw new Error(`Unknown action ${actionId}.`);
    if (entry.state === 'committed') return cloneEntry(entry);
    if (entry.state === 'ambiguous') throw new Error(`Ambiguous action ${actionId} cannot be committed automatically.`);
    return this.save({
      ...entry,
      state: 'committed',
      resultDigest: digestActionValue(result),
      completedAt: Date.now(),
    });
  }

  async markAmbiguous(actionId: string): Promise<ActionJournalEntry> {
    const entry = this.entries.get(actionId);
    if (!entry) throw new Error(`Unknown action ${actionId}.`);
    if (entry.state === 'committed') return cloneEntry(entry);
    if (entry.state === 'ambiguous') return cloneEntry(entry);
    return this.save({ ...entry, state: 'ambiguous', completedAt: Date.now() });
  }
}
