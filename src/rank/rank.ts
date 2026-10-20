import type { Alert, Confidence } from '../report/types.js';

/** What we know about how much to trust an alert. */
export interface Evidence {
  /** The state involved is reached through `any`/`unknown` or a non-literal key. */
  uncertainTypes: boolean;
  /** One side's changes look like a refactoring (see `filter/refactoring`). */
  refactoringSuspected: boolean;
  /** A run of the program confirmed the interference (dynamic analysis, an extension). */
  dynamicallyConfirmed?: boolean;
}

/**
 * - `high`: confirmed dynamically;
 * - `medium`: found statically with the types resolved;
 * - `low`: involves `any`, a dynamic access, or is suspected to be a refactoring.
 */
export function rank(evidence: Evidence): Confidence {
  if (evidence.uncertainTypes || evidence.refactoringSuspected) return 'low';
  return evidence.dynamicallyConfirmed ? 'high' : 'medium';
}

/** An alert together with the evidence behind its confidence, until the report is final. */
export interface Candidate {
  alert: Alert;
  evidence: Evidence;
}

export function candidate(alert: Omit<Alert, 'confidence'>, evidence: Evidence): Candidate {
  return { alert: { ...alert, confidence: rank(evidence) }, evidence };
}

/** Recomputes the confidence after the evidence changed. */
export function reRank(item: Candidate, changes: Partial<Evidence>): Candidate {
  const evidence = { ...item.evidence, ...changes };
  return { alert: { ...item.alert, confidence: rank(evidence) }, evidence };
}
