import ts from 'typescript';
import valueParser from 'postcss-value-parser';
import type { Binding, Evidence, SourceRange } from '../shared/model';
import type { ExportEntry } from '../shared/query-model';
import { nativeResourceAttribute } from './html-resources';
import parseSrcset from 'parse-srcset';

export interface Reference {
  specifier?: string; kind: 'import' | 'reexport' | 'resource' | 'config' | 'framework' | 'environment';
  bindings: Binding[]; evidence: Evidence; reason?: string; envName?: string;
  certainty?: 'confirmed' | 'inferred';
  resolutionMode?: 'module' | 'style' | 'asset' | 'config'; sourceExtension?: string;
  provenanceIds?: string[];
  symbolDependency?: boolean;
  occurrences?: (Binding & { range: SourceRange; exported?: string })[];
}
export interface JsResult {
  references: Reference[]; diagnostics: string[];
  childName?: string; childReferences: { name: string; evidence: Evidence }[];
  providers: { token: TokenRef; evidence: Evidence }[];
  consumers: { token: TokenRef; evidence: Evidence }[];
  exports: { name: string; range: SourceRange; namespace: ExportEntry['namespace']; kind: ExportEntry['kind']; forwarded?: { module: string; imported: string; referenceKind: 'import' | 'reexport' } }[];
  unsupportedExports?: boolean;
  implicitNames?: { name: string; evidence: Evidence; kind: 'value' | 'component' }[];
  graphql?: { definitions: { name: string; kind: string; range: SourceRange }[]; spreads: { name: string; range: SourceRange }[] };
  capabilityReasons?: string[];
  regions?: { languageId: string; kind: string; range: SourceRange }[];
  layout?: string | false; layoutDynamic?: boolean;
  globs?: { patterns: string[]; kind: 'vite' | 'webpack'; recursive?: boolean; regexp?: { source: string; flags: string }; query?: string; evidence: Evidence }[];
}
export interface TokenRef { name: string; module?: string }
export function extractJavascript(path: string, text: string): JsResult {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const result: JsResult = { references: [], diagnostics: [], childReferences: [], providers: [], consumers: [], exports: [], unsupportedExports: /\.(?:cjs|cts)$/i.test(path) };
  const imported = new Map<string, { module: string; name: string; typeOnly: boolean }>();
  const constants = new Map<string, ts.Expression>();
  for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
  const tramvaiApi = (module: string, name: string) => ({ '@tramvai/core': ['createApp', 'provide', 'Module'], '@tramvai/child-app-core': ['createChildApp'], '@tramvai/react': ['useDi'] } as Record<string, string[]>)[module]?.includes(name) ?? false;
  const range = (node: ts.Node): SourceRange => ({ start: source.getLineAndCharacterOfPosition(node.getStart(source)), end: source.getLineAndCharacterOfPosition(node.getEnd()) });
  const evidence = (node: ts.Node, rule: string): Evidence => ({ rule, range: range(node) });
  const add = (node: ts.Node, specifier: string | undefined, kind: Reference['kind'], bindings: Binding[], rule: string, reason?: string) => {
    result.references.push({ specifier, kind, bindings, evidence: evidence(node, rule), reason });
  };
  const literal = (node: ts.Node | undefined): string | undefined => node && ts.isStringLiteralLike(node) ? node.text : undefined;
  const property = (node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
    const entry = node.properties.find(item => item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
    return entry && ts.isPropertyAssignment(entry) ? entry.initializer : entry && ts.isShorthandPropertyAssignment(entry) ? entry.name : undefined;
  };
  const boundNames = (name: ts.BindingName): string[] => ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(item => ts.isOmittedExpression(item) ? [] : boundNames(item.name));
  const hoisted = new Map<ts.Node, Set<string>>();
  const collectHoisted = (node: ts.Node, owner: ts.Node) => {
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node) || ts.isModuleBlock(node)) owner = node;
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
      const names = hoisted.get(owner) ?? new Set<string>();
      for (const item of node.declarations) for (const name of boundNames(item.name)) names.add(name);
      hoisted.set(owner, names);
    }
    ts.forEachChild(node, child => collectHoisted(child, owner));
  };
  collectHoisted(source, source);
  const declared = (name: string, node: ts.Node, includeSource = true): boolean => {
    for (let scope: ts.Node | undefined = node; scope; scope = scope.parent) {
      if (!includeSource && ts.isSourceFile(scope)) break;
      if (hoisted.get(scope)?.has(name)) return true;
      if (ts.isFunctionLike(scope) && scope.parameters.some(param => boundNames(param.name).includes(name))) return true;
      if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)
        && scope.initializer.declarations.some(item => boundNames(item.name).includes(name))) return true;
      if (ts.isSourceFile(scope) || ts.isBlock(scope)) {
        for (const statement of scope.statements) {
          if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => boundNames(item.name).includes(name))) return true;
          if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return true;
          if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause;
            if (clause?.name?.text === name) return true;
            const bindings = clause?.namedBindings;
            if (bindings && (ts.isNamespaceImport(bindings) ? bindings.name.text === name : bindings.elements.some(item => item.name.text === name))) return true;
          }
        }
      }
      if (ts.isCatchClause(scope) && scope.variableDeclaration && boundNames(scope.variableDeclaration.name).includes(name)) return true;
    }
    return false;
  };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const bindings: Binding[] = [];
    const remember = (local: string, name: string, typeOnly: boolean) => {
      bindings.push({ imported: name, local, typeOnly }); imported.set(local, { module: (statement.moduleSpecifier as ts.StringLiteral).text, name, typeOnly });
    };
    if (clause?.name) remember(clause.name.text, 'default', clause.isTypeOnly);
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) remember(clause.namedBindings.name.text, '*', clause.isTypeOnly);
      else for (const item of clause.namedBindings.elements) remember(item.name.text, item.propertyName?.text ?? item.name.text, clause.isTypeOnly || item.isTypeOnly);
    }
    add(statement.moduleSpecifier, statement.moduleSpecifier.text, 'import', bindings, 'JavaScript import');
    const occurrences: NonNullable<Reference['occurrences']> = [];
    if (clause?.name) occurrences.push({ imported: 'default', local: clause.name.text, typeOnly: clause.isTypeOnly, range: range(clause.name) });
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) occurrences.push({ imported: '*', local: clause.namedBindings.name.text, typeOnly: clause.isTypeOnly, range: range(clause.namedBindings) });
      else for (const item of clause.namedBindings.elements) occurrences.push({ imported: item.propertyName?.text ?? item.name.text, local: item.name.text, typeOnly: clause.isTypeOnly || item.isTypeOnly, range: range(item) });
    }
    result.references[result.references.length - 1].occurrences = occurrences;
  }
  const locals = new Map<string, SourceRange>();
  const localNamespaces = new Map<string, ExportEntry['namespace']>();
  const namespaceLocals = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) for (const name of boundNames(declaration.name)) { locals.set(name, range(declaration.name)); localNamespaces.set(name, 'value'); }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      locals.set(statement.name.text, range(statement.name));
      localNamespaces.set(statement.name.text, ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ? 'type' : ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) ? 'both' : 'value');
    } else if (ts.isModuleDeclaration(statement)) {
      locals.set(statement.name.text, range(statement.name)); localNamespaces.set(statement.name.text, 'both'); namespaceLocals.add(statement.name.text);
    }
  }
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const defaultExport = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) for (const name of boundNames(declaration.name)) result.exports.push({ name, range: locals.get(name)!, namespace: 'value', kind: 'direct' });
    } else if (exported && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement))) {
      const namespace = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ? 'type' : ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) ? 'both' : 'value';
      if (defaultExport) result.exports.push({ name: 'default', range: statement.name ? range(statement.name) : range(statement), namespace, kind: 'direct' });
      else if (statement.name) result.exports.push({ name: statement.name.text, range: range(statement.name), namespace, kind: 'direct' });
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const symbol = ts.isIdentifier(statement.expression) ? statement.expression.text : undefined;
      const importedSymbol = symbol ? imported.get(symbol) : undefined;
      result.exports.push({ name: 'default', range: symbol && locals.has(symbol) ? locals.get(symbol)! : range(statement.expression), namespace: 'value', kind: importedSymbol ? 'forward' : 'direct', forwarded: importedSymbol ? { module: importedSymbol.module, imported: importedSymbol.name, referenceKind: 'import' } : undefined });
    } else if (ts.isExportDeclaration(statement)) {
      const module = literal(statement.moduleSpecifier);
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const entry of statement.exportClause.elements) {
          const originalName = entry.propertyName?.text ?? entry.name.text;
          const importedSymbol = imported.get(originalName);
          const namespace = statement.isTypeOnly || entry.isTypeOnly ? 'type' : module ? 'both' : importedSymbol?.typeOnly ? 'type' : localNamespaces.get(originalName) ?? 'both';
          if (module) result.exports.push({ name: entry.name.text, range: range(entry), namespace, kind: 'forward', forwarded: { module, imported: originalName, referenceKind: 'reexport' } });
          else if (locals.has(originalName)) result.exports.push({ name: entry.name.text, range: locals.get(originalName)!, namespace, kind: namespaceLocals.has(originalName) ? 'namespace' : 'direct' });
          else if (importedSymbol) result.exports.push({ name: entry.name.text, range: range(entry), namespace, kind: 'forward', forwarded: { module: importedSymbol.module, imported: importedSymbol.name, referenceKind: 'import' } });
          else result.exports.push({ name: entry.name.text, range: range(entry), namespace, kind: 'forward' });
        }
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) result.exports.push({ name: statement.exportClause.name.text, range: range(statement.exportClause), namespace: statement.isTypeOnly ? 'type' : 'both', kind: 'namespace', forwarded: module ? { module, imported: '*', referenceKind: 'reexport' } : undefined });
      else if (module) result.exports.push({ name: '*', range: range(statement), namespace: statement.isTypeOnly ? 'type' : 'both', kind: 'star', forwarded: { module, imported: '*', referenceKind: 'reexport' } });
    } else if (exported && ts.isModuleDeclaration(statement)) result.exports.push({ name: statement.name.text, range: range(statement.name), namespace: 'both', kind: 'namespace' });
  }
  const apiName = (node: ts.Expression): { module: string; name: string } | undefined => {
    if (ts.isIdentifier(node)) { const binding = imported.get(node.text); return declared(node.text, node, false) || binding?.typeOnly ? undefined : binding; }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (declared(node.expression.text, node, false)) return undefined;
      const namespace = imported.get(node.expression.text);
      if (namespace?.name === '*' && !namespace.typeOnly) return { module: namespace.module, name: node.name.text };
    }
    return undefined;
  };
  const frameworkIdentifier = (node: ts.Node, rule: string) => {
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return;
    const symbol = apiName(node);
    if (symbol) add(node, symbol.module, 'framework', [{ imported: symbol.name, local: node.getText(source), typeOnly: false }], rule);
  };
  const tokenRef = (node: ts.Node | undefined): TokenRef | undefined => {
    if (node && ts.isPropertyAccessExpression(node)) { const symbol = apiName(node); return symbol ? { name: symbol.name, module: symbol.module } : undefined; }
    if (!node || !ts.isIdentifier(node) || declared(node.text, node, false)) return undefined;
    const importedToken = imported.get(node.text);
    if (importedToken?.typeOnly) return undefined;
    return importedToken ? { name: importedToken.name, module: importedToken.module } : { name: node.text };
  };
  const mutated = new Set<string>();
  let aliasExpansionLimited = false;
  const aliasLimit = () => {
    if (!aliasExpansionLimited) result.diagnostics.push('Static object alias expansion limit reached; immutable declarations are unknown');
    aliasExpansionLimited = true;
  };
  const destructured = new Map<string, ts.Expression>();
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) && declaration.initializer) for (const name of boundNames(declaration.name)) destructured.set(name, declaration.initializer);
  }
  const rootName = (node: ts.Node): string | undefined => ts.isIdentifier(node) ? node.text
    : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) ? rootName(node.expression) : undefined;
  const objectConstant = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    if (seen.size > 20) { aliasLimit(); return false; }
    let value = constants.get(name) ?? destructured.get(name); if (!value) return false;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
    const root = rootName(value);
    return ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || !!root && objectConstant(root, new Set(seen).add(name));
  };
  const referencedObjects = (node: ts.Node): string[] => {
    const found = new Set<string>(), pending = [node];
    for (let steps = 0; pending.length && steps < 10000; steps++) {
      const current = pending.pop()!;
      if (ts.isIdentifier(current) && objectConstant(current.text) && !declared(current.text, current, false)
        && !(ts.isPropertyAccessExpression(current.parent) && current.parent.name === current)
        && !(ts.isPropertyAssignment(current.parent) && current.parent.name === current)) found.add(current.text);
      ts.forEachChild(current, child => { pending.push(child); });
    }
    if (pending.length) aliasLimit();
    return [...found];
  };
  const invalidate = (name: string) => {
    const pending = [name];
    for (let steps = 0; pending.length && steps < 10000; steps++) {
      const current = pending.pop()!;
      if (mutated.has(current)) continue;
      mutated.add(current);
      const value = constants.get(current) ?? destructured.get(current);
      if (value) pending.push(...referencedObjects(value));
    }
    if (pending.length) aliasLimit();
  };
  const mutations = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment || ts.isDeleteExpression(node)
      || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) || ts.isPostfixUnaryExpression(node)) {
      const target = ts.isBinaryExpression(node) ? node.left : ts.isDeleteExpression(node) ? node.expression : node.operand;
      const name = rootName(target); if (name && (constants.has(name) || destructured.has(name)) && !declared(name, target, false)) invalidate(name);
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
        const name = rootName(node.expression.expression); if (name && objectConstant(name) && !declared(name, node, false)) invalidate(name);
      }
      const api = apiName(node.expression);
      if (!(api && tramvaiApi(api.module, api.name) && ['createApp', 'createChildApp', 'provide', 'Module'].includes(api.name))) {
        for (const argument of node.arguments) for (const name of referencedObjects(argument)) invalidate(name);
      }
    }
    ts.forEachChild(node, mutations);
  };
  mutations(source);
  const staticValue = (value: ts.Expression | undefined, seen = new Set<string>()): ts.Expression | undefined => {
    if (!value || seen.size > 20) return undefined;
    if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) return staticValue(value.expression, seen);
    if (ts.isIdentifier(value) && constants.has(value.text) && !declared(value.text, value, false)) {
      if (seen.has(value.text) || mutated.has(value.text) || aliasExpansionLimited && objectConstant(value.text)) return undefined;
      return staticValue(constants.get(value.text), new Set(seen).add(value.text));
    }
    if (ts.isObjectLiteralExpression(value) && value.properties.some(item => ts.isSpreadAssignment(item))) return undefined;
    return value;
  };
  const cssUrls = (node: ts.Node, value: string) => {
    valueParser(value).walk(token => {
      if (token.type === 'function' && token.value.toLowerCase() === 'url') {
        const url = valueParser.stringify(token.nodes).trim().replace(/^(['"])(.*)\1$/, '$2');
        if (url && !/^(?:[a-z]+:|\/\/|#)/i.test(url)) add(node, url, 'resource', [], 'Static CSS-in-JS url()');
      }
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !declared(node.text, node) && !['undefined', 'console', 'Math', 'Date', 'JSON', 'Object', 'Array', 'String', 'Number', 'Promise', 'process', 'require', 'module', 'exports', 'URL'].includes(node.text)) {
      const parent = node.parent;
      const namePosition = ts.isPropertyAccessExpression(parent) && parent.name === node || ts.isPropertyAssignment(parent) && parent.name === node
        || ts.isVariableDeclaration(parent) && parent.name === node || ts.isParameter(parent) && parent.name === node
        || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isJsxAttribute(parent)
        || ts.isTypeReferenceNode(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent);
      if (!namePosition) (result.implicitNames ??= []).push({ name: node.text, kind: 'value', evidence: evidence(node, 'Free identifier; framework context required') });
    }
    // CommonJS can mutate exports through defineProperty/assign or an alias, not only a direct assignment.
    if (ts.isIdentifier(node) && ['exports', 'module'].includes(node.text) && !declared(node.text, node)) {
      const parent = node.parent;
      const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node
        || ts.isPropertyAssignment(parent) && parent.name === node
        || ts.isPropertyDeclaration(parent) && parent.name === node
        || ts.isMethodDeclaration(parent) && parent.name === node;
      if (!propertyName) result.unsupportedExports = true;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings: Binding[] = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map(item => ({ imported: item.propertyName?.text ?? item.name.text, local: item.name.text, typeOnly: node.isTypeOnly || item.isTypeOnly }))
        : [{ imported: '*', typeOnly: node.isTypeOnly }];
      add(node.moduleSpecifier, node.moduleSpecifier.text, 'reexport', bindings, 'JavaScript re-export');
      result.references[result.references.length - 1].occurrences = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map(item => ({ imported: item.propertyName?.text ?? item.name.text, local: item.name.text, exported: item.name.text, typeOnly: node.isTypeOnly || item.isTypeOnly, range: range(item) }))
        : [{ imported: '*', exported: node.exportClause && ts.isNamespaceExport(node.exportClause) ? node.exportClause.name.text : '*', typeOnly: node.isTypeOnly, range: range(node) }];
    }
    if (ts.isExportAssignment(node) && node.isExportEquals) result.unsupportedExports = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
        const base = left.expression;
        if (ts.isIdentifier(base) && base.text === 'exports' && !declared('exports', node)) result.unsupportedExports = true;
        if (ts.isIdentifier(base) && base.text === 'module' && !declared('module', node)) result.unsupportedExports = true;
        if ((ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) && ts.isIdentifier(base.expression) && base.expression.text === 'module' && !declared('module', node)) result.unsupportedExports = true;
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference, literal(node.moduleReference.expression), 'import', [{ imported: '*', local: node.name.text, typeOnly: node.isTypeOnly }], 'TypeScript import equals', literal(node.moduleReference.expression) === undefined ? 'Computed import-equals target' : undefined);
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const viteGlob = ts.isPropertyAccessExpression(expression) && expression.name.text === 'glob' && ts.isMetaProperty(expression.expression) && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
      const webpackContext = ts.isPropertyAccessExpression(expression) && expression.name.text === 'context' && ts.isIdentifier(expression.expression) && expression.expression.text === 'require' && !declared('require', node);
      if (viteGlob || webpackContext) {
        const first = node.arguments[0];
        const patterns = first && ts.isStringLiteralLike(first) ? [first.text] : first && ts.isArrayLiteralExpression(first) && first.elements.every(ts.isStringLiteralLike) ? first.elements.map(item => (item as ts.StringLiteral).text) : undefined;
        let regexp: { source: string; flags: string } | undefined;
        let query: string | undefined;
        let supported = !!patterns && patterns.length > 0 && patterns.length <= 30 && patterns.every(pattern => pattern.length <= 500);
        if (viteGlob && node.arguments[1]) {
          const options = node.arguments[1];
          if (!ts.isObjectLiteralExpression(options)) supported = false;
          else for (const entry of options.properties) {
            if (!ts.isPropertyAssignment(entry) || !ts.isIdentifier(entry.name) && !ts.isStringLiteralLike(entry.name)) { supported = false; continue; }
            const key = entry.name.text, value = entry.initializer;
            if (key === 'query' && ts.isStringLiteralLike(value)) query = value.text;
            else if (key === 'import' && ts.isStringLiteralLike(value)) continue;
            else if (['eager', 'exhaustive'].includes(key) && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) continue;
            else supported = false;
          }
        }
        if (webpackContext && node.arguments[1] && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.arguments[1].kind)) supported = false;
        if (webpackContext && node.arguments[2]) {
          const raw = node.arguments[2].getText(source), end = raw.lastIndexOf('/');
          const body = raw.slice(1, end), flags = raw.slice(end + 1);
          supported &&= node.arguments[2].kind === ts.SyntaxKind.RegularExpressionLiteral && body.length <= 128 && !/[(){}]|\\[1-9]/.test(body) && (body.match(/[*+]/g)?.length ?? 0) <= 1 && !/[^.][*+]/.test(body) && /^[iu]*$/.test(flags) && new Set(flags).size === flags.length;
          regexp = { source: body, flags };
        }
        if (supported) (result.globs ??= []).push({ patterns: patterns!, kind: viteGlob ? 'vite' : 'webpack', recursive: node.arguments[1]?.kind !== ts.SyntaxKind.FalseKeyword, regexp, query, evidence: evidence(node, viteGlob ? 'Vite static import.meta.glob declaration' : 'Webpack static require.context declaration') });
        else result.references.push({ kind: 'import', bindings: [], evidence: evidence(node, 'Computed or unsupported module collection'), reason: 'Module collection patterns/options are unsupported; no project expression is evaluated' });
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'definePageMeta' && !declared('definePageMeta', node)) {
        const metadata = staticValue(node.arguments[0]);
        const layout = metadata && ts.isObjectLiteralExpression(metadata) ? property(metadata, 'layout') : undefined;
        if (layout?.kind === ts.SyntaxKind.FalseKeyword) result.layout = false;
        else if (layout && ts.isStringLiteralLike(layout)) result.layout = layout.text;
        else if (layout || metadata && !ts.isObjectLiteralExpression(metadata)) result.layoutDynamic = true;
      }
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require' && !declared('require', node);
      if (dynamicImport || requireCall) {
        const target = literal(node.arguments[0]);
        const bindings: Binding[] = [];
        if (requireCall && ts.isVariableDeclaration(node.parent)) {
          const name = node.parent.name;
          if (ts.isIdentifier(name)) bindings.push({ imported: '*', local: name.text, typeOnly: false });
          else if (ts.isObjectBindingPattern(name)) for (const entry of name.elements) {
            const importedName = entry.dotDotDotToken ? '*' : entry.propertyName && (ts.isIdentifier(entry.propertyName) || ts.isStringLiteral(entry.propertyName)) ? entry.propertyName.text : ts.isIdentifier(entry.name) ? entry.name.text : undefined;
            if (importedName && ts.isIdentifier(entry.name)) bindings.push({ imported: importedName, local: entry.name.text, typeOnly: false });
          }
        }
        add(node, target, 'import', bindings, dynamicImport ? 'Dynamic import' : 'CommonJS require', target === undefined ? 'Computed import path cannot be resolved statically' : undefined);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch' && !declared('fetch', node)) {
        const target = literal(node.arguments[0]);
        if (target && /(?:\.json|\.csv|\.xml|\.wasm)(?:[?#].*)?$/i.test(target) && !/^(?:[a-z]+:|\/\/)/i.test(target)) add(node, target, 'resource', [], 'Static fetch resource; runtime endpoint may differ');
      }
      const api = apiName(node.expression);
      if (api && tramvaiApi(api.module, api.name) && api.name === 'useDi') {
        const token = tokenRef(node.arguments[0]);
        if (token) result.consumers.push({ token, evidence: evidence(node, 'Tramvai useDi token; runtime registration and scope unverified') });
        else if (node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
          for (const entry of node.arguments[0].properties) {
            const token = tokenRef(ts.isPropertyAssignment(entry) ? entry.initializer : ts.isShorthandPropertyAssignment(entry) ? entry.name : undefined);
            if (token) result.consumers.push({ token, evidence: evidence(entry, 'Tramvai useDi token map; runtime registration and scope unverified') });
          }
        }
      }
      if (api && tramvaiApi(api.module, api.name) && ['createApp', 'createChildApp', 'provide', 'Module'].includes(api.name)) {
        const options = staticValue(node.arguments[0]);
        if (options && ts.isObjectLiteralExpression(options)) {
          if (api.name === 'createChildApp') result.childName = literal(property(options, 'name'));
          for (const key of ['render', 'useClass', 'useValue', 'useFactory', 'provide']) {
            const value = property(options, key); if (value) frameworkIdentifier(value, `Tramvai ${api.name}.${key} declaration; runtime scope not inferred`);
          }
          for (const key of ['modules', 'actions', 'imports', 'providers', 'deps']) {
            const initial = property(options, key), value = staticValue(initial);
            if (value && ts.isArrayLiteralExpression(value)) for (const item of value.elements) frameworkIdentifier(item, `Tramvai ${api.name}.${key} declaration`);
            else if (initial && !value) result.diagnostics.push(`Tramvai ${api.name}.${key} is not a supported immutable declaration`);
          }
          const providerToken = property(options, 'provide');
          const declaredToken = tokenRef(providerToken);
          if (api.name === 'provide' && declaredToken) result.providers.push({ token: declaredToken, evidence: evidence(node, 'Tramvai provider declaration; registration and runtime scope unverified') });
          const deps = staticValue(property(options, 'deps'));
          if (deps && ts.isObjectLiteralExpression(deps)) for (const entry of deps.properties) {
            const token = tokenRef(ts.isPropertyAssignment(entry) ? entry.initializer : ts.isShorthandPropertyAssignment(entry) ? entry.name : undefined);
            if (token) result.consumers.push({ token, evidence: evidence(entry, 'Tramvai declared provider/module dependency token') });
          }
          const token = providerToken && apiName(providerToken);
          const value = property(options, 'useValue');
          if (token?.name === 'CHILD_APP_RESOLUTION_CONFIGS_TOKEN' && token.module.startsWith('@tramvai/') && value && ts.isArrayLiteralExpression(value)) {
            for (const entry of value.elements) if (ts.isObjectLiteralExpression(entry)) {
              const name = literal(property(entry, 'name'));
              if (name) result.childReferences.push({ name, evidence: evidence(entry, 'Tramvai declared child-app resolution name; runtime version not inferred') });
            }
          }
        } else result.diagnostics.push(`Tramvai ${api.name} options are not an inline object; framework declarations may be incomplete`);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && !declared('URL', node)) {
      const target = literal(node.arguments?.[0]);
      const base = node.arguments?.[1];
      if (target && base && ts.isPropertyAccessExpression(base) && ts.isMetaProperty(base.expression) && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword && base.name.text === 'url') add(node, target, 'resource', [], 'Static new URL relative to import.meta.url');
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : literal(node.argumentExpression);
      const base = node.expression;
      const processEnv = ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression) && base.expression.text === 'process' && base.name.text === 'env' && !declared('process', node);
      const importEnv = ts.isPropertyAccessExpression(base) && ts.isMetaProperty(base.expression) && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword && base.name.text === 'env';
      if (processEnv || importEnv) {
        result.references.push({ kind: 'environment', bindings: [], envName: name, evidence: evidence(node, 'Environment name; effective mode and value unknown'), reason: name ? undefined : 'Computed environment variable name' });
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const element = node.parent.parent;
      const name = node.name.getText(source);
      const target = literal(node.initializer) ?? (ts.isJsxExpression(node.initializer) ? literal(node.initializer.expression) : undefined);
      if (target !== undefined && (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) && ts.isIdentifier(element.tagName)
        && /^[a-z]/.test(element.tagName.text) && nativeResourceAttribute(element.tagName.text, name)) {
        for (const value of name.toLowerCase() === 'srcset' ? parseSrcset(target).map(item => item.url) : [target]) {
          if (value && !/^(?:[a-z]+:|\/\/|#)/i.test(value) && (name !== 'href' || /\.[a-z0-9]+(?:[?#].*)?$/i.test(value))) add(node.initializer, value, 'resource', [], 'Static JSX resource attribute');
        }
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName;
      if (ts.isPropertyAccessExpression(name) || ts.isIdentifier(name) && /^[A-Z]/.test(name.text)) {
        const symbol = apiName(name);
        if (symbol) {
          const binding = { imported: symbol.name, local: name.getText(source), typeOnly: false };
          add(name, symbol.module, 'import', [binding], 'JSX component binding; static reference does not prove runtime rendering');
          result.references[result.references.length - 1].occurrences = [{ ...binding, range: range(name) }];
        }
      }
    }
    if (ts.isPropertyAssignment(node) && node.name && /^(?:background|backgroundImage|maskImage|listStyleImage|src)$/.test(node.name.getText(source).replace(/['"]/g, ''))) {
      const value = literal(node.initializer); if (value) cssUrls(node.initializer, value);
    }
    if (ts.isTaggedTemplateExpression(node) && ts.isNoSubstitutionTemplateLiteral(node.template)) {
      const api = apiName(node.tag);
      const styled = ts.isPropertyAccessExpression(node.tag) ? apiName(node.tag.expression) : undefined;
      if (api?.module.includes('emotion') || styled?.module.includes('emotion') || api?.module.includes('styled-components') || styled?.module.includes('styled-components')) cssUrls(node.template, node.template.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const staticAssignments: { name: string; range: SourceRange; bases: ts.Identifier[] }[] = [];
  for (const statement of source.statements) if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = statement.expression.left;
    if (!ts.isPropertyAccessExpression(left)) continue;
    if (ts.isIdentifier(left.expression) && left.expression.text === 'exports' && !declared('exports', left)) staticAssignments.push({ name: left.name.text, range: range(left.name), bases: [left.expression] });
    else if (ts.isPropertyAccessExpression(left.expression) && left.expression.name.text === 'exports' && ts.isIdentifier(left.expression.expression) && left.expression.expression.text === 'module' && !declared('module', left)) staticAssignments.push({ name: left.name.text, range: range(left.name), bases: [left.expression.expression] });
  }
  if (staticAssignments.length) {
    const allowed = new Set(staticAssignments.flatMap(item => item.bases)); let unsafe = false;
    const check = (node: ts.Node) => {
      if (ts.isIdentifier(node) && ['exports', 'module'].includes(node.text) && !declared(node.text, node)) {
        const propertyName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
        if (!propertyName && !allowed.has(node)) unsafe = true;
      }
      ts.forEachChild(node, check);
    };
    check(source);
    if (!unsafe) {
      result.unsupportedExports = false;
      for (const item of staticAssignments) result.exports.push({ name: item.name, range: item.range, namespace: 'value', kind: 'direct' });
    }
  }
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  for (const diagnostic of parseDiagnostics ?? []) {
    const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    result.diagnostics.push(`JavaScript/TypeScript parse error TS${diagnostic.code} at ${position.line + 1}:${position.character + 1}; analysis may be incomplete`);
  }
  return result;
}
