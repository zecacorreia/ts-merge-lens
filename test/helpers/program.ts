import path from 'node:path';
import ts from 'typescript';
import { AnalysisContext } from '../../src/analysis/context.js';
import { createDirProgram } from '../../src/build/build.js';
import { asFunctionWithBody, extractFunctions } from '../../src/scenario/functions.js';
import type { FunctionWithBody } from '../../src/scenario/functions.js';
import { TSCONFIG } from './canonical.js';
import { makeTempDir, writeFiles } from './fixture-repo.js';

/** A TypeScript program over `files` (relative path -> source), with an analysis context. */
export function programOf(files: Record<string, string>): {
  dir: string;
  program: ts.Program;
  context: AnalysisContext;
  functionNamed: (name: string, file?: string) => FunctionWithBody;
  sourceFile: (file?: string) => ts.SourceFile;
} {
  const dir = makeTempDir();
  writeFiles(dir, { 'tsconfig.json': TSCONFIG, ...files });
  const { program } = createDirProgram(dir);
  const context = new AnalysisContext({ program, mergeDir: dir, annotation: { files: [] } });
  const sourceFile = (file = 'src/main.ts'): ts.SourceFile => {
    const found = program.getSourceFile(path.join(dir, file));
    if (!found) throw new Error(`no source file ${file}`);
    return found;
  };
  const functionNamed = (name: string, file = 'src/main.ts'): FunctionWithBody => {
    const fn = asFunctionWithBody(extractFunctions(sourceFile(file)).get(name));
    if (!fn) throw new Error(`no function ${name}`);
    return fn;
  };
  return { dir, program, context, functionNamed, sourceFile };
}

/** All call and new expressions inside `root`, in source order. */
export function callsIn(root: ts.Node): Array<ts.CallExpression | ts.NewExpression> {
  const found: Array<ts.CallExpression | ts.NewExpression> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}
