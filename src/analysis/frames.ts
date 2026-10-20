import ts from 'typescript';
import type { FunctionWithBody } from '../scenario/functions.js';
import type { StateElement } from '../state/element.js';
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

  const params = new Map<ts.Symbol, StateElement | null>();
  target.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) return;
    const symbol = ctx.checker.getSymbolAtLocation(parameter.name);
    if (!symbol) return;
    const argument = node.arguments?.[index];
    const raw =
      argument && !ts.isSpreadElement(argument) ? ctx.resolver.resolve(argument) : undefined;
    params.set(symbol, (raw && ctx.resolver.rebase(raw, frame, 'reference')) ?? null);
  });
  return { thisElement, params };
}

export function isDeclaredWithin(symbol: ts.Symbol, fn: ts.Node): boolean {
  return (symbol.declarations ?? []).some(
    (declaration) =>
      declaration.getSourceFile() === fn.getSourceFile() &&
      declaration.pos >= fn.pos &&
      declaration.end <= fn.end,
  );
}
