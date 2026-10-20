import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { OaState } from '../src/analysis/oa/flow.js';
import type { WriteSite } from '../src/analysis/oa/flow.js';
import { createDirProgram } from '../src/build/build.js';
import { Limitations } from '../src/limitations.js';
import type { LimitationKind } from '../src/limitations.js';
import { ANY_INDEX, covers, displayElement, elementKey, overlaps } from '../src/state/element.js';
import type { StateElement } from '../src/state/element.js';
import { ElementResolver } from '../src/state/resolve.js';
import { TSCONFIG } from './helpers/canonical.js';
import { cleanupTempDirs, makeTempDir, writeFiles } from './helpers/fixture-repo.js';

afterEach(cleanupTempDirs);

const THIS: StateElement = { root: 'this', path: [], lowConfidence: false };
const at = (...path: string[]): StateElement => ({ ...THIS, path });

describe('state elements', () => {
  it('tells apart properties and literal indexes', () => {
    expect(overlaps(at('.a'), at('.b'))).toBe(false);
    expect(overlaps(at('.a'), at('.a'))).toBe(true);
    expect(overlaps(at('[0]'), at('[1]'))).toBe(false);
    expect(overlaps(at('.a', '[0]'), at('.a', '[1]'))).toBe(false);
  });

  it('treats a prefix as overlapping and an unknown index as any index', () => {
    expect(overlaps(at('.a'), at('.a', '.b'))).toBe(true);
    expect(overlaps(at(), at('.a'))).toBe(true);
    expect(overlaps(at(ANY_INDEX), at('[3]'))).toBe(true);
    expect(overlaps(at('.a', ANY_INDEX), at('.b', '[3]'))).toBe(false);
  });

  it('only lets a write kill what it certainly replaces', () => {
    expect(covers(at('.a'), at('.a'))).toBe(true);
    expect(covers(at('.a'), at('.a', '.b'))).toBe(true);
    expect(covers(at('.a', '.b'), at('.a'))).toBe(false);
    expect(covers(at(ANY_INDEX), at('[0]'))).toBe(false);
    expect(covers(at('[0]'), at(ANY_INDEX))).toBe(false);
  });

  it('builds keys and display names', () => {
    expect(elementKey(at('.a', '[0]'))).toBe('this.a[0]');
    expect(displayElement(at('.a', '[0]'))).toBe('this.a[0]');
    expect(elementKey(at('.a'))).not.toBe(elementKey(at('.b')));
  });
});

describe('OaState', () => {
  const node = ts.factory.createIdentifier('x');
  const site = (side: 'L' | 'R', ...path: string[]): WriteSite => ({
    side,
    element: at(...path),
    node,
    functionName: 'f',
    callChain: [],
  });

  it('joins by union and ignores unreachable paths', () => {
    const a = new OaState();
    a.add(site('L', '.a'));
    const b = new OaState();
    b.add(site('R', '.b'));
    const joined = OaState.join(a, b);
    expect([...joined.left.keys()]).toEqual(['this.a']);
    expect([...joined.right.keys()]).toEqual(['this.b']);

    const dead = new OaState();
    dead.dead = true;
    expect([...OaState.join(dead, a).left.keys()]).toEqual(['this.a']);
    expect(OaState.join(dead, dead).dead).toBe(true);
  });

  it('kills covered writes of both sides, and clones independently', () => {
    const state = new OaState();
    state.add(site('L', '.a', '.x'));
    state.add(site('R', '.a'));
    state.add(site('R', '.b'));
    const copy = state.clone();
    state.killCovered(at('.a'));
    expect(state.left.size).toBe(0);
    expect([...state.right.keys()]).toEqual(['this.b']);
    expect(copy.left.size).toBe(1);
    expect(copy.right.size).toBe(2);
  });
});

describe('Limitations', () => {
  it('counts distinct sites and keeps a few examples', () => {
    const sourceFile = ts.createSourceFile(
      '/p/a.ts',
      'a;\nb;\nc;\nd;\n',
      ts.ScriptTarget.ES2022,
      true,
    );
    const limitations = new Limitations('/p');
    for (const statement of sourceFile.statements) limitations.add('closure', statement);
    limitations.add('closure', sourceFile.statements[0] ?? sourceFile); // same site again
    const [summary] = limitations.summary();
    expect(summary).toMatchObject({ kind: 'closure', count: 4 });
    expect(summary?.examples).toEqual([
      { file: 'a.ts', line: 1 },
      { file: 'a.ts', line: 2 },
      { file: 'a.ts', line: 3 },
    ]);
  });
});

describe('ElementResolver', () => {
  const source = `
    import { shared } from "./other";
    interface Box { v: number }
    const key = "v";
    export function f(box: Box, any: any, i: number): void {
      const outer = 1;
      { const outer = 2; }
      box.v = 1;
      box[key] = 2;
      box["v"] = 3;
      any.x = 4;
      box[i] = 5;
      shared.n = 6;
      f(box, any, i).v = 7;
    }
  `;

  function setup() {
    const dir = makeTempDir();
    writeFiles(dir, {
      'tsconfig.json': TSCONFIG,
      'src/main.ts': source,
      'src/other.ts': 'export const shared = { n: 0 };\n',
    });
    const { program } = createDirProgram(dir);
    const sourceFile = program.getSourceFile(path.join(dir, 'src/main.ts'));
    if (!sourceFile) throw new Error('no source file');
    const limits: LimitationKind[] = [];
    const resolver = new ElementResolver(program.getTypeChecker(), (kind) => limits.push(kind));
    const assignments: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        assignments.push(node.left);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { resolver, assignments, limits };
  }

  it('resolves property paths, literal keys and imported aliases', () => {
    const { resolver, assignments } = setup();
    const resolved = assignments.map((left) => {
      const element = resolver.resolve(left);
      return element && displayElement(element);
    });
    expect(resolved).toEqual([
      'box.v', // box.v
      'box.v', // box[key] with key: "v"
      'box.v', // box["v"]
      'any.x',
      'box[*]',
      'shared.n', // through the import alias
      undefined, // result of a call
    ]);
  });

  it('flags any-typed receivers and non-literal keys as low confidence', () => {
    const { resolver, assignments, limits } = setup();
    const lowConfidence = assignments.map((left) => resolver.resolve(left)?.lowConfidence);
    expect(lowConfidence).toEqual([false, false, false, true, true, false, undefined]);
    expect(limits).toEqual(['any-type', 'dynamic-access']);
  });

  it('rebases this and parameters onto the caller', () => {
    const { resolver, assignments } = setup();
    const raw = resolver.resolve(assignments[0] as ts.Expression);
    if (!raw || raw.root === 'this') throw new Error('expected a symbol root');
    const target = at('.target');
    const frame = { thisElement: target, params: new Map([[raw.root, at('.arg')]]) };

    expect(displayElement(resolver.rebase(raw, frame, 'write') as StateElement)).toBe('this.arg.v');
    expect(displayElement(resolver.rebase(at('.q'), frame, 'write') as StateElement)).toBe(
      'this.target.q',
    );
    expect(
      resolver.rebase(at('.q'), { thisElement: undefined, params: new Map() }, 'write'),
    ).toBeUndefined();

    // Reassigning the parameter itself is local; passing it on still refers to the argument.
    const bare = { ...raw, path: [] };
    expect(resolver.rebase(bare, frame, 'write')).toBeUndefined();
    expect(displayElement(resolver.rebase(bare, frame, 'reference') as StateElement)).toBe(
      'this.arg',
    );
    // A parameter bound to a non-reference argument shares nothing.
    const unbound = { thisElement: target, params: new Map([[raw.root, null]]) };
    expect(resolver.rebase(raw, unbound, 'write')).toBeUndefined();
  });
});
