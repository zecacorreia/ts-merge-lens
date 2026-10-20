import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TSCONFIG } from './canonical.js';
import { makeTempDir, writeFiles } from './fixture-repo.js';

/**
 * Oracle file format (`test/oracles/**\/*.oracle`):
 *
 *     # free-text description
 *     --- expect
 *     {"depth": 5, "alerts": [{"element": "x", "first": "Left f", "second": "Right g"}]}
 *     --- base [path]      (path defaults to src/main.ts)
 *     ...
 *     --- left [path]      (files not listed are the same as in base)
 *     --- right [path]
 *     --- merge [path]     (optional; by default computed with `git merge-file`)
 *
 * `first` is the overwritten write and `second` the overriding one, as "<Branch> <function>".
 */
export interface OracleAlert {
  /** Defaults to OA. For DF/CF, `first` is the source and `second` the sink. */
  type?: 'OA' | 'DF' | 'CF';
  /** Empty for a CF whose condition itself was changed. */
  element?: string;
  first: string;
  second: string;
  confidence?: 'high' | 'medium' | 'low';
}

export interface OracleExpectation {
  depth?: number;
  /** Analyses to run; defaults to OA only. */
  analyses?: Array<'oa' | 'df' | 'cf'>;
  alerts: OracleAlert[];
  /** Expected alerts per refactoring-filter mode; when absent the case runs with `downgrade`. */
  byFilter?: Partial<Record<'off' | 'downgrade' | 'suppress', OracleAlert[]>>;
  /** Limitation kinds that must appear in the report. */
  limitations?: string[];
}

export interface OracleCase {
  name: string;
  description: string;
  expect: OracleExpectation;
  dirs: { base: string; left: string; right: string; merge: string };
}

const HEADER = /^--- (expect|base|left|right|merge)(?: (\S+))?$/;
const DEFAULT_PATH = 'src/main.ts';

type Versions = Record<'base' | 'left' | 'right' | 'merge', Map<string, string>>;

function parse(text: string): { description: string; expect: string; versions: Versions } {
  const versions: Versions = {
    base: new Map(),
    left: new Map(),
    right: new Map(),
    merge: new Map(),
  };
  const description: string[] = [];
  let expect = '';
  let current: { kind: string; file: string; lines: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    const body = current.lines.join('\n');
    if (current.kind === 'expect') expect = body;
    else
      versions[current.kind as keyof Versions].set(current.file, `${body.replace(/\n+$/, '')}\n`);
  };

  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      flush();
      current = { kind: header[1] ?? '', file: header[2] ?? DEFAULT_PATH, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else if (line.startsWith('#')) {
      description.push(line.replace(/^#\s?/, ''));
    }
  }
  flush();
  return { description: description.join(' '), expect, versions };
}

/** Three-way textual merge of one file, exactly what git does for a clean merge. */
function mergeFile(dir: string, base: string, left: string, right: string): string {
  const write = (name: string, content: string): string => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, content);
    return target;
  };
  const result = spawnSync('git', [
    'merge-file',
    '-p',
    write('left.txt', left),
    write('base.txt', base),
    write('right.txt', right),
  ]);
  if (result.status !== 0) {
    throw new Error(`oracle has a textual conflict (git merge-file exit ${result.status})`);
  }
  return result.stdout.toString('utf8');
}

export function loadOracle(file: string): OracleCase {
  const { description, expect, versions } = parse(fs.readFileSync(file, 'utf8'));
  const root = makeTempDir('tsmergelens-oracle-');
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch);
  const config = JSON.stringify({
    ...(JSON.parse(TSCONFIG) as object),
  });

  const paths = new Set([
    ...versions.base.keys(),
    ...versions.left.keys(),
    ...versions.right.keys(),
    ...versions.merge.keys(),
  ]);
  const dirs = {
    base: path.join(root, 'base'),
    left: path.join(root, 'left'),
    right: path.join(root, 'right'),
    merge: path.join(root, 'merge'),
  };
  for (const dir of Object.values(dirs)) writeFiles(dir, { 'tsconfig.json': config });

  for (const rel of paths) {
    const base = versions.base.get(rel);
    if (base === undefined) throw new Error(`${file}: ${rel} has no base version`);
    const left = versions.left.get(rel) ?? base;
    const right = versions.right.get(rel) ?? base;
    const merge = versions.merge.get(rel) ?? mergeFile(scratch, base, left, right);
    writeFiles(dirs.base, { [rel]: base });
    writeFiles(dirs.left, { [rel]: left });
    writeFiles(dirs.right, { [rel]: right });
    writeFiles(dirs.merge, { [rel]: merge });
  }

  return {
    name: path.basename(file, '.oracle'),
    description,
    expect: JSON.parse(expect) as OracleExpectation,
    dirs,
  };
}

export function listOracleFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.oracle')) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}
