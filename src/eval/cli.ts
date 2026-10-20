import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { parseCsv } from './csv.js';
import { mineRepo } from './mine.js';
import type { CompileRequirement, Funnel, MinedMerge } from './mine.js';
import { evaluate, renderMarkdown } from './report.js';
import type { MinConfidence } from './report.js';
import { CONFIG_NAMES, runEvaluation } from './runner.js';
import type { RunFile } from './runner.js';
import { buildSheet } from './sheet.js';

export interface MinedFile {
  generatedAt: string;
  funnels: Array<{ repo: string; funnel: Funnel }>;
  merges: MinedMerge[];
}

const USAGE = `usage: node eval/eval.mjs <command> [options]

  mine     --repo <path> [--repo <path> ...] [--since <date>] [--limit <n>] [--seed <n>]
           [--require-compile all|base|none] --out candidates.json
  sheet    --candidates candidates.json --out labels.csv [--update]
  run      --candidates candidates.json --out results.json [--configs B0,B1,B2,B3]
           [--repetitions 10] [--labels labels.csv]
  metrics  --labels labels.csv --results results.json [--min-confidence low|medium] [--out report.md]
`;

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`missing --${name}\n\n${USAGE}`);
  return value;
}

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`--${name} must be a non-negative integer`);
  return parsed;
}

export function evalMain(argv: readonly string[], log: (line: string) => void = console.log): void {
  const [command, ...rest] = argv;
  switch (command) {
    case 'mine':
      mine(rest, log);
      break;
    case 'sheet':
      sheet(rest, log);
      break;
    case 'run':
      run(rest, log);
      break;
    case 'metrics':
      metrics(rest, log);
      break;
    default:
      throw new Error(USAGE);
  }
}

function mine(args: readonly string[], log: (line: string) => void): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      repo: { type: 'string', multiple: true },
      since: { type: 'string' },
      limit: { type: 'string' },
      seed: { type: 'string' },
      'require-compile': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const out = required(values.out, 'out');
  const repos = values.repo ?? [];
  if (repos.length === 0) throw new Error(`missing --repo\n\n${USAGE}`);
  const requireCompile = (values['require-compile'] ?? 'all') as CompileRequirement;
  if (!['all', 'base', 'none'].includes(requireCompile)) {
    throw new Error('--require-compile must be all, base or none');
  }

  const file: MinedFile = { generatedAt: new Date().toISOString(), funnels: [], merges: [] };
  for (const repoPath of repos) {
    log(`mining ${repoPath}`);
    const limit = integer(values.limit, 'limit');
    const seed = integer(values.seed, 'seed');
    const { merges, funnel } = mineRepo({
      repoPath,
      requireCompile,
      ...(values.since === undefined ? {} : { since: values.since }),
      ...(limit === undefined ? {} : { limit }),
      ...(seed === undefined ? {} : { seed }),
    });
    file.merges.push(...merges);
    file.funnels.push({ repo: merges[0]?.repo ?? repoPath, funnel });
    log(JSON.stringify(funnel));
  }
  fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  log(`${file.merges.length} scenario(s) written to ${out}`);
}

function sheet(args: readonly string[], log: (line: string) => void): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      candidates: { type: 'string' },
      out: { type: 'string' },
      update: { type: 'boolean' },
    },
  });
  const out = required(values.out, 'out');
  const mined = readJson(required(values.candidates, 'candidates')) as MinedFile;
  const exists = fs.existsSync(out);
  if (exists && !values.update) {
    throw new Error(`${out} exists; pass --update to add new scenarios keeping the labels in it`);
  }
  fs.writeFileSync(
    out,
    buildSheet(mined.merges, exists ? fs.readFileSync(out, 'utf8') : undefined),
  );
  log(`sheet written to ${out}`);
}

function run(args: readonly string[], log: (line: string) => void): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      candidates: { type: 'string' },
      out: { type: 'string' },
      configs: { type: 'string' },
      repetitions: { type: 'string' },
      labels: { type: 'string' },
    },
  });
  const mined = readJson(required(values.candidates, 'candidates')) as MinedFile;
  const configs = (values.configs ?? CONFIG_NAMES.join(',')).split(',').map((name) => {
    const found = CONFIG_NAMES.find((candidate) => candidate === name.trim());
    if (!found) throw new Error(`unknown configuration '${name}' (use ${CONFIG_NAMES.join(',')})`);
    return found;
  });
  let merges = mined.merges;
  if (values.labels) {
    // Only run what will be scored: skip scenarios the reviewers have not labelled.
    const labelled = new Set(
      parseCsv(fs.readFileSync(values.labels, 'utf8'))
        .filter(
          (row) =>
            (row.consensus ?? '') !== '' ||
            ((row.reviewer1 ?? '') !== '' && row.reviewer1 === row.reviewer2),
        )
        .map((row) => row.id),
    );
    merges = merges.filter((merge) => labelled.has(merge.id));
  }
  const repetitions = integer(values.repetitions, 'repetitions');
  const results = runEvaluation({
    merges,
    configs,
    ...(repetitions === undefined ? {} : { repetitions }),
    onProgress: (message) => {
      log(`running ${message}`);
    },
  });
  fs.writeFileSync(required(values.out, 'out'), `${JSON.stringify(results, null, 2)}\n`);
  log(`${results.records.length} record(s) written`);
}

function metrics(args: readonly string[], log: (line: string) => void): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      labels: { type: 'string' },
      results: { type: 'string' },
      'min-confidence': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const minConfidence = (values['min-confidence'] ?? 'low') as MinConfidence;
  if (!['low', 'medium'].includes(minConfidence))
    throw new Error('--min-confidence must be low or medium');
  const rows = parseCsv(fs.readFileSync(required(values.labels, 'labels'), 'utf8'));
  const evaluation = evaluate(
    rows,
    readJson(required(values.results, 'results')) as RunFile,
    minConfidence,
  );
  const markdown = renderMarkdown(evaluation);
  if (values.out) fs.writeFileSync(values.out, markdown);
  log(markdown);
}
