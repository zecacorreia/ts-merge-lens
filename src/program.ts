import fs from 'node:fs';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { ANALYSES, UsageError, analyze, scanMerges } from './pipeline.js';
import type { AnalysisName, ScenarioSource } from './pipeline.js';
import { renderReport } from './report/format.js';
import type { ReportFormat } from './report/format.js';
import { VERSION } from './version.js';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const processIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Exit codes: 0 no alerts, 1 alerts found, 2 execution error. */
export const EXIT = { clean: 0, alerts: 1, error: 2 } as const;

interface AnalyzeFlags {
  repo?: string;
  merge?: string;
  base?: string;
  left?: string;
  right?: string;
  mergeDir?: string;
  entry?: string;
  depth: number;
  analyses: AnalysisName[];
  refactoringFilter: 'off' | 'downgrade' | 'suppress';
  format: ReportFormat;
  out?: string;
}

interface ScanFlags {
  repo: string;
  since?: string;
  format: ReportFormat;
}

function parseDepth(value: string): number {
  const depth = Number(value);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new InvalidArgumentError('must be a non-negative integer');
  }
  return depth;
}

function parseAnalyses(value: string): AnalysisName[] {
  return value.split(',').map((name) => {
    const found = ANALYSES.find((analysis) => analysis === name.trim());
    if (!found)
      throw new InvalidArgumentError(`unknown analysis '${name}' (use ${ANALYSES.join(',')})`);
    return found;
  });
}

function sourceOf(flags: AnalyzeFlags): ScenarioSource {
  const { repo, merge, base, left, right, mergeDir } = flags;
  const gitMode = repo !== undefined || merge !== undefined;
  const dirsMode = [base, left, right, mergeDir].some((dir) => dir !== undefined);
  if (gitMode === dirsMode) {
    throw new UsageError(
      'use either --repo with --merge, or --base, --left, --right and --merge-dir',
    );
  }
  if (gitMode) {
    if (repo === undefined || merge === undefined) {
      throw new UsageError('--repo and --merge must be used together');
    }
    return { kind: 'git', repo, merge };
  }
  if (base === undefined || left === undefined || right === undefined || mergeDir === undefined) {
    throw new UsageError('--base, --left, --right and --merge-dir must be used together');
  }
  return { kind: 'dirs', dirs: { base, left, right, merge: mergeDir } };
}

function formatOption(choices: readonly string[]): Option {
  return new Option('--format <format>', 'output format').choices(choices).default('text');
}

export async function run(argv: readonly string[], io: Io = processIo): Promise<number> {
  let exitCode: number = EXIT.clean;
  const program = new Command()
    .name('tsmergelens')
    .description('Detects semantic interferences in merges of TypeScript projects')
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  program
    .command('analyze')
    .description('analyze one merge scenario')
    .option('--repo <path>', 'git repository')
    .option('--merge <sha>', 'merge commit to analyze')
    .option('--base <dir>', 'Base version (directory mode)')
    .option('--left <dir>', 'Left version (directory mode)')
    .option('--right <dir>', 'Right version (directory mode)')
    .option('--merge-dir <dir>', 'Merge version (directory mode)')
    .option('--entry <file#function>', 'restrict the analysis to one function')
    .option(
      '--depth <n>',
      'call depth followed by the OA analysis (0 = intraprocedural)',
      parseDepth,
      5,
    )
    .option('--analyses <list>', 'analyses to run: oa,df,cf,build', parseAnalyses, [...ANALYSES])
    .addOption(
      new Option('--refactoring-filter <mode>', 'treatment of refactoring-only changes')
        .choices(['off', 'downgrade', 'suppress'])
        .default('downgrade'),
    )
    .addOption(formatOption(['text', 'json', 'sarif']))
    .option('--out <file>', 'write the report to a file instead of stdout')
    .action((flags: AnalyzeFlags) => {
      const report = analyze({
        source: sourceOf(flags),
        depth: flags.depth,
        analyses: flags.analyses,
        refactoringFilter: flags.refactoringFilter,
        ...(flags.entry === undefined ? {} : { entry: flags.entry }),
      });
      const text = renderReport(report, flags.format);
      if (flags.out === undefined) io.out(text);
      else fs.writeFileSync(flags.out, text);
      exitCode = report.alerts.length > 0 ? EXIT.alerts : EXIT.clean;
    });

  program
    .command('scan')
    .description('list merge commits that are candidates for analysis')
    .requiredOption('--repo <path>', 'git repository')
    .option('--since <date>', 'only merges after this date')
    .addOption(formatOption(['text', 'json']))
    .action((flags: ScanFlags) => {
      const candidates = scanMerges(flags.repo, flags.since);
      if (flags.format === 'json') {
        io.out(`${JSON.stringify(candidates, null, 2)}\n`);
      } else {
        for (const c of candidates) {
          io.out(`${c.sha.slice(0, 10)}  ${c.date}  ${c.subject}  (${c.units.length} functions)\n`);
        }
        io.out(`${candidates.length} candidate merge(s)\n`);
      }
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.clean : EXIT.error;
    io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.error;
  }
  return exitCode;
}
