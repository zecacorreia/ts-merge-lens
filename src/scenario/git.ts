import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toPosix } from '../util/files.js';

export class GitError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runGit(repo: string, args: string[], env: Record<string, string> = {}): GitResult {
  const result = spawnSync('git', args, {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw new GitError(`cannot run git: ${result.error.message}`, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs git and returns stdout; any non-zero exit is an error. */
export function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  const result = runGit(repo, args, env);
  if (result.status !== 0) {
    throw new GitError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`, result.status);
  }
  return result.stdout;
}

export function resolveCommit(repo: string, rev: string): string {
  return git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim();
}

export function parentsOf(repo: string, commit: string): string[] {
  const [, ...parents] = git(repo, ['rev-list', '--parents', '-n', '1', commit]).trim().split(' ');
  return parents;
}

/** All best common ancestors; more than one means a criss-cross merge. */
export function mergeBases(repo: string, a: string, b: string): string[] {
  const result = runGit(repo, ['merge-base', '--all', a, b]);
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new GitError(`git merge-base failed: ${result.stderr.trim()}`, result.status);
  }
  return result.stdout.split('\n').filter((line) => line !== '');
}

export type AutomaticMerge = { clean: true; tree: string } | { clean: false };

/** Replays the merge of two commits in memory (needs git >= 2.38). */
export function automaticMerge(repo: string, left: string, right: string): AutomaticMerge {
  const result = runGit(repo, ['merge-tree', '--write-tree', '--no-messages', left, right]);
  if (result.status === 0) return { clean: true, tree: result.stdout.split('\n')[0] ?? '' };
  if (result.status === 1) return { clean: false };
  throw new GitError(
    `git merge-tree failed (git >= 2.38 is required): ${result.stderr.trim()}`,
    result.status,
  );
}

export function treeOf(repo: string, commit: string): string {
  return git(repo, ['rev-parse', `${commit}^{tree}`]).trim();
}

/** Writes the tree of `commit` into `dir` without touching the repository's index or worktree. */
export function exportTree(repo: string, commit: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmergelens-index-'));
  const env = { GIT_INDEX_FILE: path.join(indexDir, 'index') };
  try {
    git(repo, ['read-tree', commit], env);
    git(repo, ['checkout-index', '--all', '--force', `--prefix=${toPosix(dir)}/`], env);
  } finally {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}

export function changedPaths(repo: string, from: string, to: string): string[] {
  return git(repo, ['diff', '--name-only', '-z', from, to])
    .split('\0')
    .filter((p) => p !== '');
}

export function listMergeCommits(repo: string, since?: string): string[] {
  const args = ['rev-list', '--merges'];
  if (since !== undefined) args.push(`--since=${since}`);
  args.push('HEAD');
  return git(repo, args)
    .split('\n')
    .filter((line) => line !== '');
}

export interface CommitSummary {
  sha: string;
  date: string;
  subject: string;
}

export function commitSummary(repo: string, commit: string): CommitSummary {
  const [sha = commit, date = '', subject = ''] = git(repo, [
    'show',
    '-s',
    '--format=%H%x00%cI%x00%s',
    commit,
  ])
    .trim()
    .split('\0');
  return { sha, date, subject };
}
