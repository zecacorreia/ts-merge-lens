import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { annotateFile, summarize } from '../src/annotate/annotate.js';
import type { AnnotatedUnit, FileAnnotation, Origin } from '../src/annotate/annotate.js';
import { CANONICAL } from './helpers/canonical.js';

function originsByText(annotation: FileAnnotation): Map<string, Origin> {
  return new Map(annotation.units.map((unit) => [unit.text, unit.origin]));
}

function unitAt(units: AnnotatedUnit[], text: string): AnnotatedUnit {
  const found = units.find((unit) => unit.text === text);
  if (!found) throw new Error(`no unit with text ${text}`);
  return found;
}

describe('annotateFile', () => {
  it('marks the calls added by each side in the canonical example', () => {
    const annotation = annotateFile('src/text.ts', CANONICAL);
    const origins = originsByText(annotation);
    expect(origins.get('this.countDuplicatedWhitespaces();')).toBe('L');
    expect(origins.get('this.countDuplicatedWords();')).toBe('R');
    expect(origins.get('this.countComments();')).toBe('Base');
    expect(origins.get('generateReport(): void {')).toBe('Base');
    expect(origins.get('export class Text {')).toBe('Base');
  });

  it('annotates by AST position, not by line', () => {
    const base = 'function f() {\n  a();\n  b();\n}\n';
    // Left only reformats and adds blank lines: nothing changed structurally.
    const left = 'function f() {\n\n  a();\n\n\n  b();\n}\n';
    const annotation = annotateFile('a.ts', { base, left, right: base, merge: left });
    expect(annotation.units.every((unit) => unit.origin === 'Base')).toBe(true);
  });

  it('marks a modified statement with the side that modified it', () => {
    const base = 'function f() {\n  a(1);\n  b(1);\n}\n';
    const left = 'function f() {\n  a(2);\n  b(1);\n}\n';
    const right = 'function f() {\n  a(1);\n  b(1);\n  c();\n}\n';
    const merge = 'function f() {\n  a(2);\n  b(1);\n  c();\n}\n';
    const origins = originsByText(annotateFile('a.ts', { base, left, right, merge }));
    expect(origins.get('a(2);')).toBe('L');
    expect(origins.get('b(1);')).toBe('Base');
    expect(origins.get('c();')).toBe('R');
  });

  it('marks a change made identically by both sides as LR', () => {
    const base = 'function f() {\n  a();\n}\n';
    const both = 'function f() {\n  a();\n  b();\n}\n';
    const origins = originsByText(
      annotateFile('a.ts', { base, left: both, right: both, merge: both }),
    );
    expect(origins.get('b();')).toBe('LR');
  });

  it('keeps a compound statement as Base when only a nested statement changes', () => {
    const base = 'function f(c: boolean) {\n  if (c) {\n    a();\n  }\n}\n';
    const left = 'function f(c: boolean) {\n  if (c) {\n    a();\n    b();\n  }\n}\n';
    const annotation = annotateFile('a.ts', { base, left, right: base, merge: left });
    const origins = originsByText(annotation);
    expect(origins.get('if (c) {')).toBe('Base');
    expect(origins.get('b();')).toBe('L');
    expect(origins.get('a();')).toBe('Base');
  });

  it('marks a changed condition on the compound statement itself', () => {
    const base = 'function f(c: boolean) {\n  if (c) {\n    a();\n  }\n}\n';
    const right = 'function f(c: boolean) {\n  if (!c) {\n    a();\n  }\n}\n';
    const annotation = annotateFile('a.ts', { base, left: base, right, merge: right });
    const origins = originsByText(annotation);
    expect(origins.get('if (!c) {')).toBe('R');
    expect(origins.get('a();')).toBe('Base');
  });

  it('treats a file created by one side as entirely that side', () => {
    const text = 'export function g() {\n  h();\n}\n';
    const annotation = annotateFile('new.ts', { left: text, merge: text });
    expect(new Set(annotation.units.map((unit) => unit.origin))).toEqual(new Set(['L']));
  });

  it('records units removed against Base and who removed them', () => {
    const base = 'function f() {\n  a();\n  b();\n  c();\n}\n';
    const left = 'function f() {\n  a();\n  c();\n}\n';
    const right = 'function f() {\n  a();\n  b();\n  c();\n  d();\n}\n';
    const merge = 'function f() {\n  a();\n  c();\n  d();\n}\n';
    const annotation = annotateFile('a.ts', { base, left, right, merge });
    expect(annotation.removed).toEqual([
      { kind: 'ExpressionStatement', line: 3, text: 'b();', removedBy: ['L'] },
    ]);
    expect(unitAt(annotation.units, 'd();').origin).toBe('R');
  });

  it('reports only the outermost removed unit', () => {
    const base = 'function keep() {}\n\nfunction gone() {\n  a();\n  b();\n}\n';
    const left = 'function keep() {}\n';
    const merge = left;
    const annotation = annotateFile('a.ts', { base, left, right: base, merge });
    expect(annotation.removed).toHaveLength(1);
    expect(annotation.removed[0]).toMatchObject({ kind: 'FunctionDeclaration', removedBy: ['L'] });
  });

  it('answers originOf for any node inside a unit', () => {
    const annotation = annotateFile('src/text.ts', CANONICAL);
    let callIdentifier: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'countDuplicatedWords' && !callIdentifier) {
        if (ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent)) {
          callIdentifier = node;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(annotation.sourceFile);
    expect(callIdentifier).toBeDefined();
    if (callIdentifier) expect(annotation.originOf(callIdentifier)).toBe('R');
  });
});

describe('originAt', () => {
  it('finds the innermost unit by offset, in any parse of the same text', () => {
    const annotation = annotateFile('src/text.ts', CANONICAL);
    const offsetOf = (needle: string): number => CANONICAL.merge.indexOf(needle) + 2;
    expect(annotation.originAt(offsetOf('this.countDuplicatedWhitespaces();'))).toBe('L');
    expect(annotation.originAt(offsetOf('this.countDuplicatedWords();'))).toBe('R');
    expect(annotation.originAt(offsetOf('this.countComments();'))).toBe('Base');
    expect(annotation.originAt(0)).toBe('Base');
    expect(annotation.originAt(CANONICAL.merge.length + 100)).toBe('Base');
  });
});

describe('summarize', () => {
  it('counts units per origin and removed units per file', () => {
    const annotation = annotateFile('src/text.ts', CANONICAL);
    const [summary] = summarize({ files: [annotation] });
    expect(summary).toMatchObject({ file: 'src/text.ts', removed: 0 });
    expect(summary?.units.L).toBe(1);
    expect(summary?.units.R).toBe(1);
  });
});
