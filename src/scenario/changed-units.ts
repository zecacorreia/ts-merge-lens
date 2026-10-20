import { Fingerprinter } from '../ast/fingerprint.js';
import { endLine, parseSource, startLine } from '../ast/parse.js';
import { listSourceFiles, readTextIfExists } from '../util/files.js';
import { extractFunctions } from './functions.js';
import type { ScenarioDirs } from './scenario.js';

/** An experimental unit: a function changed by both Left and Right (relative to Base). */
export interface ChangedUnit {
  file: string;
  name: string;
  /** `file#name`, the format accepted by `--entry`. */
  key: string;
  /** Position in the Merge version. */
  line: number;
  endLine: number;
}

export function findUnitsChangedByBoth(dirs: ScenarioDirs): ChangedUnit[] {
  const files = new Set([
    ...listSourceFiles(dirs.base),
    ...listSourceFiles(dirs.left),
    ...listSourceFiles(dirs.right),
  ]);
  const units: ChangedUnit[] = [];

  for (const file of [...files].sort()) {
    const base = readTextIfExists(dirs.base, file);
    const left = readTextIfExists(dirs.left, file);
    const right = readTextIfExists(dirs.right, file);
    const merge = readTextIfExists(dirs.merge, file);
    if (base === undefined || left === undefined || right === undefined || merge === undefined) {
      continue;
    }
    if (left === base || right === base) continue;

    const versions = [base, left, right, merge].map((text) => {
      const sourceFile = parseSource(file, text);
      return { sourceFile, fingerprints: new Fingerprinter(sourceFile) };
    });
    const [baseV, leftV, rightV, mergeV] = versions;
    if (!baseV || !leftV || !rightV || !mergeV) continue;

    const baseFns = extractFunctions(baseV.sourceFile);
    const leftFns = extractFunctions(leftV.sourceFile);
    const rightFns = extractFunctions(rightV.sourceFile);
    const mergeFns = extractFunctions(mergeV.sourceFile);

    for (const [name, baseNode] of baseFns) {
      const leftNode = leftFns.get(name);
      const rightNode = rightFns.get(name);
      const mergeNode = mergeFns.get(name);
      if (!leftNode || !rightNode || !mergeNode) continue;
      const baseHash = baseV.fingerprints.deep(baseNode);
      if (leftV.fingerprints.deep(leftNode) === baseHash) continue;
      if (rightV.fingerprints.deep(rightNode) === baseHash) continue;
      units.push({
        file,
        name,
        key: `${file}#${name}`,
        line: startLine(mergeNode, mergeV.sourceFile),
        endLine: endLine(mergeNode, mergeV.sourceFile),
      });
    }
  }
  return units;
}
