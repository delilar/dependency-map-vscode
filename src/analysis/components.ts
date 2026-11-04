import path from 'node:path';
import ts from 'typescript';
import { parseFragment } from 'parse5';
import type { Binding } from '../shared/model';
import { extractJavascript, type JsResult, type Reference } from './javascript';
import { extractResources } from './resources';
import { emptySourceResult, mergeSourceRegion, sourceRange } from './result-utils';
import { nativeResourceAttribute } from './html-resources';
import parseSrcset from 'parse-srcset';

type Imported = { reference: Reference; binding: Binding };
const localPath = (value: string) => !!value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
const scriptLanguages = new Set(['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx']);
const styleLanguages = new Set(['css', 'scss', 'sass', 'less', 'styl', 'stylus']);
const globals = new Set(['undefined', 'NaN', 'Infinity', 'Math', 'Date', 'Array', 'Object', 'Number', 'String', 'Boolean', 'JSON', 'Intl', 'console', '$event', '$attrs', '$slots', '$emit', '$props', '$refs', '$el', '$nextTick']);
const builtinComponents = new Set(['slot', 'component', 'template', 'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense']);
const kebab = (value: string) => value.replace(/\B([A-Z])/g, '-$1').toLowerCase();

function boundNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(item => ts.isOmittedExpression(item) ? [] : boundNames(item.name));
}

function scriptNames(text: string): Set<string> {
  const source = ts.createSourceFile('component.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) for (const name of boundNames(declaration.name)) names.add(name);
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) names.add(statement.name.text);
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.name) names.add(statement.importClause.name.text);
      const binding = statement.importClause?.namedBindings;
      if (binding) for (const name of ts.isNamespaceImport(binding) ? [binding.name.text] : binding.elements.map(item => item.name.text)) names.add(name);
    }
  }
  return names;
}

function imports(result: JsResult): Map<string, Imported> {
  const values = new Map<string, Imported>();
  for (const reference of result.references) if (reference.kind === 'import') for (const binding of reference.bindings) {
    if (binding.local && !binding.typeOnly) values.set(binding.local, { reference, binding });
  }
  return values;
}

function resource(result: JsResult, text: string, value: string, start: number, end: number, rule: string, attribute?: string): void {
  for (const target of attribute === 'srcset' ? parseSrcset(value).map(item => item.url) : [value]) {
    if (localPath(target)) result.references.push({ kind: 'resource', specifier: target, bindings: [], resolutionMode: 'asset', evidence: { rule, range: sourceRange(text, start, end) } });
  }
}

function templateBinding(result: JsResult, text: string, imported: Imported, start: number, end: number, rule: string, member?: string): void {
  const binding = member ? { imported: member, local: `${imported.binding.local}.${member}`, typeOnly: false } : { ...imported.binding };
  const range = sourceRange(text, start, end);
  result.references.push({ ...imported.reference, bindings: [binding], evidence: { rule, range }, occurrences: [{ ...binding, range }] });
}

function implicit(result: JsResult, text: string, name: string, start: number, end: number, kind: 'value' | 'component'): void {
  if (!globals.has(name)) (result.implicitNames ??= []).push({ name, kind, evidence: { rule: `Vue implicit template ${kind}; framework context required`, range: sourceRange(text, start, end) } });
}

function implicitExpression(result: JsResult, text: string, expression: string, start: number, end: number, known: Set<string>, locals: Set<string>): void {
  const prefix = 'const __expression = (';
  const source = ts.createSourceFile('template.ts', `${prefix}${expression});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const locallyBound = (name: string, node: ts.Node) => {
    for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent) && parent.parameters.some(parameter => boundNames(parameter.name).includes(name))) return true;
      if (ts.isBlock(parent) && parent.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => boundNames(declaration.name).includes(name)))) return true;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const property = ts.isPropertyAccessExpression(parent) && parent.name === node
        || ts.isPropertyAssignment(parent) && parent.name === node
        || ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)
        || ts.isParameter(parent) && parent.name === node
        || ts.isVariableDeclaration(parent) && parent.name === node;
      const offset = node.getStart(source) - prefix.length;
      if (!property && offset >= 0 && offset < expression.length && !known.has(node.text) && !locals.has(node.text) && !locallyBound(node.text, node)) {
        const directMapping = text.slice(start, end) === expression;
        implicit(result, text, node.text, directMapping ? start + offset : start, directMapping ? start + offset + node.text.length : end, 'value');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function patternNames(pattern: string): string[] {
  const source = ts.createSourceFile('binding.ts', `const __binding = (${pattern}) => 0`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = source.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) return [];
  const expression = statement.declarationList.declarations[0]?.initializer;
  return expression && ts.isArrowFunction(expression) ? expression.parameters.flatMap(parameter => boundNames(parameter.name)) : [];
}

function literalExpression(value: string): string | undefined {
  const source = ts.createSourceFile('literal.ts', `(${value})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return undefined;
  const expression = ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : statement.expression;
  return ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

function addScript(result: JsResult, file: string, text: string, content: string, start: number, lang: string, exported: boolean, kind: string): void {
  (result.regions ??= []).push({ languageId: lang, kind, range: sourceRange(text, start, start + content.length) });
  if (!scriptLanguages.has(lang)) { result.diagnostics.push(`Unsupported component script language: ${lang}`); return; }
  const extension = ['ts', 'typescript'].includes(lang) ? 'ts' : lang === 'tsx' ? 'tsx' : lang === 'jsx' ? 'jsx' : 'js';
  mergeSourceRegion(result, extractJavascript(`${file}.${extension}`, content), text, start, { exports: exported });
}

function addStyle(result: JsResult, file: string, text: string, content: string, start: number, language: string): void {
  const lang = language === 'stylus' ? 'styl' : language;
  (result.regions ??= []).push({ languageId: lang, kind: 'style', range: sourceRange(text, start, start + content.length) });
  if (!styleLanguages.has(language)) { result.diagnostics.push(`Unsupported component style language: ${language}`); return; }
  const part = extractResources(`${file}.${lang}`, content);
  for (const reference of part.references) {
    reference.sourceExtension = `.${lang}`;
    reference.resolutionMode = /(?:@(?:import|use|forward)|Stylus (?:import|require))/.test(reference.evidence.rule) ? 'style' : 'asset';
  }
  mergeSourceRegion(result, part, text, start, { exports: false });
}

function vueRegistrations(content: string, imported: Map<string, Imported>): Map<string, string> {
  const source = ts.createSourceFile('vue.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const registrations = new Map<string, string>();
  for (const statement of source.statements) if (ts.isExportAssignment(statement)) {
    let value = statement.expression;
    if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
      const api = imported.get(value.expression.text);
      if (api?.reference.specifier === 'vue' && api.binding.imported === 'defineComponent' && value.arguments[0]) value = value.arguments[0];
    }
    if (!ts.isObjectLiteralExpression(value)) continue;
    const components = value.properties.find(item => item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === 'components');
    if (!components || !ts.isPropertyAssignment(components) || !ts.isObjectLiteralExpression(components.initializer)) continue;
    for (const entry of components.initializer.properties) {
      if (ts.isShorthandPropertyAssignment(entry) && imported.has(entry.name.text)) registrations.set(entry.name.text, entry.name.text);
      if (ts.isPropertyAssignment(entry) && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && ts.isIdentifier(entry.initializer) && imported.has(entry.initializer.text)) registrations.set(entry.name.text, entry.initializer.text);
    }
  }
  return registrations;
}

async function vue(file: string, text: string): Promise<JsResult> {
  const result = emptySourceResult();
  // The browser parse build avoids the Node build's optional preprocessor loaders.
  // @ts-expect-error The official browser bundle exposes parse but omits its declaration file.
  const { parse } = await import('@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js') as typeof import('@vue/compiler-sfc');
  const { descriptor, errors } = parse(text, { filename: file, sourceMap: false });
  if (errors.length) result.diagnostics.push('Vue SFC parse error; some regions may be incomplete');
  const scripts = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null);
  const known = new Set<string>();
  for (const block of scripts) {
    if (block.src) result.references.push({ specifier: block.src, kind: 'import', bindings: [], resolutionMode: 'module', evidence: { rule: 'Vue external script src', range: sourceRange(text, block.loc.start.offset, block.loc.end.offset) } });
    else {
      addScript(result, file, text, block.content, block.loc.start.offset, block.lang ?? 'js', !block.setup, block.setup ? 'script-setup' : 'script');
      for (const name of scriptNames(block.content)) known.add(name);
    }
  }
  const imported = imports(result);
  const exposed = descriptor.scriptSetup ? new Map([...imported.keys()].map(name => [name, name])) : vueRegistrations(descriptor.script?.content ?? '', imported);
  const resolveTag = (tag: string, locals: Set<string>): Imported | undefined => {
    const [base, member] = tag.split('.');
    if (locals.has(base)) return undefined;
    const local = [...exposed].find(([name]) => name === base || kebab(name) === base)?.[1];
    const item = local ? imported.get(local) : undefined;
    return member && item?.binding.imported !== '*' ? undefined : item;
  };
  const template = descriptor.template;
  if (template?.src) resource(result, text, template.src, template.loc.start.offset, template.loc.end.offset, 'Vue external template src');
  else if (template) {
    (result.regions ??= []).push({ languageId: template.lang ?? 'html', kind: 'template', range: sourceRange(text, template.loc.start.offset, template.loc.end.offset) });
    if (template.lang && template.lang !== 'html') result.diagnostics.push(`Unsupported Vue template language: ${template.lang}`);
    else {
      const expression = (node: any, locals: Set<string>) => {
        if (node?.content && node.loc) implicitExpression(result, text, node.content, node.loc.start.offset, node.loc.end.offset, known, locals);
      };
      const visit = (node: any, inherited: Set<string>) => {
        const locals = new Set(inherited);
        if (node.type === 1) {
          for (const prop of node.props ?? []) if (prop.type === 7 && prop.name === 'for') {
            const parsed = prop.forParseResult;
            if (parsed) {
              expression(parsed.source, inherited);
              for (const binding of [parsed.value, parsed.key, parsed.index]) if (binding) for (const name of patternNames(binding.content)) locals.add(name);
            } else result.diagnostics.push('Unsupported Vue v-for binding; template analysis may be incomplete');
          }
          for (const prop of node.props ?? []) if (prop.type === 7 && prop.name === 'slot' && prop.exp) for (const name of patternNames(prop.exp.content)) locals.add(name);
          if (node.tagType === 1 && !builtinComponents.has(node.tag)) {
            const item = resolveTag(node.tag, locals);
            const start = node.loc.start.offset + 1;
            if (item) templateBinding(result, text, item, start, start + node.tag.length, 'Vue template component binding', node.tag.includes('.') ? node.tag.split('.')[1] : undefined);
            else if (!locals.has(node.tag.split('.')[0]) && !known.has(node.tag) && !known.has(node.tag.split('.')[0])) implicit(result, text, node.tag, start, start + node.tag.length, 'component');
          }
          for (const prop of node.props ?? []) {
            if (node.tagType === 0 && prop.type === 6 && nativeResourceAttribute(node.tag, prop.name) && prop.value) resource(result, text, prop.value.content, prop.loc.start.offset, prop.loc.end.offset, `Vue template ${prop.name}`, prop.name);
            if (prop.type !== 7 || prop.name === 'for' || prop.name === 'slot') continue;
            if (node.tagType === 0 && prop.name === 'bind' && prop.arg?.isStatic && nativeResourceAttribute(node.tag, prop.arg.content) && prop.exp) {
              const value = literalExpression(prop.exp.content);
              if (value !== undefined) resource(result, text, value, prop.loc.start.offset, prop.loc.end.offset, `Vue template bound ${prop.arg.content}`, prop.arg.content);
            }
            expression(prop.exp, locals);
          }
        } else if (node.type === 5) expression(node.content, locals);
        for (const child of node.children ?? []) visit(child, locals);
      };
      visit(template.ast, new Set());
    }
  }
  for (const block of descriptor.styles) {
    if (block.src) resource(result, text, block.src, block.loc.start.offset, block.loc.end.offset, 'Vue external style src');
    else addStyle(result, file, text, block.content, block.loc.start.offset, block.lang ?? 'css');
  }
  for (const block of descriptor.customBlocks) {
    result.diagnostics.push(`Unsupported Vue custom block: ${block.type}`);
    if (block.src) resource(result, text, block.src, block.loc.start.offset, block.loc.end.offset, 'Vue external custom-block src');
  }
  if (!result.exports.some(entry => entry.name === 'default')) result.exports.push({ name: 'default', namespace: 'value', kind: 'direct', range: sourceRange(text, 0, Math.min(text.length, 1)) });
  return result;
}

type HtmlBlock = { name: 'script' | 'style'; start: number; end: number; attrs: Map<string, string>; topLevel: boolean };
function svelteBlocks(text: string): HtmlBlock[] {
  const fragment = parseFragment(text, { sourceCodeLocationInfo: true });
  const blocks: HtmlBlock[] = [];
  const visit = (node: any, depth: number) => {
    if (['script', 'style'].includes(node.tagName)) {
      const loc = node.sourceCodeLocation;
      if (loc?.startTag && loc.endTag) blocks.push({ name: node.tagName as HtmlBlock['name'], start: loc.startTag.endOffset, end: loc.endTag.startOffset, attrs: new Map(node.attrs.map((attribute: { name: string; value: string }) => [attribute.name, attribute.value])), topLevel: depth === 1 });
    }
    for (const child of node.childNodes ?? []) visit(child, depth + 1);
    if (node.content) visit(node.content, depth + 1);
  };
  visit(fragment, 0);
  return blocks;
}

async function svelte(file: string, text: string): Promise<JsResult> {
  const result = emptySourceResult();
  const blocks = svelteBlocks(text);
  const parsedScripts = new Set<HtmlBlock>();
  for (const block of blocks) if (block.name === 'script' && block.topLevel) {
    const module = block.attrs.has('module') || block.attrs.get('context') === 'module';
    addScript(result, file, text, text.slice(block.start, block.end), block.start, block.attrs.get('lang') ?? 'js', module, module ? 'script-module' : 'script');
    parsedScripts.add(block);
  }
  let masked = text;
  for (const block of [...blocks].reverse()) {
    const language = block.attrs.get('lang') ?? (block.name === 'script' ? 'js' : 'css');
    const content = text.slice(block.start, block.end);
    // Mask only parser-delimited regions: project preprocessors never execute.
    if (block.name === 'style' || !scriptLanguages.has(language)) masked = masked.slice(0, block.start) + content.replace(/[^\r\n]/g, ' ') + masked.slice(block.end);
  }
  const { parse } = require('svelte/compiler') as typeof import('svelte/compiler');
  let ast: any;
  try { ast = parse(masked, { modern: true }); }
  catch { result.diagnostics.push('Svelte component parse error; template analysis is incomplete'); return result; }
  for (const block of blocks) {
    const language = block.attrs.get('lang') ?? (block.name === 'script' ? 'js' : 'css');
    const content = text.slice(block.start, block.end);
    if (block.name === 'script') {
      const module = ast.module?.content?.start === block.start;
      if (!parsedScripts.has(block) && (module || ast.instance?.content?.start === block.start)) addScript(result, file, text, content, block.start, language, module, module ? 'script-module' : 'script');
    } else if (ast.css?.content?.start === block.start) addStyle(result, file, text, content, block.start, language);
  }
  const imported = imports(result);
  const visit = (node: any, inherited: Set<string>) => {
    if (!node || typeof node !== 'object') return;
    const locals = new Set(inherited);
    if (node.type === 'EachBlock') {
      const names = (pattern: any): void => {
        if (!pattern) return;
        if (pattern.type === 'Identifier') locals.add(pattern.name);
        else if (pattern.type === 'ObjectPattern') for (const prop of pattern.properties ?? []) names(prop.value ?? prop.argument);
        else if (pattern.type === 'ArrayPattern') for (const item of pattern.elements ?? []) names(item);
        else if (pattern.type === 'AssignmentPattern') names(pattern.left);
        else if (pattern.type === 'RestElement') names(pattern.argument);
      };
      names(node.context);
      if (node.index) locals.add(node.index);
    }
    for (const attribute of node.attributes ?? []) if (attribute.type === 'LetDirective') locals.add(attribute.expression?.name ?? attribute.name);
    if (node.type === 'Component') {
      const [name, member] = node.name.split('.');
      const item = locals.has(name) ? undefined : imported.get(name);
      if (item && (!member || item.binding.imported === '*')) templateBinding(result, text, item, node.start + 1, node.start + 1 + node.name.length, 'Svelte template component binding', member);
    }
    if (node.type === 'SvelteComponent') result.references.push({ kind: 'framework', bindings: [], evidence: { rule: 'Svelte dynamic component expression', range: sourceRange(text, node.start, node.end) }, reason: 'Dynamic component target cannot be resolved statically' });
    for (const attribute of node.attributes ?? []) if (node.type === 'RegularElement' && attribute.type === 'Attribute' && nativeResourceAttribute(node.name, attribute.name)) {
      const values = Array.isArray(attribute.value) ? attribute.value : [attribute.value];
      if (values.length !== 1) continue;
      const value = values[0];
      const literal = value?.type === 'Text' ? value.data : value?.type === 'ExpressionTag' && value.expression?.type === 'Literal' && typeof value.expression.value === 'string' ? value.expression.value : undefined;
      if (literal !== undefined) resource(result, text, literal, attribute.start, attribute.end, `Svelte template ${attribute.name}`, attribute.name);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['parent', 'metadata', 'loc', 'attributes', 'expression', 'content'].includes(key)) continue;
      if (Array.isArray(value)) for (const child of value) visit(child, locals);
      else if (value && typeof value === 'object') visit(value, locals);
    }
  };
  visit(ast.fragment, new Set());
  result.exports.push({ name: 'default', namespace: 'value', kind: 'direct', range: sourceRange(text, 0, Math.min(text.length, 1)) });
  return result;
}

export async function extractComponent(file: string, text: string): Promise<JsResult | undefined> {
  const extension = path.extname(file).toLowerCase();
  if (extension !== '.vue' && extension !== '.svelte') return undefined;
  try { return extension === '.vue' ? await vue(file, text) : await svelte(file, text); }
  catch {
    const result = emptySourceResult();
    result.diagnostics.push(`${extension === '.vue' ? 'Vue' : 'Svelte'} component parser failed; analysis is incomplete`);
    return result;
  }
}
