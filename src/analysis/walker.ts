import ts from 'typescript';
import type { StateElement } from '../state/element.js';
import type { CallNode } from './calls.js';
import type { Activation, AnalysisContext, JumpTarget } from './context.js';

/** The part of an abstract state the traversal needs: reachability, copying, overwriting. */
export interface WalkState<S> {
  dead: boolean;
  clone(): S;
  assign(other: S): void;
}

type Target = ts.Expression | ts.ShorthandPropertyAssignment;

function skipParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** The leaf targets of an assignment, looking through destructuring patterns. */
function assignmentTargets(left: ts.Expression): Target[] {
  const target = skipParentheses(left);
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property): Target[] => {
      if (ts.isPropertyAssignment(property)) return assignmentTargets(property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) return [property];
      if (ts.isSpreadAssignment(property)) return assignmentTargets(property.expression);
      return [];
    });
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element): Target[] => {
      if (ts.isOmittedExpression(element)) return [];
      return assignmentTargets(ts.isSpreadElement(element) ? element.expression : element);
    });
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentTargets(target.left); // `[a = 1] = ...`: a default value
  }
  return [target];
}

function boundIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : boundIdentifiers(element.name),
  );
}

/**
 * Walks the statements of a function in execution order, calling hooks for the state accesses it
 * finds. Branches are analysed on every path and joined, loops run their body once, `return` and
 * `throw` end a path. What to do at a write, a read or a call is up to the subclass.
 */
export abstract class FlowWalker<S extends WalkState<S>> {
  constructor(protected readonly ctx: AnalysisContext) {}

  protected abstract join(a: S, b: S): S;
  protected abstract unreachable(): S;
  /** `raw` is in terms of the function being walked; `site` is the statement part that writes. */
  protected abstract onWrite(raw: StateElement, site: ts.Node, act: Activation<S>, st: S): void;
  protected abstract onCall(node: CallNode, act: Activation<S>, st: S): void;
  /** Optional: reads matter only to some analyses. `raw` is as for `onWrite`. */
  protected onRead?(raw: StateElement, site: ts.Node, act: Activation<S>, st: S): void;

  /** Evaluates the condition of `owner` (an if, loop, switch, ...). */
  protected condition(
    condition: ts.Expression | undefined,
    _owner: ts.Node,
    act: Activation<S>,
    st: S,
  ): void {
    this.expression(condition, act, st);
  }

  /** Runs `run`, the code whose execution depends on the condition just evaluated for `owner`. */
  protected controlled(_owner: ts.Node, _act: Activation<S>, run: () => void): void {
    run();
  }

  /** Executes the body of the function of `act` on `st`, joining the states at its returns. */
  protected runBody(act: Activation<S>, st: S): void {
    const { fn } = act;
    if (
      (ts.canHaveDecorators(fn) && (ts.getDecorators(fn)?.length ?? 0) > 0) ||
      (ts.isClassLike(fn.parent) && (ts.getDecorators(fn.parent)?.length ?? 0) > 0)
    ) {
      this.ctx.limits.add('decorators', fn);
    }
    if (fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      this.ctx.limits.add('async-order', fn);
    }
    if (ts.isBlock(fn.body)) this.statement(fn.body, act, st);
    else this.expression(fn.body, act, st);
    for (const returned of act.returns) st.assign(this.join(st, returned));
  }

  // ---- statements ------------------------------------------------------------------------

  protected statement(node: ts.Statement, act: Activation<S>, st: S): void {
    if (st.dead) return;
    if (ts.isBlock(node)) {
      for (const inner of node.statements) this.statement(inner, act, st);
    } else if (ts.isExpressionStatement(node)) {
      this.expression(node.expression, act, st);
    } else if (ts.isVariableStatement(node)) {
      this.declarations(node.declarationList, act, st);
    } else if (ts.isIfStatement(node)) {
      this.condition(node.expression, node, act, st);
      this.controlled(node, act, () => {
        const thenState = st.clone();
        this.statement(node.thenStatement, act, thenState);
        const elseState = st.clone();
        if (node.elseStatement) this.statement(node.elseStatement, act, elseState);
        st.assign(this.join(thenState, elseState));
      });
    } else if (ts.isForStatement(node)) {
      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        this.declarations(node.initializer, act, st);
      } else {
        this.expression(node.initializer, act, st);
      }
      this.condition(node.condition, node, act, st);
      this.loop(node, node.statement, act, st, (bodyState) => {
        this.expression(node.incrementor, act, bodyState);
      });
    } else if (ts.isWhileStatement(node)) {
      this.condition(node.expression, node, act, st);
      this.loop(node, node.statement, act, st);
    } else if (ts.isDoStatement(node)) {
      this.doWhile(node, act, st);
    } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      this.condition(node.expression, node, act, st);
      this.loop(node, node.statement, act, st);
    } else if (ts.isSwitchStatement(node)) {
      this.switchStatement(node, act, st);
    } else if (ts.isTryStatement(node)) {
      this.tryStatement(node, act, st);
    } else if (ts.isReturnStatement(node)) {
      this.expression(node.expression, act, st);
      act.returns.push(st.clone());
      st.dead = true;
    } else if (ts.isThrowStatement(node)) {
      this.expression(node.expression, act, st);
      st.dead = true;
    } else if (ts.isBreakStatement(node)) {
      act.jumpTargets.at(-1)?.breaks.push(st.clone());
      st.dead = true;
    } else if (ts.isContinueStatement(node)) {
      const loop = [...act.jumpTargets].reverse().find((target) => target.kind === 'loop');
      loop?.continues.push(st.clone());
      st.dead = true;
    } else if (ts.isLabeledStatement(node)) {
      this.statement(node.statement, act, st);
    }
    // Declarations (functions, classes, types, imports) and empty statements have no effect.
  }

  /** The body runs zero or more times: the state after is the join of all the ways out. */
  private loop(
    owner: ts.Node,
    body: ts.Statement,
    act: Activation<S>,
    st: S,
    afterBody?: (bodyState: S) => void,
  ): void {
    const target: JumpTarget<S> = { kind: 'loop', breaks: [], continues: [] };
    act.jumpTargets.push(target);
    const bodyState = st.clone();
    this.controlled(owner, act, () => {
      this.statement(body, act, bodyState);
      for (const continued of target.continues) bodyState.assign(this.join(bodyState, continued));
      afterBody?.(bodyState);
    });
    act.jumpTargets.pop();
    let exit = this.join(st, bodyState);
    for (const broken of target.breaks) exit = this.join(exit, broken);
    st.assign(exit);
  }

  private doWhile(node: ts.DoStatement, act: Activation<S>, st: S): void {
    const target: JumpTarget<S> = { kind: 'loop', breaks: [], continues: [] };
    act.jumpTargets.push(target);
    this.statement(node.statement, act, st);
    for (const continued of target.continues) st.assign(this.join(st, continued));
    this.condition(node.expression, node, act, st);
    act.jumpTargets.pop();
    for (const broken of target.breaks) st.assign(this.join(st, broken));
  }

  private switchStatement(node: ts.SwitchStatement, act: Activation<S>, st: S): void {
    this.condition(node.expression, node, act, st);
    const entry = st.clone();
    const target: JumpTarget<S> = { kind: 'switch', breaks: [], continues: [] };
    act.jumpTargets.push(target);
    let carried = this.unreachable();
    const hasDefault = node.caseBlock.clauses.some((clause) => ts.isDefaultClause(clause));
    this.controlled(node, act, () => {
      for (const clause of node.caseBlock.clauses) {
        const start = this.join(entry, carried); // reached by the switch or by fall-through
        if (ts.isCaseClause(clause)) this.expression(clause.expression, act, start);

        for (const inner of clause.statements) this.statement(inner, act, start);
        carried = start;
      }
    });
    act.jumpTargets.pop();
    let exit = hasDefault ? carried : this.join(carried, entry);
    for (const broken of target.breaks) exit = this.join(exit, broken);
    st.assign(exit);
  }

  private tryStatement(node: ts.TryStatement, act: Activation<S>, st: S): void {
    const before = st.clone();
    const tried = st.clone();
    this.statement(node.tryBlock, act, tried);
    let after = tried;
    if (node.catchClause) {
      const caught = this.join(before, tried); // an exception may happen anywhere in the try
      this.statement(node.catchClause.block, act, caught);
      after = this.join(tried, caught);
    }
    if (node.finallyBlock) this.statement(node.finallyBlock, act, after);
    st.assign(after);
  }

  private declarations(list: ts.VariableDeclarationList, act: Activation<S>, st: S): void {
    for (const declaration of list.declarations) {
      if (!declaration.initializer) continue;
      this.expression(declaration.initializer, act, st);
      for (const name of boundIdentifiers(declaration.name)) {
        const root = this.ctx.resolver.rootOfDeclaration(name);
        if (!root) continue;
        this.onWrite({ root, path: [], lowConfidence: false }, declaration, act, st);
      }
    }
  }

  // ---- expressions -----------------------------------------------------------------------

  protected expression(node: ts.Node | undefined, act: Activation<S>, st: S): void {
    if (!node || st.dead) return;
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      this.ctx.limits.add('closure', node);
    } else if (ts.isTypeNode(node)) {
      // types have no run-time effect
    } else if (
      ts.isIdentifier(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      node.kind === ts.SyntaxKind.ThisKeyword
    ) {
      this.reference(node as ts.Expression, act, st);
    } else if (ts.isObjectLiteralExpression(node)) {
      this.objectLiteral(node, act, st);
    } else if (ts.isBinaryExpression(node)) {
      this.binary(node, act, st);
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      this.expression(node.operand, act, st);
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        this.writeTarget(node.operand, node, act, st);
      }
    } else if (ts.isDeleteExpression(node)) {
      this.targetOperands(node.expression, act, st);
      this.writeTarget(node.expression, node, act, st);
    } else if (ts.isConditionalExpression(node)) {
      this.condition(node.condition, node, act, st);
      this.controlled(node, act, () => {
        const whenTrue = st.clone();
        this.expression(node.whenTrue, act, whenTrue);
        const whenFalse = st.clone();
        this.expression(node.whenFalse, act, whenFalse);
        st.assign(this.join(whenTrue, whenFalse));
      });
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      this.call(node, act, st);
    } else {
      if (ts.isAwaitExpression(node)) this.ctx.limits.add('async-order', node);
      ts.forEachChild(node, (child) => {
        this.expression(child, act, st);
      });
    }
  }

  /** A read of a variable, field or element; the sub-expressions of the path are evaluated. */
  private reference(node: ts.Expression, act: Activation<S>, st: S): void {
    const raw = this.ctx.resolver.resolve(node);
    this.referenceOperands(node, act, st);
    // The bare receiver `this` is an object identity, not a read of any state.
    if (raw && !(raw.root === 'this' && raw.path.length === 0)) this.onRead?.(raw, node, act, st);
  }

  /** Evaluates what a reference expression computes on the way: keys and non-reference bases. */
  private referenceOperands(node: ts.Expression, act: Activation<S>, st: S): void {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      this.referenceOperands(node.expression, act, st);
    } else if (ts.isPropertyAccessExpression(node)) {
      this.referenceOperands(node.expression, act, st);
    } else if (ts.isElementAccessExpression(node)) {
      this.referenceOperands(node.expression, act, st);
      this.expression(node.argumentExpression, act, st);
    } else if (!ts.isIdentifier(node) && node.kind !== ts.SyntaxKind.ThisKeyword) {
      this.expression(node, act, st); // e.g. a call result used as a base
    }
  }

  private objectLiteral(node: ts.ObjectLiteralExpression, act: Activation<S>, st: S): void {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        if (ts.isComputedPropertyName(property.name)) {
          this.expression(property.name.expression, act, st);
        }
        this.expression(property.initializer, act, st);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const root = this.ctx.resolver.rootOfShorthand(property);
        if (root) this.onRead?.({ root, path: [], lowConfidence: false }, property, act, st);
      } else if (ts.isSpreadAssignment(property)) {
        this.expression(property.expression, act, st);
      } else {
        this.ctx.limits.add('closure', property); // methods and accessors
      }
    }
  }

  private binary(node: ts.BinaryExpression, act: Activation<S>, st: S): void {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.EqualsToken) {
      this.expression(node.right, act, st);
      for (const target of assignmentTargets(node.left)) {
        this.targetOperands(target, act, st);
        this.writeTarget(target, node, act, st);
      }
    } else if (
      operator > ts.SyntaxKind.FirstAssignment &&
      operator <= ts.SyntaxKind.LastAssignment
    ) {
      this.expression(node.left, act, st); // compound assignment: reads, then writes
      this.expression(node.right, act, st);
      this.writeTarget(node.left, node, act, st);
    } else if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      this.condition(node.left, node, act, st);
      this.controlled(node, act, () => {
        const right = st.clone(); // the right operand may not be evaluated
        this.expression(node.right, act, right);
        st.assign(this.join(st, right));
      });
    } else {
      this.expression(node.left, act, st);
      this.expression(node.right, act, st);
    }
  }

  /** Evaluates the sub-expressions of an assignment target (`a[f()]`, `g().x`). */
  private targetOperands(target: Target, act: Activation<S>, st: S): void {
    if (ts.isShorthandPropertyAssignment(target)) return;
    const inner = skipParentheses(target);
    if (ts.isPropertyAccessExpression(inner)) {
      this.referenceOperands(inner.expression, act, st);
    } else if (ts.isElementAccessExpression(inner)) {
      this.referenceOperands(inner.expression, act, st);
      this.expression(inner.argumentExpression, act, st);
    }
  }

  private writeTarget(target: Target, site: ts.Node, act: Activation<S>, st: S): void {
    let raw: StateElement | undefined;
    if (ts.isShorthandPropertyAssignment(target)) {
      const root = this.ctx.resolver.rootOfShorthand(target);
      raw = root && { root, path: [], lowConfidence: false };
    } else {
      raw = this.ctx.resolver.resolve(target);
    }
    if (raw) this.onWrite(raw, site, act, st);
  }

  // ---- calls -----------------------------------------------------------------------------

  private call(node: CallNode, act: Activation<S>, st: S): void {
    const callee = skipParentheses(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      this.expression(callee.expression, act, st);
    } else if (ts.isElementAccessExpression(callee)) {
      this.expression(callee.expression, act, st);
      this.expression(callee.argumentExpression, act, st);
    } else if (
      !ts.isIdentifier(callee) &&
      callee.kind !== ts.SyntaxKind.SuperKeyword &&
      !ts.isFunctionExpression(callee) &&
      !ts.isArrowFunction(callee)
    ) {
      this.expression(callee, act, st);
    }
    for (const argument of node.arguments ?? []) this.expression(argument, act, st);

    if (
      ts.isIdentifier(callee) &&
      (callee.text === 'eval' || (ts.isNewExpression(node) && callee.text === 'Function'))
    ) {
      this.ctx.limits.add('eval', node);
    }
    this.onCall(node, act, st);
  }
}
