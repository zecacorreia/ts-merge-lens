import type ts from 'typescript';

/** A resolved variable/class symbol, or the receiver `this` of the function being analysed. */
export type Root = ts.Symbol | 'this';

/** Path segment for an index whose value is unknown (`a[i]`): it may be any index. */
export const ANY_INDEX = '[*]';

/**
 * A state element: a symbol (resolved by the type checker, so shadowed names and aliases are
 * told apart) plus a property path. `o.a` and `o.b` are different elements, and so are `a[0]`
 * and `a[1]`; `a[i]` with an unknown `i` may be any of them.
 */
export interface StateElement {
  root: Root;
  /** Segments: `.name` for properties, `[0]` for literal indexes, `[*]` for unknown ones. */
  path: readonly string[];
  /** The element was reached through an `any`/`unknown` value or a non-literal key. */
  lowConfidence: boolean;
}

const symbolIds = new WeakMap<ts.Symbol, number>();
let nextSymbolId = 1;

function rootId(root: Root): string {
  if (root === 'this') return 'this';
  let id = symbolIds.get(root);
  if (id === undefined) {
    id = nextSymbolId++;
    symbolIds.set(root, id);
  }
  return `#${id}`;
}

/** Identity of the element, equal for equal elements (wildcards are just another segment). */
export function elementKey(element: StateElement): string {
  return rootId(element.root) + element.path.join('');
}

export function displayElement(element: StateElement): string {
  const root = element.root === 'this' ? 'this' : element.root.name;
  return root + element.path.join('');
}

function sameRoot(a: StateElement, b: StateElement): boolean {
  return rootId(a.root) === rootId(b.root);
}

/**
 * May the two elements denote overlapping state? True when one path is a prefix of the other
 * (`o` overlaps `o.a`), segment by segment, with `[*]` matching any segment.
 */
export function overlaps(a: StateElement, b: StateElement): boolean {
  if (!sameRoot(a, b)) return false;
  const common = Math.min(a.path.length, b.path.length);
  for (let i = 0; i < common; i++) {
    const x = a.path[i];
    const y = b.path[i];
    if (x !== y && x !== ANY_INDEX && y !== ANY_INDEX) return false;
  }
  return true;
}

/**
 * Does a write to `write` certainly replace the value of `tracked`? Only when `write` is a
 * prefix of `tracked` with identical segments: writing `o` replaces `o.a`; writing `a[i]` with an
 * unknown `i` replaces nothing for sure.
 */
export function covers(write: StateElement, tracked: StateElement): boolean {
  if (!sameRoot(write, tracked) || write.path.length > tracked.path.length) return false;
  return write.path.every((segment, i) => segment !== ANY_INDEX && segment === tracked.path[i]);
}

/**
 * Does a read of `read` observe a write to `write`? Only if the write replaces what the read
 * looks at: `write` is a prefix of `read` (segment by segment, `[*]` matching anything). Reading
 * `o` (passing it around) does not observe a write to `o.a`; reading `o.a` observes a write to `o`.
 */
export function observes(read: StateElement, write: StateElement): boolean {
  if (!sameRoot(read, write) || write.path.length > read.path.length) return false;
  return write.path.every((segment, i) => {
    const other = read.path[i];
    return segment === other || segment === ANY_INDEX || other === ANY_INDEX;
  });
}
