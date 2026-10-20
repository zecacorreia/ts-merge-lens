import type ts from 'typescript';
import type { Branch, Location } from './types.js';
import { toPosix } from '../util/files.js';
import path from 'node:path';

/** A place in the Merge that an analysis attributes to a side. */
export interface Place {
  node: ts.Node;
  functionName: string;
  callChain: readonly string[];
}

export function locationOf(place: Place, branch: Branch, mergeDir: string): Location {
  const sourceFile = place.node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    place.node.getStart(sourceFile),
  );
  const location: Location = {
    file: toPosix(path.relative(mergeDir, sourceFile.fileName)),
    line: line + 1,
    column: character + 1,
    function: place.functionName,
    branch,
  };
  if (place.callChain.length > 0) location.callChain = [...place.callChain];
  return location;
}

export function snippetOf(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return sourceFile.text.split(/\r?\n/)[line]?.trim() ?? '';
}

export function describeLocation(location: Location): string {
  return `${location.function ?? '?'} (${location.file}:${location.line})`;
}

export function sortByLastLocation<T extends { alert: { locations: Location[] } }>(
  items: T[],
): T[] {
  return items.sort((a, b) => {
    const x = a.alert.locations.at(-1);
    const y = b.alert.locations.at(-1);
    return (x?.file ?? '').localeCompare(y?.file ?? '') || (x?.line ?? 0) - (y?.line ?? 0);
  });
}
