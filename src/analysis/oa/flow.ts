import type ts from 'typescript';
import { covers, elementKey } from '../../state/element.js';
import type { Root, StateElement } from '../../state/element.js';

export type Side = 'L' | 'R';

/** A write attributed to one side that has not been overwritten by Base yet. */
export interface WriteSite {
  side: Side;
  element: StateElement;
  node: ts.Node;
  /** Qualified name of the function that contains the write. */
  functionName: string;
  /** Call sites followed from the entry function to reach the write, outermost first. */
  callChain: readonly string[];
}

/**
 * Abstract state of the OA algorithm at one program point: the writes by Left and by Right that
 * may still be live, per state element, plus whether the point is reachable at all.
 */
export class OaState {
  dead = false;

  constructor(
    readonly left = new Map<string, WriteSite>(),
    readonly right = new Map<string, WriteSite>(),
  ) {}

  writes(side: Side): Map<string, WriteSite> {
    return side === 'L' ? this.left : this.right;
  }

  clone(): OaState {
    const copy = new OaState(new Map(this.left), new Map(this.right));
    copy.dead = this.dead;
    return copy;
  }

  /** Makes this state equal to `other`. */
  assign(other: OaState): void {
    this.left.clear();
    this.right.clear();
    for (const [key, site] of other.left) this.left.set(key, site);
    for (const [key, site] of other.right) this.right.set(key, site);
    this.dead = other.dead;
  }

  /** A Base write to `element`: certainly replaced values can no longer be overridden. */
  killCovered(element: StateElement): void {
    for (const side of ['L', 'R'] as const) this.removeCovered(side, element);
  }

  removeCovered(side: Side, element: StateElement): void {
    const writes = this.writes(side);
    for (const [key, site] of writes) {
      if (covers(element, site.element)) writes.delete(key);
    }
  }

  add(site: WriteSite): void {
    this.writes(site.side).set(elementKey(site.element), site);
  }

  /** Forgets writes to variables that stop existing, e.g. locals of a returning callee. */
  dropRoots(isGone: (root: Root) => boolean): void {
    for (const writes of [this.left, this.right]) {
      for (const [key, site] of writes) {
        if (isGone(site.element.root)) writes.delete(key);
      }
    }
  }

  /** Control-flow join: a write is live if it is live on any incoming path. */
  static join(a: OaState, b: OaState): OaState {
    if (a.dead) return b.clone();
    if (b.dead) return a.clone();
    const joined = a.clone();
    for (const [key, site] of b.left) if (!joined.left.has(key)) joined.left.set(key, site);
    for (const [key, site] of b.right) if (!joined.right.has(key)) joined.right.set(key, site);
    return joined;
  }
}
