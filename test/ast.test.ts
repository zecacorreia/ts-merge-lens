import { describe, expect, it } from 'vitest';
import { Fingerprinter } from '../src/ast/fingerprint.js';
import { parseSource } from '../src/ast/parse.js';
import { extractFunctions } from '../src/scenario/functions.js';

function deepHash(text: string): string {
  const sourceFile = parseSource('a.ts', text);
  return new Fingerprinter(sourceFile).deep(sourceFile);
}

describe('Fingerprinter', () => {
  it('ignores whitespace, comments, semicolons and quote style', () => {
    const a = `function f(x: number) { return x + 1; }`;
    const b = `function f(x: number) {\n  // add one\n  return x + 1\n}`;
    expect(deepHash(a)).toBe(deepHash(b));
    expect(deepHash(`const s = "a";`)).toBe(deepHash(`const s = 'a';`));
  });

  it('distinguishes operators and attributes that are not child nodes', () => {
    expect(deepHash('x++;')).not.toBe(deepHash('x--;'));
    expect(deepHash('x + 1;')).not.toBe(deepHash('x - 1;'));
    expect(deepHash('let a = 1;')).not.toBe(deepHash('const a = 1;'));
    expect(deepHash('f(1);')).not.toBe(deepHash('f(2);'));
  });

  it('keeps the shallow hash of a unit stable when only a nested unit changes', () => {
    const parse = (body: string) => {
      const sourceFile = parseSource('a.ts', `if (cond) { ${body} }`);
      const fingerprints = new Fingerprinter(sourceFile);
      const statement = sourceFile.statements[0];
      if (!statement) throw new Error('no statement');
      return fingerprints.shallow(statement);
    };
    expect(parse('a();')).toBe(parse('b();'));
  });
});

describe('extractFunctions', () => {
  it('lists functions, methods, accessors, constructors and function-valued variables', () => {
    const sourceFile = parseSource(
      'a.ts',
      `
      function top() {}
      export const arrow = () => 1;
      class A {
        constructor() {}
        m() { const inner = () => 2; }
        get v() { return 1; }
        set v(x: number) {}
        prop = () => 3;
        declared(): void;
        declared(x?: number): void {}
      }
      namespace N { export function f() {} }
      `,
    );
    expect([...extractFunctions(sourceFile).keys()]).toEqual([
      'top',
      'arrow',
      'A.constructor',
      'A.m',
      'A.get v',
      'A.set v',
      'A.prop',
      'A.declared',
      'N.f',
    ]);
  });
});
