import { afterEach, describe, expect, it } from 'vitest';
import { classifyFile, classifySide } from '../src/filter/refactoring/classify.js';
import { applyRefactoringFilter } from '../src/filter/refactoring/filter.js';
import { candidate, rank, reRank } from '../src/rank/rank.js';
import type { Candidate } from '../src/rank/rank.js';
import type { Alert } from '../src/report/types.js';
import { cleanupTempDirs, makeTempDir, writeFiles } from './helpers/fixture-repo.js';

afterEach(cleanupTempDirs);

const kinds = (base: string, side: string): string[] | 'real change' => {
  const verdict = classifyFile('a.ts', base, side);
  return verdict.structural ? [...verdict.kinds].sort() : 'real change';
};

describe('classifyFile', () => {
  it('recognises formatting-only changes, including redundant parentheses', () => {
    expect(
      kinds(
        'const a=1;\nfunction f(){return a}',
        'const a = 1; // one\nfunction f() {\n  return (a);\n}\n',
      ),
    ).toEqual(['format']);
  });

  it('recognises the renaming of locals and parameters', () => {
    const base = 'function f(n: number) { const t = n * 2; return t; }';
    const side = 'function f(count: number) { const doubled = count * 2; return doubled; }';
    expect(kinds(base, side)).toEqual(['rename']);
  });

  it('recognises the renaming of a function together with its call sites', () => {
    const base = 'function inc(n: number) { return n + 1; }\nfunction run() { return inc(1); }';
    const side = 'function next(n: number) { return n + 1; }\nfunction run() { return next(1); }';
    expect(kinds(base, side)).toContain('rename');
  });

  it('recognises extracting statements into a function, with parameters, and its inverse', () => {
    const inline = 'function run(o: { v: number }) { o.v = 1 + 2; o.v += 1; }';
    const extracted =
      'function run(o: { v: number }) { set(o, 1 + 2); o.v += 1; }\nfunction set(t: { v: number }, n: number) { t.v = n; }';
    expect(kinds(inline, extracted)).toEqual(['extract-function']);
    expect(kinds(extracted, inline)).toEqual(['inline-function']);
  });

  it('recognises extracting an expression into a variable, and its inverse', () => {
    const inline = 'function f(a: number, b: number) { return Math.max(a + b, a - b); }';
    const extracted =
      'function f(a: number, b: number) { const sum = a + b; return Math.max(sum, a - b); }';
    expect(kinds(inline, extracted)).toEqual(['extract-variable']);
    expect(kinds(extracted, inline)).toEqual(['inline-variable']);
  });

  it('does not take an unused or different constant for an extraction', () => {
    const base = 'function f(a: number) { return a; }';
    expect(kinds(base, 'function f(a: number) { const unused = a + 1; return a; }')).toBe(
      'real change',
    );
    expect(kinds(base, 'function f(a: number) { const t = a + 1; return t; }')).toBe('real change');
  });

  it('treats every behavioural change as real', () => {
    const base = 'function f(a: number) { return a + 1; }';
    expect(kinds(base, 'function f(a: number) { return a - 1; }')).toBe('real change');
    expect(kinds(base, 'function f(a: number) { return a + 1; }\nfunction g() { return 1; }')).toBe(
      'real change',
    );
    expect(kinds(base, 'function f(a: number) { return a + 1; }\nconst top = 1;')).toBe(
      'real change',
    );
    expect(kinds(base, 'function f(a: number) { return a++ + 1; }')).toBe('real change');
  });

  it('treats changes outside function bodies as real', () => {
    const base = 'class A { v = 0; run() { return this.v; } }';
    expect(kinds(base, 'class A { v = 1; run() { return this.v; } }')).toBe('real change');
    expect(kinds(base, 'class A { v = 0; w = 0; run() { return this.v; } }')).toBe('real change');
  });
});

describe('classifySide', () => {
  it('is structural only when every changed file is', () => {
    const base = makeTempDir();
    const side = makeTempDir();
    writeFiles(base, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' });
    writeFiles(side, {
      'a.ts': 'export const a = 1; // comment\n',
      'b.ts': 'export const b = 2;\n',
    });
    expect(classifySide(base, side)).toMatchObject({ structural: true, changedFiles: 1 });

    writeFiles(side, { 'b.ts': 'export const b = 3;\n' });
    expect(classifySide(base, side)).toMatchObject({ structural: false, changedFiles: 2 });
  });

  it('counts a new or deleted file as a real change, and no change as not structural', () => {
    const base = makeTempDir();
    const side = makeTempDir();
    writeFiles(base, { 'a.ts': 'export const a = 1;\n' });
    writeFiles(side, { 'a.ts': 'export const a = 1;\n' });
    expect(classifySide(base, side)).toMatchObject({ structural: false, changedFiles: 0 });
    writeFiles(side, { 'new.ts': 'export const n = 1;\n' });
    expect(classifySide(base, side)).toMatchObject({ structural: false, changedFiles: 1 });
  });
});

const alert = (branches: Array<'Left' | 'Right' | 'Merge'>): Alert => ({
  type: 'OA',
  confidence: 'medium',
  locations: branches.map((branch) => ({ file: 'a.ts', line: 1, column: 1, branch })),
  explanation: { pt: '', en: '' },
});
const asCandidate = (branches: Array<'Left' | 'Right' | 'Merge'>): Candidate =>
  candidate(alert(branches), { uncertainTypes: false, refactoringSuspected: false });

describe('applyRefactoringFilter', () => {
  const left = { structural: true, kinds: ['rename' as const], changedFiles: 1 };
  const none = { structural: false, kinds: [], changedFiles: 1 };
  const items = [
    asCandidate(['Left', 'Right']),
    asCandidate(['Right', 'Right']),
    asCandidate(['Merge']),
  ];

  it('does nothing when off, and never touches alerts without a Left/Right location', () => {
    expect(applyRefactoringFilter(items, { left, right: none }, 'off').kept).toHaveLength(3);
    const suppressed = applyRefactoringFilter(items, { left, right: none }, 'suppress');
    expect(suppressed).toMatchObject({ suppressed: 1, downgraded: 0 });
    expect(suppressed.kept).toHaveLength(2);
  });

  it('downgrades to low confidence instead of removing', () => {
    const result = applyRefactoringFilter(items, { left, right: none }, 'downgrade');
    expect(result).toMatchObject({ suppressed: 0, downgraded: 1 });
    expect(result.kept.map((item) => item.alert.confidence)).toEqual(['low', 'medium', 'medium']);
  });

  it('applies to either side', () => {
    const result = applyRefactoringFilter(items, { left: none, right: left }, 'suppress');
    expect(result.suppressed).toBe(2);
  });
});

describe('rank', () => {
  it('orders confidence: confirmed > typed > uncertain or refactoring', () => {
    const base = { uncertainTypes: false, refactoringSuspected: false };
    expect(rank(base)).toBe('medium');
    expect(rank({ ...base, dynamicallyConfirmed: true })).toBe('high');
    expect(rank({ ...base, uncertainTypes: true })).toBe('low');
    expect(rank({ ...base, refactoringSuspected: true })).toBe('low');
    expect(rank({ ...base, uncertainTypes: true, dynamicallyConfirmed: true })).toBe('low');
  });

  it('re-ranks a candidate when new evidence arrives', () => {
    const item = asCandidate(['Left', 'Right']);
    expect(reRank(item, { refactoringSuspected: true }).alert.confidence).toBe('low');
    expect(item.alert.confidence).toBe('medium');
  });
});
