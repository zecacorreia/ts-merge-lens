import { candidate } from '../../rank/rank.js';
import type { Candidate } from '../../rank/rank.js';
import {
  describeLocation,
  locationOf,
  snippetOf,
  sortByLastLocation,
} from '../../report/locations.js';
import type { Branch } from '../../report/types.js';
import type { Side } from '../oa/flow.js';
import type { FlowFinding } from './dfcf.js';

const branchOf = (side: Side): Branch => (side === 'L' ? 'Left' : 'Right');

/**
 * DF and CF alerts. `locations[0]` is the source (the write that reaches a read, or whatever
 * influences a condition) and `locations[1]` the sink (the read, or the changed statement that
 * only runs under that condition), each with its branch.
 */
export function flowAlerts(findings: readonly FlowFinding[], mergeDir: string): Candidate[] {
  const items = findings.map((finding): Candidate => {
    const source = locationOf(finding.source, branchOf(finding.source.side), mergeDir);
    const sink = locationOf(finding.sink, branchOf(finding.sink.side), mergeDir);
    const element = finding.element;
    let pt: string;
    let en: string;
    if (finding.type === 'DF') {
      pt = `${sink.branch}, em ${describeLocation(sink)}, lê ${element ?? '?'} escrito por ${source.branch} em ${describeLocation(source)}.`;
      en = `${sink.branch}, in ${describeLocation(sink)}, reads ${element ?? '?'} written by ${source.branch} in ${describeLocation(source)}.`;
    } else {
      const condition = finding.predicate
        ? describeLocation(
            locationOf(
              { ...finding.predicate, callChain: [] },
              branchOf(finding.sink.side),
              mergeDir,
            ),
          )
        : 'a condition';
      pt = element
        ? `${sink.branch} executa ${describeLocation(sink)} somente sob a condição em ${condition}, que depende de ${element} escrito por ${source.branch} em ${describeLocation(source)}.`
        : `${sink.branch} executa ${describeLocation(sink)} sob a condição em ${condition}, alterada por ${source.branch}.`;
      en = element
        ? `${sink.branch} runs ${describeLocation(sink)} only under the condition at ${condition}, which depends on ${element} written by ${source.branch} in ${describeLocation(source)}.`
        : `${sink.branch} runs ${describeLocation(sink)} under the condition at ${condition}, which ${source.branch} changed.`;
    }
    return candidate(
      {
        type: finding.type,
        locations: [source, sink],
        ...(element ? { element } : {}),
        snippet: snippetOf(finding.sink.node),
        explanation: { pt, en },
      },
      { uncertainTypes: finding.lowConfidence, refactoringSuspected: false },
    );
  });
  return sortByLastLocation(items);
}
