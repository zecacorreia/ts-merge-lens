import { createHash } from 'node:crypto';
import ts from 'typescript';
import { childNodes, isUnitNode } from './units.js';

function digest(text: string): string {
  return createHash('sha1').update(text).digest('base64');
}

/**
 * Structural hashes of AST nodes. Whitespace, comments, semicolons and string quote style do
 * not influence them, so two nodes with equal hashes are the same code for our purposes.
 *
 * - `deep(node)`: hash of the whole subtree.
 * - `shallow(unit)`: hash of the unit ignoring its nested units (each replaced by a placeholder),
 *   so an `if` whose condition is untouched keeps its hash when a statement inside it changes.
 */
export class Fingerprinter {
  private readonly deepCache = new Map<ts.Node, string>();
  private readonly partCache = new Map<ts.Node, string>();
  private readonly shallowCache = new Map<ts.Node, string>();

  constructor(private readonly sourceFile: ts.SourceFile) {}

  deep(node: ts.Node): string {
    let hash = this.deepCache.get(node);
    if (hash === undefined) {
      hash = this.compose(node, (child) => this.deep(child));
      this.deepCache.set(node, hash);
    }
    return hash;
  }

  shallow(unit: ts.Node): string {
    let hash = this.shallowCache.get(unit);
    if (hash === undefined) {
      hash = this.compose(unit, (child) => this.part(child));
      this.shallowCache.set(unit, hash);
    }
    return hash;
  }

  /** Leaf texts of the unit excluding nested units, used to compare units that have no name. */
  shallowTokens(unit: ts.Node): string[] {
    const tokens: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJSDoc(node) || isUnitNode(node)) return;
      const children = childNodes(node);
      if (children.length === 0) tokens.push(this.leafText(node));
      else children.forEach(visit);
    };
    ts.forEachChild(unit, visit);
    return tokens;
  }

  private part(node: ts.Node): string {
    if (isUnitNode(node)) return '§';
    let hash = this.partCache.get(node);
    if (hash === undefined) {
      hash = this.compose(node, (child) => this.part(child));
      this.partCache.set(node, hash);
    }
    return hash;
  }

  private compose(node: ts.Node, hashOfChild: (child: ts.Node) => string): string {
    const parts = childNodes(node).map(hashOfChild);
    const body = parts.length === 0 ? this.leafText(node) : parts.join(',');
    return digest(`${ts.SyntaxKind[node.kind]}${nodeAttributes(node)}(${body})`);
  }

  private leafText(node: ts.Node): string {
    if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text);
    return node.getText(this.sourceFile);
  }
}

/** Semantic attributes that `forEachChild` does not expose as child nodes. */
export function nodeAttributes(node: ts.Node): string {
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return `:${node.operator}`;
  }
  if (ts.isTypeOperatorNode(node)) return `:${node.operator}`;
  if (ts.isHeritageClause(node)) return `:${node.token}`;
  if (ts.isMetaProperty(node)) return `:${node.keywordToken}`;
  if (ts.isVariableDeclarationList(node)) {
    return `:${node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)}`;
  }
  if (ts.isImportClause(node)) return `:${node.phaseModifier ?? ''}`;
  if (ts.isExportDeclaration(node)) return `:${node.isTypeOnly}`;
  return '';
}
