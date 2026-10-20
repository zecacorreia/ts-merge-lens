import { DISCARD_MESSAGES } from '../scenario/scenario.js';
import { renderSarif } from './sarif.js';
import type { Alert, AnalysisReport, Location } from './types.js';

export type ReportFormat = 'text' | 'json' | 'sarif';

export function renderReport(report: AnalysisReport, format: ReportFormat): string {
  if (format === 'sarif') return renderSarif(report);
  return format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderText(report);
}

function place(location: Location): string {
  const where = `${location.file}:${location.line}:${location.column}`;
  return location.function ? `${where} (${location.function}, ${location.branch})` : where;
}

function renderAlert(alert: Alert, index: number): string[] {
  const lines = [`${index + 1}. [${alert.type}] confidence: ${alert.confidence}`];
  for (const location of alert.locations) {
    lines.push(`   at ${place(location)}`);
    if (location.callChain) lines.push(`      via ${location.callChain.join(' -> ')}`);
  }
  if (alert.element) lines.push(`   state element: ${alert.element}`);
  if (alert.snippet) lines.push(`   > ${alert.snippet.trim()}`);
  lines.push(`   pt: ${alert.explanation.pt}`, `   en: ${alert.explanation.en}`);
  return lines;
}

function renderText(report: AnalysisReport): string {
  const lines = [`tsmergelens ${report.version}`];
  const { scenario } = report;
  if (scenario.source === 'git' && scenario.merge) {
    lines.push(
      `merge ${scenario.merge.slice(0, 10)} (base ${scenario.base?.slice(0, 10) ?? '?'}, ` +
        `left ${scenario.left?.slice(0, 10) ?? '?'}, right ${scenario.right?.slice(0, 10) ?? '?'})`,
    );
    if (scenario.matchesAutomaticMerge === false) {
      lines.push('note: the recorded merge differs from the automatic merge (manual edits)');
    }
  } else {
    lines.push('scenario: directories');
  }

  if (report.status === 'discarded' && report.discardReason) {
    lines.push(`scenario discarded: ${DISCARD_MESSAGES[report.discardReason]}`);
  } else {
    lines.push('', `functions changed by both sides: ${report.units.length}`);
    for (const unit of report.units)
      lines.push(`  ${unit.key} (lines ${unit.line}-${unit.endLine})`);
    lines.push('', `alerts: ${report.alerts.length}`);
    report.alerts.forEach((alert, index) => lines.push(...renderAlert(alert, index)));
  }

  if (report.limitations.length > 0) {
    lines.push('', 'limitations:');
    for (const limitation of report.limitations) {
      const where = limitation.examples.map((e) => `${e.file}:${e.line}`).join(', ');
      lines.push(
        `  - ${limitation.kind} x${limitation.count}: ${limitation.description} [${where}]`,
      );
    }
  }

  if (report.notes.length > 0) lines.push('', 'notes:', ...report.notes.map((n) => `  - ${n}`));
  return `${lines.join('\n')}\n`;
}
