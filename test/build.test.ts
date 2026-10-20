import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileDir, findBuildConflicts, mergeOnlyDiagnostics } from '../src/build/build.js';
import type { BuildDiagnostic } from '../src/build/build.js';
import { TSCONFIG } from './helpers/canonical.js';
import { cleanupTempDirs, makeTempDir, writeFiles } from './helpers/fixture-repo.js';

afterEach(cleanupTempDirs);

function project(files: Record<string, string>): string {
  const dir = makeTempDir();
  writeFiles(dir, { 'tsconfig.json': TSCONFIG, ...files });
  return dir;
}

const diag = (message: string, file = 'src/a.ts', code = 2345): BuildDiagnostic => ({
  file,
  code,
  message,
  line: 1,
  column: 1,
});

describe('compileDir', () => {
  it('returns no diagnostics for a valid project', () => {
    const dir = project({ 'src/a.ts': 'export const a: number = 1;\n' });
    expect(compileDir(dir)).toEqual([]);
  });

  it('reports type errors with relative paths and 1-based positions', () => {
    const dir = project({ 'src/a.ts': 'export const a: number = "x";\n' });
    const [diagnostic, ...rest] = compileDir(dir);
    expect(rest).toEqual([]);
    expect(diagnostic).toMatchObject({ file: 'src/a.ts', line: 1, column: 14, code: 2322 });
  });

  it('falls back to default strict options without a tsconfig', () => {
    const dir = makeTempDir();
    writeFiles(dir, { 'a.ts': 'export function f(x) { return x; }\n' });
    expect(compileDir(dir).map((d) => d.code)).toContain(7006); // implicit any
  });

  it('does not pick up a tsconfig from a parent directory', () => {
    const parent = makeTempDir();
    writeFiles(parent, { 'tsconfig.json': '{ this is not json' });
    const child = path.join(parent, 'child');
    writeFiles(child, { 'a.ts': 'export const a = 1;\n' });
    expect(compileDir(child)).toEqual([]);
  });
});

describe('mergeOnlyDiagnostics', () => {
  it('keeps only diagnostics that no other version has', () => {
    const shared = diag('shared');
    const fromLeft = diag('left only');
    const introduced = diag('merge only');
    const result = mergeOnlyDiagnostics({
      base: [shared],
      left: [shared, fromLeft],
      right: [shared],
      merge: [shared, fromLeft, introduced],
    });
    expect(result).toEqual([introduced]);
  });

  it('ignores position changes and reports extra occurrences', () => {
    const moved = { ...diag('same'), line: 40 };
    expect(
      mergeOnlyDiagnostics({
        base: [diag('same')],
        left: [diag('same')],
        right: [],
        merge: [moved],
      }),
    ).toEqual([]);
    expect(
      mergeOnlyDiagnostics({
        base: [diag('same')],
        left: [diag('same')],
        right: [],
        merge: [diag('same'), moved],
      }),
    ).toEqual([moved]);
  });
});

describe('findBuildConflicts', () => {
  it('reports a call that no longer matches a signature changed by the other side', () => {
    const base = {
      'src/lib.ts': 'export function area(w: number): number {\n  return w * w;\n}\n',
      'src/use.ts': "import { area } from './lib';\nexport const small = area(1);\n",
    };
    const left = {
      'src/lib.ts': 'export function area(w: number, h: number): number {\n  return w * h;\n}\n',
    };
    const right = {
      'src/use.ts':
        "import { area } from './lib';\nexport const small = area(1);\nexport const big = area(10);\n",
    };
    const dirs = {
      base: project(base),
      left: project({
        ...base,
        ...left,
        'src/use.ts': "import { area } from './lib';\nexport const small = area(1, 1);\n",
      }),
      right: project({ ...base, ...right }),
      merge: project({ ...base, ...left, ...right }),
    };
    const conflicts = findBuildConflicts(dirs);
    // Left fixed its own call site; after the merge both calls of Right's file break.
    expect(conflicts.map((c) => c.file)).toEqual(['src/use.ts', 'src/use.ts']);
    expect(conflicts.every((c) => c.code === 2554)).toBe(true);
  });

  it('reports nothing for a merge that compiles', () => {
    const files = { 'src/a.ts': 'export const a = 1;\n' };
    const dirs = {
      base: project(files),
      left: project(files),
      right: project(files),
      merge: project(files),
    };
    expect(findBuildConflicts(dirs)).toEqual([]);
  });
});
