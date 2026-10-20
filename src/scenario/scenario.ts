import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { automaticMerge, exportTree, mergeBases, parentsOf, resolveCommit, treeOf } from './git.js';

export interface ScenarioDirs {
  base: string;
  left: string;
  right: string;
  merge: string;
}

export interface MergeCommits {
  merge: string;
  base: string;
  /** First parent: the branch the merge was made on. */
  left: string;
  /** Second parent: the branch that was merged in. */
  right: string;
  /** False when the recorded merge differs from what git computes automatically. */
  matchesAutomaticMerge: boolean;
}

export interface Scenario {
  dirs: ScenarioDirs;
  commits?: MergeCommits;
  /** Removes the temporary directories created for this scenario. */
  dispose(): void;
}

export type DiscardReason =
  | 'not-a-merge'
  | 'octopus'
  | 'no-common-ancestor'
  | 'fast-forward'
  | 'criss-cross'
  | 'textual-conflict';

export const DISCARD_MESSAGES: Record<DiscardReason, string> = {
  'not-a-merge': 'the commit has fewer than two parents',
  octopus: 'the merge has more than two parents',
  'no-common-ancestor': 'the parents share no common ancestor',
  'fast-forward': 'one parent is an ancestor of the other (fast-forward)',
  'criss-cross': 'the parents have more than one merge base (criss-cross merge)',
  'textual-conflict': 'git cannot merge the parents without a textual conflict',
};

export type ClassifiedMerge =
  { status: 'candidate'; commits: MergeCommits } | { status: 'discarded'; reason: DiscardReason };

/** Cheap, checkout-free test of whether a merge commit is a valid experimental scenario. */
export function classifyMerge(repo: string, rev: string): ClassifiedMerge {
  const merge = resolveCommit(repo, rev);
  const parents = parentsOf(repo, merge);
  if (parents.length < 2) return { status: 'discarded', reason: 'not-a-merge' };
  const [left, right] = parents;
  if (parents.length > 2 || left === undefined || right === undefined) {
    return { status: 'discarded', reason: 'octopus' };
  }
  const bases = mergeBases(repo, left, right);
  const [base] = bases;
  if (base === undefined) return { status: 'discarded', reason: 'no-common-ancestor' };
  if (bases.length > 1) return { status: 'discarded', reason: 'criss-cross' };
  if (base === left || base === right) return { status: 'discarded', reason: 'fast-forward' };
  const automatic = automaticMerge(repo, left, right);
  if (!automatic.clean) return { status: 'discarded', reason: 'textual-conflict' };
  return {
    status: 'candidate',
    commits: {
      merge,
      base,
      left,
      right,
      matchesAutomaticMerge: automatic.tree === treeOf(repo, merge),
    },
  };
}

export interface MaterializeOptions {
  /**
   * Make the `node_modules` of the repository's working tree visible in each checkout (a link, not
   * a copy), so the project can be type-checked with its dependencies. They are those installed
   * for the repository's current state, which may differ from the ones the commit used.
   */
  linkNodeModules?: boolean;
}

/** Removes a link without ever touching what it points to. */
function removeLink(link: string): void {
  if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link); // Windows junctions are removed as directories
  }
}

/** Checks out Base, Left, Right and Merge into fresh temporary directories. */
export function materializeScenario(
  repo: string,
  commits: MergeCommits,
  options: MaterializeOptions = {},
): Scenario {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmergelens-'));
  const dirs: ScenarioDirs = {
    base: path.join(root, 'base'),
    left: path.join(root, 'left'),
    right: path.join(root, 'right'),
    merge: path.join(root, 'merge'),
  };
  const links: string[] = [];
  const dispose = (): void => {
    // Links first: a recursive delete must never be able to reach the linked directory.
    for (const link of links) removeLink(link);
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    exportTree(repo, commits.base, dirs.base);
    exportTree(repo, commits.left, dirs.left);
    exportTree(repo, commits.right, dirs.right);
    exportTree(repo, commits.merge, dirs.merge);
    const modules = path.join(repo, 'node_modules');
    if (options.linkNodeModules && fs.existsSync(modules)) {
      for (const dir of [dirs.base, dirs.left, dirs.right, dirs.merge]) {
        const link = path.join(dir, 'node_modules');
        if (fs.existsSync(link)) continue; // the commit tracks its own
        fs.symlinkSync(path.resolve(modules), link, 'junction');
        links.push(link);
      }
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { dirs, commits, dispose };
}

export type ScenarioResult =
  { status: 'ok'; scenario: Scenario } | { status: 'discarded'; reason: DiscardReason };

export function scenarioFromGit(repo: string, mergeRev: string): ScenarioResult {
  const classified = classifyMerge(repo, mergeRev);
  if (classified.status === 'discarded') return classified;
  return { status: 'ok', scenario: materializeScenario(repo, classified.commits) };
}

/** Directory mode: the four versions already exist on disk and are left untouched. */
export function scenarioFromDirs(dirs: ScenarioDirs): Scenario {
  const resolved = {
    base: path.resolve(dirs.base),
    left: path.resolve(dirs.left),
    right: path.resolve(dirs.right),
    merge: path.resolve(dirs.merge),
  };
  for (const [name, dir] of Object.entries(resolved)) {
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${name} directory not found: ${dir}`);
    }
  }
  return {
    dirs: resolved,
    dispose: () => {
      // nothing to clean: the directories belong to the caller
    },
  };
}
