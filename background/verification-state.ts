export type EffectEvidence = {
  actionId: string;
  tool: string;
  tabId: number | null;
  frameId: number;
  domRevision: number;
  navigationRevision: number;
  postconditionSatisfied?: boolean;
};

export type ObservationEvidence = {
  tool: string;
  tabId: number | null;
  frameId: number;
  domRevision: number;
  navigationRevision: number;
};

export type VerificationOutcome = {
  verified: boolean;
  reason: 'no_pending_effect' | 'scope_mismatch' | 'stale_observation' | 'matching_observation';
  effect: EffectEvidence | null;
};

export class VerificationState {
  private pendingEffect: EffectEvidence | null = null;

  recordEffect(effect: EffectEvidence): void {
    this.pendingEffect = effect.postconditionSatisfied ? null : { ...effect };
  }

  recordObservation(observation: ObservationEvidence): VerificationOutcome {
    const effect = this.pendingEffect;
    if (!effect) return { verified: false, reason: 'no_pending_effect', effect: null };
    if (effect.tabId !== observation.tabId || effect.frameId !== observation.frameId) {
      return { verified: false, reason: 'scope_mismatch', effect: { ...effect } };
    }
    const newer =
      observation.navigationRevision > effect.navigationRevision ||
      (observation.navigationRevision === effect.navigationRevision &&
        observation.domRevision > effect.domRevision);
    if (!newer) return { verified: false, reason: 'stale_observation', effect: { ...effect } };
    this.pendingEffect = null;
    return { verified: true, reason: 'matching_observation', effect: { ...effect } };
  }

  pending(): EffectEvidence | null {
    return this.pendingEffect ? { ...this.pendingEffect } : null;
  }

  reset(): void {
    this.pendingEffect = null;
  }
}
