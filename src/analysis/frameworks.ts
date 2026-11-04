import path from 'node:path';
import ts from 'typescript';
import type { GraphNode, Evidence, Relation, SourceRange } from '../shared/model';
import type { JsResult, Reference } from './javascript';
import { sourceRange } from './result-utils';
import { extractResources } from './resources';
import { emptySourceResult, mergeSourceRegion } from './result-utils';
import { frameworkProfile } from './framework-profile';

export interface FrameworkProject {
  id: string; directory: string; manifest?: Record<string, any>;
  context: { config: Record<string, any>; partial: boolean; nuxt?: number; sourceDirectory: string;
    toolConfigs?: Record<string, { config: Record<string, any>; partial: boolean; directory: string }> };
}
export interface FrameworkFile { node: GraphNode; path: string; result?: JsResult }
export interface FrameworkHost {
  files: FrameworkFile[]; projects: FrameworkProject[];
  read(file: string): string | undefined;
  add(source: GraphNode, target: GraphNode, reference: Reference, certainty?: Relation['certainty']): void;
  diagnostic(source: GraphNode, reason: string): void;
  resolveDeclaration?(sourcePath: string, module: string, imported: string): { fileId: string; name: string; range?: SourceRange; provenanceIds: string[] } | undefined;
}
const slash = (value: string) => value.replace(/\\/g, '/');
const pathKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (directory: string, file: string) => { const value = path.relative(directory, file); return value === '' || !path.isAbsolute(value) && value !== '..' && !value.startsWith('..' + path.sep); };
const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const pascal = (value: string) => value.split(/[-_./]+/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');

export async function applyFrameworks(host: FrameworkHost): Promise<void> {
  for (const project of host.projects) {
    const files = host.files.filter(file => file.node.projectId === project.id);
    const tool = (name: string): { config: Record<string, any>; partial: boolean } => project.context.toolConfigs?.[name] ?? (project.context.toolConfigs ? { config: {}, partial: false } : project.context);
    const profile = (name: string, majors: number[], relevant: (file: FrameworkFile) => boolean) => {
      const value = frameworkProfile(project.manifest, name, majors);
      if (value.status === 'unknown' || value.status === 'unsupported') {
        for (const file of files) if (relevant(file)) host.diagnostic(file.node, `${name} framework profile is ${value.status}; convention analysis is partial`);
      } else if (value.status === 'supported' && tool(name === '@sveltejs/kit' ? 'svelte' : name).partial) {
        for (const file of files) if (relevant(file)) host.diagnostic(file.node, `${name} framework configuration is partial; convention coverage is incomplete`);
      }
      return value;
    };
    const exact = (file: string) => files.find(item => pathKey(item.path) === pathKey(file));
    const add = (source: FrameworkFile, target: FrameworkFile, rule: string, inferred = false, evidence?: Evidence) => {
      if (source.node.id !== target.node.id) host.add(source.node, target.node, { kind: 'framework', bindings: [], evidence: evidence ?? { rule } }, inferred ? 'inferred' : 'confirmed');
    };
    const next = profile('next', [12, 13, 14, 15, 16], file => /(?:^|\/)(?:pages|app)\//.test(slash(path.relative(project.directory, file.path))) && !!file.result);
    if (next.status === 'supported') {
      const { config, partial } = tool('next');
      const root = (name: string) => path.join(project.directory, files.some(file => inside(path.join(project.directory, name), file.path)) ? name : 'src/' + name);
      const pages = root('pages'), app = root('app');
      const pageFile = (name: string) => Array.isArray(config.pageExtensions) ? config.pageExtensions.some((extension: unknown) => typeof extension === 'string' && name.endsWith('.' + extension)) : /\.[jt]sx?$/.test(name);
      const wrapper = files.find(file => path.dirname(file.path) === pages && path.basename(file.path).startsWith('_app.') && pageFile(file.path));
      for (const file of files) {
        if (!pageFile(file.path)) continue;
        const relative = slash(path.relative(pages, file.path));
        if (inside(pages, file.path) && !relative.startsWith('api/') && !path.basename(file.path).startsWith('_') && wrapper) add(file, wrapper, 'Next.js Pages Router wraps pages in _app; not a source import', partial);
        if (!inside(app, file.path) || !/^(?:page|layout)\./.test(path.basename(file.path))) continue;
        if (next.major! < 13) { host.diagnostic(file.node, 'Next.js App Router is outside this version profile'); continue; }
        const parts = slash(path.relative(app, file.path)).split('/');
        if (parts.some(part => part.startsWith('_'))) continue;
        if (parts.some(part => part.startsWith('@') || /^\(\.{1,3}\)/.test(part))) { host.diagnostic(file.node, 'Next parallel/intercepting route has conditional layout scope'); continue; }
        for (const candidate of files) {
          if (!inside(app, candidate.path) || !inside(path.dirname(candidate.path), path.dirname(file.path)) || !pageFile(candidate.path)) continue;
          const basename = path.basename(candidate.path);
          if (basename.startsWith('layout.')) add(file, candidate, 'Next.js App Router ancestor layout convention; not a source import', partial);
          if (/^(?:loading|error|not-found|template)\./.test(basename) && (!path.basename(file.path).startsWith('layout.') || path.dirname(candidate.path) !== path.dirname(file.path))) add(file, candidate, 'Next.js segment boundary; conditional runtime activation', true);
        }
      }
    }
    const nuxt = profile('nuxt', [3, 4], file => !!file.result?.implicitNames?.length || !!file.result?.references.some(ref => ['#imports', '#components'].includes(ref.specifier ?? '')) || /(?:^|\/)pages\/.*\.vue$/.test(slash(file.path)));
    if (nuxt.status === 'supported') {
      const { config, partial } = tool('nuxt');
      const source = path.resolve(project.directory, typeof config.srcDir === 'string' ? config.srcDir : nuxt.major! >= 4 ? 'app' : '.');
      const valueExports = new Map<string, FrameworkFile[]>();
      const scanDirs = Array.isArray(config.imports?.dirs) ? config.imports.dirs.filter((value: unknown): value is string => typeof value === 'string' && !/[*!?{}]/.test(value)).map((directory: string) => path.resolve(source, directory)) : [path.join(source, 'composables'), path.join(source, 'utils')];
      if (config.imports?.scan !== false) for (const file of files) {
        if (!scanDirs.some((directory: string) => path.dirname(file.path) === directory)) continue;
        for (const exported of file.result?.exports ?? []) if (!['default', '*'].includes(exported.name) && exported.namespace !== 'type') valueExports.set(exported.name, [...(valueExports.get(exported.name) ?? []), file]);
      }
      const componentNames = new Map<string, FrameworkFile[]>();
      const componentEntries = config.components === false ? [] : Array.isArray(config.components) ? config.components : Array.isArray(config.components?.dirs) ? config.components.dirs : ['components'];
      for (const entry of componentEntries) {
        const directory = typeof entry === 'string' ? entry : entry?.path;
        if (typeof directory !== 'string' || /[*!?{}]/.test(directory)) continue;
        const root = path.resolve(source, directory);
        for (const file of files) if (inside(root, file.path) && file.node.format === '.vue') {
          const relative = slash(path.relative(root, file.path)).replace(/\.vue$/i, '');
          const name = pascal((typeof entry === 'object' && entry.pathPrefix === false ? path.basename(relative) : relative).replace(/\/index$/i, ''));
          const full = String(typeof entry === 'object' ? entry.prefix ?? '' : '') + name;
          for (const alias of [full, kebab(full), 'Lazy' + full, 'lazy-' + kebab(full)]) componentNames.set(alias, [...(componentNames.get(alias) ?? []), file]);
        }
      }
      for (const file of files) {
        for (const name of file.result?.implicitNames ?? []) {
          if (name.kind === 'value' && config.imports?.autoImport === false) continue;
          const candidates = [...new Map(((name.kind === 'component' ? componentNames : valueExports).get(name.name) ?? []).map(file => [file.node.id, file])).values()];
          if (candidates.length === 1) {
            const binding = { imported: name.kind === 'component' ? 'default' : name.name, local: name.name, typeOnly: false };
            host.add(file.node, candidates[0].node, { kind: 'framework', specifier: name.name, bindings: [binding], symbolDependency: true,
              occurrences: name.evidence.range ? [{ ...binding, range: name.evidence.range }] : undefined,
              evidence: { ...name.evidence, rule: `Nuxt local ${name.kind} auto-import; registration plugins are not executed` } }, partial || config.extends || config.modules ? 'inferred' : 'confirmed');
          }
          else if (candidates.length > 1) host.diagnostic(file.node, `Nuxt auto-import is ambiguous: ${name.name}`);
        }
        for (const reference of file.result?.references ?? []) if (reference.specifier === '#imports' || reference.specifier === '#components') {
          let allResolved = reference.bindings.length > 0;
          for (const binding of reference.bindings) {
            const candidates = [...new Map(((reference.specifier === '#components' ? componentNames : valueExports).get(binding.imported) ?? []).map(item => [item.node.id, item])).values()];
            if (candidates.length === 1) host.add(file.node, candidates[0].node, { ...reference, kind: reference.kind === 'reexport' ? 'reexport' : 'import', bindings: [{ ...binding, ...(reference.specifier === '#components' ? { resolvedImported: 'default' } : {}) }], evidence: { ...reference.evidence, rule: 'Nuxt explicit virtual import resolved to local declaration' } }, partial ? 'inferred' : 'confirmed');
            else allResolved = false;
          }
          if (!allResolved) host.diagnostic(file.node, 'Nuxt virtual import has missing, generated or ambiguous local exports');
        }
        if (file.node.format === '.vue' && inside(path.join(source, 'pages'), file.path) && config.pages !== false) {
          if (file.result?.layoutDynamic) host.diagnostic(file.node, 'Nuxt layout selection is computed and is not evaluated');
          const name = typeof file.result?.layout === 'string' ? file.result.layout : 'default';
          const layoutDirectory = path.join(source, 'layouts');
          const layout = exact(path.join(layoutDirectory, name + '.vue')) ?? files.find(candidate => inside(layoutDirectory, candidate.path) && candidate.node.format === '.vue' && kebab(pascal(slash(path.relative(layoutDirectory, candidate.path)).replace(/\.vue$/, ''))) === kebab(name));
          if (layout && file.result?.layout !== false && !file.result?.layoutDynamic) add(file, layout, 'Nuxt named/default layout candidate; NuxtLayout outlet and runtime selection are conditional', true);
        }
      }
      if (config.extends || config.modules) for (const file of files.filter(file => file.result?.implicitNames?.length)) host.diagnostic(file.node, 'Nuxt layers/modules may add or override registrations; static local auto-import coverage is partial');
    }
    const kit = profile('@sveltejs/kit', [1, 2], file => /(?:^|\/)\+(?:page|layout)/.test(slash(file.path)));
    if (kit.status === 'supported') {
      const { config, partial } = tool('svelte');
      const routes = path.resolve(project.directory, typeof config.kit?.files?.routes === 'string' ? config.kit.files.routes : 'src/routes');
      for (const file of files) if (inside(routes, file.path) && /^\+(?:page|layout)(?:@[^.]*)?\.svelte$/.test(path.basename(file.path))) {
        const directory = path.dirname(file.path);
        const stem = path.basename(file.path).startsWith('+page') ? '+page' : '+layout';
        for (const candidate of files) if (path.dirname(candidate.path) === directory && new RegExp('^\\' + stem + '(?:\\.server)?\\.[jt]s$').test(path.basename(candidate.path))) add(file, candidate, 'SvelteKit route load declaration; not a source import', partial);
        const reset = /@([^.]*)\.svelte$/.exec(path.basename(file.path));
        let targetDirectory: string | undefined = directory;
        if (reset) {
          targetDirectory = reset[1] ? undefined : routes;
          for (let current = directory; reset[1] && inside(routes, current); current = path.dirname(current)) {
            if (path.basename(current) === reset[1]) { targetDirectory = current; break; }
            if (current === routes) break;
          }
          if (!targetDirectory) host.diagnostic(file.node, 'SvelteKit layout reset target is unknown');
        }
        for (const candidate of files) if (targetDirectory && candidate.node.id !== file.node.id && inside(path.dirname(candidate.path), targetDirectory) && inside(routes, candidate.path)) {
          if (/^\+layout(?:\.server)?\.[jt]s$|^\+layout\.svelte$/.test(path.basename(candidate.path))) add(file, candidate, 'SvelteKit applicable layout/load declaration; route hierarchy convention', partial);
          if (path.basename(candidate.path) === '+error.svelte') add(file, candidate, 'SvelteKit conditional route error boundary', true);
        }
      }
    }
    const astro = profile('astro', [4, 5, 6], file => ['.astro', '.md', '.mdx'].includes(file.node.format));
    if (astro.status === 'supported') for (const file of files) {
      const { config, partial } = tool('astro');
      if (inside(path.resolve(project.directory, typeof config.srcDir === 'string' ? config.srcDir : 'src', 'pages'), file.path) && ['.astro', '.md', '.mdx', '.html'].includes(file.node.format)) { file.node.role = 'page'; file.node.roleReason = 'Astro configured pages directory; runtime routing is not executed'; }
      if (file.node.format === '.md' && typeof file.result?.layout === 'string') {
        const layout = exact(path.resolve(path.dirname(file.path), file.result.layout));
        if (layout) add(file, layout, 'Astro Markdown frontmatter layout declaration', partial);
        else host.diagnostic(file.node, 'Astro Markdown layout has no permitted local target');
      }
    }
    const angular = profile('@angular/core', [18, 19, 20, 21], file => !!file.result?.references.some(ref => ref.specifier === '@angular/core') || ['.html', '.htm'].includes(file.node.format));
    if (angular.status === 'supported') await angularRules(host, project, files, angular.major!);
    const { config, partial: graphqlPartial } = tool('graphql');
    if (graphqlPartial) for (const file of files) if (file.result?.graphql) host.diagnostic(file.node, 'GraphQL document collection configuration is partial');
    const documentPatterns = config.documents ?? project.manifest?.dependencyMap?.graphqlDocuments;
    if (documentPatterns) {
      const { minimatch } = await import('minimatch');
      const patterns: unknown[] = typeof documentPatterns === 'string' ? [documentPatterns] : Array.isArray(documentPatterns) ? documentPatterns : [];
      if (!patterns.length || patterns.length > 30 || !patterns.every((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500 && value !== '!')) {
        for (const file of files) if (file.result?.graphql) host.diagnostic(file.node, 'GraphQL document collection is invalid or exceeds the static collection limit');
        continue;
      }
      const positives = patterns.filter((pattern: string) => !pattern.startsWith('!') && pattern.length <= 500);
      const negatives = patterns.filter((pattern: string) => pattern.startsWith('!') && pattern.length <= 500).map((pattern: string) => pattern.slice(1));
      const collection = files.filter(file => file.result?.graphql && positives.some((pattern: string) => minimatch(slash(path.relative(project.directory, file.path)), pattern, { dot: true })) && !negatives.some((pattern: string) => minimatch(slash(path.relative(project.directory, file.path)), pattern, { dot: true })));
      for (const file of collection) for (const spread of file.result!.graphql!.spreads) {
        const targets = collection.flatMap(candidate => candidate.result!.graphql!.definitions.filter(definition => definition.kind === 'fragment' && definition.name === spread.name).map(() => candidate));
        if (targets.length === 1) host.add(file.node, targets[0].node, { kind: 'resource', specifier: spread.name, bindings: [], evidence: { rule: 'GraphQL fragment in explicit local document collection', range: spread.range } });
        else host.diagnostic(file.node, 'GraphQL fragment is missing or ambiguous in the explicit document collection');
      }
    } else for (const file of files) if (file.result?.graphql?.spreads.length) host.diagnostic(file.node, 'GraphQL fragment resolution requires an explicit document collection');
  }
}

async function angularRules(host: FrameworkHost, project: FrameworkProject, files: FrameworkFile[], major: number): Promise<void> {
  const compiler = await import('@angular/compiler');
  const declarations = new Map<string, { file: FrameworkFile; name: string; range: SourceRange; kind: string; selector?: string; standalone?: boolean; imports: string[]; exports: string[]; members: string[]; template?: { text: string; physical: string; file: FrameworkFile; offset?: number } }>();
  const imports = new Map<string, Map<string, { module: string; name: string }>>();
  for (const file of files.filter(file => /\.[jt]s$/.test(file.path))) {
    const text = host.read(file.path); if (text === undefined) continue;
    const source = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, true);
    const imported = new Map<string, { module: string; name: string }>(); imports.set(file.node.id, imported);
    for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) if (!binding.isTypeOnly) imported.set(binding.name.text, { module: statement.moduleSpecifier.text, name: binding.propertyName?.text ?? binding.name.text });
      } else if (bindings && ts.isNamespaceImport(bindings)) imported.set(bindings.name.text, { module: statement.moduleSpecifier.text, name: '*' });
      if (statement.importClause?.name) imported.set(statement.importClause.name.text, { module: statement.moduleSpecifier.text, name: 'default' });
    }
    for (const declaration of source.statements) if (ts.isClassDeclaration(declaration) && declaration.name) for (const decorator of ts.getDecorators(declaration) ?? []) {
      if (!ts.isCallExpression(decorator.expression)) continue;
      const expression = decorator.expression.expression;
      const namespace = ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) ? imported.get(expression.expression.text) : undefined;
      const api = ts.isIdentifier(expression) ? imported.get(expression.text) : namespace?.name === '*' && ts.isPropertyAccessExpression(expression) ? { module: namespace.module, name: expression.name.text } : undefined;
      if (api?.module !== '@angular/core' || !['Component', 'Directive', 'Pipe', 'NgModule'].includes(api.name)) continue;
      const options = decorator.expression.arguments[0]; if (!options || !ts.isObjectLiteralExpression(options)) { host.diagnostic(file.node, 'Angular decorator metadata is not a supported static object'); continue; }
      const property = (name: string) => options.properties.find(item => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)) && item.name.text === name) as ts.PropertyAssignment | undefined;
      const string = (name: string) => { const value = property(name)?.initializer; return value && ts.isStringLiteralLike(value) ? value.text : undefined; };
      const names = (name: string): string[] => {
        const value = property(name)?.initializer;
        if (!value) return [];
        if (!ts.isArrayLiteralExpression(value)) { host.diagnostic(file.node, 'Angular registration array is not statically supported'); return []; }
        const entries: string[] = [];
        for (const item of value.elements) {
          if (ts.isIdentifier(item)) entries.push(item.text);
          else if (ts.isPropertyAccessExpression(item) && ts.isIdentifier(item.expression)) entries.push(`${item.expression.text}.${item.name.text}`);
          else host.diagnostic(file.node, 'Angular registration contains an unsupported expression');
        }
        return [...new Set(entries)];
      };
      const standalone = property('standalone')?.initializer;
      const info = { file, name: declaration.name.text, range: sourceRange(text, declaration.name.getStart(source), declaration.name.end), kind: api.name, selector: string('selector'), standalone: standalone ? standalone.kind === ts.SyntaxKind.TrueKeyword ? true : standalone.kind === ts.SyntaxKind.FalseKeyword ? false : undefined : major >= 19, imports: names('imports'), exports: names('exports'), members: names('declarations'), template: undefined as { text: string; physical: string; file: FrameworkFile; offset?: number } | undefined };
      for (const name of ['templateUrl', 'styleUrl']) { const value = string(name); if (value) resource(name, value); }
      const styles = property('styleUrls')?.initializer;
      if (styles && ts.isArrayLiteralExpression(styles)) for (const item of styles.elements) if (ts.isStringLiteralLike(item)) resource('styleUrls', item.text, { rule: 'Angular styleUrls', range: sourceRange(text, item.getStart(source), item.end) });
      const inlineStyles = property('styles')?.initializer;
      const styleNodes = inlineStyles && ts.isArrayLiteralExpression(inlineStyles) ? inlineStyles.elements : inlineStyles ? [inlineStyles] : [];
      if (styleNodes.some(style => !ts.isStringLiteralLike(style))) host.diagnostic(file.node, 'Angular dynamic inline style is not evaluated');
      for (const style of styleNodes) if (ts.isStringLiteralLike(style)) {
        const raw = text.slice(style.getStart(source) + 1, style.end - 1);
        const parsed = extractResources(file.path + '.css', style.text);
        const mapped = emptySourceResult();
        if (raw === style.text) mergeSourceRegion(mapped, parsed, text, style.getStart(source) + 1);
        else { mapped.references.push(...parsed.references.map(reference => ({ ...reference, evidence: { rule: reference.evidence.rule + '; escaped inline string has file-only navigation' } }))); host.diagnostic(file.node, 'Angular escaped inline style has file-only navigation'); }
        for (const reference of mapped.references) if (reference.specifier?.startsWith('.')) resource('inline style resource', reference.specifier, { ...reference.evidence, rule: `Angular inline style resource; ${reference.evidence.rule}` });
      }
      function resource(kind: string, value: string, evidence?: Evidence) {
        const target = files.find(candidate => pathKey(candidate.path) === pathKey(path.resolve(path.dirname(file.path), value)));
        const origin = property(kind)?.initializer ?? options;
        if (target) host.add(file.node, target.node, { kind: 'resource', specifier: value, bindings: [], evidence: evidence ?? { rule: `Angular ${kind}`, range: sourceRange(text!, origin.getStart(source), origin.end) } });
        else host.diagnostic(file.node, 'Angular literal template/style target is unavailable');
      }
      const external = string('templateUrl');
      if (external) { const target = files.find(candidate => pathKey(candidate.path) === pathKey(path.resolve(path.dirname(file.path), external))); const content = target && host.read(target.path); if (target && content !== undefined) info.template = { text: content, physical: content, file: target, offset: 0 }; }
      const inline = property('template')?.initializer;
      if (inline && ts.isStringLiteralLike(inline)) { const raw = text.slice(inline.getStart(source) + 1, inline.end - 1); info.template = { text: inline.text, physical: text, file, offset: raw === inline.text ? inline.getStart(source) + 1 : undefined }; if (raw !== inline.text) host.diagnostic(file.node, 'Angular escaped inline template has file-only navigation'); }
      else if (inline) host.diagnostic(file.node, 'Angular dynamic inline template is not evaluated');
      declarations.set(JSON.stringify([file.node.id, info.name]), info);
    }
  }
  type Declaration = NonNullable<ReturnType<typeof declarations.get>>;
  const resolutions = new Map<string, Declaration | undefined>();
  const proofs = new Map<string, string[]>();
  const diagnostics = new Set<string>();
  const partialScopes = new Set<string>();
  const diagnose = (file: FrameworkFile, reason: string) => {
    partialScopes.add(file.node.id);
    const key = JSON.stringify([file.node.id, reason]);
    if (!diagnostics.has(key)) { diagnostics.add(key); host.diagnostic(file.node, reason); }
  };
  const resolutionKey = (file: FrameworkFile, name: string) => JSON.stringify([file.node.id, name]);
  const sameRange = (left: SourceRange, right: SourceRange) => left.start.line === right.start.line && left.start.character === right.start.character && left.end.line === right.end.line && left.end.character === right.end.character;
  const resolveName = (file: FrameworkFile, name: string): Declaration | undefined => {
    const key = resolutionKey(file, name);
    if (resolutions.has(key)) return resolutions.get(key);
    const local = declarations.get(key);
    if (local) { resolutions.set(key, local); proofs.set(key, [file.node.id]); return local; }
    const [base, member] = name.split('.');
    const imported = imports.get(file.node.id)?.get(base);
    const binding = member && imported?.name === '*' ? { module: imported.module, name: member } : !member ? imported : undefined;
    const resolved = binding && host.resolveDeclaration?.(file.path, binding.module, binding.name);
    const direct = resolved && declarations.get(JSON.stringify([resolved.fileId, resolved.name]));
    const candidates = direct ? [direct] : resolved?.range ? [...declarations.values()].filter(candidate => candidate.file.node.id === resolved.fileId && sameRange(candidate.range, resolved.range!)) : [];
    const target = candidates.length === 1 ? candidates[0] : undefined;
    resolutions.set(key, target);
    if (target && resolved) proofs.set(key, [...new Set([file.node.id, target.file.node.id, ...resolved.provenanceIds])]);
    else diagnose(file, 'Angular registration declaration is unresolved or ambiguous in the common symbol resolver');
    return target;
  };
  const proofFor = (file: FrameworkFile, name: string) => proofs.get(resolutionKey(file, name)) ?? [file.node.id];
  let expansionSteps = 0;
  let expansionLimited = false;
  const exportedScope = (item: Declaration, owner: FrameworkFile, seen = new Set<string>(), provenance: string[] = [], depth = 0): (Declaration & { provenanceIds: string[] })[] => {
    if (++expansionSteps > 10000 || depth > 100) { expansionLimited = true; diagnose(owner, 'Angular exported scope expansion limit reached; selector scope is partial'); return []; }
    const key = JSON.stringify([item.file.node.id, item.name]); if (seen.has(key)) return []; seen.add(key);
    const proof = [...new Set([...provenance, item.file.node.id])];
    if (item.kind !== 'NgModule') return [{ ...item, provenanceIds: proof }];
    const result: (Declaration & { provenanceIds: string[] })[] = [];
    for (const name of item.exports) {
      if (expansionSteps >= 10000) { expansionLimited = true; diagnose(owner, 'Angular exported scope expansion limit reached; selector scope is partial'); break; }
      const target = resolveName(item.file, name);
      if (target) result.push(...exportedScope(target, owner, new Set(seen), [...proof, ...proofFor(item.file, name)], depth + 1));
      else diagnose(owner, 'Angular exported selector scope contains an unresolved declaration');
    }
    return result;
  };
  for (const item of declarations.values()) {
    const refs = [...item.imports, ...item.members, ...item.exports];
    for (const name of refs) { const target = resolveName(item.file, name); if (target && item.file.node.id !== target.file.node.id) host.add(item.file.node, target.file.node, { kind: 'framework', specifier: name, bindings: [], provenanceIds: proofFor(item.file, name), evidence: { rule: 'Angular static registration; registration does not prove template use' } }); }
    if (!item.template) continue;
    const scope: (Declaration & { provenanceIds: string[] })[] = [];
    const addScope = (owner: Declaration, names: string[], provenance: string[]) => {
      for (const name of names) {
        const target = resolveName(owner.file, name);
        if (target) scope.push(...exportedScope(target, item.file, new Set(), [...provenance, ...proofFor(owner.file, name)]));
        else diagnose(item.file, 'Angular template scope contains an unresolved registration');
      }
    };
    if (item.standalone) addScope(item, item.imports, [item.file.node.id]);
    else for (const module of declarations.values()) if (module.kind === 'NgModule') {
      const membership = module.members.filter(name => resolveName(module.file, name) === item);
      if (membership.length) addScope(module, [...module.members, ...module.imports], [module.file.node.id, item.file.node.id, ...membership.flatMap(name => proofFor(module.file, name))]);
    }
    if (item.standalone === undefined) host.diagnostic(item.file.node, 'Angular standalone default is unknown for this version');
    const parsed = compiler.parseTemplate(item.template.text, item.template.file.path);
    if (parsed.errors?.length) host.diagnostic(item.file.node, 'Angular template grammar is partially unsupported');
    const matcher = new compiler.SelectorMatcher<(typeof scope)[number]>();
    for (const component of scope) if (component.selector) {
      try { matcher.addSelectables(compiler.CssSelector.parse(component.selector), component); }
      catch { diagnose(item.file, 'Angular selector grammar is unsupported'); }
    }
    const visit = (node: any) => {
      const selector = new compiler.CssSelector();
      if (node.name) selector.setElement(node.name);
      for (const attribute of node.attributes ?? []) {
        selector.addAttribute(attribute.name, attribute.value ?? '');
        if (attribute.name === 'class') for (const name of String(attribute.value).split(/\s+/).filter(Boolean)) selector.addClassName(name);
      }
      for (const attribute of node.inputs ?? []) selector.addAttribute(attribute.name, '');
      const matched = new Map<string, (typeof scope)[number]>();
      matcher.match(selector, (_selector, declaration) => {
        const key = JSON.stringify([declaration.file.node.id, declaration.name]);
        const previous = matched.get(key);
        matched.set(key, previous ? { ...declaration, provenanceIds: [...new Set([...previous.provenanceIds, ...declaration.provenanceIds])] } : declaration);
      });
      const matches = [...matched.values()];
      const components = matches.filter(match => match.kind === 'Component');
      if (components.length > 1) host.diagnostic(item.file.node, 'Angular selector has ambiguous declarations in template scope');
      for (const match of matches) if (match.kind === 'Directive' || components.length === 1 && match.kind === 'Component') {
        const range = item.template!.offset === undefined ? undefined : sourceRange(item.template!.physical, item.template!.offset + node.sourceSpan.start.offset, item.template!.offset + node.sourceSpan.end.offset);
        const binding = { imported: match.name, local: match.selector, typeOnly: false };
        host.add(item.template!.file.node, match.file.node, { kind: 'framework', specifier: match.selector, bindings: [binding], symbolDependency: true, occurrences: range ? [{ ...binding, range }] : undefined, provenanceIds: match.provenanceIds, evidence: { rule: 'Angular template selector in proven local scope', range } }, expansionLimited || partialScopes.has(item.file.node.id) || item.standalone === undefined ? 'inferred' : 'confirmed');
      }
      for (const key of ['children', 'branches']) for (const child of node[key] ?? []) visit(child);
    };
    for (const node of parsed.nodes) visit(node);
  }
}
