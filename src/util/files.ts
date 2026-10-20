import fs from 'node:fs';
import path from 'node:path';

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/** `.ts`/`.tsx` sources, excluding declaration files. */
export function isAnalyzableSource(fileName: string): boolean {
  return /\.tsx?$/.test(fileName) && !/\.d\.ts$/.test(fileName);
}

/** Relative POSIX paths of the analyzable sources under `root`, sorted. */
export function listSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(entryRel);
      } else if (entry.isFile() && isAnalyzableSource(entry.name)) {
        found.push(entryRel);
      }
    }
  };
  walk('');
  return found.sort();
}

export function readTextIfExists(root: string, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Indexed access that fails loudly instead of yielding `undefined`. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index ${index} out of range (length ${items.length})`);
  return item;
}
