/** Ground truth for one scenario: does the merge contain a semantic interference? */
export type Truth = 'interference' | 'clean';

export type LabelStatus = 'agreed' | 'consensus' | 'needs-consensus' | 'unlabeled';

export interface ResolvedLabel {
  id: string;
  status: LabelStatus;
  /** Present when `status` is `agreed` or `consensus`. */
  truth?: Truth;
}

const VALUES: Record<string, Truth> = {
  '1': 'interference',
  '0': 'clean',
  interference: 'interference',
  clean: 'clean',
};

function parseValue(raw: string | undefined): Truth | 'invalid' | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return undefined;
  return VALUES[value] ?? 'invalid';
}

/**
 * Two reviewers label independently (`1` interference, `0` clean). Equal labels are the truth;
 * different ones need a `consensus` value, written after the reviewers discuss them.
 */
export function resolveLabels(rows: ReadonlyArray<Record<string, string>>): ResolvedLabel[] {
  return rows.map((row): ResolvedLabel => {
    const id = row.id ?? '';
    const first = parseValue(row.reviewer1);
    const second = parseValue(row.reviewer2);
    const consensus = parseValue(row.consensus);
    if (first === 'invalid' || second === 'invalid' || consensus === 'invalid') {
      throw new Error(`row ${id}: labels must be 1, 0, interference or clean`);
    }
    if (consensus) return { id, status: 'consensus', truth: consensus };
    if (first === undefined || second === undefined) return { id, status: 'unlabeled' };
    if (first === second) return { id, status: 'agreed', truth: first };
    return { id, status: 'needs-consensus' };
  });
}

/** Cohen's kappa between the two reviewers over the rows both labelled; null if undefined. */
export function cohenKappa(rows: ReadonlyArray<Record<string, string>>): number | null {
  const pairs = rows.flatMap((row) => {
    const first = parseValue(row.reviewer1);
    const second = parseValue(row.reviewer2);
    return first && second && first !== 'invalid' && second !== 'invalid' ? [[first, second]] : [];
  });
  if (pairs.length === 0) return null;
  const observed = pairs.filter(([a, b]) => a === b).length / pairs.length;
  const share = (index: 0 | 1, value: Truth): number =>
    pairs.filter((pair) => pair[index] === value).length / pairs.length;
  const expected =
    share(0, 'interference') * share(1, 'interference') + share(0, 'clean') * share(1, 'clean');
  return expected === 1 ? null : (observed - expected) / (1 - expected);
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface Scores extends Confusion {
  /** Scenarios counted. */
  total: number;
  /** Each is null when its denominator is zero, never a made-up 0 or 1. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export function score(pairs: ReadonlyArray<{ truth: Truth; predicted: boolean }>): Scores {
  const confusion: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const { truth, predicted } of pairs) {
    const positive = truth === 'interference';
    if (positive && predicted) confusion.tp++;
    else if (!positive && predicted) confusion.fp++;
    else if (!positive && !predicted) confusion.tn++;
    else confusion.fn++;
  }
  const precision = ratio(confusion.tp, confusion.tp + confusion.fp);
  const recall = ratio(confusion.tp, confusion.tp + confusion.fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return {
    ...confusion,
    total: pairs.length,
    precision,
    recall,
    f1,
    accuracy: ratio(confusion.tp + confusion.tn, pairs.length),
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (high === undefined) return null;
  return sorted.length % 2 === 1 || low === undefined ? high : (low + high) / 2;
}
