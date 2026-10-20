import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/report/format.js';
import { renderSarif } from '../src/report/sarif.js';
import type { Alert, AnalysisReport } from '../src/report/types.js';

const report = (alerts: Alert[], extra: Partial<AnalysisReport> = {}): AnalysisReport => ({
  tool: 'tsmergelens',
  version: '1.2.3',
  scenario: { source: 'dirs' },
  status: 'analyzed',
  units: [],
  annotation: [],
  alerts,
  limitations: [],
  notes: ['a note'],
  ...extra,
});

const loc = (branch: 'Left' | 'Right' | 'Merge', line: number) => ({
  file: 'src/a.ts',
  line,
  column: 3,
  function: 'f',
  branch,
});

interface Sarif {
  runs: Array<{
    results: Array<{
      ruleId: string;
      ruleIndex: number;
      level: string;
      locations: unknown[];
      relatedLocations: unknown[];
      properties: Record<string, unknown>;
    }>;
    invocations: Array<{ executionSuccessful: boolean; properties: Record<string, unknown> }>;
  }>;
}

describe('SARIF', () => {
  it('maps confidence to level and keeps both locations and the Portuguese text', () => {
    const alerts: Alert[] = [
      {
        type: 'DF',
        confidence: 'low',
        locations: [loc('Left', 3), loc('Right', 9)],
        element: 'x',
        explanation: { pt: 'portugues', en: 'english' },
      },
      {
        type: 'BUILD',
        confidence: 'high',
        locations: [loc('Merge', 1)],
        explanation: { pt: 'p', en: 'e' },
      },
    ];
    const sarif = JSON.parse(renderSarif(report(alerts))) as Sarif;
    const [run] = sarif.runs;
    const [df, build] = run?.results ?? [];
    expect(df).toMatchObject({ ruleId: 'DF', ruleIndex: 1, level: 'note' });
    expect(df?.locations).toHaveLength(1);
    expect(df?.relatedLocations).toHaveLength(1);
    expect(df?.properties).toMatchObject({
      confidence: 'low',
      element: 'x',
      explanationPt: 'portugues',
      branches: ['Left', 'Right'],
    });
    expect(build).toMatchObject({ ruleId: 'BUILD', level: 'error', relatedLocations: [] });
    expect(run?.invocations[0]?.properties).toMatchObject({ notes: ['a note'] });
  });

  it('reports a discarded scenario as a run that did not analyse anything', () => {
    const sarif = JSON.parse(
      renderSarif(report([], { status: 'discarded', discardReason: 'fast-forward' })),
    ) as Sarif;
    expect(sarif.runs[0]?.results).toEqual([]);
    expect(sarif.runs[0]?.invocations[0]).toMatchObject({
      executionSuccessful: false,
      properties: { discardReason: 'fast-forward' },
    });
  });

  it('is selected by the sarif format', () => {
    expect(() => {
      JSON.parse(renderReport(report([]), 'sarif'));
    }).not.toThrow();
    expect(renderReport(report([]), 'text')).toContain('tsmergelens 1.2.3');
  });
});
