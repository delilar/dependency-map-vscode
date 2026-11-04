import path from 'node:path';
import ts from 'typescript';

export interface StaticConfig { value?: Record<string, any>; partial: boolean }
export function splitSpecifier(specifier: string): { path: string; qualifier: string } {
  const query = specifier.indexOf('?');
  const hash = specifier.indexOf('#', specifier.startsWith('#') ? 1 : 0);
  const split = [query, hash].filter(index => index >= 0).sort((a, b) => a - b)[0];
  return split === undefined ? { path: specifier, qualifier: '' } : { path: specifier.slice(0, split), qualifier: specifier.slice(split) };
}

export const webConfigPattern = /^(?:(?:vite|vitest|webpack|next|nuxt|svelte|astro|playwright|cypress|postcss|tailwind|graphql)\.config|\.storybook[\\/](?:main|preview)|jest\.config)(?:\.[cm]?[jt]s)?$/i;

export function readStaticConfig(file: string, text: string): StaticConfig {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = new Map<string, { module: string; name: string }>();
  const constants = new Map<string, ts.Expression>();
  let exported: ts.Expression | undefined;
  let partial = false;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
      const clause = statement.importClause;
      if (clause?.name) imports.set(clause.name.text, { module: statement.moduleSpecifier.text, name: 'default' });
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) imports.set(clause.namedBindings.name.text, { module: statement.moduleSpecifier.text, name: '*' });
        else for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) imports.set(item.name.text, { module: statement.moduleSpecifier.text, name: item.propertyName?.text ?? item.name.text });
      }
    }
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name) && item.initializer) constants.set(item.name.text, item.initializer);
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) exported = statement.expression;
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
      const assignment = statement.expression;
      if (assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(assignment.left) && assignment.left.expression.getText(source) === 'module' && assignment.left.name.text === 'exports') exported = assignment.right;
    }
  }
  const wrappers = new Set(['vite', 'vitest/config', 'nuxt/config', '@nuxt/kit', 'astro/config', '@playwright/test', 'cypress']);
  const localUrl = Symbol('static URL');
  const mutated = new Set<string>();
  const rootName = (node: ts.Node): string | undefined => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? rootName(node.expression) : undefined;
  const objectConstant = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name) || seen.size > 30) return false;
    const value = constants.get(name); if (!value) return false;
    return ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || ts.isIdentifier(value) && objectConstant(value.text, new Set(seen).add(name));
  };
  const invalidate = (name: string) => {
    let current: string | undefined = name;
    for (let count = 0; current && !mutated.has(current) && count < 10000; count++) {
      mutated.add(current);
      const value = constants.get(current);
      current = value && ts.isIdentifier(value) ? value.text : undefined;
    }
  };
  const mutations = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment || ts.isDeleteExpression(node) || ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) || ts.isPostfixUnaryExpression(node)) {
      const target = ts.isBinaryExpression(node) ? node.left : ts.isDeleteExpression(node) ? node.expression : node.operand;
      const name = rootName(target); if (name && constants.has(name)) invalidate(name);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) { const name = rootName(node.expression.expression); if (name && objectConstant(name)) invalidate(name); }
    if (ts.isVariableDeclaration(node) && node.initializer && (!ts.isIdentifier(node.name) || ts.isPropertyAccessExpression(node.initializer) || ts.isElementAccessExpression(node.initializer))) { const name = rootName(node.initializer); if (name && objectConstant(name)) invalidate(name); }
    if (ts.isCallExpression(node)) for (const argument of node.arguments) if (ts.isIdentifier(argument) && objectConstant(argument.text)) {
      const api = ts.isIdentifier(node.expression) ? imports.get(node.expression.text) : undefined;
      if (!(api && wrappers.has(api.module) && ['defineConfig', 'defineNuxtConfig'].includes(api.name))) invalidate(argument.text);
    }
    ts.forEachChild(node, mutations);
  };
  mutations(source);
  const unknown = () => { partial = true; return undefined; };
  let evaluationSteps = 0;
  const evaluate = (node: ts.Expression | undefined, seen = new Set<string>(), depth = 0): any => {
    if (!node || depth > 30 || ++evaluationSteps > 10000) return unknown();
    const next = (value: ts.Expression | undefined) => evaluate(value, seen, depth + 1);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return next(node.expression);
    if (ts.isIdentifier(node)) {
      if (mutated.has(node.text)) return unknown();
      if (node.text === '__dirname' && !constants.has(node.text)) return path.dirname(file);
      if (node.text === 'undefined') return undefined;
      if (seen.has(node.text) || !constants.has(node.text)) return unknown();
      return evaluate(constants.get(node.text), new Set(seen).add(node.text), depth + 1);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values: unknown[] = [];
      for (const item of node.elements) { if (evaluationSteps >= 10000) { unknown(); break; } values.push(ts.isSpreadElement(item) ? unknown() : next(item)); }
      return values;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const value: Record<string, any> = Object.create(null);
      for (const item of node.properties) {
        if (evaluationSteps >= 10000) { unknown(); break; }
        if (ts.isShorthandPropertyAssignment(item)) value[item.name.text] = next(item.name);
        else if (ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name))) value[item.name.text] = next(item.initializer);
        else {
          if ('name' in item && item.name && (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name))) value[item.name.text] = undefined;
          else for (const key of Object.keys(value)) value[key] = undefined;
          unknown();
        }
      }
      return value;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const api = ts.isIdentifier(expression) ? imports.get(expression.text) : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) ? (() => { const entry = imports.get(expression.expression.text); return entry && { module: entry.module, name: expression.name.text }; })() : undefined;
      if (api && wrappers.has(api.module) && ['defineConfig', 'defineNuxtConfig'].includes(api.name) && node.arguments.length === 1) return next(node.arguments[0]);
      if (ts.isIdentifier(expression) && ['defineNuxtConfig', 'defineConfig'].includes(expression.text) && !imports.has(expression.text) && !constants.has(expression.text) && /^nuxt\.config\./.test(path.basename(file)) && !source.statements.some(item => ts.isFunctionDeclaration(item) && item.name?.text === expression.text)) return next(node.arguments[0]);
      if (api && ['path', 'node:path'].includes(api.module) && ['resolve', 'join'].includes(api.name)) {
        const parts = node.arguments.map(item => next(item));
        if (parts.every(item => typeof item === 'string')) return api.name === 'join' ? path.join(...parts) : path.resolve(path.dirname(file), ...parts);
      }
      if (api && ['url', 'node:url'].includes(api.module) && api.name === 'fileURLToPath' && node.arguments.length === 1) { const value = next(node.arguments[0]); return value?.[localUrl] ?? unknown(); }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.length === 2 && node.arguments[1].getText(source) === 'import.meta.url') {
      const relative = next(node.arguments[0]);
      if (typeof relative === 'string' && relative.startsWith('.') && !constants.has('URL') && !imports.has('URL') && !source.statements.some(item => ts.isClassDeclaration(item) && item.name?.text === 'URL')) return { [localUrl]: path.resolve(path.dirname(file), relative) };
    }
    return unknown();
  };
  const value = evaluate(exported);
  return { value: value && typeof value === 'object' && !Array.isArray(value) ? value : undefined, partial };
}
