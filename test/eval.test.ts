import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCsv, stringifyCsv } from '../src/eval/csv.js';
import { cohenKappa, median, resolveLabels, score } from '../src/eval/metrics.js';
import { mineRepo, shuffled } from '../src/eval/mine.js';
import { evaluate, renderMarkdown } from '../src/eval/report.js';
import { runEvaluation } from '../src/eval/runner.js';
import type { RunFile } from '../src/eval/runner.js';
import { SHEET_COLUMNS, buildSheet } from '../src/eval/sheet.js';
import { evalMain } from '../src/eval/cli.js';
import { analyze } from '../src/pipeline.js';
import { TSCONFIG, buildMergeFixture, canonicalFixture } from './helpers/canonical.js';
import { cleanupTempDirs, makeTempDir } from './helpers/fixture-repo.js';
import { loadOracle } from './helpers/oracle.js';

afterEach(cleanupTempDirs);

describe('csv', () => {
  it('round-trips quotes, commas, newlines and empty cells', () => {
    const rows = [{ a: 'x,y', b: 'say "hi"', c: 'line1\nline2', d: '' }];
    const text = stringifyCsv(['a', 'b', 'c', 'd'], rows);
    expect(parseCsv(text)).toEqual(rows);
  });

  it('tolerates a BOM, CRLF and blank lines', () => {
    expect(parseCsv('﻿id,v\r\n1,a\r\n\r\n2,b')).toEqual([
      { id: '1', v: 'a' },
      { id: '2', v: 'b' },
    ]);
  });
});

describe('metrics', () => {
  it('computes the confusion matrix and derived scores', () => {
    const scores = score([
      { truth: 'interference', predicted: true },
      { truth: 'interference', predicted: true },
      { truth: 'interference', predicted: false },
      { truth: 'clean', predicted: true },
      { truth: 'clean', predicted: false },
      { truth: 'clean', predicted: false },
    ]);
    expect(scores).toMatchObject({ tp: 2, fn: 1, fp: 1, tn: 2, total: 6 });
    expect(scores.precision).toBeCloseTo(2 / 3);
    expect(scores.recall).toBeCloseTo(2 / 3);
    expect(scores.f1).toBeCloseTo(2 / 3);
    expect(scores.accuracy).toBeCloseTo(4 / 6);
  });

  it('reports undefined ratios as null instead of inventing a value', () => {
    const neverPositive = score([{ truth: 'clean', predicted: false }]);
    expect(neverPositive).toMatchObject({ precision: null, recall: null, f1: null, accuracy: 1 });
    expect(score([])).toMatchObject({ precision: null, accuracy: null });
  });

  it('takes the median', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('resolves labels: agreement, consensus, disagreement and missing', () => {
    const labels = resolveLabels([
      { id: 'a', reviewer1: '1', reviewer2: '1', consensus: '' },
      { id: 'b', reviewer1: '1', reviewer2: '0', consensus: '' },
      { id: 'c', reviewer1: '1', reviewer2: '0', consensus: '0' },
      { id: 'd', reviewer1: '1', reviewer2: '', consensus: '' },
    ]);
    expect(labels.map((l) => [l.status, l.truth])).toEqual([
      ['agreed', 'interference'],
      ['needs-consensus', undefined],
      ['consensus', 'clean'],
      ['unlabeled', undefined],
    ]);
    expect(() => resolveLabels([{ id: 'x', reviewer1: 'maybe' }])).toThrow(/labels must be/);
  });

  it("computes Cohen's kappa", () => {
    const row = (a: string, b: string) => ({ id: a + b, reviewer1: a, reviewer2: b });
    expect(cohenKappa([row('1', '1'), row('0', '0'), row('1', '1'), row('0', '0')])).toBe(1);
    // 3 of 4 agree; each reviewer says 1 half of the time: kappa = (0.75 - 0.5) / 0.5
    expect(cohenKappa([row('1', '1'), row('0', '0'), row('1', '0'), row('0', '1')])).toBeCloseTo(0);
    expect(cohenKappa([row('1', '1'), row('0', '0'), row('1', '1'), row('0', '1')])).toBeCloseTo(
      0.5,
    );
    expect(cohenKappa([])).toBeNull();
  });
});

describe('mining', () => {
  it('selects a clean merge where both sides changed the same function', () => {
    const fixture = canonicalFixture();
    const { merges, funnel } = mineRepo({ repoPath: fixture.repo.dir, repoName: 'canon' });
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      id: `canon@${fixture.merge.slice(0, 10)}`,
      sha: fixture.merge,
      base: fixture.base,
      units: ['src/text.ts#Text.generateReport'],
      compiles: { base: true, left: true, right: true, merge: true },
    });
    expect(funnel).toMatchObject({
      mergeCommits: 1,
      structural: 1,
      compileChecked: 1,
      selected: 1,
    });
  });

  it('counts every reason a merge is left out', () => {
    // Different functions of one file.
    const same =
      'export function a() { return 1; }\n\nexport const k = 0;\n\nexport function b() { return 1; }\n';
    const differentFunctions = buildMergeFixture({
      base: { 'tsconfig.json': TSCONFIG, 'src/m.ts': same },
      left: {
        'src/m.ts': same.replace('function a() { return 1; }', 'function a() { return 2; }'),
      },
      right: {
        'src/m.ts': same.replace('function b() { return 1; }', 'function b() { return 3; }'),
      },
    });
    expect(mineRepo({ repoPath: differentFunctions.repo.dir }).funnel).toMatchObject({
      mergeCommits: 1,
      noSharedFunction: 1,
      selected: 0,
    });

    // Different files.
    const differentFiles = buildMergeFixture({
      base: {
        'tsconfig.json': TSCONFIG,
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': 'export const b = 1;\n',
      },
      left: { 'src/a.ts': 'export const a = 2;\n' },
      right: { 'src/b.ts': 'export const b = 2;\n' },
    });
    expect(mineRepo({ repoPath: differentFiles.repo.dir }).funnel).toMatchObject({
      noSharedSourceFile: 1,
      selected: 0,
    });
  });

  it('drops scenarios that do not compile, unless compilation is not required', () => {
    const base =
      'export function run(): number {\n  let x = 0;\n\n  const a = 1;\n\n  const b = 2;\n\n  return x + a + b + 0;\n}\n';
    const fixture = buildMergeFixture({
      base: { 'tsconfig.json': TSCONFIG, 'src/main.ts': base },
      left: { 'src/main.ts': base.replace('let x = 0;', 'let x = 0;\n  x = 1;') },
      right: { 'src/main.ts': base.replace('return x', 'x = 2;\n  return x') },
    });
    expect(mineRepo({ repoPath: fixture.repo.dir }).merges).toHaveLength(1);

    // Base itself does not compile (a string assigned to a number).
    const bad = [
      'export function run(): number {',
      '  const a: number = "x";',
      '',
      '  const k = 1;',
      '',
      '  const b = 2;',
      '  return a + k + b;',
      '}',
      '',
    ].join('\n');
    const uncompilable = buildMergeFixture({
      base: { 'tsconfig.json': TSCONFIG, 'src/main.ts': bad },
      left: { 'src/main.ts': bad.replace('"x"', '"y"') },
      right: { 'src/main.ts': bad.replace('const b = 2;', 'const b = 3;') },
    });
    const strict = mineRepo({ repoPath: uncompilable.repo.dir });
    expect(strict.merges).toHaveLength(0);
    expect(strict.funnel).toMatchObject({ structural: 1, failedCompile: 1 });
    expect(
      mineRepo({ repoPath: uncompilable.repo.dir, requireCompile: 'none' }).merges,
    ).toHaveLength(1);
  });

  it('samples deterministically', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffled(items, 7)).toEqual(shuffled(items, 7));
    expect(shuffled(items, 7)).not.toEqual(shuffled(items, 8));
    expect([...shuffled(items, 7)].sort((a, b) => a - b)).toEqual(items);
  });
});

describe('sheet', () => {
  it('has the reviewers columns empty and no tool output', () => {
    const fixture = canonicalFixture();
    const { merges } = mineRepo({ repoPath: fixture.repo.dir, repoName: 'canon' });
    const rows = parseCsv(buildSheet(merges));
    expect(Object.keys(rows[0] ?? {})).toEqual([...SHEET_COLUMNS]);
    expect(rows[0]).toMatchObject({
      reviewer1: '',
      reviewer2: '',
      consensus: '',
      merge_sha: fixture.merge,
    });
    expect(JSON.stringify(rows)).not.toMatch(/alert|OA|DF|CF/);
  });

  it('keeps the labels already written when updated', () => {
    const fixture = canonicalFixture();
    const { merges } = mineRepo({ repoPath: fixture.repo.dir, repoName: 'canon' });
    const labelled = parseCsv(buildSheet(merges)).map((row) => ({
      ...row,
      reviewer1: '1',
      reviewer2: '0',
      consensus: '1',
      notes: 'discussed',
    }));
    const existing = stringifyCsv(SHEET_COLUMNS, labelled);
    const extra = {
      ...(merges[0] as (typeof merges)[number]),
      id: 'canon@new',
      sha: 'f'.repeat(40),
    };
    const updated = parseCsv(buildSheet([...merges, extra], existing));
    expect(updated).toHaveLength(2);
    expect(updated[0]).toMatchObject({
      reviewer1: '1',
      reviewer2: '0',
      consensus: '1',
      notes: 'discussed',
    });
    expect(updated[1]).toMatchObject({ id: 'canon@new', reviewer1: '' });
  });
});

describe('running the configurations', () => {
  it('records alerts, repeated times and the median for each configuration', () => {
    const fixture = canonicalFixture();
    const { merges } = mineRepo({ repoPath: fixture.repo.dir, repoName: 'canon' });
    const run = runEvaluation({ merges, configs: ['B0', 'B1', 'B2', 'B3'], repetitions: 3 });
    expect(run.repetitions).toBe(3);
    const byConfig = new Map(run.records.map((r) => [r.config, r]));
    expect(byConfig.get('B0')?.alerts).toEqual([]);
    expect(byConfig.get('B1')?.alerts).toEqual([]); // the canonical merge compiles
    expect(byConfig.get('B2')?.alerts.map((a) => a.type)).toEqual(['OA']);
    expect(byConfig.get('B3')?.alerts.map((a) => a.type)).toEqual(['OA']);
    for (const record of run.records) {
      expect(record.runsMs).toHaveLength(3);
      expect(record.error).toBeUndefined();
      expect(record.medianMs).toBe([...record.runsMs].sort((a, b) => a - b)[1]);
    }
  });

  it('records a failure as an error, not as a prediction', () => {
    const fixture = canonicalFixture();
    const { merges } = mineRepo({ repoPath: fixture.repo.dir, repoName: 'canon' });
    const [merge] = merges;
    if (!merge) throw new Error('no merge');
    const run = runEvaluation({
      merges: [{ ...merge, repoPath: path.join(makeTempDir(), 'gone') }],
      configs: ['B0'],
      repetitions: 1,
    });
    expect(run.records).toHaveLength(1);
    expect(run.records[0]?.error).toBeDefined();
    expect(run.records[0]?.medianMs).toBeNull();
  });
});

describe('typeless baseline (B2) versus complete analysis', () => {
  it('confuses same-named variables of different scopes, which types tell apart', () => {
    const file = path.join(makeTempDir(), 'shadow.oracle');
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'oracles/negative/07-shadowed-variable.oracle'),
      'utf8',
    );
    fs.writeFileSync(file, source);
    const { dirs } = loadOracle(file);
    const run = (identity: 'symbol' | 'name') =>
      analyze({ source: { kind: 'dirs', dirs }, depth: 5, analyses: ['oa'], identity }).alerts;
    expect(run('symbol')).toHaveLength(0);
    expect(run('name')).toHaveLength(1);
  });
});

describe('evaluation report', () => {
  const sheetRows = [
    { id: 's1', reviewer1: '1', reviewer2: '1', consensus: '' },
    { id: 's2', reviewer1: '0', reviewer2: '0', consensus: '' },
    { id: 's3', reviewer1: '1', reviewer2: '0', consensus: '' },
    { id: 's4', reviewer1: '', reviewer2: '', consensus: '' },
    { id: 's5', reviewer1: '1', reviewer2: '0', consensus: '1' },
  ];
  const record = (
    id: string,
    alerts: Array<'low' | 'medium'>,
    medianMs: number,
    error?: string,
  ) => ({
    id,
    config: 'B3' as const,
    alerts: alerts.map((confidence) => ({ type: 'OA', confidence })),
    runsMs: [medianMs],
    medianMs,
    ...(error ? { error } : {}),
  });
  const results: RunFile = {
    generatedAt: '',
    tool: 'test',
    node: process.version,
    repetitions: 1,
    configs: ['B3'],
    records: [
      record('s1', ['medium'], 10),
      record('s2', ['low'], 30),
      record('s3', ['medium'], 99),
      record('s5', [], 20),
    ],
  };

  it('scores only scenarios with an agreed or consensus label', () => {
    const evaluation = evaluate(sheetRows, results);
    expect(evaluation.scenarios).toMatchObject({ labelled: 3, needConsensus: 1, unlabeled: 1 });
    // s1 TP, s2 FP (a low-confidence alert counts when min confidence is low), s5 FN.
    expect(evaluation.configs[0]).toMatchObject({ tp: 1, fp: 1, tn: 0, fn: 1, total: 3 });
    expect(evaluation.configs[0]?.medianMs).toBe(20);
  });

  it('can ignore low-confidence alerts', () => {
    const evaluation = evaluate(sheetRows, results, 'medium');
    expect(evaluation.configs[0]).toMatchObject({ tp: 1, fp: 0, tn: 1, fn: 1 });
  });

  it('excludes failed runs and says so', () => {
    const failed: RunFile = {
      ...results,
      records: [record('s1', [], 1, 'boom'), ...results.records.slice(1)],
    };
    const evaluation = evaluate(sheetRows, failed);
    expect(evaluation.configs[0]?.errors).toBe(1);
    expect(evaluation.configs[0]?.total).toBe(2);
    expect(renderMarkdown(evaluation)).toContain('| B3 |');
  });
});

describe('eval command line', () => {
  it('mines, makes a sheet, refuses to overwrite it, runs and computes metrics', () => {
    const fixture = canonicalFixture();
    const dir = makeTempDir();
    const out = (name: string): string => path.join(dir, name);
    const lines: string[] = [];
    const log = (line: string): void => {
      lines.push(line);
    };

    evalMain(['mine', '--repo', fixture.repo.dir, '--out', out('c.json')], log);
    evalMain(['sheet', '--candidates', out('c.json'), '--out', out('labels.csv')], log);
    expect(() => {
      evalMain(['sheet', '--candidates', out('c.json'), '--out', out('labels.csv')], log);
    }).toThrow(/exists/);

    // Reviewers label the only scenario as an interference.
    const rows = parseCsv(fs.readFileSync(out('labels.csv'), 'utf8')).map((row) => ({
      ...row,
      reviewer1: '1',
      reviewer2: '1',
    }));
    fs.writeFileSync(out('labels.csv'), stringifyCsv(SHEET_COLUMNS, rows));

    evalMain(
      [
        'run',
        '--candidates',
        out('c.json'),
        '--out',
        out('r.json'),
        '--repetitions',
        '2',
        '--labels',
        out('labels.csv'),
      ],
      log,
    );
    evalMain(
      ['metrics', '--labels', out('labels.csv'), '--results', out('r.json'), '--out', out('m.md')],
      log,
    );
    const report = fs.readFileSync(out('m.md'), 'utf8');
    expect(report).toMatch(/\| B0 \| 0 \| 0 \| 0 \| 1 \|/); // git misses the interference
    expect(report).toMatch(/\| B3 \| 1 \| 0 \| 0 \| 0 \|/); // the complete analysis finds it
  });

  it('rejects unknown commands and options', () => {
    expect(() => {
      evalMain(['nope']);
    }).toThrow(/usage/);
    expect(() => {
      evalMain(['run', '--candidates', 'x', '--configs', 'B9']);
    }).toThrow();
    expect(() => {
      evalMain(['metrics', '--labels', 'x', '--results', 'y', '--min-confidence', 'high']);
    }).toThrow();
  });
});
