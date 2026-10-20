import ts from 'typescript';

function memberName(name: ts.PropertyName): string {
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return name.getText();
}

function isFunctionExpression(node: ts.Node | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

export type FunctionWithBody = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

/**
 * The function-like declaration behind a node returned by `extractFunctions` (which returns the
 * variable or property declaration for function-valued initialisers), if it has a body.
 */
export function asFunctionWithBody(node: ts.Node | undefined): FunctionWithBody | undefined {
  if (node === undefined) return undefined;
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
    return asFunctionWithBody(node.initializer);
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return node.body ? (node as FunctionWithBody) : undefined;
  }
  return undefined;
}

/**
 * Named functions of a file keyed by qualified name (`Class.method`, `get Class.prop`,
 * `namespace.fn`). Covers function declarations, methods, constructors, accessors and
 * variables or class properties initialised with an arrow/function expression. Functions nested
 * inside other functions belong to their enclosing function and are not listed on their own.
 */
export function extractFunctions(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const found = new Map<string, ts.Node>();
  const add = (scope: readonly string[], name: string, node: ts.Node): void => {
    const qualified = [...scope, name].join('.');
    let key = qualified;
    for (let n = 2; found.has(key); n++) key = `${qualified}#${n}`;
    found.set(key, node);
  };

  const visitMember = (member: ts.ClassElement, scope: readonly string[]): void => {
    if (ts.isMethodDeclaration(member) && member.body) {
      add(scope, memberName(member.name), member);
    } else if (ts.isConstructorDeclaration(member) && member.body) {
      add(scope, 'constructor', member);
    } else if ((ts.isGetAccessor(member) || ts.isSetAccessor(member)) && member.body) {
      add(scope, `${ts.isGetAccessor(member) ? 'get' : 'set'} ${memberName(member.name)}`, member);
    } else if (ts.isPropertyDeclaration(member) && isFunctionExpression(member.initializer)) {
      add(scope, memberName(member.name), member);
    }
  };

  const visit = (node: ts.Node, scope: readonly string[]): void => {
    if (ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      for (const statement of node.statements) visit(statement, scope);
    } else if (ts.isFunctionDeclaration(node)) {
      if (node.body) add(scope, node.name?.text ?? 'default', node);
    } else if (ts.isClassDeclaration(node)) {
      const inner = [...scope, node.name?.text ?? 'default'];
      for (const member of node.members) visitMember(member, inner);
    } else if (ts.isModuleDeclaration(node)) {
      if (node.body) visit(node.body, [...scope, node.name.text]);
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isFunctionExpression(declaration.initializer)) {
          add(scope, declaration.name.text, declaration);
        }
      }
    }
  };

  visit(sourceFile, []);
  return found;
}
