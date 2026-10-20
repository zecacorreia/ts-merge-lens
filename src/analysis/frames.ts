import ts from 'typescript';
import type { FunctionWithBody } from '../scenario/functions.js';
import { symbolOf } from '../state/element.js';
import type { Root, StateElement } from '../state/element.js';
import type { Frame } from '../state/resolve.js';
import type { CallNode } from './calls.js';
import type { AnalysisContext } from './context.js';

/** What `this` and the parameters of `target` stand for in a call made from a function with `frame`. */
export function frameForCall(
  ctx: AnalysisContext,
  node: CallNode,
  target: FunctionWithBody,
  frame: Frame,
): Frame {
  let callee: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  let thisElement: StateElement | undefined;
  if (ts.isNewExpression(node)) {
    thisElement = undefined; // a fresh object: nothing the caller can share
  } else if (ts.isArrowFunction(target) || callee.kind === ts.SyntaxKind.SuperKeyword) {
    thisElement = frame.thisElement;
  } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const receiver = ctx.resolver.resolve(callee.expression);
    thisElement = receiver && ctx.resolver.rebase(receiver, frame, 'reference');
  }

  const params = new Map<Root, StateElement | null>();
  target.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) return;
    const symbol = ctx.resolver.rootOfDeclaration(parameter.name);
    if (!symbol) return;
    const argument = node.arguments?.[index];
    const raw =
      argument && !ts.isSpreadElement(argument) ? ctx.resolver.resolve(argument) : undefined;
    params.set(symbol, (raw && ctx.resolver.rebase(raw, frame, 'reference')) ?? null);
  });
  return { thisElement, params };
}

export function isDeclaredWithin(root: Root, fn: ts.Node): boolean {
  const symbol = symbolOf(root); // a root by name has no declarations: it is never "local"
  return (symbol?.declarations ?? []).some(
    (declaration) =>
      declaration.getSourceFile() === fn.getSourceFile() &&
      declaration.pos >= fn.pos &&
      declaration.end <= fn.end,
  );
}
