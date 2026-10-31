import ts from 'typescript';
import valueParser from 'postcss-value-parser';
import type { Binding, Evidence, SourceRange } from '../shared/model';

export interface Reference {
  specifier?: string; kind: 'import' | 'reexport' | 'resource' | 'config' | 'framework' | 'environment';
  bindings: Binding[]; evidence: Evidence; reason?: string; envName?: string;
  certainty?: 'confirmed' | 'inferred';
}
export interface JsResult {
  references: Reference[]; diagnostics: string[];
  childName?: string; childReferences: { name: string; evidence: Evidence }[];
  providers: { token: TokenRef; evidence: Evidence }[];
  consumers: { token: TokenRef; evidence: Evidence }[];
  exports: { name: string; range: SourceRange; forwarded?: { module: string; imported: string } }[];
}
export interface TokenRef { name: string; module?: string }
export function extractJavascript(path: string, text: string): JsResult {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const result: JsResult = { references: [], diagnostics: [], childReferences: [], providers: [], consumers: [], exports: [] };
  const imported = new Map<string, { module: string; name: string }>();
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
  const declared = (name: string, node: ts.Node, includeSource = true): boolean => {
    for (let scope: ts.Node | undefined = node; scope; scope = scope.parent) {
      if (!includeSource && ts.isSourceFile(scope)) break;
      if (ts.isFunctionLike(scope) && scope.parameters.some(param => boundNames(param.name).includes(name))) return true;
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
      bindings.push({ imported: name, local, typeOnly }); imported.set(local, { module: (statement.moduleSpecifier as ts.StringLiteral).text, name });
    };
    if (clause?.name) remember(clause.name.text, 'default', clause.isTypeOnly);
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) remember(clause.namedBindings.name.text, '*', clause.isTypeOnly);
      else for (const item of clause.namedBindings.elements) remember(item.name.text, item.propertyName?.text ?? item.name.text, clause.isTypeOnly || item.isTypeOnly);
    }
    add(statement.moduleSpecifier, statement.moduleSpecifier.text, 'import', bindings, 'JavaScript import');
  }
  const locals = new Map<string, SourceRange>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) for (const name of boundNames(declaration.name)) locals.set(name, range(declaration.name));
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) locals.set(statement.name.text, range(statement.name));
  }
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const defaultExport = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) for (const name of boundNames(declaration.name)) result.exports.push({ name, range: locals.get(name)! });
    } else if (exported && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement))) {
      if (defaultExport) result.exports.push({ name: 'default', range: statement.name ? range(statement.name) : range(statement) });
      else if (statement.name) result.exports.push({ name: statement.name.text, range: range(statement.name) });
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const symbol = ts.isIdentifier(statement.expression) ? statement.expression.text : undefined;
      const importedSymbol = symbol ? imported.get(symbol) : undefined;
      result.exports.push({ name: 'default', range: symbol && locals.has(symbol) ? locals.get(symbol)! : range(statement.expression), forwarded: importedSymbol ? { module: importedSymbol.module, imported: importedSymbol.name } : undefined });
    } else if (ts.isExportDeclaration(statement)) {
      const module = literal(statement.moduleSpecifier);
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const entry of statement.exportClause.elements) {
          const originalName = entry.propertyName?.text ?? entry.name.text;
          const importedSymbol = imported.get(originalName);
          if (module) result.exports.push({ name: entry.name.text, range: range(entry), forwarded: { module, imported: originalName } });
          else if (locals.has(originalName)) result.exports.push({ name: entry.name.text, range: locals.get(originalName)! });
          else if (importedSymbol) result.exports.push({ name: entry.name.text, range: range(entry), forwarded: { module: importedSymbol.module, imported: importedSymbol.name } });
        }
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) result.exports.push({ name: statement.exportClause.name.text, range: range(statement.exportClause) });
      else if (module) result.exports.push({ name: '*', range: range(statement), forwarded: { module, imported: '*' } });
    }
  }
  const apiName = (node: ts.Expression): { module: string; name: string } | undefined => {
    if (ts.isIdentifier(node)) return declared(node.text, node, false) ? undefined : imported.get(node.text);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (declared(node.expression.text, node, false)) return undefined;
      const namespace = imported.get(node.expression.text);
      if (namespace?.name === '*') return { module: namespace.module, name: node.name.text };
    }
    return undefined;
  };
  const frameworkIdentifier = (node: ts.Node, rule: string) => {
    if (!ts.isIdentifier(node) || declared(node.text, node, false)) return;
    const symbol = imported.get(node.text);
    if (symbol) add(node, symbol.module, 'framework', [{ imported: symbol.name, local: node.text, typeOnly: false }], rule);
  };
  const tokenRef = (node: ts.Node | undefined): TokenRef | undefined => {
    if (!node || !ts.isIdentifier(node) || declared(node.text, node, false)) return undefined;
    const importedToken = imported.get(node.text);
    return importedToken ? { name: importedToken.name, module: importedToken.module } : { name: node.text };
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
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings: Binding[] = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map(item => ({ imported: item.propertyName?.text ?? item.name.text, local: item.name.text, typeOnly: node.isTypeOnly || item.isTypeOnly }))
        : [{ imported: '*', typeOnly: node.isTypeOnly }];
      add(node.moduleSpecifier, node.moduleSpecifier.text, 'reexport', bindings, 'JavaScript re-export');
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference, literal(node.moduleReference.expression), 'import', [{ imported: '*', local: node.name.text, typeOnly: node.isTypeOnly }], 'TypeScript import equals', literal(node.moduleReference.expression) === undefined ? 'Computed import-equals target' : undefined);
    }
    if (ts.isCallExpression(node)) {
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
      if (api && api.module.startsWith('@tramvai/') && api.name === 'useDi') {
        const token = tokenRef(node.arguments[0]);
        if (token) result.consumers.push({ token, evidence: evidence(node, 'Tramvai useDi token; runtime registration and scope unverified') });
        else if (node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
          for (const entry of node.arguments[0].properties) {
            const token = tokenRef(ts.isPropertyAssignment(entry) ? entry.initializer : ts.isShorthandPropertyAssignment(entry) ? entry.name : undefined);
            if (token) result.consumers.push({ token, evidence: evidence(entry, 'Tramvai useDi token map; runtime registration and scope unverified') });
          }
        }
      }
      if (api && api.module.startsWith('@tramvai/') && ['createApp', 'createChildApp', 'provide', 'Module'].includes(api.name)) {
        const options = node.arguments[0];
        if (options && ts.isObjectLiteralExpression(options)) {
          if (api.name === 'createChildApp') result.childName = literal(property(options, 'name'));
          for (const key of ['render', 'useClass', 'useValue', 'useFactory', 'provide']) {
            const value = property(options, key); if (value) frameworkIdentifier(value, `Tramvai ${api.name}.${key} declaration; runtime scope not inferred`);
          }
          for (const key of ['modules', 'actions']) {
            const value = property(options, key);
            if (value && ts.isArrayLiteralExpression(value)) for (const item of value.elements) frameworkIdentifier(item, `Tramvai ${api.name}.${key} declaration`);
          }
          const providerToken = property(options, 'provide');
          const declaredToken = tokenRef(providerToken);
          if (api.name === 'provide' && declaredToken) result.providers.push({ token: declaredToken, evidence: evidence(node, 'Tramvai provider declaration; registration and runtime scope unverified') });
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
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && ['src', 'href', 'poster'].includes(node.name.getText(source))) {
      const target = node.initializer.text;
      if (target && !/^(?:[a-z]+:|\/\/|#)/i.test(target) && (node.name.getText(source) !== 'href' || /\.[a-z0-9]+(?:[?#].*)?$/i.test(target))) add(node.initializer, target, 'resource', [], 'Static JSX resource attribute');
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
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  for (const diagnostic of parseDiagnostics ?? []) {
    const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    result.diagnostics.push(`JavaScript/TypeScript parse error TS${diagnostic.code} at ${position.line + 1}:${position.character + 1}; analysis may be incomplete`);
  }
  return result;
}
