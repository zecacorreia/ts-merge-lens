import type { AnnotationSummary } from '../annotate/annotate.js';
import type { LimitationSummary } from '../limitations.js';
import type { ChangedUnit } from '../scenario/changed-units.js';
import type { RefactoringVerdict } from '../filter/refactoring/classify.js';
import type { DiscardReason } from '../scenario/scenario.js';

export type AlertType = 'OA' | 'DF' | 'CF' | 'BUILD';
export type Confidence = 'high' | 'medium' | 'low';
export type Branch = 'Base' | 'Left' | 'Right' | 'Merge';

export interface Location {
  file: string;
  line: number;
  column: number;
  function?: string;
  branch: Branch;
  /** Call sites followed from the analysed function to reach this location, outermost first. */
  callChain?: string[];
}

export interface Alert {
  type: AlertType;
  confidence: Confidence;
  /**
   * One location for BUILD. For OA, two: the overwritten write and then the write that overrides
   * it, in execution order, each tagged with its branch (Left or Right).
   */
  locations: Location[];
  /** The state element involved, e.g. `this.fixes`. */
  element?: string;
  snippet?: string;
  explanation: { pt: string; en: string };
}

export interface ScenarioInfo {
  source: 'git' | 'dirs';
  merge?: string;
  base?: string;
  left?: string;
  right?: string;
  matchesAutomaticMerge?: boolean;
}

export interface AnalysisReport {
  tool: 'tsmergelens';
  version: string;
  scenario: ScenarioInfo;
  status: 'analyzed' | 'discarded';
  discardReason?: DiscardReason;
  units: ChangedUnit[];
  annotation: AnnotationSummary[];
  alerts: Alert[];
  /** Whether each side's changes look like refactorings; present when the filter is on. */
  refactoring?: RefactoringVerdict;
  /** Places where the analyses approximated; they bound how far the result can be trusted. */
  limitations: LimitationSummary[];
  /** Warnings and limitations that affect how far the result can be trusted. */
  notes: string[];
}
