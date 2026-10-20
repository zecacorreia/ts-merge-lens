import type { Alert, AlertType, AnalysisReport, Confidence, Location } from './types.js';

/** Minimal SARIF 2.1.0 types: only the parts we emit. */
interface SarifLocation {
  id?: number;
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region: { startLine: number; startColumn: number };
  };
  logicalLocations?: Array<{ name: string; kind: string }>;
  message?: { text: string };
}

interface SarifResult {
  ruleId: AlertType;
  ruleIndex: number;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: SarifLocation[];
  relatedLocations: SarifLocation[];
  properties: Record<string, unknown>;
}

const RULES: Array<{ id: AlertType; name: string; description: string }> = [
  {
    id: 'OA',
    name: 'OverridingAssignment',
    description:
      'An assignment by one side overrides, with no write by Base in between, an assignment by the other side to the same state element.',
  },
  {
    id: 'DF',
    name: 'DataFlowInterference',
    description:
      'A value written by the changes of one side reaches a read made by the changes of the other side.',
  },
  {
    id: 'CF',
    name: 'ControlFlowInterference',
    description:
      'The changes of one side influence the condition under which the changes of the other side execute.',
  },
  {
    id: 'BUILD',
    name: 'BuildConflict',
    description: 'The merged code has a compilation error that none of Base, Left and Right has.',
  },
];

const LEVEL: Record<Confidence, SarifResult['level']> = {
  high: 'error',
  medium: 'warning',
  low: 'note',
};

function locationOf(location: Location, id: number, message: string): SarifLocation {
  return {
    id,
    physicalLocation: {
      artifactLocation: { uri: location.file, uriBaseId: '%SRCROOT%' },
      region: { startLine: Math.max(location.line, 1), startColumn: Math.max(location.column, 1) },
    },
    ...(location.function
      ? { logicalLocations: [{ name: location.function, kind: 'function' }] }
      : {}),
    message: { text: message },
  };
}

const ROLE: Record<AlertType, [string, string]> = {
  OA: ['Overwritten write', 'Overriding write'],
  DF: ['Write that reaches the read', 'Read'],
  CF: ['Source of the influence', 'Statement that runs under the condition'],
  BUILD: ['Build error', 'Build error'],
};

function resultOf(alert: Alert): SarifResult {
  const [first, last] = [alert.locations[0], alert.locations.at(-1)];
  const [firstRole, lastRole] = ROLE[alert.type];
  const related = alert.locations.length > 1 && first ? [first] : [];
  return {
    ruleId: alert.type,
    ruleIndex: RULES.findIndex((rule) => rule.id === alert.type),
    level: LEVEL[alert.confidence],
    message: { text: alert.explanation.en },
    // The primary location is where a reviewer should look first: the later, overriding change.
    locations: last ? [locationOf(last, 0, `${lastRole} (${last.branch})`)] : [],
    relatedLocations: related.map((location) =>
      locationOf(location, 1, `${firstRole} (${location.branch})`),
    ),
    properties: {
      confidence: alert.confidence,
      explanationPt: alert.explanation.pt,
      ...(alert.element ? { element: alert.element } : {}),
      ...(alert.snippet ? { snippet: alert.snippet } : {}),
      branches: alert.locations.map((location) => location.branch),
      callChains: alert.locations.map((location) => location.callChain ?? []),
    },
  };
}

export function renderSarif(report: AnalysisReport): string {
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'TSMergeLens',
            version: report.version,
            rules: RULES.map((rule) => ({
              id: rule.id,
              name: rule.name,
              shortDescription: { text: rule.name },
              fullDescription: { text: rule.description },
            })),
          },
        },
        originalUriBaseIds: { '%SRCROOT%': { description: { text: 'Root of the Merge version' } } },
        results: report.alerts.map(resultOf),
        invocations: [
          {
            executionSuccessful: report.status === 'analyzed',
            properties: {
              scenario: report.scenario,
              discardReason: report.discardReason,
              notes: report.notes,
              limitations: report.limitations,
              refactoring: report.refactoring,
            },
          },
        ],
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
