import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { listSourceFiles, toPosix } from '../util/files.js';
import type { ScenarioDirs } from '../scenario/scenario.js';

export interface BuildDiagnostic {
  /** Path relative to the compiled directory; absent for global diagnostics. */
  file?: string;
  /** 1-based. */
  line?: number;
  column?: number;
  code: number;
  message: string;
}

/** Used when a version has no `tsconfig.json` at its root. */
const FALLBACK_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
};

/** Overrides that make `tsc --noEmit` safe to run on a throwaway checkout. */
const FORCED_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  incremental: false,
  composite: false,
};

function toDiagnostic(dir: string, diagnostic: ts.Diagnostic): BuildDiagnostic {
  const result: BuildDiagnostic = {
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  };
  if (diagnostic.file) {
    result.file = toPosix(path.relative(dir, diagnostic.file.fileName));
    if (diagnostic.start !== undefined) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      result.line = line + 1;
      result.column = character + 1;
    }
  }
  return result;
}

/**
 * Parsed standard-library files shared by the compilations of one scenario: the four versions
 * use the same `lib.*.d.ts`, and parsing them dominates the cost of creating a program.
 */
export type LibraryCache = Map<string, ts.SourceFile | undefined>;

function hostWithLibraryCache(options: ts.CompilerOptions, cache: LibraryCache): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const libDir = path.dirname(ts.getDefaultLibFilePath(options));
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    if (path.dirname(fileName) !== libDir) {
      return getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
    }
    const key = `${fileName}|${JSON.stringify(languageVersionOrOptions)}`;
    if (!cache.has(key)) {
      cache.set(key, getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate));
    }
    return cache.get(key);
  };
  return host;
}

/** Standard-library files never change, so one cache serves the whole process. */
const sharedLibraries: LibraryCache = new Map();

export interface DirProgram {
  program: ts.Program;
  /** Problems found while reading `tsconfig.json`. */
  configErrors: readonly ts.Diagnostic[];
}

/** The program `tsc -p <dir>` would build: its `tsconfig.json`, or a strict default. */
export function createDirProgram(
  dir: string,
  libraries: LibraryCache = sharedLibraries,
): DirProgram {
  const configPath = path.join(dir, 'tsconfig.json');
  let rootNames: string[];
  let options: ts.CompilerOptions;
  let configErrors: readonly ts.Diagnostic[] = [];

  if (fs.existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
    if (config.error) {
      rootNames = [];
      options = { ...FALLBACK_OPTIONS, ...FORCED_OPTIONS };
      configErrors = [config.error];
      return { program: ts.createProgram({ rootNames, options }), configErrors };
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dir,
      FORCED_OPTIONS,
      configPath,
    );
    rootNames = parsed.fileNames;
    options = { ...parsed.options, ...FORCED_OPTIONS };
    configErrors = parsed.errors;
  } else {
    rootNames = listSourceFiles(dir).map((file) => path.join(dir, file));
    options = { ...FALLBACK_OPTIONS, ...FORCED_OPTIONS };
  }

  const program = ts.createProgram({
    rootNames,
    options,
    host: hostWithLibraryCache(options, libraries),
  });
  return { program, configErrors };
}

/** Equivalent of `tsc --noEmit -p <dir>` through the compiler API. */
export function compileDir(dir: string, existing?: DirProgram): BuildDiagnostic[] {
  const { program, configErrors } = existing ?? createDirProgram(dir);
  return [...configErrors, ...ts.getPreEmitDiagnostics(program)].map((d) => toDiagnostic(dir, d));
}

function signature(diagnostic: BuildDiagnostic): string {
  return `${diagnostic.file ?? ''}|${diagnostic.code}|${diagnostic.message}`;
}

function countBySignature(diagnostics: readonly BuildDiagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const key = signature(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Diagnostics of the Merge that none of Base, Left or Right has. Diagnostics are compared by
 * file, code and message (not position, which shifts across versions); when the Merge has more
 * occurrences of a diagnostic than any single other version, the extra ones are reported.
 * Errors that every version shares (e.g. missing `node_modules`) therefore never show up.
 */
export function mergeOnlyDiagnostics(
  versions: Record<keyof ScenarioDirs, readonly BuildDiagnostic[]>,
): BuildDiagnostic[] {
  const others = [versions.base, versions.left, versions.right].map(countBySignature);
  const seen = new Map<string, number>();
  const introduced: BuildDiagnostic[] = [];
  for (const diagnostic of versions.merge) {
    const key = signature(diagnostic);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    const inOthers = Math.max(...others.map((counts) => counts.get(key) ?? 0));
    if (occurrence > inOthers) introduced.push(diagnostic);
  }
  return introduced;
}

/** Static (build) conflicts: compilation errors that only the merge introduces. */
export function findBuildConflicts(dirs: ScenarioDirs, merge?: DirProgram): BuildDiagnostic[] {
  return mergeOnlyDiagnostics({
    base: compileDir(dirs.base),
    left: compileDir(dirs.left),
    right: compileDir(dirs.right),
    merge: compileDir(dirs.merge, merge),
  });
}
