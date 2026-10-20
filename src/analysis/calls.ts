import fs from 'node:fs';
import ts from 'typescript';
import { asFunctionWithBody } from '../scenario/functions.js';
import type { FunctionWithBody } from '../scenario/functions.js';

export type CallNode = ts.CallExpression | ts.NewExpression;

export type ResolvedCall =
  /** Library code or a default constructor: assumed not to touch project state. */
  | { kind: 'external' }
  /** Should be project code, but no body could be found (any-typed callee, interface method). */
  | { kind: 'unresolved' }
  | { kind: 'targets'; targets: FunctionWithBody[] };

function skipParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Finds the function bodies a call may run, with the checker and, for dispatch, the language service. */
export class CallResolver {
  private service: ts.LanguageService | undefined;

  constructor(
    private readonly program: ts.Program,
    private readonly checker: ts.TypeChecker,
  ) {}

  resolve(node: CallNode): ResolvedCall {
    const declaration = this.checker.getResolvedSignature(node)?.declaration;
    if (declaration === undefined) {
      return ts.isNewExpression(node) ? { kind: 'external' } : { kind: 'unresolved' };
    }
    const sourceFile = declaration.getSourceFile();
    if (sourceFile.isDeclarationFile || this.program.isSourceFileFromExternalLibrary(sourceFile)) {
      return { kind: 'external' };
    }
    if (ts.isNewExpression(node) && ts.isClassLike(declaration)) return { kind: 'external' };

    const direct = asFunctionWithBody(declaration);
    if (direct) return { kind: 'targets', targets: [direct] };

    // An overload signature or an abstract/interface member: find implementations.
    const callee = skipParentheses(node.expression);
    const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    const symbol = this.checker.getSymbolAtLocation(nameNode);
    const own = (symbol?.declarations ?? [])
      .map((candidate) => asFunctionWithBody(candidate))
      .filter((fn): fn is FunctionWithBody => fn !== undefined);
    if (own.length > 0) return { kind: 'targets', targets: own };

    const implementations = this.implementations(nameNode);
    return implementations.length > 0
      ? { kind: 'targets', targets: implementations }
      : { kind: 'unresolved' };
  }

  /** Dynamic dispatch: the implementations the language service finds for a member name. */
  private implementations(nameNode: ts.Node): FunctionWithBody[] {
    const sourceFile = nameNode.getSourceFile();
    const found = this.languageService().getImplementationAtPosition(
      sourceFile.fileName,
      nameNode.getStart(sourceFile),
    );
    const targets = new Map<ts.Node, FunctionWithBody>();
    for (const location of found ?? []) {
      const implFile = this.program.getSourceFile(location.fileName);
      if (!implFile) continue;
      const fn = enclosingFunction(implFile, location.textSpan.start);
      if (fn) targets.set(fn, fn);
    }
    return [...targets.values()];
  }

  private languageService(): ts.LanguageService {
    if (this.service) return this.service;
    const options = this.program.getCompilerOptions();
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...this.program.getRootFileNames()],
      getScriptVersion: () => '1',
      getScriptSnapshot: (fileName) => {
        const text = fs.existsSync(fileName) ? ts.sys.readFile(fileName) : undefined;
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.program.getCurrentDirectory(),
      getCompilationSettings: () => options,
      getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
      fileExists: (fileName) => ts.sys.fileExists(fileName),
      readFile: (fileName) => ts.sys.readFile(fileName),
      readDirectory: (...args) => ts.sys.readDirectory(...args),
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return this.service;
  }
}

/** The function-like declaration with a body that contains `position`. */
function enclosingFunction(
  sourceFile: ts.SourceFile,
  position: number,
): FunctionWithBody | undefined {
  let innermost: ts.Node = sourceFile;
  for (;;) {
    const child = ts.forEachChild(innermost, (candidate) =>
      candidate.getStart(sourceFile) <= position && position < candidate.getEnd()
        ? candidate
        : undefined,
    );
    if (!child) break;
    innermost = child;
  }
  let node: ts.Node = innermost;
  for (;;) {
    const fn = asFunctionWithBody(node);
    if (fn) return fn;
    if (ts.isSourceFile(node)) break;
    node = node.parent;
  }
  return undefined;
}
