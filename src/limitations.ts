import path from 'node:path';
import type ts from 'typescript';
import { toPosix } from './util/files.js';

export const LIMITATIONS = {
  eval: 'eval / Function constructor: code built at run time is invisible to the analysis',
  'dynamic-access':
    'element access with a non-literal key, treated as "any key" (may over-approximate)',
  decorators: 'decorated declarations: decorators may rewrite the declaration',
  'async-order': 'async functions: the order of their effects is not modelled',
  'unresolved-call':
    'call without a resolvable body (any-typed callee, abstract or interface method): effects ignored',
  closure: 'function/arrow expressions are not executed where defined: callbacks are ignored',
  'any-type': 'state reached through a value typed any/unknown: low-confidence alerts',
  'depth-limit': 'call not followed because the call-depth limit was reached',
  budget: 'analysis stopped following calls after exhausting the per-entry budget',
} as const;

export type LimitationKind = keyof typeof LIMITATIONS;

export interface LimitationSummary {
  kind: LimitationKind;
  description: string;
  /** Distinct source positions where the limitation applied. */
  count: number;
  examples: Array<{ file: string; line: number }>;
}

const MAX_EXAMPLES = 3;

/** Collects the places where an analysis had to approximate, so reports can list them. */
export class Limitations {
  private readonly sites = new Map<LimitationKind, Map<string, { file: string; line: number }>>();

  constructor(private readonly root: string) {}

  add(kind: LimitationKind, node: ts.Node): void {
    const sourceFile = node.getSourceFile();
    const start = node.getStart(sourceFile);
    const file = toPosix(path.relative(this.root, sourceFile.fileName));
    const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
    let bucket = this.sites.get(kind);
    if (!bucket) {
      bucket = new Map();
      this.sites.set(kind, bucket);
    }
    bucket.set(`${file}:${start}`, { file, line });
  }

  summary(): LimitationSummary[] {
    return [...this.sites].map(([kind, bucket]) => ({
      kind,
      description: LIMITATIONS[kind],
      count: bucket.size,
      examples: [...bucket.values()].slice(0, MAX_EXAMPLES),
    }));
  }
}
