import { afterEach, describe, expect, it } from 'vitest';
import { SummaryTable } from '../src/analysis/flow/summary.js';
import type { Access } from '../src/analysis/flow/summary.js';
import { displayElement } from '../src/state/element.js';
import { cleanupTempDirs } from './helpers/fixture-repo.js';
import { callsIn, programOf } from './helpers/program.js';

afterEach(cleanupTempDirs);

const describeAccesses = (accesses: Iterable<Access>): string[] =>
  [...accesses].map((a) => `${a.kind} ${displayElement(a.element)}`).sort();

describe('CallResolver', () => {
  const source = `
    interface Shape { area(): number }
    class Square implements Shape { area(): number { return 1; } }
    class Circle implements Shape { area(): number { return 2; } }
    function overloaded(x: string): void;
    function overloaded(x: number): void;
    function overloaded(x: string | number): void { void x; }
    export function f(shape: Shape, loose: any): void {
      shape.area();
      loose.go();
      Math.abs(1);
      new Square();
      overloaded("a");
    }
  `;

  it('resolves project code, library code, unknown callees and dispatch', () => {
    const { context, functionNamed } = programOf({ 'src/main.ts': source });
    const calls = callsIn(functionNamed('f'));
    const kinds = calls.map((call) => {
      const resolved = context.calls.resolve(call);
      if (resolved.kind !== 'targets') return resolved.kind;
      return resolved.targets
        .map((fn) => context.functionName(fn))
        .sort()
        .join('+');
    });
    expect(kinds).toEqual([
      'Circle.area+Square.area', // through the interface, by the language service
      'unresolved', // loose is any
      'external', // library code
      'external', // implicit constructor
      'overloaded', // the implementation behind the overload signature
    ]);
  });
});

describe('SummaryTable', () => {
  it('rewrites the accesses of callees to the caller terms', () => {
    const { context, functionNamed } = programOf({
      'src/main.ts': `
        class Counter {
          n = 0;
          other = 0;
          bump(): void { this.n = this.n + 1; }
          peek(): number { return this.other; }
          both(): number { this.bump(); return this.peek(); }
        }
        export function use(c: Counter): number { return c.both(); }
      `,
    });
    const table = new SummaryTable(context);
    expect(describeAccesses(table.get(functionNamed('Counter.bump')).accesses.values())).toEqual([
      'read this.n',
      'write this.n',
    ]);
    expect(describeAccesses(table.get(functionNamed('use')).accesses.values())).toEqual([
      'read c',
      'read c.n',
      'read c.other',
      'write c.n',
    ]);
  });

  it('drops the locals of callees and the reassignment of by-value parameters', () => {
    const { context, functionNamed } = programOf({
      'src/main.ts': `
        function helper(n: number): number { let tmp = n; tmp = tmp + 1; n = 5; return tmp; }
        export function use(x: number): number { return helper(x); }
      `,
    });
    const summary = new SummaryTable(context).get(functionNamed('use'));
    expect(describeAccesses(summary.accesses.values())).toEqual(['read x']);
  });

  it('terminates on recursion and cuts ever-growing paths', () => {
    const { context, functionNamed } = programOf({
      'src/main.ts': `
        interface Node { next: Node; value: number }
        export function walk(node: Node): void { walk(node.next); node.value = 1; }
      `,
    });
    const summary = new SummaryTable(context).get(functionNamed('walk'));
    const writes = [...summary.accesses.values()].filter((a) => a.kind === 'write');
    expect(writes.length).toBeGreaterThan(1);
    expect(Math.max(...writes.map((a) => a.element.path.length))).toBeLessThanOrEqual(4);
    expect(writes.some((a) => a.element.lowConfidence)).toBe(true); // a cut path is an approximation
  });

  it('labels accesses with who changed the statement and keeps the call chain', () => {
    const { context, functionNamed } = programOf({
      'src/main.ts': `
        class Box {
          v = 0;
          set(): void { this.v = 1; }
          run(): void { this.set(); }
        }
      `,
    });
    const summary = new SummaryTable(context).get(functionNamed('Box.run'));
    const [write] = [...summary.accesses.values()];
    expect(write).toMatchObject({ kind: 'write', label: 'Base', functionName: 'Box.set' });
    expect(write?.via).toEqual(['Box.run (src/main.ts:5)']);
  });
});
