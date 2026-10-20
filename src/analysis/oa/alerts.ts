import { displayElement } from '../../state/element.js';
import { candidate } from '../../rank/rank.js';
import type { Candidate } from '../../rank/rank.js';
import {
  describeLocation,
  locationOf,
  snippetOf,
  sortByLastLocation,
} from '../../report/locations.js';
import type { Branch } from '../../report/types.js';
import type { WriteSite } from './flow.js';
import type { OaFinding } from './oa.js';

function branchOf(site: WriteSite): Branch {
  return site.side === 'L' ? 'Left' : 'Right';
}

/**
 * One alert per overriding assignment. `locations[0]` is the overwritten write and `locations[1]`
 * the write that overrides it, in execution order; each carries its branch (Left or Right).
 */
export function oaAlerts(findings: readonly OaFinding[], mergeDir: string): Candidate[] {
  const items = findings.map((finding): Candidate => {
    const earlier = locationOf(finding.earlier, branchOf(finding.earlier), mergeDir);
    const later = locationOf(finding.later, branchOf(finding.later), mergeDir);
    const written =
      displayElement(finding.earlier.element) === finding.element
        ? finding.element
        : `${finding.element} (written as ${displayElement(finding.earlier.element)})`;
    return candidate(
      {
        type: 'OA',
        locations: [earlier, later],
        element: finding.element,
        snippet: snippetOf(finding.later.node),
        explanation: {
          pt: `${later.branch}, em ${describeLocation(later)}, sobrescreve ${finding.element} escrito por ${earlier.branch} em ${describeLocation(earlier)}.`,
          en: `${later.branch}, in ${describeLocation(later)}, overwrites ${written} written by ${earlier.branch} in ${describeLocation(earlier)}.`,
        },
      },
      { uncertainTypes: finding.lowConfidence, refactoringSuspected: false },
    );
  });
  return sortByLastLocation(items);
}
