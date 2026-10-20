import ts from 'typescript';
import { endLine, startLine } from '../ast/parse.js';
import { forEachUnit } from '../ast/units.js';
import { listSourceFiles, readTextIfExists } from '../util/files.js';
import type { ScenarioDirs } from '../scenario/scenario.js';
import { align, parseFile } from './align.js';
import type { Alignment, ParsedFile } from './align.js';

/**
 * Who introduced a unit of the Merge version: `Base` (unchanged), `L` (Left), `R` (Right) or
 * `LR` (both sides, or a combination of both that matches neither side exactly).
 */
export type Origin = 'Base' | 'L' | 'R' | 'LR';

export interface FileTexts {
  base?: string;
  left?: string;
  right?: string;
  merge: string;
}

export interface AnnotatedUnit {
  kind: string;
  origin: Origin;
  /** 1-based lines in the Merge version. */
  line: number;
  endLine: number;
  /** First line of the unit's source. */
  text: string;
}

/** A unit of Base that no longer exists in the Merge version. */
export interface RemovedUnit {
  kind: string;
  /** 1-based line in the Base version. */
  line: number;
  text: string;
  /** Sides whose version lacks the unit; empty when the alignment could not tell. */
  removedBy: Array<'L' | 'R'>;
}

export interface FileAnnotation {
  file: string;
  /** AST of the Merge version, the one the analyses walk. */
  sourceFile: ts.SourceFile;
  units: AnnotatedUnit[];
  removed: RemovedUnit[];
  /** Origin of the innermost unit that contains `node` (a node of `sourceFile`). */
  originOf(node: ts.Node): Origin;
  /**
   * Origin of the innermost unit that contains the character offset `position`. Works for nodes
   * of any parse of the same text (e.g. the source file of a `ts.Program`).
   */
  originAt(position: number): Origin;
}

const MAX_TEXT = 80;

function firstLine(node: ts.Node, sourceFile: ts.SourceFile): string {
  const line = node.getText(sourceFile).split('\n')[0] ?? '';
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT)}…` : line.trim();
}

export function annotateFile(file: string, texts: FileTexts): FileAnnotation {
  const merge = parseFile(file, texts.merge);
  const parse = (text: string | undefined): ParsedFile | undefined =>
    text === undefined ? undefined : parseFile(file, text);
  const base = parse(texts.base);
  const left = parse(texts.left);
  const right = parse(texts.right);

  const baseMerge = align(base, merge);
  const leftMerge = align(left, merge);
  const rightMerge = align(right, merge);

  const sameAs = (side: ParsedFile | undefined, alignment: Alignment, unit: ts.Node): boolean => {
    const counterpart = alignment.bToA.get(unit);
    return (
      side !== undefined &&
      counterpart !== undefined &&
      side.fingerprints.shallow(counterpart) === merge.fingerprints.shallow(unit)
    );
  };

  const originByUnit = new Map<ts.Node, Origin>();
  const units: AnnotatedUnit[] = [];
  // Units in pre-order (sorted by start), for position lookups.
  const ranges: Array<{ start: number; end: number; origin: Origin; parent: number }> = [];
  const rangeIndex = new Map<ts.Node, number>();
  forEachUnit(merge.sourceFile, (unit, parent) => {
    let origin: Origin = 'Base';
    if (!sameAs(base, baseMerge, unit)) {
      const fromLeft = sameAs(left, leftMerge, unit);
      const fromRight = sameAs(right, rightMerge, unit);
      origin = fromLeft && !fromRight ? 'L' : fromRight && !fromLeft ? 'R' : 'LR';
    }
    originByUnit.set(unit, origin);
    rangeIndex.set(unit, ranges.length);
    ranges.push({
      start: unit.getStart(merge.sourceFile),
      end: unit.getEnd(),
      origin,
      parent: parent === undefined ? -1 : (rangeIndex.get(parent) ?? -1),
    });
    if (!ts.isSourceFile(unit)) {
      units.push({
        kind: ts.SyntaxKind[unit.kind],
        origin,
        line: startLine(unit, merge.sourceFile),
        endLine: endLine(unit, merge.sourceFile),
        text: firstLine(unit, merge.sourceFile),
      });
    }
  });

  const removed: RemovedUnit[] = [];
  if (base) {
    const baseLeft = align(base, left ?? base);
    const baseRight = align(base, right ?? base);
    forEachUnit(base.sourceFile, (unit, parent) => {
      if (baseMerge.aToB.has(unit)) return;
      if (parent !== undefined && !baseMerge.aToB.has(parent)) return; // only the outermost
      const removedBy: Array<'L' | 'R'> = [];
      if (left && !baseLeft.aToB.has(unit)) removedBy.push('L');
      if (right && !baseRight.aToB.has(unit)) removedBy.push('R');
      removed.push({
        kind: ts.SyntaxKind[unit.kind],
        line: startLine(unit, base.sourceFile),
        text: firstLine(unit, base.sourceFile),
        removedBy,
      });
    });
  }

  const originOf = (node: ts.Node): Origin => {
    let current = node;
    for (;;) {
      const origin = originByUnit.get(current);
      if (origin !== undefined) return origin;
      if (ts.isSourceFile(current)) return 'Base';
      current = current.parent;
    }
  };

  const originAt = (position: number): Origin => {
    let low = 0;
    let high = ranges.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((ranges[middle]?.start ?? Infinity) <= position) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    while (found >= 0) {
      const range = ranges[found];
      if (range === undefined) break;
      if (position < range.end) return range.origin;
      found = range.parent;
    }
    return 'Base';
  };

  return { file, sourceFile: merge.sourceFile, units, removed, originOf, originAt };
}

export interface ScenarioAnnotation {
  /** Only files whose Merge version differs from Base; every other file is entirely `Base`. */
  files: FileAnnotation[];
}

export function annotateScenario(dirs: ScenarioDirs): ScenarioAnnotation {
  const files: FileAnnotation[] = [];
  for (const file of listSourceFiles(dirs.merge)) {
    const merge = readTextIfExists(dirs.merge, file);
    const base = readTextIfExists(dirs.base, file);
    if (merge === undefined || merge === base) continue;
    const texts: FileTexts = { merge };
    const left = readTextIfExists(dirs.left, file);
    const right = readTextIfExists(dirs.right, file);
    if (base !== undefined) texts.base = base;
    if (left !== undefined) texts.left = left;
    if (right !== undefined) texts.right = right;
    files.push(annotateFile(file, texts));
  }
  return { files };
}

export interface AnnotationSummary {
  file: string;
  units: Record<Origin, number>;
  removed: number;
}

export function summarize(annotation: ScenarioAnnotation): AnnotationSummary[] {
  return annotation.files.map((file) => {
    const units: Record<Origin, number> = { Base: 0, L: 0, R: 0, LR: 0 };
    for (const unit of file.units) units[unit.origin]++;
    return { file: file.file, units, removed: file.removed.length };
  });
}
