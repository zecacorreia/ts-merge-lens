import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from '../src/pipeline.js';
import { cleanupTempDirs, makeTempDir } from './helpers/fixture-repo.js';
import { loadOracle } from './helpers/oracle.js';

afterEach(cleanupTempDirs);

const body = (marker: string): string =>
  `export function run(): number {\n  let x = 0;\n${marker}  const a = 1;\n  const b = 2;\n  return x + a + b;\n}\n`;

describe('analyze with the OA analysis', () => {
  it('notes units that are not part of the Merge program instead of failing', () => {
    // tsconfig.json only includes src/, and this function lives in lib/.
    const file = path.join(makeTempDir(), 'outside.oracle');
    fs.writeFileSync(
      file,
      [
        '--- expect',
        '{"alerts":[]}',
        '--- base lib/main.ts',
        body(''),
        '--- left lib/main.ts',
        body('  x = 1;\n'),
        '--- right lib/main.ts',
        body('').replace('const b = 2;', 'const b = 2;\n  x = 2;'),
      ].join('\n'),
    );
    const oracle = loadOracle(file);
    const report = analyze({
      source: { kind: 'dirs', dirs: oracle.dirs },
      depth: 5,
      analyses: ['oa'],
    });
    expect(report.units.map((unit) => unit.key)).toEqual(['lib/main.ts#run']);
    expect(report.alerts).toEqual([]);
    expect(report.notes).toEqual([
      'lib/main.ts#run was not analysed: it is not part of the Merge TypeScript program',
    ]);
  });

  it('reports no alert and no limitation when nothing was changed by both sides', () => {
    const file = path.join(makeTempDir(), 'one-sided.oracle');
    fs.writeFileSync(
      file,
      [
        '--- expect',
        '{"alerts":[]}',
        '--- base',
        body(''),
        '--- left',
        body('  x = 1;\n'),
        '--- right',
        body(''),
      ].join('\n'),
    );
    const oracle = loadOracle(file);
    const report = analyze({
      source: { kind: 'dirs', dirs: oracle.dirs },
      depth: 5,
      analyses: ['oa', 'build'],
    });
    expect(report.units).toEqual([]);
    expect(report.alerts).toEqual([]);
    expect(report.limitations).toEqual([]);
  });
});
