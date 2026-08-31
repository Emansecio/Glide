/** Shared, testable guards for panel session/run/model/history bookkeeping. */

import { SidePanelUI } from './panel-ui.js';

export const PANEL_BOOKKEEPING_SET_MAX = 64;

export function shouldAppendAssistantFinalForCommit(input: {
  contextRevision: number;
  finalRevision?: number;
}): boolean {
  return !Number.isInteger(input.finalRevision) || Number(input.finalRevision) > input.contextRevision;
}

export function boundPanelIdSet(set: Set<string>, id: string, max = PANEL_BOOKKEEPING_SET_MAX): void {
  const trimmed = String(id || '').trim();
  if (!trimmed) return;
  set.add(trimmed);
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest == null) break;
    set.delete(oldest);
  }
}

export function buildModelProbeRequestKey(provider: string, apiKey: string, endpoint: string): string {
  const pid = String(provider || '').trim();
  const ep = String(endpoint || '').trim();
  const key = String(apiKey || '');
  return `${pid}|${ep}|${key.length}|${key.slice(-4)}`;
}

export type CompactionAcceptInput = {
  messageSessionId?: string | null;
  newSessionId?: string | null;
  previousSessionId?: string | null;
  messageRunId?: string | null;
  activeRunId?: string | null;
  completedRunIds: ReadonlySet<string>;
  sessionId: string;
  pendingSessionId?: string | null;
  acceptedSessionIds: ReadonlySet<string>;
};

/**
 * Accept compaction when the run is still relevant and the session envelope
 * links to the panel's current or accepted session. Compatible with workers
 * that send the old id, the new id, or both in `sessionId` / `newSessionId`.
 */
export function shouldAcceptContextCompaction(input: CompactionAcceptInput): boolean {
  const envelope = String(input.messageSessionId || '').trim();
  const nextSession = String(input.newSessionId || '').trim();
  const previousSession = String(input.previousSessionId || '').trim();
  const runId = String(input.messageRunId || '').trim();
  const activeRunId = String(input.activeRunId || '').trim();

  if (runId && activeRunId && runId !== activeRunId) {
    return false;
  }
  if (runId && activeRunId && input.completedRunIds.has(runId) && runId !== activeRunId) {
    return false;
  }

  const sessionId = String(input.sessionId || '').trim();
  const accepted = input.acceptedSessionIds;
  const pending = String(input.pendingSessionId || '').trim();

  const matchesSession = (candidate: string): boolean =>
    Boolean(candidate) && (candidate === sessionId || candidate === pending || accepted.has(candidate));

  const linkedSources = new Set<string>();
  if (envelope) linkedSources.add(envelope);
  if (previousSession) linkedSources.add(previousSession);
  if (nextSession && nextSession !== envelope) {
    // Worker may already have swapped sessionId to the new id before emit.
    if (matchesSession(nextSession) || matchesSession(sessionId)) {
      linkedSources.add(sessionId);
    }
  }

  for (const candidate of linkedSources) {
    if (matchesSession(candidate)) return true;
  }

  if (nextSession && matchesSession(sessionId) && (envelope === sessionId || previousSession === sessionId)) {
    return true;
  }

  if (runId) {
    if (activeRunId && runId === activeRunId) return true;
    if (!activeRunId && input.completedRunIds.has(runId)) return true;
  }

  if (!envelope && !nextSession && !previousSession) return true;
  return false;
}

export function isModelProbeResponseStale(input: {
  requestSeq: number;
  currentSeq: number;
  requestKey: string;
  currentKey: string;
}): boolean {
  return input.requestSeq !== input.currentSeq || input.requestKey !== input.currentKey;
}

export function shouldPersistAutoDetectedModel(input: {
  snapshotModel: string;
  pickerModel: string;
  savedModel: string;
  userExplicitSelection: boolean;
}): boolean {
  if (input.userExplicitSelection) return false;
  const snapshot = String(input.snapshotModel || '').trim();
  const picker = String(input.pickerModel || '').trim();
  if (snapshot && picker && picker !== snapshot) return false;
  return true;
}

export function isHistoryPersistBarrierStale(requestBarrier: number, currentBarrier: number): boolean {
  return requestBarrier !== currentBarrier;
}

export function isRenderGenerationStale(requestGeneration: number, currentGeneration: number): boolean {
  return requestGeneration !== currentGeneration;
}

export function isHistoryListLoadTokenStale(requestToken: number, currentToken: number): boolean {
  return requestToken !== currentToken;
}

const SETTINGS_CONTROL_SELECTOR =
  '#provider, #apiKey, #model, #customEndpoint, #systemPrompt, #saveSettingsBtn, #detectModelsBtn, #anthropicOauthBtn, #codexOauthBtn, #importCredentialsBtn, #enableDebugger, #notifyOnComplete, #permRead, #permInteract, #permNavigate, #permTabs, #permScreenshots, #permSensitiveDataRead, #permClipboard, #permFileUpload, #permDownloads, #permScripting';

SidePanelUI.prototype.bumpRenderSessionGeneration = function bumpRenderSessionGeneration() {
  this.renderSessionGeneration += 1;
  this.cancelDeferredConversationRender?.();
};

SidePanelUI.prototype.cancelDeferredConversationRender = function cancelDeferredConversationRender() {
  if (this.renderConversationRafId) {
    cancelAnimationFrame(this.renderConversationRafId);
    this.renderConversationRafId = 0;
  }
};

SidePanelUI.prototype.setSettingsControlsEnabled = function setSettingsControlsEnabled(enabled: boolean) {
  for (const el of Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(SETTINGS_CONTROL_SELECTOR),
  )) {
    el.disabled = !enabled;
  }
};

SidePanelUI.prototype.resolveRunStopAckWaiter = function resolveRunStopAckWaiter() {
  const waiter = this._runStopAckWaiter;
  this._runStopAckWaiter = null;
  waiter?.();
};

SidePanelUI.prototype.bumpHistoryDeletionBarrier = function bumpHistoryDeletionBarrier() {
  this.historyDeletionBarrier += 1;
  if (this.historyPersistDebounceTimerId) {
    window.clearTimeout(this.historyPersistDebounceTimerId);
    this.historyPersistDebounceTimerId = null;
  }
};

SidePanelUI.prototype.noteCompletedRunId = function noteCompletedRunId(runId: string | null | undefined) {
  const trimmed = String(runId || '').trim();
  if (!trimmed) return;
  boundPanelIdSet(this.completedRunIds, trimmed);
};

SidePanelUI.prototype.noteAcceptedSessionId = function noteAcceptedSessionId(sessionId: string | null | undefined) {
  const trimmed = String(sessionId || '').trim();
  if (!trimmed) return;
  boundPanelIdSet(this.acceptedSessionIds, trimmed);
};
