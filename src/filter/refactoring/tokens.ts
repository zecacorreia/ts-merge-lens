import ts from 'typescript';
import { nodeAttributes } from '../../ast/fingerprint.js';
import { childNodes } from '../../ast/units.js';
import type { FunctionWithBody } from '../../scenario/functions.js';

export interface TokenOptions {
  /** Statement-level calls to these members are replaced by the callee's body (extract/inline). */
  expand?: ReadonlyMap<string, FunctionWithBody>;
  /** Single `const` variables with these names are replaced by their initializer. */
  inlineConsts?: ReadonlySet<string>;
  /** Member and global names to rewrite (new name -> old name). */
  rename?: ReadonlyMap<string, string>;
  /** Emit the function's own name as a placeholder (to compare a function with its renamed twin). */
  anonymizeName?: boolean;
  /** Nodes left out entirely, and nodes replaced by a named placeholder (file skeletons). */
  skip?: ReadonlySet<ts.Node>;
  placeholders?: ReadonlyMap<ts.Node, string>;
}

export interface Tokens {
  tokens: string[];
  /** Names of the functions whose calls were replaced by their bodies. */
  expanded: Set<string>;
  inlinedConsts: boolean;
  /**
   * A constant was dropped from the stream but never used, so it was not an extraction at all:
   * the code gained a (possibly effectful) declaration.
   */
  droppedUnusedConst: boolean;
  renamed: boolean;
  /** Names declared inside the function (parameters and variables). */
  locals: Set<string>;
}

const MAX_EXPANSION_DEPTH = 3;

function declaredNames(root: ts.Node, into: Set<string>): void {
  const addName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) into.add(name.text);
    else {
      for (const element of name.elements) {
        if (!ts.isOmittedExpression(element)) addName(element.name);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) addName(node.name);
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/**
 * A normalised token stream for comparing code that may differ only by a refactoring:
 * whitespace, comments, semicolons, parentheses and quote style are ignored, local names are
 * renamed by order of appearance, and optionally calls, constants and member names are rewritten.
 */
export function tokenize(root: ts.Node, options: TokenOptions = {}): Tokens {
  return new Emitter(options).run(root);
}

class Emitter {
  private out: string[] = [];
  private readonly locals = new Set<string>();
  private readonly substitutions = new Map<string, string[]>();
  private readonly expanded = new Set<string>();
  private inlinedConsts = false;
  private readonly definedConsts = new Set<string>();
  private readonly usedConsts = new Set<string>();
  private renamed = false;
  private depth = 0;

  constructor(private readonly options: TokenOptions) {}

  run(root: ts.Node): Tokens {
    declaredNames(root, this.locals);
    this.emit(root);
    // Local names become $0, $1, ... in order of first appearance.
    const numbering = new Map<string, number>();
    const tokens = this.out.map((token) => {
      if (!token.startsWith('local:')) return token;
      const name = token.slice('local:'.length);
      let number = numbering.get(name);
      if (number === undefined) {
        number = numbering.size;
        numbering.set(name, number);
      }
      return `$${number}`;
    });
    return {
      tokens,
      expanded: this.expanded,
      inlinedConsts: this.inlinedConsts,
      droppedUnusedConst: [...this.definedConsts].some((name) => !this.usedConsts.has(name)),
      renamed: this.renamed,
      locals: this.locals,
    };
  }

  private emit(node: ts.Node): void {
    const { skip, placeholders } = this.options;
    if (ts.isJSDoc(node) || skip?.has(node)) return;
    const placeholder = placeholders?.get(node);
    if (placeholder !== undefined) {
      this.out.push(`fn:${placeholder}`);
      return;
    }
    if (ts.isParenthesizedExpression(node)) {
      this.emit(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) {
      this.identifier(node.text, 'id');
      return;
    }
    if (ts.isStringLiteralLike(node)) {
      this.out.push(JSON.stringify(node.text));
      return;
    }
    if (ts.isVariableStatement(node) && this.inlineConst(node)) return;
    if (ts.isExpressionStatement(node) && this.expandCall(node)) return;

    this.out.push(`(${ts.SyntaxKind[node.kind]}${nodeAttributes(node)}`);
    if (ts.isPropertyAccessExpression(node)) {
      this.emit(node.expression);
      this.identifier(node.name.text, 'prop');
    } else {
      const children = childNodes(node);
      if (children.length === 0) this.out.push(node.getText());
      for (const child of children) this.emitChild(node, child);
    }
    this.out.push(')');
  }

  private emitChild(parent: ts.Node, child: ts.Node): void {
    if (
      this.options.anonymizeName &&
      ts.isIdentifier(child) &&
      (parent as { name?: ts.Node }).name === child &&
      ts.isFunctionLike(parent)
    ) {
      this.out.push('id:$self');
      return;
    }
    this.emit(child);
  }

  private identifier(text: string, kind: 'id' | 'prop'): void {
    const replacement = this.substitutions.get(text);
    if (kind === 'id' && replacement) {
      this.usedConsts.add(text);
      this.out.push(...replacement);
      return;
    }
    if (kind === 'id' && this.locals.has(text)) {
      this.out.push(`local:${text}`);
      return;
    }
    const renamed = this.options.rename?.get(text);
    if (renamed !== undefined) this.renamed = true;
    this.out.push(`${kind}:${renamed ?? text}`);
  }

  /** `const name = init;` where `name` is to be inlined: remember `init`, emit nothing. */
  private inlineConst(statement: ts.VariableStatement): boolean {
    const { declarations, flags } = statement.declarationList;
    const [declaration] = declarations;
    if (declarations.length !== 1 || !declaration || !(flags & ts.NodeFlags.Const)) return false;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return false;
    if (!this.options.inlineConsts?.has(declaration.name.text)) return false;
    this.substitutions.set(declaration.name.text, this.capture(declaration.initializer));
    this.definedConsts.add(declaration.name.text);
    this.inlinedConsts = true;
    return true;
  }

  /** `this.f(args);` / `f(args);` where `f` is to be expanded: emit the body of `f` instead. */
  private expandCall(statement: ts.ExpressionStatement): boolean {
    let expression = statement.expression;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (!ts.isCallExpression(expression) || this.depth >= MAX_EXPANSION_DEPTH) return false;
    const callee = expression.expression;
    let name: string | undefined;
    if (ts.isIdentifier(callee)) name = callee.text;
    else if (
      ts.isPropertyAccessExpression(callee) &&
      callee.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      name = callee.name.text;
    }
    const target = name === undefined ? undefined : this.options.expand?.get(name);
    if (name === undefined || !target) return false;

    const saved = new Map(this.substitutions);
    target.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const argument = expression.arguments[index];
      this.substitutions.set(
        parameter.name.text,
        argument ? this.capture(argument) : ['undefined'],
      );
    });
    declaredNames(target.body, this.locals);
    this.depth++;
    if (ts.isBlock(target.body)) for (const inner of target.body.statements) this.emit(inner);
    else this.emit(target.body);
    this.depth--;
    this.substitutions.clear();
    for (const [key, value] of saved) this.substitutions.set(key, value);
    this.expanded.add(name);
    return true;
  }

  private capture(node: ts.Node): string[] {
    const outer = this.out;
    this.out = [];
    this.emit(node);
    const captured = this.out;
    this.out = outer;
    return captured;
  }
}

/** The member name of an `extractFunctions` key: `Class.method` -> `method`, `Class.get p` -> `p`. */
export function simpleName(qualified: string): string {
  const last = qualified.split('.').at(-1) ?? qualified;
  return last.replace(/^(get|set) /, '').replace(/#\d+$/, '');
}
