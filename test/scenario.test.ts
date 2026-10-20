import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findUnitsChangedByBoth } from '../src/scenario/changed-units.js';
import { classifyMerge, scenarioFromDirs, scenarioFromGit } from '../src/scenario/scenario.js';
import { CANONICAL, buildMergeFixture, canonicalFixture } from './helpers/canonical.js';
import { FixtureRepo, cleanupTempDirs, makeTempDir, writeFiles } from './helpers/fixture-repo.js';

afterEach(cleanupTempDirs);

describe('scenarioFromGit', () => {
  it('materializes Base, Left, Right and Merge of a clean merge', () => {
    const fixture = canonicalFixture();
    const result = scenarioFromGit(fixture.repo.dir, fixture.merge);
    if (result.status !== 'ok') throw new Error('expected an ok scenario');
    try {
      const { dirs, commits } = result.scenario;
      const read = (dir: string): string => fs.readFileSync(path.join(dir, 'src/text.ts'), 'utf8');
      expect(read(dirs.base)).toBe(CANONICAL.base);
      expect(read(dirs.left)).toBe(CANONICAL.left);
      expect(read(dirs.right)).toBe(CANONICAL.right);
      expect(read(dirs.merge)).toBe(CANONICAL.merge);
      expect(commits).toMatchObject({
        merge: fixture.merge,
        base: fixture.base,
        left: fixture.left,
        right: fixture.right,
        matchesAutomaticMerge: true,
      });
    } finally {
      result.scenario.dispose();
    }
  });

  it('removes its temporary directories on dispose', () => {
    const fixture = canonicalFixture();
    const result = scenarioFromGit(fixture.repo.dir, fixture.merge);
    if (result.status !== 'ok') throw new Error('expected an ok scenario');
    const { dirs } = result.scenario;
    expect(fs.existsSync(dirs.merge)).toBe(true);
    result.scenario.dispose();
    expect(fs.existsSync(dirs.merge)).toBe(false);
  });

  it('does not touch the working tree or index of the repository', () => {
    const fixture = canonicalFixture();
    const before = fixture.repo.git('status', '--porcelain');
    const result = scenarioFromGit(fixture.repo.dir, fixture.merge);
    if (result.status === 'ok') result.scenario.dispose();
    expect(fixture.repo.git('status', '--porcelain')).toBe(before);
  });
});

describe('classifyMerge', () => {
  it('discards a commit that is not a merge', () => {
    const repo = new FixtureRepo();
    const sha = repo.commit('only', { 'a.ts': 'export const a = 1;\n' });
    expect(classifyMerge(repo.dir, sha)).toEqual({ status: 'discarded', reason: 'not-a-merge' });
  });

  it('discards a fast-forward style merge', () => {
    const repo = new FixtureRepo();
    repo.commit('base', { 'a.ts': 'export const a = 1;\n' });
    repo.branch('feature');
    repo.commit('work', { 'a.ts': 'export const a = 2;\n' });
    repo.checkout('main');
    const merge = repo.merge('feature');
    expect(classifyMerge(repo.dir, merge)).toEqual({ status: 'discarded', reason: 'fast-forward' });
  });

  it('discards a merge whose parents conflict textually', () => {
    const repo = new FixtureRepo();
    repo.commit('base', { 'a.ts': 'export const a = 1;\n' });
    repo.branch('feature');
    repo.commit('right', { 'a.ts': 'export const a = 2;\n' });
    repo.checkout('main');
    repo.commit('left', { 'a.ts': 'export const a = 3;\n' });
    const merge = repo.mergeWithConflict('feature', { 'a.ts': 'export const a = 4;\n' });
    expect(classifyMerge(repo.dir, merge)).toEqual({
      status: 'discarded',
      reason: 'textual-conflict',
    });
  });

  it('discards a criss-cross merge', () => {
    const repo = new FixtureRepo();
    repo.commit('base', { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    repo.branch('x');
    const x1 = repo.commit('x1', { 'a.ts': 'export const a = 2;\n' });
    repo.checkout('main');
    repo.branch('y');
    const y1 = repo.commit('y1', { 'b.ts': 'export const b = 2;\n' });
    // Cross-merge the two tips so the final merge has two equally good merge bases.
    repo.checkout('x');
    repo.merge(y1, 'x <- y1');
    repo.checkout('y');
    repo.merge(x1, 'y <- x1');
    repo.checkout('x');
    repo.commit('x2', { 'a.ts': 'export const a = 3;\n' });
    repo.checkout('y');
    repo.commit('y2', { 'b.ts': 'export const b = 3;\n' });
    repo.checkout('x');
    const merge = repo.merge('y', 'final');
    expect(classifyMerge(repo.dir, merge)).toEqual({ status: 'discarded', reason: 'criss-cross' });
  });
});

describe('findUnitsChangedByBoth', () => {
  it('lists only functions changed by both sides', () => {
    const fixture = canonicalFixture();
    const result = scenarioFromGit(fixture.repo.dir, fixture.merge);
    if (result.status !== 'ok') throw new Error('expected an ok scenario');
    try {
      const units = findUnitsChangedByBoth(result.scenario.dirs);
      expect(units.map((u) => u.key)).toEqual(['src/text.ts#Text.generateReport']);
      expect(units[0]).toMatchObject({ line: 5, endLine: 9 });
    } finally {
      result.scenario.dispose();
    }
  });

  it('ignores functions changed by a single side', () => {
    const base =
      'export function a() { return 1; }\n\nexport const keep = 0;\n\nexport function b() { return 1; }\n';
    const fixture = buildMergeFixture({
      base: { 'src/m.ts': base },
      left: {
        'src/m.ts': base.replace('function a() { return 1; }', 'function a() { return 2; }'),
      },
      right: {
        'src/m.ts': base.replace('function b() { return 1; }', 'function b() { return 3; }'),
      },
    });
    const result = scenarioFromGit(fixture.repo.dir, fixture.merge);
    if (result.status !== 'ok') throw new Error('expected an ok scenario');
    try {
      expect(findUnitsChangedByBoth(result.scenario.dirs)).toEqual([]);
    } finally {
      result.scenario.dispose();
    }
  });
});

describe('scenarioFromDirs', () => {
  it('uses existing directories and leaves them alone on dispose', () => {
    const root = makeTempDir();
    const dirs = {
      base: path.join(root, 'b'),
      left: path.join(root, 'l'),
      right: path.join(root, 'r'),
      merge: path.join(root, 'm'),
    };
    for (const dir of Object.values(dirs)) writeFiles(dir, { 'a.ts': 'export {};\n' });
    const scenario = scenarioFromDirs(dirs);
    scenario.dispose();
    expect(fs.existsSync(dirs.merge)).toBe(true);
  });

  it('fails when a directory is missing', () => {
    const root = makeTempDir();
    const missing = path.join(root, 'nope');
    expect(() =>
      scenarioFromDirs({ base: missing, left: missing, right: missing, merge: missing }),
    ).toThrow(/not found/);
  });
});
