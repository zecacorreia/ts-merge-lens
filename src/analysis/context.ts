import path from 'node:path';
import ts from 'typescript';
import type { FileAnnotation, ScenarioAnnotation } from '../annotate/annotate.js';
import { Limitations } from '../limitations.js';
import type { ChangedUnit } from '../scenario/changed-units.js';
import { asFunctionWithBody, extractFunctions } from '../scenario/functions.js';
import type { FunctionWithBody } from '../scenario/functions.js';
import { ElementResolver } from '../state/resolve.js';
import type { Frame } from '../state/resolve.js';
import { toPosix } from '../util/files.js';
import { CallResolver } from './calls.js';

/** Who answers for a piece of code: Left, Right, or neither (Base). */
export type Label = 'Base' | 'L' | 'R';

export interface AnalysisInput {
  /** TypeScript program of the Merge version. */
  program: ts.Program;
  mergeDir: string;
  annotation: ScenarioAnnotation;
  /** How state elements are identified: by resolved symbol (default) or by bare name (baseline). */
  identity?: 'symbol' | 'name';
}

export interface JumpTarget<S> {
  kind: 'loop' | 'switch';
  breaks: S[];
  continues: S[];
}

/** One execution of a function body: the entry unit, or a callee inlined into it. */
export interface Activation<S> {
  fn: FunctionWithBody;
  name: string;
  frame: Frame;
  /** Label of the call site that led here; Base statements of the callee inherit it. */
  context: Label;
  depth: number;
  callChain: readonly string[];
  returns: S[];
  jumpTargets: Array<JumpTarget<S>>;
  /** Functions being analysed, shared along a call chain, to cut recursion. */
  stack: Set<ts.Node>;
}

/** What every analysis of one scenario shares: the checker, annotations and limitations. */
export class AnalysisContext {
  readonly checker: ts.TypeChecker;
  readonly limits: Limitations;
  readonly resolver: ElementResolver;
  readonly calls: CallResolver;
  private readonly annotations = new Map<string, FileAnnotation>();
  private readonly names = new WeakMap<ts.SourceFile, Map<ts.Node, string>>();

  constructor(readonly input: AnalysisInput) {
    this.checker = input.program.getTypeChecker();
    this.limits = new Limitations(input.mergeDir);
    this.resolver = new ElementResolver(
      this.checker,
      (kind, node) => {
        this.limits.add(kind, node);
      },
      input.identity ?? 'symbol',
    );
    this.calls = new CallResolver(input.program, this.checker);
    for (const file of input.annotation.files) this.annotations.set(file.file, file);
  }

  /** Path of a source file relative to the Merge directory, POSIX style. */
  relative(sourceFile: ts.SourceFile): string {
    return toPosix(path.relative(this.input.mergeDir, sourceFile.fileName));
  }

  /**
   * Who is responsible for the statement containing `node`: its own origin if Left or Right
   * changed it, otherwise `inherited`, the label of the call site being executed (Base on top).
   */
  labelAt(node: ts.Node, inherited: Label): Label {
    const sourceFile = node.getSourceFile();
    const origin = this.annotations
      .get(this.relative(sourceFile))
      ?.originAt(node.getStart(sourceFile));
    return origin === 'L' || origin === 'R' ? origin : inherited;
  }

  /** `file:line` of a node. */
  describe(node: ts.Node): string {
    const sourceFile = node.getSourceFile();
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${this.relative(sourceFile)}:${line + 1}`;
  }

  functionName(fn: ts.Node): string {
    const sourceFile = fn.getSourceFile();
    let names = this.names.get(sourceFile);
    if (!names) {
      names = new Map();
      for (const [name, node] of extractFunctions(sourceFile)) {
        names.set(node, name);
        const withBody = asFunctionWithBody(node);
        if (withBody) names.set(withBody, name);
      }
      this.names.set(sourceFile, names);
    }
    return names.get(fn) ?? '<anonymous>';
  }

  /** The function of a unit in the Merge program, if the program contains it. */
  locate(unit: ChangedUnit): FunctionWithBody | undefined {
    const sourceFile = this.input.program.getSourceFile(path.join(this.input.mergeDir, unit.file));
    return asFunctionWithBody(sourceFile && extractFunctions(sourceFile).get(unit.name));
  }
}

/** The frame of an entry function: `this` and the parameters stand for themselves. */
export function entryFrame(): Frame {
  return { thisElement: { root: 'this', path: [], lowConfidence: false }, params: new Map() };
}
