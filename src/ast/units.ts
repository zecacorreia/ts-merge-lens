import ts from 'typescript';

const K = ts.SyntaxKind;

const UNIT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  K.SourceFile,
  K.Block,
  K.ModuleBlock,
  K.CaseClause,
  K.DefaultClause,
  K.CatchClause,
  K.FunctionDeclaration,
  K.ClassDeclaration,
  K.InterfaceDeclaration,
  K.TypeAliasDeclaration,
  K.EnumDeclaration,
  K.ModuleDeclaration,
  K.ImportDeclaration,
  K.ImportEqualsDeclaration,
  K.ExportDeclaration,
  K.ExportAssignment,
  K.NamespaceExportDeclaration,
  K.MethodDeclaration,
  K.Constructor,
  K.GetAccessor,
  K.SetAccessor,
  K.PropertyDeclaration,
  K.ClassStaticBlockDeclaration,
]);

/**
 * A "unit" is an instruction-level node: a statement, a block, a clause or a declaration that
 * can hold statements. Annotation and alignment work on the tree of units; expressions are
 * treated as part of the unit that contains them.
 */
export function isUnitNode(node: ts.Node): boolean {
  return (
    UNIT_KINDS.has(node.kind) || (node.kind >= K.FirstStatement && node.kind <= K.LastStatement)
  );
}

/** Direct children of `node`, skipping JSDoc. */
export function childNodes(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    if (!ts.isJSDoc(child)) children.push(child);
  });
  return children;
}

/** Nearest unit descendants of `node` (looking through expressions, e.g. arrow-function bodies). */
export function unitChildren(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isJSDoc(child)) return;
    if (isUnitNode(child)) found.push(child);
    else ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** Pre-order walk of the unit tree rooted at `root` (inclusive). */
export function forEachUnit(
  root: ts.Node,
  callback: (unit: ts.Node, parent: ts.Node | undefined) => void,
): void {
  const walk = (unit: ts.Node, parent: ts.Node | undefined): void => {
    callback(unit, parent);
    for (const child of unitChildren(unit)) walk(child, unit);
  };
  walk(root, undefined);
}
