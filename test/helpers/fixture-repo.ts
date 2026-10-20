import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoots: string[] = [];

export function makeTempDir(prefix = 'tsmergelens-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Writes `files` (relative path -> content) under `root`, creating directories as needed. */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** A throwaway git repository driven programmatically by the tests. */
export class FixtureRepo {
  readonly dir = makeTempDir('tsmergelens-repo-');

  constructor() {
    this.git('init', '--quiet', '--initial-branch=main');
    this.git('config', 'user.name', 'Test');
    this.git('config', 'user.email', 'test@example.com');
    this.git('config', 'commit.gpgsign', 'false');
    this.git('config', 'core.autocrlf', 'false');
  }

  git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: this.dir, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}${result.stdout}`);
    }
    return result.stdout.trim();
  }

  /** Overwrites the given files, stages everything and commits. Returns the commit sha. */
  commit(message: string, files: Record<string, string> = {}): string {
    writeFiles(this.dir, files);
    this.git('add', '--all');
    this.git('commit', '--quiet', '--allow-empty', '-m', message);
    return this.head();
  }

  head(): string {
    return this.git('rev-parse', 'HEAD');
  }

  branch(name: string, from = 'HEAD'): void {
    this.git('checkout', '--quiet', '-b', name, from);
  }

  checkout(name: string): void {
    this.git('checkout', '--quiet', name);
  }

  /** Non-fast-forward merge commit; throws if git reports a conflict. */
  merge(branch: string, message = `merge ${branch}`): string {
    this.git('merge', '--quiet', '--no-ff', '-m', message, branch);
    return this.head();
  }

  /** Attempts a merge expected to conflict, then resolves it by writing `resolution`. */
  mergeWithConflict(branch: string, resolution: Record<string, string>): string {
    const result = spawnSync('git', ['merge', '--no-ff', '-m', `merge ${branch}`, branch], {
      cwd: this.dir,
      encoding: 'utf8',
    });
    if (result.status === 0) throw new Error('expected a merge conflict');
    writeFiles(this.dir, resolution);
    this.git('add', '--all');
    this.git('commit', '--quiet', '--no-edit');
    return this.head();
  }
}
