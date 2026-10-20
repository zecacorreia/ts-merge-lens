import { reRank } from '../../rank/rank.js';
import type { Candidate } from '../../rank/rank.js';
import type { ScenarioDirs } from '../../scenario/scenario.js';
import { classifySide } from './classify.js';
import type { RefactoringVerdict } from './classify.js';

export type RefactoringFilterMode = 'off' | 'downgrade' | 'suppress';

export function refactoringVerdict(dirs: ScenarioDirs): RefactoringVerdict {
  return {
    left: classifySide(dirs.base, dirs.left),
    right: classifySide(dirs.base, dirs.right),
  };
}

export interface FilterResult {
  kept: Candidate[];
  suppressed: number;
  downgraded: number;
}

/**
 * An interference needs a change on each side. If every change of one side is a refactoring, the
 * side did not alter behaviour, so alerts involving it are most likely false positives: they are
 * removed (`suppress`) or demoted to low confidence (`downgrade`). Alerts without a Left or Right
 * location (BUILD) are never touched.
 */
export function applyRefactoringFilter(
  candidates: readonly Candidate[],
  verdict: RefactoringVerdict,
  mode: RefactoringFilterMode,
): FilterResult {
  if (mode === 'off') return { kept: [...candidates], suppressed: 0, downgraded: 0 };
  const kept: Candidate[] = [];
  let suppressed = 0;
  let downgraded = 0;
  for (const item of candidates) {
    const branches = new Set(item.alert.locations.map((location) => location.branch));
    const refactored =
      (branches.has('Left') && verdict.left.structural) ||
      (branches.has('Right') && verdict.right.structural);
    if (!refactored) {
      kept.push(item);
    } else if (mode === 'suppress') {
      suppressed++;
    } else {
      kept.push(reRank(item, { refactoringSuspected: true }));
      downgraded++;
    }
  }
  return { kept, suppressed, downgraded };
}
