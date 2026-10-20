import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/pipeline.js';
import type { Alert } from '../src/report/types.js';
import { cleanupTempDirs } from './helpers/fixture-repo.js';
import { listOracleFiles, loadOracle } from './helpers/oracle.js';
import type { OracleAlert } from './helpers/oracle.js';

afterAll(cleanupTempDirs);

const ROOT = path.join(import.meta.dirname, 'oracles');

function describeAlert(alert: Alert): Required<Omit<OracleAlert, 'element'>> & { element: string } {
  const [first, second] = alert.locations;
  if (!first || !second) throw new Error('an OA/DF/CF alert must have two locations');
  return {
    type: alert.type as 'OA' | 'DF' | 'CF',
    element: alert.element ?? '',
    first: `${first.branch} ${first.function ?? ''}`,
    second: `${second.branch} ${second.function ?? ''}`,
    confidence: alert.confidence,
  };
}

function normalize(alerts: readonly OracleAlert[]): ReturnType<typeof describeAlert>[] {
  return alerts
    .map((alert) => ({ type: 'OA' as const, element: '', confidence: 'medium' as const, ...alert }))
    .sort(byKey);
}

const key = (a: ReturnType<typeof describeAlert>): string =>
  `${a.type}|${a.element}|${a.first}|${a.second}`;
const byKey = (a: ReturnType<typeof describeAlert>, b: ReturnType<typeof describeAlert>): number =>
  key(a).localeCompare(key(b));

const files = listOracleFiles(ROOT);

describe('oracle suite', () => {
  it('has at least 30 cases, positive and negative', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(files.some((f) => f.includes(`${path.sep}positive${path.sep}`))).toBe(true);
    expect(files.some((f) => f.includes(`${path.sep}negative${path.sep}`))).toBe(true);
  });

  for (const file of files) {
    const label = path
      .relative(ROOT, file)
      .replace(/\\/g, '/')
      .replace(/\.oracle$/, '');
    it(label, () => {
      const oracle = loadOracle(file);
      const runs = oracle.expect.byFilter
        ? Object.entries(oracle.expect.byFilter)
        : ([['downgrade', oracle.expect.alerts]] as const);

      for (const [filter, expectedAlerts] of runs) {
        const report = analyze({
          source: { kind: 'dirs', dirs: oracle.dirs },
          depth: oracle.expect.depth ?? 5,
          analyses: oracle.expect.analyses ?? ['oa'],
          refactoringFilter: filter as 'off' | 'downgrade' | 'suppress',
        });

        // A negative that never analysed anything would pass for the wrong reason.
        expect(report.units.length, 'both sides must change the same function').toBeGreaterThan(0);
        expect(report.notes.filter((note) => note.includes('was not analysed'))).toEqual([]);

        const actual = report.alerts.map(describeAlert).sort(byKey);
        expect(actual, `filter=${filter}`).toEqual(normalize(expectedAlerts));

        const kinds = report.limitations.map((limitation) => limitation.kind);
        for (const kind of oracle.expect.limitations ?? []) expect(kinds).toContain(kind);
      }
    });
  }
});
