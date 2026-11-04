import path from 'node:path';
import ts from 'typescript';
import type { SourceRange } from '../shared/model';
import { extractJavascript, type JsResult } from './javascript';
import { extractResources } from './resources';
import { emptySourceResult, mergeSourceRegion, sourceRange } from './result-utils';

interface Point { offset?: number; line?: number; column?: number }
interface DocumentNode {
  type: string; value?: string; name?: string | null; url?: string; identifier?: string;
  position?: { start: Point; end?: Point }; children?: DocumentNode[];
  attributes?: { type?: string; name?: string; kind?: string; value?: string | { value?: string; type?: string }; position?: { start: Point; end?: Point } }[];
}

const local = (value: string) => !!value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
const supportedStyles = new Set(['css', 'scss', 'sass', 'less', 'styl', 'stylus']);

function addResource(result: JsResult, specifier: string, rule: string, range?: SourceRange): void {
  if (local(specifier)) result.references.push({ specifier, kind: 'resource', bindings: [], evidence: { rule, range } });
}

function literalExpression(value: string): string | undefined {
  const source = ts.createSourceFile('expression.ts', `(${value})`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return;
  const expression = ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : statement.expression;
  return ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

function componentReference(result: JsResult, name: string, range: SourceRange | undefined, format: string): void {
  const localName = name.split('.')[0];
  const original = result.references.find(reference => reference.kind === 'import' && reference.bindings.some(binding => binding.local === localName && !binding.typeOnly));
  const binding = original?.bindings.find(item => item.local === localName && !item.typeOnly);
  if (original?.specifier && binding) result.references.push({ specifier: original.specifier, kind: 'import', bindings: [binding], evidence: { rule: `${format} component reference`, range },
    occurrences: range ? [{ ...binding, range }] : undefined });
}

function attributeResources(result: JsResult, node: DocumentNode, text: string, offsetOf?: (offset: number) => number): void {
  for (const attribute of node.attributes ?? []) {
    if (!attribute.name || !['src', 'href', 'poster', 'data'].includes(attribute.name)) continue;
    let value: string | undefined;
    if (typeof attribute.value === 'string') {
      value = attribute.kind === 'expression' || attribute.kind === 'template-literal' ? literalExpression(attribute.value) : attribute.value;
    } else if (attribute.value?.type === 'mdxJsxAttributeValueExpression') value = literalExpression(attribute.value.value ?? '');
    if (value === undefined) continue;
    const offset = attribute.position?.start.offset;
    const end = attribute.position?.end?.offset;
    const startOffset = offset === undefined ? undefined : offsetOf ? offsetOf(offset) : offset;
    const endOffset = end === undefined ? startOffset : offsetOf ? offsetOf(end) : end;
    addResource(result, value, `${offsetOf ? 'Astro' : 'MDX'} ${attribute.name}`, startOffset === undefined ? undefined : sourceRange(text, startOffset, endOffset ?? startOffset));
  }
}

async function markdown(file: string, text: string, mdx: boolean): Promise<JsResult> {
  const [{ unified }, { default: remarkParse }, { default: remarkFrontmatter }] = await Promise.all([import('unified'), import('remark-parse'), import('remark-frontmatter')]);
  const parser = unified().use(remarkParse).use(remarkFrontmatter);
  if (mdx) parser.use((await import('remark-mdx')).default);
  const result = emptySourceResult();
  let tree: DocumentNode;
  try { tree = parser.parse(text) as DocumentNode; }
  catch { result.diagnostics.push(`${mdx ? 'MDX' : 'Markdown'} parse error; references may be incomplete`); return result; }
  const frontmatter = tree.children?.find(node => node.type === 'yaml');
  if (frontmatter?.value) {
    const { parseDocument } = await import('yaml');
    const metadata = parseDocument(frontmatter.value);
    if (metadata.errors.length) result.diagnostics.push('Markdown frontmatter is malformed; layout reference is unavailable');
    else { const layout = metadata.get('layout'); if (typeof layout === 'string') result.layout = layout; else if (layout !== undefined) result.layoutDynamic = true; }
  }
  const definitions = new Map<string, DocumentNode>();
  let moduleSource = text.replace(/[^\r\n]/g, ' ');
  let hasModule = false;
  const visit = (node: DocumentNode, action: (node: DocumentNode) => void): void => {
    action(node);
    if (node.type === 'code' || node.type === 'inlineCode') return;
    for (const child of node.children ?? []) visit(child, action);
  };
  visit(tree, node => {
    if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier.toLowerCase())) definitions.set(node.identifier.toLowerCase(), node);
    if (node.type === 'mdxjsEsm' && typeof node.value === 'string' && node.position?.start.offset !== undefined) {
      const offset = node.position.start.offset;
      moduleSource = moduleSource.slice(0, offset) + node.value + moduleSource.slice(offset + node.value.length);
      (result.regions ??= []).push({ languageId: 'javascript', kind: 'mdx-esm', range: sourceRange(text, offset, offset + node.value.length) });
      hasModule = true;
    }
  });
  if (hasModule) mergeSourceRegion(result, extractJavascript(`${file}.js`, moduleSource), text, 0);
  visit(tree, node => {
    const start = node.position?.start.offset, end = node.position?.end?.offset;
    const range = start === undefined ? undefined : sourceRange(text, start, end ?? start);
    if (['link', 'image'].includes(node.type) && node.url) addResource(result, node.url, `Markdown ${node.type}`, range);
    if (node.type === 'html' && node.value && start !== undefined) mergeSourceRegion(result, extractResources(file + '.html', node.value), text, start, { exports: false });
    if (['linkReference', 'imageReference'].includes(node.type) && node.identifier) {
      const definition = definitions.get(node.identifier.toLowerCase());
      if (definition?.url) addResource(result, definition.url, `Markdown ${node.type}`, range);
    }
    if (['mdxFlowExpression', 'mdxTextExpression'].includes(node.type) && typeof node.value === 'string' && start !== undefined) {
      const offset = text.indexOf(node.value, start);
      if (offset >= start && offset + node.value.length <= (end ?? text.length)) mergeSourceRegion(result, extractJavascript(`${file}.tsx`, node.value), text, offset, { exports: false });
    }
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      if (node.name) componentReference(result, node.name, range, 'MDX');
      if (node.name && /^[a-z][\w:-]*$/.test(node.name)) attributeResources(result, node, text);
    }
  });
  if (mdx && !result.exports.some(entry => entry.name === 'default')) result.exports.push({ name: 'default', namespace: 'value', kind: 'direct', range: sourceRange(text, 0, 0) });
  return result;
}

function byteOffsetMapper(text: string): (offset: number) => number {
  const offsets = new Uint32Array(Buffer.byteLength(text, 'utf8') + 1);
  let byte = 0, character = 0;
  for (const value of text) {
    const width = Buffer.byteLength(value, 'utf8');
    offsets.fill(character, byte, byte + width);
    byte += width; character += value.length;
    offsets[byte] = character;
  }
  return offset => offsets[Math.max(0, Math.min(Math.trunc(offset), offsets.length - 1))];
}

function contentOffset(text: string, node: DocumentNode, offsetOf: (offset: number) => number): number | undefined {
  if (!node.value || node.position?.start.offset === undefined) return;
  const start = offsetOf(node.position.start.offset);
  const end = node.position.end?.offset === undefined ? text.length : offsetOf(node.position.end.offset);
  const found = text.indexOf(node.value, start);
  return found >= start && found + node.value.length <= end ? found : undefined;
}

async function astro(file: string, text: string): Promise<JsResult> {
  const result = emptySourceResult();
  let tree: DocumentNode;
  try {
    const imported = await import('@astrojs/compiler');
    const compiler = 'default' in imported ? imported.default as typeof imported : imported;
    const parsed = await compiler.parse(text, { position: true });
    tree = parsed.ast as DocumentNode;
    for (const diagnostic of parsed.diagnostics) if (diagnostic.severity <= 2) result.diagnostics.push(`Astro parse diagnostic ${diagnostic.code}; references may be incomplete`);
  } catch { result.diagnostics.push('Astro parse error; references may be incomplete'); return result; }
  const offsetOf = byteOffsetMapper(text);
  const scripts: DocumentNode[] = [];
  const visit = (node: DocumentNode): void => {
    if (node.type === 'frontmatter') {
      const offset = contentOffset(text, node, offsetOf);
      if (offset !== undefined) {
        mergeSourceRegion(result, extractJavascript(`${file}.ts`, node.value!), text, offset);
        (result.regions ??= []).push({ languageId: 'typescript', kind: 'script', range: sourceRange(text, offset, offset + node.value!.length) });
      }
      else if (node.value?.trim()) result.diagnostics.push('Astro frontmatter source position unavailable');
      return;
    }
    if (node.type === 'element' && ['script', 'style'].includes(node.name ?? '')) { scripts.push(node); return; }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  for (const node of scripts) {
    if (node.type === 'element') attributeResources(result, node, text, offsetOf);
    const attrs = new Map((node.attributes ?? []).filter(attribute => typeof attribute.value === 'string').map(attribute => [attribute.name, attribute.value as string]));
    if (attrs.has('src')) continue;
    const style = node.name === 'style';
    if (!style && attrs.has('type') && !['module', 'text/javascript', 'application/javascript'].includes(attrs.get('type')!)) continue;
    const language = attrs.get('lang') ?? (style ? 'css' : 'js');
    if (!(style ? supportedStyles.has(language) : ['js', 'ts', 'javascript', 'typescript'].includes(language))) {
      result.diagnostics.push(`Astro ${style ? 'style' : 'script'} language is not supported`); continue;
    }
    const content = node.children?.find(child => child.type === 'text');
    if (!content?.value) continue;
    const offset = contentOffset(text, content, offsetOf);
    if (offset === undefined) { result.diagnostics.push(`Astro ${node.name} source position unavailable`); continue; }
    const suffix = language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language === 'stylus' ? 'styl' : language;
    const part = style ? extractResources(`${file}.${suffix}`, content.value) : extractJavascript(`${file}.${suffix}`, content.value);
    if (style) for (const reference of part.references) {
      reference.sourceExtension = `.${suffix}`;
      reference.resolutionMode = /^Stylesheet @|^(?:Less|Stylus|Sass) (?:@|import|require|use|forward)/.test(reference.evidence.rule) ? 'style' : 'asset';
    }
    mergeSourceRegion(result, part, text, offset, { exports: false });
    (result.regions ??= []).push({ languageId: language, kind: style ? 'style' : 'script', range: sourceRange(text, offset, offset + content.value.length) });
  }
  const template = (node: DocumentNode): void => {
    if (node.type === 'frontmatter' || node.type === 'element' && ['script', 'style'].includes(node.name ?? '')) return;
    if (node.type === 'component' && node.name) {
      const offset = node.position?.start.offset;
      const range = offset === undefined ? undefined : sourceRange(text, offsetOf(offset), offsetOf(offset) + node.name.length + 1);
      componentReference(result, node.name, range, 'Astro');
    }
    if (node.type === 'element') attributeResources(result, node, text, offsetOf);
    for (const child of node.children ?? []) template(child);
  };
  template(tree);
  if (!result.exports.some(entry => entry.name === 'default')) result.exports.push({ name: 'default', namespace: 'value', kind: 'direct', range: sourceRange(text, 0, 0) });
  return result;
}

async function graphql(text: string): Promise<JsResult> {
  const result = emptySourceResult();
  if (/^\s*#\s*import\b/m.test(text)) result.diagnostics.push('GraphQL #import is a loader convention; no universal file-import rule is applied');
  const { parse, visit, Kind } = await import('graphql');
  try {
    const ast = parse(text);
    result.graphql = { definitions: [], spreads: [] };
    for (const definition of ast.definitions) {
      if ('name' in definition && definition.name && definition.name.loc) result.graphql.definitions.push({ name: definition.name.value,
        kind: definition.kind === Kind.FRAGMENT_DEFINITION ? 'fragment' : definition.kind === Kind.OPERATION_DEFINITION ? 'operation' : 'type',
        range: sourceRange(text, definition.name.loc.start, definition.name.loc.end) });
    }
    visit(ast, { FragmentSpread(node) {
      if (node.name.loc) result.graphql!.spreads.push({ name: node.name.value, range: sourceRange(text, node.name.loc.start, node.name.loc.end) });
    } });
  } catch { result.diagnostics.push('GraphQL parse error; definitions and references may be incomplete'); }
  return result;
}

export async function extractDocument(file: string, text: string): Promise<JsResult | undefined> {
  switch (path.extname(file).toLowerCase()) {
    case '.md': case '.markdown': return markdown(file, text, false);
    case '.mdx': return markdown(file, text, true);
    case '.astro': return astro(file, text);
    case '.graphql': case '.gql': return graphql(text);
    default: return undefined;
  }
}

export async function extractEmbeddedGraphQL(file: string, text: string): Promise<JsResult> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = new Set<string>();
  for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && ['graphql-tag', '@apollo/client', '@urql/core', 'urql'].includes(statement.moduleSpecifier.text) && !statement.importClause?.isTypeOnly) {
    if (statement.moduleSpecifier.text === 'graphql-tag' && statement.importClause?.name) bindings.add(statement.importClause.name.text);
    const names = statement.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const item of names.elements) if (!item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === 'gql') bindings.add(item.name.text);
  }
  const result = emptySourceResult(); const pending: ts.TaggedTemplateExpression[] = [];
  const bound = (name: ts.BindingName): string[] => ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(item => ts.isOmittedExpression(item) ? [] : bound(item.name));
  const shadowed = (node: ts.Node, name: string) => {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent) && parent.parameters.some(parameter => bound(parameter.name).includes(name))) return true;
      if (ts.isBlock(parent) || ts.isSourceFile(parent)) for (const statement of parent.statements) {
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => bound(declaration.name).includes(name))) return true;
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return true;
      }
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && bindings.has(node.tag.text) && !shadowed(node, node.tag.text)) pending.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const node of pending) {
    if (!ts.isNoSubstitutionTemplateLiteral(node.template)) { result.diagnostics.push('Interpolated GraphQL document is not evaluated'); continue; }
    const raw = text.slice(node.template.getStart(source) + 1, node.template.end - 1);
    if (raw !== node.template.text) { result.diagnostics.push('Escaped GraphQL document has unsupported source mapping'); continue; }
    const part = await graphql(raw);
    mergeSourceRegion(result, part, text, node.template.getStart(source) + 1);
  }
  return result;
}
