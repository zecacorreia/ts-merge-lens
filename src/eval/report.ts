import { cohenKappa, median, resolveLabels, score } from './metrics.js';
import type { Scores } from './metrics.js';
import { CONFIG_DESCRIPTIONS } from './runner.js';
import type { ConfigName, RunFile, RunRecord } from './runner.js';

export type MinConfidence = 'low' | 'medium';

export interface ConfigSummary extends Scores {
  config: ConfigName;
  /** Median over scenarios of each scenario's median time, in milliseconds. */
  medianMs: number | null;
  /** Scenarios that could not be scored because the configuration failed on them. */
  errors: number;
}

export interface Evaluation {
  scenarios: {
    sheetRows: number;
    labelled: number;
    needConsensus: number;
    unlabeled: number;
    withResults: number;
  };
  /** Cohen's kappa between the two reviewers, before consensus. */
  kappa: number | null;
  positiveRule: string;
  configs: ConfigSummary[];
}

/**
 * A scenario counts as predicted positive when the configuration raised at least one alert of
 * `minConfidence` or higher.
 */
export function evaluate(
  sheetRows: ReadonlyArray<Record<string, string>>,
  results: RunFile,
  minConfidence: MinConfidence = 'low',
): Evaluation {
  const labels = resolveLabels(sheetRows);
  const truthById = new Map(labels.flatMap((l) => (l.truth ? [[l.id, l.truth] as const] : [])));
  const idsWithResults = new Set(results.records.map((record) => record.id));

  const summaries = results.configs.map((config): ConfigSummary => {
    const records = results.records.filter(
      (record): record is RunRecord => record.config === config && truthById.has(record.id),
    );
    const errors = records.filter((record) => record.error !== undefined).length;
    const scored = records.filter((record) => record.error === undefined);
    const scores = score(
      scored.map((record) => ({
        truth: truthById.get(record.id) ?? 'clean',
        predicted: record.alerts.some(
          (alert) => minConfidence === 'low' || alert.confidence !== 'low',
        ),
      })),
    );
    return {
      config,
      ...scores,
      errors,
      medianMs: median(scored.map((record) => record.medianMs ?? 0)),
    };
  });

  return {
    scenarios: {
      sheetRows: sheetRows.length,
      labelled: truthById.size,
      needConsensus: labels.filter((l) => l.status === 'needs-consensus').length,
      unlabeled: labels.filter((l) => l.status === 'unlabeled').length,
      withResults: labels.filter((l) => idsWithResults.has(l.id)).length,
    },
    kappa: cohenKappa(sheetRows),
    positiveRule:
      minConfidence === 'low'
        ? 'an alert of any confidence'
        : 'an alert of medium or high confidence',
    configs: summaries,
  };
}

const pct = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(3));
const ms = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(1));

export function renderMarkdown(evaluation: Evaluation): string {
  const { scenarios } = evaluation;
  const lines = [
    '# Evaluation',
    '',
    `Scenarios in the sheet: ${scenarios.sheetRows}; labelled: ${scenarios.labelled}; ` +
      `disagreements awaiting consensus: ${scenarios.needConsensus}; unlabelled: ${scenarios.unlabeled}.`,
    `Reviewer agreement (Cohen's kappa): ${pct(evaluation.kappa)}.`,
    `Predicted positive = ${evaluation.positiveRule}.`,
    '',
    '| Config | TP | FP | TN | FN | Precision | Recall | F1 | Accuracy | Median time (ms) | Errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...evaluation.configs.map(
      (c) =>
        `| ${c.config} | ${c.tp} | ${c.fp} | ${c.tn} | ${c.fn} | ${pct(c.precision)} | ${pct(c.recall)} | ${pct(c.f1)} | ${pct(c.accuracy)} | ${ms(c.medianMs)} | ${c.errors} |`,
    ),
    '',
    ...evaluation.configs.map((c) => `- **${c.config}**: ${CONFIG_DESCRIPTIONS[c.config]}`),
    '',
    'n/a means the denominator is zero (for example precision when nothing was predicted positive).',
    '',
  ];
  return lines.join('\n');
}
