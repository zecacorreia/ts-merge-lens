import path from 'node:path';
import { compileDir } from '../build/build.js';
import { findUnitsChangedByBoth } from '../scenario/changed-units.js';
import { changedPaths, commitSummary, listMergeCommits } from '../scenario/git.js';
import { classifyMerge, materializeScenario } from '../scenario/scenario.js';
import type { DiscardReason } from '../scenario/scenario.js';
import { isAnalyzableSource } from '../util/files.js';

export interface MinedMerge {
  /** `<repo>@<first 10 chars of the merge sha>`: stable, unique across repositories. */
  id: string;
  repo: string;
  repoPath: string;
  sha: string;
  date: string;
  subject: string;
  base: string;
  left: string;
  right: string;
  /** Functions changed by both sides, as `file#Qualified.name`. */
  units: string[];
  /**
   * Whether each version type-checks with no error (dependencies as installed in the repo);
   * `null` when it was not checked.
   */
  compiles: {
    base: boolean | null;
    left: boolean | null;
    right: boolean | null;
    merge: boolean | null;
  };
}

/** How many merge commits were left after each selection criterion, for the paper's funnel. */
export interface Funnel {
  mergeCommits: number;
  discarded: Partial<Record<DiscardReason, number>>;
  /** Clean merges where the two sides changed no `.ts`/`.tsx` file in common. */
  noSharedSourceFile: number;
  /** Clean merges with a shared file but no function changed by both sides. */
  noSharedFunction: number;
  /** Scenarios meeting every structural criterion. */
  structural: number;
  /** Structural scenarios checked for compilation, and how many failed it. */
  compileChecked: number;
  failedCompile: number;
  selected: number;
}

export type CompileRequirement = 'all' | 'base' | 'none';

export interface MineOptions {
  repoPath: string;
  repoName?: string;
  since?: string;
  /** Keep at most this many scenarios, sampled at random with `seed`. */
  limit?: number;
  seed?: number;
  /**
   * `all`: Base, Left and Right must type-check (so a Merge-only error is a real build conflict);
   * `base`: only Base; `none`: no check.
   */
  requireCompile?: CompileRequirement;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic shuffle, so the same seed samples the same scenarios. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = copy[i];
    const b = copy[j];
    if (a === undefined || b === undefined) continue;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

type Structural = Omit<MinedMerge, 'compiles'>;

/**
 * Selects the merges of one repository that can serve as experimental scenarios: two parents, no
 * textual conflict, no fast-forward or criss-cross, both sides changed the same function of a
 * `.ts`/`.tsx` file, and the versions compile. Nothing here depends on the tool's own verdict.
 */
export function mineRepo(options: MineOptions): { merges: MinedMerge[]; funnel: Funnel } {
  const { repoPath } = options;
  const repoName = options.repoName ?? path.basename(path.resolve(repoPath));
  const funnel: Funnel = {
    mergeCommits: 0,
    discarded: {},
    noSharedSourceFile: 0,
    noSharedFunction: 0,
    structural: 0,
    compileChecked: 0,
    failedCompile: 0,
    selected: 0,
  };

  const structural: Structural[] = [];
  for (const sha of listMergeCommits(repoPath, options.since)) {
    funnel.mergeCommits++;
    const classified = classifyMerge(repoPath, sha);
    if (classified.status === 'discarded') {
      funnel.discarded[classified.reason] = (funnel.discarded[classified.reason] ?? 0) + 1;
      continue;
    }
    const { base, left, right } = classified.commits;
    const leftChanges = new Set(changedPaths(repoPath, base, left));
    const shared = changedPaths(repoPath, base, right).filter(
      (file) => leftChanges.has(file) && isAnalyzableSource(file),
    );
    if (shared.length === 0) {
      funnel.noSharedSourceFile++;
      continue;
    }
    const scenario = materializeScenario(repoPath, classified.commits);
    try {
      const units = findUnitsChangedByBoth(scenario.dirs).map((unit) => unit.key);
      if (units.length === 0) {
        funnel.noSharedFunction++;
        continue;
      }
      const summary = commitSummary(repoPath, sha);
      structural.push({
        id: `${repoName}@${sha.slice(0, 10)}`,
        repo: repoName,
        repoPath: path.resolve(repoPath),
        sha,
        date: summary.date,
        subject: summary.subject,
        base,
        left,
        right,
        units,
      });
    } finally {
      scenario.dispose();
    }
  }
  funnel.structural = structural.length;

  // Sample first, then compile-check lazily: compiling four versions is the expensive part.
  const requirement = options.requireCompile ?? 'all';
  const merges: MinedMerge[] = [];
  for (const candidate of shuffled(structural, options.seed ?? 1)) {
    if (options.limit !== undefined && merges.length >= options.limit) break;
    const compiles = checkCompiles(candidate, requirement);
    if (requirement !== 'none') funnel.compileChecked++;
    const required =
      requirement === 'all'
        ? compiles.base === true && compiles.left === true && compiles.right === true
        : requirement === 'base'
          ? compiles.base === true
          : true;
    if (!required) {
      funnel.failedCompile++;
      continue;
    }
    merges.push({ ...candidate, compiles });
  }
  funnel.selected = merges.length;
  return { merges, funnel };
}

function checkCompiles(
  candidate: Structural,
  requirement: CompileRequirement,
): MinedMerge['compiles'] {
  const unchecked = { base: null, left: null, right: null, merge: null };
  if (requirement === 'none') return unchecked;
  const scenario = materializeScenario(
    candidate.repoPath,
    {
      merge: candidate.sha,
      base: candidate.base,
      left: candidate.left,
      right: candidate.right,
      matchesAutomaticMerge: true,
    },
    { linkNodeModules: true },
  );
  try {
    const ok = (dir: string): boolean => compileDir(dir).length === 0;
    const base = ok(scenario.dirs.base);
    // Stop early when the requirement is already lost.
    if (requirement === 'base' || !base) return { ...unchecked, base };
    const left = ok(scenario.dirs.left);
    if (!left) return { ...unchecked, base, left };
    const right = ok(scenario.dirs.right);
    if (!right) return { ...unchecked, base, left, right };
    return { base, left, right, merge: ok(scenario.dirs.merge) };
  } finally {
    scenario.dispose();
  }
}
