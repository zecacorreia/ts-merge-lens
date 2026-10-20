import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, run } from '../src/program.js';
import type { AnalysisReport } from '../src/report/types.js';
import { CANONICAL, TSCONFIG, buildMergeFixture, canonicalFixture } from './helpers/canonical.js';
import { cleanupTempDirs, makeTempDir, writeFiles } from './helpers/fixture-repo.js';

afterEach(cleanupTempDirs);

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await run(argv, {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { code, out, err };
}

describe('tsmergelens analyze', () => {
  it('reports exactly one OA alert, with the two right lines, for the canonical merge', async () => {
    const fixture = canonicalFixture();
    const { code, out } = await cli(
      'analyze',
      '--repo',
      fixture.repo.dir,
      '--merge',
      fixture.merge,
      '--format',
      'json',
    );
    const report = JSON.parse(out) as AnalysisReport;
    expect(code).toBe(EXIT.alerts);
    expect(report.status).toBe('analyzed');
    expect(report.units.map((u) => u.key)).toEqual(['src/text.ts#Text.generateReport']);
    expect(report.annotation).toHaveLength(1);
    expect(report.annotation[0]?.units).toMatchObject({ L: 1, R: 1 });

    expect(report.alerts).toHaveLength(1);
    const [alert] = report.alerts;
    expect(alert).toMatchObject({ type: 'OA', element: 'this.fixes', confidence: 'medium' });
    const [overwritten, overriding] = alert?.locations ?? [];
    expect(overwritten).toMatchObject({
      branch: 'Left',
      function: 'Text.countDuplicatedWhitespaces',
      file: 'src/text.ts',
      line: 11,
      callChain: ['Text.generateReport (src/text.ts:6)'],
    });
    expect(overriding).toMatchObject({
      branch: 'Right',
      function: 'Text.countDuplicatedWords',
      file: 'src/text.ts',
      line: 17,
      callChain: ['Text.generateReport (src/text.ts:8)'],
    });
    expect(alert?.explanation.pt).toContain('Right, em Text.countDuplicatedWords');
    expect(alert?.explanation.pt).toContain('sobrescreve this.fixes escrito por Left');
    // All four analyses ran, and none of them reported anything but the one OA alert.
    expect(report.notes).toEqual([]);
    expect(report.refactoring).toMatchObject({
      left: { structural: false },
      right: { structural: false },
    });
  });

  it('writes a SARIF 2.1.0 report', async () => {
    const fixture = canonicalFixture();
    const { code, out } = await cli(
      'analyze',
      '--repo',
      fixture.repo.dir,
      '--merge',
      fixture.merge,
      '--analyses',
      'oa',
      '--format',
      'sarif',
    );
    expect(code).toBe(EXIT.alerts);
    const sarif = JSON.parse(out) as {
      version: string;
      runs: Array<{
        tool: { driver: { name: string; rules: Array<{ id: string }> } };
        results: Array<{
          ruleId: string;
          level: string;
          message: { text: string };
          locations: Array<{ physicalLocation: { region: { startLine: number } } }>;
          relatedLocations: Array<{ physicalLocation: { region: { startLine: number } } }>;
        }>;
      }>;
    };
    expect(sarif.version).toBe('2.1.0');
    const [run] = sarif.runs;
    expect(run?.tool.driver.name).toBe('TSMergeLens');
    expect(run?.tool.driver.rules.map((r) => r.id)).toEqual(['OA', 'DF', 'CF', 'BUILD']);
    expect(run?.results).toHaveLength(1);
    const [result] = run?.results ?? [];
    expect(result).toMatchObject({ ruleId: 'OA', level: 'warning' });
    // Primary location: the overriding write; related: the overwritten one.
    expect(result?.locations[0]?.physicalLocation.region.startLine).toBe(17);
    expect(result?.relatedLocations[0]?.physicalLocation.region.startLine).toBe(11);
    expect(result?.message.text).toContain('overwrites this.fixes');
  });

  it('prints the call chain of an OA alert in text format', async () => {
    const fixture = canonicalFixture();
    const { out } = await cli(
      'analyze',
      '--repo',
      fixture.repo.dir,
      '--merge',
      fixture.merge,
      '--analyses',
      'oa',
    );
    expect(out).toContain('[OA]');
    expect(out).toContain('via Text.generateReport (src/text.ts:6)');
  });

  it('--depth 0 runs the intraprocedural analysis, which sees no writes in callees', async () => {
    const fixture = canonicalFixture();
    const { code, out } = await cli(
      'analyze',
      '--repo',
      fixture.repo.dir,
      '--merge',
      fixture.merge,
      '--analyses',
      'oa',
      '--depth',
      '0',
      '--format',
      'json',
    );
    const report = JSON.parse(out) as AnalysisReport;
    expect(code).toBe(EXIT.clean);
    expect(report.alerts).toEqual([]);
    expect(report.limitations.map((l) => l.kind)).toContain('depth-limit');
  });

  it('exits 1 and reports a BUILD alert when the merge does not compile', async () => {
    const lib = 'export function area(w: number): number {\n  return w * w;\n}\n';
    const lib2 = 'export function area(w: number, h: number): number {\n  return w * h;\n}\n';
    const filler = '\n\n\n\n';
    const use = "import { area } from './lib';\nexport const a = area(1);\n";
    const use2 = `${use}${filler}export const b = area(2);\n`;
    const fixture = buildMergeFixture({
      base: { 'tsconfig.json': TSCONFIG, 'src/lib.ts': lib, 'src/use.ts': `${use}${filler}` },
      left: { 'src/lib.ts': lib2 },
      right: { 'src/use.ts': use2 },
    });
    const { code, out } = await cli(
      'analyze',
      '--repo',
      fixture.repo.dir,
      '--merge',
      fixture.merge,
      '--analyses',
      'build',
    );
    expect(code).toBe(EXIT.alerts);
    expect(out).toContain('[BUILD]');
    expect(out).toContain('src/use.ts');
  });

  it('writes the report to --out', async () => {
    const fixture = canonicalFixture();
    const target = path.join(makeTempDir(), 'report.json');
    const { code, out } = await cli(
      'analyze',
      '--repo',
      fixture.repo.dir,
      '--merge',
      fixture.merge,
      '--format',
      'json',
      '--analyses',
      'build',
      '--out',
      target,
    );
    expect(code).toBe(EXIT.clean);
    expect(out).toBe('');
    expect((JSON.parse(fs.readFileSync(target, 'utf8')) as AnalysisReport).tool).toBe(
      'tsmergelens',
    );
  });

  it('reports a discarded scenario without failing', async () => {
    const fixture = canonicalFixture();
    const { code, out } = await cli(
      'analyze',
      '--repo',
      fixture.repo.dir,
      '--merge',
      fixture.base,
      '--analyses',
      'build',
    );
    expect(code).toBe(EXIT.clean);
    expect(out).toContain('scenario discarded');
  });

  it('restricts the units with --entry and rejects unknown entries', async () => {
    const fixture = canonicalFixture();
    const ok = await cli(
      'analyze',
      '--repo',
      fixture.repo.dir,
      '--merge',
      fixture.merge,
      '--entry',
      'src/text.ts#Text.generateReport',
      '--analyses',
      'build',
    );
    expect(ok.code).toBe(EXIT.clean);
    const bad = await cli(
      'analyze',
      '--repo',
      fixture.repo.dir,
      '--merge',
      fixture.merge,
      '--entry',
      'src/text.ts#Text.nope',
      '--analyses',
      'build',
    );
    expect(bad.code).toBe(EXIT.error);
    expect(bad.err).toContain('--entry');
  });

  it('supports directory mode', async () => {
    const root = makeTempDir();
    const dirs = ['base', 'left', 'right', 'merge'].map((name) => path.join(root, name));
    const [base, left, right, merge] = dirs;
    if (!base || !left || !right || !merge) throw new Error('unreachable');
    writeFiles(base, { 'tsconfig.json': TSCONFIG, 'src/text.ts': CANONICAL.base });
    writeFiles(left, { 'tsconfig.json': TSCONFIG, 'src/text.ts': CANONICAL.left });
    writeFiles(right, { 'tsconfig.json': TSCONFIG, 'src/text.ts': CANONICAL.right });
    writeFiles(merge, { 'tsconfig.json': TSCONFIG, 'src/text.ts': CANONICAL.merge });
    const { code, out } = await cli(
      'analyze',
      '--base',
      base,
      '--left',
      left,
      '--right',
      right,
      '--merge-dir',
      merge,
      '--format',
      'json',
      '--analyses',
      'build',
    );
    expect(code).toBe(EXIT.clean);
    expect((JSON.parse(out) as AnalysisReport).scenario.source).toBe('dirs');
    expect(fs.existsSync(merge)).toBe(true);
  });

  it('exits 2 on usage errors', async () => {
    expect((await cli('analyze')).code).toBe(EXIT.error);
    expect((await cli('analyze', '--repo', 'x')).code).toBe(EXIT.error);
    expect((await cli('analyze', '--repo', 'x', '--merge', 'y', '--base', 'z')).code).toBe(
      EXIT.error,
    );
    expect((await cli('analyze', '--repo', 'x', '--merge', 'y', '--analyses', 'zz')).code).toBe(
      EXIT.error,
    );
    expect((await cli('analyze', '--repo', 'x', '--merge', 'y', '--format', 'sarif')).code).toBe(
      EXIT.error,
    );
  });

  it('exits 2 when the repository does not exist', async () => {
    const missing = path.join(makeTempDir(), 'missing');
    const { code, err } = await cli('analyze', '--repo', missing, '--merge', 'HEAD');
    expect(code).toBe(EXIT.error);
    expect(err).toContain('error:');
  });
});

describe('tsmergelens scan', () => {
  it('lists merges with functions changed by both sides', async () => {
    const fixture = canonicalFixture();
    const { code, out } = await cli('scan', '--repo', fixture.repo.dir, '--format', 'json');
    expect(code).toBe(EXIT.clean);
    const candidates = JSON.parse(out) as Array<{ sha: string; units: unknown[] }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sha).toBe(fixture.merge);
    expect(candidates[0]?.units).toHaveLength(1);
  });

  it('prints a text summary', async () => {
    const fixture = canonicalFixture();
    const { out } = await cli('scan', '--repo', fixture.repo.dir);
    expect(out).toContain('1 functions');
    expect(out).toContain('1 candidate merge(s)');
  });
});
