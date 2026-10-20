import ts from 'typescript';
import { Fingerprinter } from '../../ast/fingerprint.js';
import { parseSource } from '../../ast/parse.js';
import { asFunctionWithBody, extractFunctions } from '../../scenario/functions.js';
import type { FunctionWithBody } from '../../scenario/functions.js';
import { listSourceFiles, readTextIfExists } from '../../util/files.js';
import { simpleName, tokenize } from './tokens.js';
import type { Tokens } from './tokens.js';

export type RefactoringKind =
  | 'format'
  | 'rename'
  | 'extract-function'
  | 'inline-function'
  | 'extract-variable'
  | 'inline-variable';

export interface SideVerdict {
  /** Every change of this side, in every file it touches, looks like a refactoring. */
  structural: boolean;
  kinds: RefactoringKind[];
  changedFiles: number;
}

export interface RefactoringVerdict {
  left: SideVerdict;
  right: SideVerdict;
}

interface FileVerdict {
  structural: boolean;
  kinds: Set<RefactoringKind>;
}

const NOT_STRUCTURAL: FileVerdict = { structural: false, kinds: new Set() };

function sameTokens(a: Tokens, b: Tokens): boolean {
  return a.tokens.length === b.tokens.length && a.tokens.every((token, i) => token === b.tokens[i]);
}

function identifiersOf(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) names.add(current.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

/** `const` locals of `fn` with a single declarator whose name the other function does not use. */
function constsAbsentFrom(fn: ts.Node, other: ts.Node): Set<string> {
  const otherNames = identifiersOf(other);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Const) {
      const [declaration] = node.declarationList.declarations;
      if (
        node.declarationList.declarations.length === 1 &&
        declaration &&
        ts.isIdentifier(declaration.name) &&
        !otherNames.has(declaration.name.text)
      ) {
        found.add(declaration.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

/**
 * Does the Base -> side change of one file consist only of refactorings? Recognised: formatting,
 * renaming (of locals, parameters, functions and methods), extracting statements into a new
 * function or an expression into a variable, and the inverse of both. Heuristic and token-based:
 * everything else, including any change outside function bodies, counts as a real change.
 */
export function classifyFile(file: string, baseText: string, sideText: string): FileVerdict {
  const base = parseSource(file, baseText);
  const side = parseSource(file, sideText);
  const baseFingerprints = new Fingerprinter(base);
  if (baseFingerprints.deep(base) === new Fingerprinter(side).deep(side)) {
    return { structural: true, kinds: new Set<RefactoringKind>(['format']) };
  }

  const baseFns = extractFunctions(base);
  const sideFns = extractFunctions(side);
  const removed = [...baseFns.keys()].filter((name) => !sideFns.has(name));
  const added = [...sideFns.keys()].filter((name) => !baseFns.has(name));

  // Renamed functions: a removed and an added function with the same body under another name.
  const kinds = new Set<RefactoringKind>();
  const rename = new Map<string, string>(); // new simple name -> old simple name
  const pairs = new Map<string, string>(); // removed qualified name -> added qualified name
  const unmatchedAdded = new Set(added);
  for (const oldName of removed) {
    const oldFn = asFunctionWithBody(baseFns.get(oldName));
    if (!oldFn) continue;
    const oldTokens = tokenize(oldFn, { anonymizeName: true });
    for (const newName of unmatchedAdded) {
      const newFn = asFunctionWithBody(sideFns.get(newName));
      if (!newFn || !sameTokens(oldTokens, tokenize(newFn, { anonymizeName: true }))) continue;
      pairs.set(oldName, newName);
      rename.set(simpleName(newName), simpleName(oldName));
      unmatchedAdded.delete(newName);
      kinds.add('rename');
      break;
    }
  }
  const renamedOld = new Set(pairs.keys());
  const renamedNew = new Set(pairs.values());
  const addedFns = new Map<string, FunctionWithBody>();
  for (const name of added) {
    const fn = asFunctionWithBody(sideFns.get(name));
    if (fn && !renamedNew.has(name)) addedFns.set(simpleName(name), fn);
  }
  const removedFns = new Map<string, FunctionWithBody>();
  for (const name of removed) {
    const fn = asFunctionWithBody(baseFns.get(name));
    if (fn && !renamedOld.has(name)) removedFns.set(simpleName(name), fn);
  }

  // Every function present on both sides must be equivalent up to the refactorings.
  const extracted = new Set<string>();
  const inlined = new Set<string>();
  const sideFingerprints = new Fingerprinter(side);
  const matched: Array<[string, string]> = [
    ...[...baseFns.keys()]
      .filter((name) => sideFns.has(name))
      .map((name): [string, string] => [name, name]),
    ...pairs,
  ];
  for (const [baseName, sideName] of matched) {
    const baseNode = baseFns.get(baseName);
    const sideNode = sideFns.get(sideName);
    const baseFn = asFunctionWithBody(baseNode);
    const sideFn = asFunctionWithBody(sideNode);
    if (!baseNode || !sideNode || !baseFn || !sideFn) return NOT_STRUCTURAL;
    const renamedHere = baseName !== sideName;
    if (!renamedHere && baseFingerprints.deep(baseNode) === sideFingerprints.deep(sideNode))
      continue;

    // Prefer the simplest explanation: first without turning constants into expressions.
    const compare = (withConsts: boolean): [Tokens, Tokens] => [
      tokenize(baseFn, {
        expand: removedFns,
        ...(withConsts ? { inlineConsts: constsAbsentFrom(baseFn, sideFn) } : {}),
        anonymizeName: renamedHere,
      }),
      tokenize(sideFn, {
        expand: addedFns,
        ...(withConsts ? { inlineConsts: constsAbsentFrom(sideFn, baseFn) } : {}),
        rename,
        anonymizeName: renamedHere,
      }),
    ];
    let [baseTokens, sideTokens] = compare(false);
    if (!sameTokens(baseTokens, sideTokens)) [baseTokens, sideTokens] = compare(true);
    if (!sameTokens(baseTokens, sideTokens)) return NOT_STRUCTURAL;
    if (baseTokens.droppedUnusedConst || sideTokens.droppedUnusedConst) return NOT_STRUCTURAL;
    for (const name of baseTokens.expanded) inlined.add(name);
    for (const name of sideTokens.expanded) extracted.add(name);
    if (baseTokens.expanded.size > 0) kinds.add('inline-function');
    if (sideTokens.expanded.size > 0) kinds.add('extract-function');
    if (baseTokens.inlinedConsts) kinds.add('inline-variable');
    if (sideTokens.inlinedConsts) kinds.add('extract-variable');
    if (sideTokens.renamed || renamedHere) kinds.add('rename');
    if (
      !baseTokens.inlinedConsts &&
      !sideTokens.inlinedConsts &&
      baseTokens.expanded.size === 0 &&
      sideTokens.expanded.size === 0 &&
      !renamedHere
    ) {
      // Same shape: either local names changed, or only parentheses did.
      const sameLocals =
        baseTokens.locals.size === sideTokens.locals.size &&
        [...baseTokens.locals].every((name) => sideTokens.locals.has(name));
      kinds.add(sameLocals ? 'format' : 'rename');
    }
  }

  // Functions that appear or disappear must be explained by an extraction or an inlining.
  for (const name of addedFns.keys()) if (!extracted.has(name)) return NOT_STRUCTURAL;
  for (const name of removedFns.keys()) if (!inlined.has(name)) return NOT_STRUCTURAL;

  // Everything that is not a function body must be unchanged.
  const skeleton = (
    sourceFile: ts.SourceFile,
    fns: Map<string, ts.Node>,
    name: (key: string) => string | undefined,
    skip: ReadonlySet<string>,
    rename: ReadonlyMap<string, string>,
  ): Tokens => {
    const skipNodes = new Set<ts.Node>();
    const placeholders = new Map<ts.Node, string>();
    for (const [key, node] of fns) {
      if (skip.has(key)) skipNodes.add(node);
      else {
        const label = name(key);
        if (label !== undefined) placeholders.set(node, label);
      }
    }
    return tokenize(sourceFile, { skip: skipNodes, placeholders, rename });
  };
  const newToOld = new Map([...pairs].map(([oldName, newName]) => [newName, oldName] as const));
  const baseSkip = new Set(removed.filter((key) => !renamedOld.has(key)));
  const sideSkip = new Set(added.filter((key) => !renamedNew.has(key)));
  const baseOutline = skeleton(base, baseFns, (key) => key, baseSkip, new Map());
  const sideOutline = skeleton(side, sideFns, (key) => newToOld.get(key) ?? key, sideSkip, rename);
  if (!sameTokens(baseOutline, sideOutline)) return NOT_STRUCTURAL;

  return { structural: true, kinds };
}

/** Classifies everything `side` changed relative to `base` (two directories of one scenario). */
export function classifySide(baseDir: string, sideDir: string): SideVerdict {
  const files = new Set([...listSourceFiles(baseDir), ...listSourceFiles(sideDir)]);
  const kinds = new Set<RefactoringKind>();
  let changedFiles = 0;
  let structural = true;
  for (const file of [...files].sort()) {
    const before = readTextIfExists(baseDir, file);
    const after = readTextIfExists(sideDir, file);
    if (before === after) continue;
    changedFiles++;
    if (before === undefined || after === undefined) {
      structural = false; // a file was added or deleted
      continue;
    }
    const verdict = classifyFile(file, before, after);
    if (!verdict.structural) structural = false;
    for (const kind of verdict.kinds) kinds.add(kind);
  }
  return {
    structural: structural && changedFiles > 0,
    kinds: structural ? [...kinds].sort() : [],
    changedFiles,
  };
}
