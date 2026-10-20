import ts from 'typescript';
import { Fingerprinter } from '../ast/fingerprint.js';
import { parseSource } from '../ast/parse.js';
import { unitChildren } from '../ast/units.js';
import { at } from '../util/files.js';

export interface ParsedFile {
  sourceFile: ts.SourceFile;
  fingerprints: Fingerprinter;
}

export function parseFile(fileName: string, text: string): ParsedFile {
  const sourceFile = parseSource(fileName, text);
  return { sourceFile, fingerprints: new Fingerprinter(sourceFile) };
}

/** One-to-one correspondence between the units of two versions of a file. */
export interface Alignment {
  readonly aToB: ReadonlyMap<ts.Node, ts.Node>;
  readonly bToA: ReadonlyMap<ts.Node, ts.Node>;
}

const EMPTY: Alignment = { aToB: new Map(), bToA: new Map() };

/**
 * Aligns the unit trees of `a` and `b` by AST position: identical sibling sequences are matched
 * through a longest common subsequence on structural hashes; the leftover siblings between two
 * anchors are paired in order when they look alike (same declared name, or similar tokens) and
 * then aligned recursively. Units that stay unpaired were added (in `b`) or removed (from `a`).
 * Moves are not detected: a moved unit shows up as removed plus added.
 */
export function align(a: ParsedFile | undefined, b: ParsedFile): Alignment {
  if (a === undefined) return EMPTY;
  const aligner = new Aligner(a, b);
  aligner.matchModified(a.sourceFile, b.sourceFile);
  return aligner;
}

class Aligner implements Alignment {
  readonly aToB = new Map<ts.Node, ts.Node>();
  readonly bToA = new Map<ts.Node, ts.Node>();

  constructor(
    private readonly a: ParsedFile,
    private readonly b: ParsedFile,
  ) {}

  matchModified(x: ts.Node, y: ts.Node): void {
    this.link(x, y);
    const xs = unitChildren(x);
    const ys = unitChildren(y);
    const anchors = longestCommonSubsequence(
      xs,
      ys,
      (p, q) => this.a.fingerprints.deep(p) === this.b.fingerprints.deep(q),
    );
    let nextX = 0;
    let nextY = 0;
    for (const [i, j] of anchors) {
      this.pairGap(xs.slice(nextX, i), ys.slice(nextY, j));
      this.matchIdentical(at(xs, i), at(ys, j));
      nextX = i + 1;
      nextY = j + 1;
    }
    this.pairGap(xs.slice(nextX), ys.slice(nextY));
  }

  private matchIdentical(x: ts.Node, y: ts.Node): void {
    this.link(x, y);
    const ys = unitChildren(y);
    unitChildren(x).forEach((child, index) => {
      this.matchIdentical(child, at(ys, index));
    });
  }

  private pairGap(xs: readonly ts.Node[], ys: readonly ts.Node[]): void {
    let from = 0;
    for (const y of ys) {
      for (let k = from; k < xs.length; k++) {
        const x = at(xs, k);
        if (this.similar(x, y)) {
          this.matchModified(x, y);
          from = k + 1;
          break;
        }
      }
    }
  }

  private similar(x: ts.Node, y: ts.Node): boolean {
    if (x.kind !== y.kind) return false;
    const nameX = declaredName(x);
    const nameY = declaredName(y);
    if (nameX !== undefined || nameY !== undefined) return nameX === nameY;
    return dice(this.a.fingerprints.shallowTokens(x), this.b.fingerprints.shallowTokens(y)) >= 0.5;
  }

  private link(x: ts.Node, y: ts.Node): void {
    this.aToB.set(x, y);
    this.bToA.set(y, x);
  }
}

function declaredName(node: ts.Node): string | undefined {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  return ts.getNameOfDeclaration(node as ts.Declaration)?.getText();
}

/** Sørensen–Dice coefficient over token multisets; two empty lists are identical. */
function dice(xs: readonly string[], ys: readonly string[]): number {
  if (xs.length === 0 && ys.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const token of xs) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of ys) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      shared++;
      counts.set(token, remaining - 1);
    }
  }
  return (2 * shared) / (xs.length + ys.length);
}

/** Index pairs of a longest common subsequence of `xs` and `ys`. */
export function longestCommonSubsequence<T, U>(
  xs: readonly T[],
  ys: readonly U[],
  equal: (x: T, y: U) => boolean,
): Array<[number, number]> {
  let prefix = 0;
  while (prefix < xs.length && prefix < ys.length && equal(at(xs, prefix), at(ys, prefix)))
    prefix++;
  let endX = xs.length;
  let endY = ys.length;
  while (endX > prefix && endY > prefix && equal(at(xs, endX - 1), at(ys, endY - 1))) {
    endX--;
    endY--;
  }

  const pairs: Array<[number, number]> = [];
  for (let k = 0; k < prefix; k++) pairs.push([k, k]);

  const n = endX - prefix;
  const m = endY - prefix;
  if (n > 0 && m > 0) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    const cell = (i: number, j: number): number => table[i * width + j] ?? 0;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = equal(at(xs, prefix + i), at(ys, prefix + j))
          ? cell(i + 1, j + 1) + 1
          : Math.max(cell(i + 1, j), cell(i, j + 1));
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (equal(at(xs, prefix + i), at(ys, prefix + j))) {
        pairs.push([prefix + i, prefix + j]);
        i++;
        j++;
      } else if (cell(i + 1, j) >= cell(i, j + 1)) {
        i++;
      } else {
        j++;
      }
    }
  }

  for (let k = 0; k < xs.length - endX; k++) pairs.push([endX + k, endY + k]);
  return pairs;
}
