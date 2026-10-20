import { parseCsv, stringifyCsv } from './csv.js';
import type { MinedMerge } from './mine.js';

/**
 * The labelling sheet. Reviewers fill `reviewer1` and `reviewer2` independently (1 = the merge
 * contains a semantic interference, 0 = it does not) and, for disagreements, `consensus`. The
 * tool's output is deliberately absent so that nobody labels with it in view.
 */
export const SHEET_COLUMNS = [
  'id',
  'repo',
  'merge_sha',
  'date',
  'subject',
  'base_sha',
  'left_sha',
  'right_sha',
  'changed_functions',
  'reviewer1',
  'reviewer2',
  'consensus',
  'notes',
] as const;

const HUMAN_COLUMNS = ['reviewer1', 'reviewer2', 'consensus', 'notes'];

function rowOf(merge: MinedMerge): Record<string, string> {
  return {
    id: merge.id,
    repo: merge.repo,
    merge_sha: merge.sha,
    date: merge.date,
    subject: merge.subject,
    base_sha: merge.base,
    left_sha: merge.left,
    right_sha: merge.right,
    changed_functions: merge.units.join('; '),
    reviewer1: '',
    reviewer2: '',
    consensus: '',
    notes: '',
  };
}

/**
 * Builds the sheet for `merges`. When `existing` (the text of a previous sheet) is given, the
 * reviewers' columns of every scenario already in it are kept, scenarios no longer mined stay
 * with their labels, and new ones are appended: labelling work is never lost.
 */
export function buildSheet(merges: readonly MinedMerge[], existing?: string): string {
  const rows = (existing ? parseCsv(existing) : []).map((row) => ({ ...row }));
  const index = new Map(rows.map((row) => [row.id ?? '', row]));
  for (const merge of merges) {
    const fresh = rowOf(merge);
    const old = index.get(merge.id);
    if (!old) {
      rows.push(fresh);
      index.set(merge.id, fresh);
      continue;
    }
    for (const [column, value] of Object.entries(fresh)) {
      if (!HUMAN_COLUMNS.includes(column)) old[column] = value;
    }
  }
  return stringifyCsv(SHEET_COLUMNS, rows);
}
