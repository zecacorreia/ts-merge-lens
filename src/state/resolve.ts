import ts from 'typescript';
import type { LimitationKind } from '../limitations.js';
import { ANY_INDEX } from './element.js';
import type { StateElement } from './element.js';

/**
 * How the function being analysed relates to the entry function: what its `this` and its
 * parameters stand for. Elements are always reported in terms of the entry function.
 */
export interface Frame {
  /** The element `this` stands for; absent for plain calls and constructors. */
  thisElement: StateElement | undefined;
  /** Parameter -> argument element; `null` when the argument is not a trackable reference. */
  params: ReadonlyMap<ts.Symbol, StateElement | null>;
}

export type LimitationSink = (kind: LimitationKind, node: ts.Node) => void;

const IDENTIFIER_LIKE = /^[A-Za-z_$][\w$]*$/;

function isAnyLike(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function propertySegment(name: string): string {
  return IDENTIFIER_LIKE.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}

/** Turns lvalue-like expressions into state elements using the type checker. */
export class ElementResolver {
  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly limit: LimitationSink,
  ) {}

  /**
   * The element an expression denotes, in terms of the function that contains it (`this` and
   * parameters are not yet substituted, see `rebase`). Undefined for expressions that do not
   * name state, such as call results.
   */
  resolve(expression: ts.Expression): StateElement | undefined {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return this.resolve(expression.expression);
    }
    if (
      expression.kind === ts.SyntaxKind.ThisKeyword ||
      expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      return { root: 'this', path: [], lowConfidence: false };
    }
    if (ts.isIdentifier(expression)) return this.resolveIdentifier(expression);
    if (ts.isPropertyAccessExpression(expression)) {
      const base = this.resolve(expression.expression);
      if (!base) return undefined;
      return this.extend(base, propertySegment(expression.name.text), expression.expression);
    }
    if (ts.isElementAccessExpression(expression)) {
      const base = this.resolve(expression.expression);
      if (!base) return undefined;
      return this.resolveElementAccess(base, expression);
    }
    return undefined;
  }

  /**
   * Substitutes `this` and parameters by what they stand for in the entry function. When the
   * element is *written*, assigning a parameter itself only changes a local and yields undefined;
   * as a *reference* (an argument, a receiver) the parameter stands for its argument.
   */
  rebase(
    element: StateElement,
    frame: Frame,
    purpose: 'write' | 'reference',
  ): StateElement | undefined {
    if (element.root === 'this') {
      return frame.thisElement && compose(frame.thisElement, element);
    }
    if (frame.params.has(element.root)) {
      if (element.path.length === 0 && purpose === 'write') return undefined;
      const argument = frame.params.get(element.root);
      return argument ? compose(argument, element) : undefined;
    }
    return element;
  }

  private resolveIdentifier(identifier: ts.Identifier): StateElement | undefined {
    let symbol = this.checker.getSymbolAtLocation(identifier);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = this.checker.getAliasedSymbol(symbol);
    if (!symbol?.declarations?.length) return undefined;
    return { root: symbol, path: [], lowConfidence: false };
  }

  private resolveElementAccess(
    base: StateElement,
    access: ts.ElementAccessExpression,
  ): StateElement {
    const argument = access.argumentExpression;
    const type = this.checker.getTypeAtLocation(argument);
    let segment: string;
    if (ts.isStringLiteralLike(argument)) segment = propertySegment(argument.text);
    else if (ts.isNumericLiteral(argument)) segment = `[${Number(argument.text)}]`;
    else if (type.isStringLiteral()) segment = propertySegment(type.value);
    else if (type.isNumberLiteral()) segment = `[${type.value}]`;
    else {
      this.limit('dynamic-access', access);
      return { ...this.extend(base, ANY_INDEX, access.expression), lowConfidence: true };
    }
    return this.extend(base, segment, access.expression);
  }

  private extend(base: StateElement, segment: string, receiver: ts.Expression): StateElement {
    const lowConfidence = base.lowConfidence || isAnyLike(this.checker.getTypeAtLocation(receiver));
    if (lowConfidence && !base.lowConfidence) this.limit('any-type', receiver);
    return { root: base.root, path: [...base.path, segment], lowConfidence };
  }
}

function compose(prefix: StateElement, suffix: StateElement): StateElement {
  return {
    root: prefix.root,
    path: [...prefix.path, ...suffix.path],
    lowConfidence: prefix.lowConfidence || suffix.lowConfidence,
  };
}
