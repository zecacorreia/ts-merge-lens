import fs from 'node:fs';
import path from 'node:path';
import { annotateScenario, summarize } from './annotate/annotate.js';
import { AnalysisContext } from './analysis/context.js';
import { flowAlerts } from './analysis/flow/alerts.js';
import { analyzeFlow } from './analysis/flow/dfcf.js';
import { oaAlerts } from './analysis/oa/alerts.js';
import { analyzeOa } from './analysis/oa/oa.js';
import { applyRefactoringFilter, refactoringVerdict } from './filter/refactoring/filter.js';
import type { RefactoringFilterMode } from './filter/refactoring/filter.js';
import type { Candidate } from './rank/rank.js';
import { createDirProgram, findBuildConflicts } from './build/build.js';
import type { DirProgram } from './build/build.js';
import type { BuildDiagnostic } from './build/build.js';
import type { Alert, AnalysisReport, ScenarioInfo } from './report/types.js';
import { findUnitsChangedByBoth } from './scenario/changed-units.js';
import type { ChangedUnit } from './scenario/changed-units.js';
import { changedPaths, commitSummary, listMergeCommits } from './scenario/git.js';
import { classifyMerge, materializeScenario, scenarioFromDirs } from './scenario/scenario.js';
import type { Scenario, ScenarioDirs } from './scenario/scenario.js';
import { isAnalyzableSource } from './util/files.js';
import { VERSION } from './version.js';

export const ANALYSES = ['oa', 'df', 'cf', 'build'] as const;
export type AnalysisName = (typeof ANALYSES)[number];

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type ScenarioSource =
  { kind: 'git'; repo: string; merge: string } | { kind: 'dirs'; dirs: ScenarioDirs };

export interface AnalyzeOptions {
  source: ScenarioSource;
  /** `file#function`; restricts the units of interest. */
  entry?: string;
  /** Call nesting followed by OA; 0 is the intraprocedural analysis. */
  depth: number;
  analyses: readonly AnalysisName[];
  /** `name` identifies state by identifier text only (the typeless baseline); default `symbol`. */
  identity?: 'symbol' | 'name';
  /** How alerts of sides whose changes are all refactorings are treated; default `off`. */
  refactoringFilter?: RefactoringFilterMode;
}

function buildAlert(scenario: Scenario, diagnostic: BuildDiagnostic): Candidate {
  const file = diagnostic.file ?? '(global)';
  const line = diagnostic.line ?? 0;
  const alert: Omit<Alert, 'confidence'> = {
    type: 'BUILD',
    locations: [{ file, line, column: diagnostic.column ?? 0, branch: 'Merge' }],
    explanation: {
      pt:
        `O Merge não compila (TS${diagnostic.code}) em ${file}:${line}, ` +
        `embora Base, Left e Right não tenham esse erro: ${diagnostic.message}`,
      en:
        `The Merge does not compile (TS${diagnostic.code}) at ${file}:${line}, ` +
        `although Base, Left and Right do not have this error: ${diagnostic.message}`,
    },
  };
  if (diagnostic.file !== undefined && line > 0) {
    const text = fs.readFileSync(path.join(scenario.dirs.merge, diagnostic.file), 'utf8');
    const snippet = text.split(/\r?\n/)[line - 1];
    if (snippet !== undefined) alert.snippet = snippet;
  }
  // The compiler is deterministic: a build error is as certain as an alert can be.
  return {
    alert: { ...alert, confidence: 'high' },
    evidence: { uncertainTypes: false, refactoringSuspected: false },
  };
}

function scenarioInfo(scenario: Scenario): ScenarioInfo {
  const { commits } = scenario;
  if (!commits) return { source: 'dirs' };
  return {
    source: 'git',
    merge: commits.merge,
    base: commits.base,
    left: commits.left,
    right: commits.right,
    matchesAutomaticMerge: commits.matchesAutomaticMerge,
  };
}

function selectUnits(units: ChangedUnit[], entry: string | undefined): ChangedUnit[] {
  if (entry === undefined) return units;
  const selected = units.filter((unit) => unit.key === entry);
  if (selected.length === 0) {
    throw new UsageError(`--entry ${entry} is not a function changed by both sides`);
  }
  return selected;
}

export function analyze(options: AnalyzeOptions): AnalysisReport {
  const report: AnalysisReport = {
    tool: 'tsmergelens',
    version: VERSION,
    scenario: { source: options.source.kind },
    status: 'analyzed',
    units: [],
    annotation: [],
    alerts: [],
    limitations: [],
    notes: [],
  };

  let scenario: Scenario;
  if (options.source.kind === 'git') {
    const { repo, merge } = options.source;
    const classified = classifyMerge(repo, merge);
    if (classified.status === 'discarded') {
      return { ...report, status: 'discarded', discardReason: classified.reason };
    }
    scenario = materializeScenario(repo, classified.commits);
  } else {
    scenario = scenarioFromDirs(options.source.dirs);
  }

  try {
    report.scenario = scenarioInfo(scenario);
    report.units = selectUnits(findUnitsChangedByBoth(scenario.dirs), options.entry);
    const annotation = annotateScenario(scenario.dirs);
    report.annotation = summarize(annotation);

    // Both the build check and the analyses need the program of the Merge version.
    let mergeProgram: DirProgram | undefined;
    const getMergeProgram = (): DirProgram =>
      (mergeProgram ??= createDirProgram(scenario.dirs.merge));
    const wants = (name: AnalysisName): boolean => options.analyses.includes(name);

    const candidates: Candidate[] = [];
    if (wants('build')) {
      candidates.push(
        ...findBuildConflicts(scenario.dirs, getMergeProgram()).map((diagnostic) =>
          buildAlert(scenario, diagnostic),
        ),
      );
    }
    if (wants('oa') || wants('df') || wants('cf')) {
      const input = {
        program: getMergeProgram().program,
        mergeDir: scenario.dirs.merge,
        annotation,
        units: report.units,
        ...(options.identity ? { identity: options.identity } : {}),
      };
      const context = new AnalysisContext(input);
      const skipped = new Set<string>();
      if (wants('oa')) {
        const result = analyzeOa({ ...input, depth: options.depth }, context);
        candidates.push(...oaAlerts(result.findings, scenario.dirs.merge));
        for (const key of result.skipped) skipped.add(key);
      }
      if (wants('df') || wants('cf')) {
        const result = analyzeFlow(input, context);
        const findings = result.findings.filter((f) => wants(f.type === 'DF' ? 'df' : 'cf'));
        candidates.push(...flowAlerts(findings, scenario.dirs.merge));
        for (const key of result.skipped) skipped.add(key);
      }
      report.limitations = context.limits.summary();
      for (const key of skipped) {
        report.notes.push(
          `${key} was not analysed: it is not part of the Merge TypeScript program`,
        );
      }
    }

    const mode = options.refactoringFilter ?? 'off';
    if (mode !== 'off') {
      report.refactoring = refactoringVerdict(scenario.dirs);
      const filtered = applyRefactoringFilter(candidates, report.refactoring, mode);
      candidates.splice(0, candidates.length, ...filtered.kept);
      if (filtered.suppressed > 0) {
        report.notes.push(
          `${filtered.suppressed} alert(s) suppressed: all changes of one side look like refactorings`,
        );
      }
      if (filtered.downgraded > 0) {
        report.notes.push(
          `${filtered.downgraded} alert(s) downgraded to low confidence: all changes of one side look like refactorings`,
        );
      }
    }
    report.alerts = candidates.map((item) => item.alert);
    return report;
  } finally {
    scenario.dispose();
  }
}

export interface MergeCandidate {
  sha: string;
  date: string;
  subject: string;
  units: ChangedUnit[];
}

/** Merge commits that are valid scenarios and have functions changed by both sides. */
export function scanMerges(repo: string, since?: string): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];
  for (const sha of listMergeCommits(repo, since)) {
    const classified = classifyMerge(repo, sha);
    if (classified.status === 'discarded') continue;
    const { base, left, right } = classified.commits;
    const leftChanges = new Set(changedPaths(repo, base, left));
    const bothChanged = changedPaths(repo, base, right).filter(
      (file) => leftChanges.has(file) && isAnalyzableSource(file),
    );
    if (bothChanged.length === 0) continue;

    const scenario = materializeScenario(repo, classified.commits);
    try {
      const units = findUnitsChangedByBoth(scenario.dirs);
      if (units.length > 0) candidates.push({ ...commitSummary(repo, sha), units });
    } finally {
      scenario.dispose();
    }
  }
  return candidates;
}
