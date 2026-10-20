import { performance } from 'node:perf_hooks';
import { findBuildConflicts } from '../build/build.js';
import { analyze } from '../pipeline.js';
import type { Confidence } from '../report/types.js';
import { automaticMerge } from '../scenario/git.js';
import { materializeScenario } from '../scenario/scenario.js';
import type { ScenarioDirs } from '../scenario/scenario.js';
import { VERSION } from '../version.js';
import type { MinedMerge } from './mine.js';
import { median } from './metrics.js';

export const CONFIG_NAMES = ['B0', 'B1', 'B2', 'B3'] as const;
export type ConfigName = (typeof CONFIG_NAMES)[number];

export const CONFIG_DESCRIPTIONS: Record<ConfigName, string> = {
  B0: 'git: the merge is accepted whenever git merges it without a conflict (never predicts interference)',
  B1: 'tsc only: predicts interference when the Merge has a compilation error that Base, Left and Right do not',
  B2: 'OA with state identified by identifier name, with no type information',
  B3: 'complete: OA, DF, CF and build, symbols from the type checker, refactoring filter on (downgrade)',
};

export interface AlertSummary {
  type: string;
  confidence: Confidence;
}

/** What one configuration says about one scenario, without timing. */
interface Verdict {
  alerts: AlertSummary[];
}

type Execution = (merge: MinedMerge, dirs: ScenarioDirs) => Verdict;

const EXECUTIONS: Record<ConfigName, Execution> = {
  B0: (merge) => {
    // The only thing git does: replay the merge. A scenario is only mined if that is clean.
    automaticMerge(merge.repoPath, merge.left, merge.right);
    return { alerts: [] };
  },
  B1: (_merge, dirs) => ({
    alerts: findBuildConflicts(dirs).map(() => ({ type: 'BUILD', confidence: 'high' as const })),
  }),
  B2: (_merge, dirs) =>
    verdictOf(
      analyze({
        source: { kind: 'dirs', dirs },
        depth: 5,
        analyses: ['oa'],
        identity: 'name',
        refactoringFilter: 'off',
      }),
    ),
  B3: (_merge, dirs) =>
    verdictOf(
      analyze({
        source: { kind: 'dirs', dirs },
        depth: 5,
        analyses: ['oa', 'df', 'cf', 'build'],
        refactoringFilter: 'downgrade',
      }),
    ),
};

function verdictOf(report: {
  alerts: ReadonlyArray<{ type: string; confidence: Confidence }>;
}): Verdict {
  return { alerts: report.alerts.map(({ type, confidence }) => ({ type, confidence })) };
}

export interface RunRecord {
  id: string;
  config: ConfigName;
  alerts: AlertSummary[];
  /** Wall-clock milliseconds of each repetition. */
  runsMs: number[];
  medianMs: number | null;
  /** Set when the configuration failed; the scenario then counts as an error, not a prediction. */
  error?: string;
}

export interface RunFile {
  generatedAt: string;
  tool: string;
  node: string;
  repetitions: number;
  configs: ConfigName[];
  records: RunRecord[];
}

export interface RunOptions {
  merges: readonly MinedMerge[];
  configs: readonly ConfigName[];
  /** Repetitions per scenario and configuration; the report uses their median. */
  repetitions?: number;
  onProgress?: (message: string) => void;
}

/**
 * Runs each configuration on each scenario `repetitions` times (10 by default) in this process
 * and records alerts and times. Checkout of the four versions is done once per scenario and is
 * not timed; everything the configuration does with them (parsing, annotation, type checking,
 * analyses, report) is. Standard-library parsing is cached across runs, so repetitions are warm.
 */
export function runEvaluation(options: RunOptions): RunFile {
  const repetitions = options.repetitions ?? 10;
  const records: RunRecord[] = [];
  for (const merge of options.merges) {
    options.onProgress?.(merge.id);
    let scenario: ReturnType<typeof materializeScenario>;
    try {
      scenario = materializeScenario(
        merge.repoPath,
        {
          merge: merge.sha,
          base: merge.base,
          left: merge.left,
          right: merge.right,
          matchesAutomaticMerge: true,
        },
        { linkNodeModules: true },
      );
    } catch (error) {
      // The scenario cannot even be checked out: every configuration fails on it.
      for (const config of options.configs) {
        records.push({
          id: merge.id,
          config,
          alerts: [],
          runsMs: [],
          medianMs: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    try {
      for (const config of options.configs) {
        records.push(measure(merge, config, scenario.dirs, repetitions));
      }
    } finally {
      scenario.dispose();
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    tool: VERSION,
    node: process.version,
    repetitions,
    configs: [...options.configs],
    records,
  };
}

function measure(
  merge: MinedMerge,
  config: ConfigName,
  dirs: ScenarioDirs,
  repetitions: number,
): RunRecord {
  const runsMs: number[] = [];
  let verdict: Verdict = { alerts: [] };
  try {
    for (let run = 0; run < repetitions; run++) {
      const start = performance.now();
      verdict = EXECUTIONS[config](merge, dirs);
      runsMs.push(performance.now() - start);
    }
  } catch (error) {
    return {
      id: merge.id,
      config,
      alerts: [],
      runsMs,
      medianMs: median(runsMs),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { id: merge.id, config, alerts: verdict.alerts, runsMs, medianMs: median(runsMs) };
}
