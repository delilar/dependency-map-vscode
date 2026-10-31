import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import { minimatch } from 'minimatch';
import { fileId, relationId, type AnalysisOptions, type DeclarationTarget, type Diagnostic, type EnvKey, type Evidence, type GraphNode, type GraphSnapshot, type Relation, type SourceOverlay, type WorkspaceRoot } from '../shared/model';
import { extractJavascript, type JsResult, type Reference, type TokenRef } from './javascript';
import { extractEnvKeys, extractResources } from './resources';
import { classifyFile, type RoleContext } from '../shared/roles';
export { formatCapabilities } from './formats';

const slash = (value: string) => value.replace(/\\/g, '/');
const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (parent: string, child: string) => { const relative = path.relative(canonical(parent), canonical(child)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const javascript = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const isEnv = (value: string) => /^\.env(?:\.|$)/i.test(path.basename(value));
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const maxTextBytes = 2 * 1024 * 1024;
type ParsedSource = ReturnType<typeof extractJavascript> | ReturnType<typeof extractResources>;
const parsedCache = new Map<string, { text: string; result: ParsedSource }>();
let parsedCacheBytes = 0;
let parsedCacheWorkspace = '';

function parseSource(file: string, text: string): { result: ParsedSource; reused: boolean } {
  const key = canonical(file);
  const previous = parsedCache.get(key);
  const reused = previous?.text === text;
  const original = reused ? previous.result : javascript.test(file) ? extractJavascript(file, text) : extractResources(file, text);
  if (!reused) {
    if (previous) { parsedCacheBytes -= previous.text.length * 2; parsedCache.delete(key); }
    parsedCache.set(key, { text, result: original }); parsedCacheBytes += text.length * 2;
    while (parsedCacheBytes > 32 * 1024 * 1024 || parsedCache.size > 2000) {
      const oldest = parsedCache.keys().next().value as string | undefined;
      if (!oldest) break;
      parsedCacheBytes -= parsedCache.get(oldest)!.text.length * 2; parsedCache.delete(oldest);
    }
  }
  const result = { ...original, references: [...original.references], diagnostics: [...original.diagnostics] };
  return { result, reused };
}

export class WorkspaceFiles {
  readonly files = new Map<string, { path: string; root: WorkspaceRoot }>();
  private readonly safeCache = new Map<string, boolean>();
  private readonly overlay: Map<string, SourceOverlay>;
  constructor(readonly roots: WorkspaceRoot[], readonly exclude: string[], overlays: SourceOverlay[]) {
    this.roots = [...roots].sort((a, b) => b.path.length - a.path.length);
    this.overlay = new Map(overlays.map(item => [canonical(item.path), item]));
  }
  updateOverlays(overlays: SourceOverlay[]): string[] {
    const next = new Map(overlays.map(item => [canonical(item.path), item]));
    const changed = [...new Set([...this.overlay.keys(), ...next.keys()])].filter(key => JSON.stringify(this.overlay.get(key)) !== JSON.stringify(next.get(key)));
    this.overlay.clear(); for (const [key, value] of next) this.overlay.set(key, value);
    return changed;
  }
  allowed(candidate: string): boolean {
    const key = canonical(candidate);
    if (this.safeCache.has(key)) return this.safeCache.get(key)!;
    if (slash(key).split('/').includes('node_modules')) return false;
    const root = this.roots.find(item => within(item.path, candidate));
    if (!root) return false;
    const relative = slash(path.relative(root.path, candidate));
    if (relative && relative.split('/').some(part => part === 'node_modules')) return false;
    if (this.exclude.some(pattern => relative.split('/').includes(pattern) || minimatch(relative, pattern, { dot: true }) || minimatch(relative, `${pattern}/**`, { dot: true }))) return false;
    let allowed = true;
    try {
      const physical = fs.realpathSync(candidate);
      allowed = !slash(canonical(physical)).split('/').includes('node_modules') && this.roots.some(item => within(item.path, physical));
    } catch { /* Missing candidates are safe to test but cannot resolve. */ }
    this.safeCache.set(key, allowed);
    return allowed;
  }
  scan(): void {
    this.files.clear(); this.safeCache.clear();
    this.scanTargets(this.roots.map(root => root.path));
  }
  update(changes: string[]): void {
    this.safeCache.clear();
    for (const [key, entry] of this.files) if (changes.some(changed => within(changed, entry.path))) this.files.delete(key);
    this.scanTargets(changes);
  }
  private scanTargets(targets: string[]): void {
    const seen = new Set<string>();
    const walk = (directory: string) => {
      if (!this.allowed(directory) || seen.has(canonical(directory))) return;
      seen.add(canonical(directory));
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(directory, entry.name);
        if (!this.allowed(full) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const root = this.roots.find(item => within(item.path, full));
          if (root) this.files.set(canonical(full), { path: full, root });
        }
      }
    };
    for (const candidate of targets) {
      if (!this.allowed(candidate)) continue;
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink()) continue;
        const actual = fs.realpathSync.native(candidate);
        if (stat.isDirectory()) walk(actual);
        else if (stat.isFile()) {
          const root = this.roots.find(item => within(item.path, actual));
          if (root) this.files.set(canonical(actual), { path: actual, root });
        }
      } catch { /* A deleted file is removed from the inventory, not an analysis failure. */ }
    }
    for (const overlay of this.overlay.values()) {
      const root = this.roots.find(item => within(item.path, overlay.path));
      if (root && this.allowed(overlay.path)) {
        const key = canonical(overlay.path);
        let physical = this.files.get(key)?.path;
        if (!physical) {
          try { physical = fs.realpathSync.native(overlay.path); } catch { /* Unsaved new files have no physical path yet. */ }
        }
        this.files.set(key, { path: physical ?? path.resolve(overlay.path), root });
      }
    }
  }
  exists(candidate: string): boolean {
    return this.allowed(candidate) && (this.files.has(canonical(candidate)) || this.overlay.has(canonical(candidate)));
  }
  directory(candidate: string): boolean {
    if (!this.allowed(candidate)) return false;
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  }
  read(candidate: string): string | undefined {
    if (!this.allowed(candidate)) return undefined;
    const overlay = this.overlay.get(canonical(candidate));
    if (overlay?.text !== undefined) return overlay.text.length * 2 <= maxTextBytes ? overlay.text : undefined;
    try {
      if (fs.statSync(candidate).size > maxTextBytes) return undefined;
      return fs.readFileSync(candidate, 'utf8');
    } catch { return undefined; }
  }
  env(candidate: string): EnvKey[] {
    const overlay = this.overlay.get(canonical(candidate));
    if (overlay?.envKeys) return overlay.envKeys;
    return extractEnvKeys(this.read(candidate) ?? '');
  }
  node(candidate: string, projectId: string, roleContext: RoleContext = {}): GraphNode | undefined {
    const entry = this.files.get(canonical(candidate));
    if (!entry) return undefined;
    const relative = slash(path.relative(entry.root.path, entry.path));
    const file = { rootId: entry.root.id, path: relative };
    const basename = path.basename(entry.path);
    const role = classifyFile(relative, roleContext);
    return { id: fileId(file), file, projectId, kind: 'file', label: basename, format: isEnv(entry.path) ? '.env' : path.extname(entry.path).toLowerCase() || '(none)', ...role };
  }
}

interface Project { id: string; directory: string; manifest?: Record<string, any>; manifestPath?: string }
interface Config { path: string; directory: string; options: ts.CompilerOptions; members: Set<string>; raw: any }
interface Contribution {
  result: ParsedSource; relations: Relation[]; unresolved: GraphSnapshot['unresolved']; diagnostics: Diagnostic[];
  externals: GraphNode[];
}
interface Resolution { node?: GraphNode; reason?: string }
type ResolutionMode = 'module' | 'style' | 'asset' | 'config';
interface SessionState {
  key: string; files: WorkspaceFiles; projects: Project[]; configs: Config[];
  configDiagnostics: Diagnostic[]; configInputs: Set<string>; configTexts: Map<string, string>; contributions: Map<string, Contribution>;
  resolutionCache: Map<string, { source: string; value: Resolution }>; lookups: Map<string, Set<string>>;
  envKeys: Map<string, EnvKey[]>; graph: GraphSnapshot;
}
const changesProjectContext = (file: string) => /^(?:package\.json|(?:ts|js)config(?:\.[^.]+)*\.json|pnpm-workspace\.yaml|lerna\.json)$/.test(path.basename(file));

async function analyzeWorkspaceInternal(roots: WorkspaceRoot[], options: AnalysisOptions, overlays: SourceOverlay[], onProgress: (message: string) => void, previous?: SessionState, changedPaths?: string[]): Promise<{ graph: GraphSnapshot; state: SessionState }> {
  const started = performance.now();
  const contextKey = JSON.stringify([roots.map(root => [root.id, root.name, canonical(root.path)]).sort(), options.exclude]);
  let incremental = !!previous && previous.key === contextKey && changedPaths !== undefined;
  let inventoryChanged = false;
  const changed = new Set((changedPaths ?? []).map(canonical));
  let files: WorkspaceFiles;
  if (incremental && previous) {
    files = previous.files;
    for (const overlayPath of files.updateOverlays(overlays)) changed.add(canonical(overlayPath));
    const before = new Set(files.files.keys());
    files.update([...changed]);
    const membershipChanges = [...new Set([...before, ...files.files.keys()])].filter(key => before.has(key) !== files.files.has(key));
    inventoryChanged = membershipChanges.length > 0;
    for (const membershipChange of membershipChanges) changed.add(membershipChange);
    if ([...changed].some(key => changesProjectContext(key) || [...previous.configInputs].some(input => within(key, input)))) incremental = false;
  }
  if (!incremental) { files = new WorkspaceFiles(roots, options.exclude, overlays); files.scan(); }
  files = files!;
  const affected = new Set(changed);
  if (incremental && previous) {
    for (const key of previous.contributions.keys()) if ([...changed].some(candidate => within(candidate, key))) affected.add(key);
    for (const [source, lookups] of previous.lookups) if ([...lookups].some(lookup => [...changed].some(candidate => within(candidate, lookup)))) affected.add(source);
    const pathsById = new Map(previous.graph.nodes.filter(node => node.file).map(node => {
      const root = roots.find(item => item.id === node.file!.rootId)!;
      return [node.id, canonical(path.resolve(root.path, node.file!.path))];
    }));
    const reverse = reverseIndex(previous.graph);
    const queue = [...pathsById].filter(([, file]) => affected.has(file)).map(([id]) => id);
    const visited = new Set(queue);
    for (let index = 0; index < queue.length; index++) for (const relation of reverse.get(queue[index]) ?? []) {
      const sourcePath = pathsById.get(relation.sourceId);
      if (sourcePath) affected.add(sourcePath);
      if (!visited.has(relation.sourceId)) { visited.add(relation.sourceId); queue.push(relation.sourceId); }
    }
    if ([...changed].some(isEnv)) {
      for (const [source, contribution] of previous.contributions) if (contribution.result.references.some(reference => reference.kind === 'environment')) affected.add(source);
    }
  }
  const workspaceKey = roots.map(root => canonical(root.path)).sort().join('\0');
  if (workspaceKey !== parsedCacheWorkspace) { parsedCache.clear(); parsedCacheBytes = 0; parsedCacheWorkspace = workspaceKey; }
  for (const [key, cached] of parsedCache) if (!files.files.has(key)) { parsedCache.delete(key); parsedCacheBytes -= cached.text.length * 2; }
  onProgress(`Found ${files.files.size} workspace files`);
  const nodes = new Map<string, GraphNode>();
  const byPath = new Map<string, GraphNode>();
  const relations = new Map<string, Relation>();
  const unresolved: GraphSnapshot['unresolved'] = [];
  const diagnostics: Diagnostic[] = [];
  const projects: Project[] = incremental ? previous!.projects : roots.map(root => ({ id: `project:${root.id}`, directory: root.path }));
  const configs: Config[] = incremental ? previous!.configs : [];
  const configInputs = incremental ? previous!.configInputs : new Set<string>();
  const configTexts = incremental ? previous!.configTexts : new Map<string, string>();
  const contributions = incremental ? new Map(previous!.contributions) : new Map<string, Contribution>();
  const resolvedReferences = incremental ? new Map(previous!.resolutionCache) : new Map<string, { source: string; value: Resolution }>();
  const lookups = incremental ? new Map(previous!.lookups) : new Map<string, Set<string>>();
  const envKeys = incremental ? new Map(previous!.envKeys) : new Map<string, EnvKey[]>();
  for (const key of contributions.keys()) if (!files.files.has(key)) contributions.delete(key);
  for (const key of envKeys.keys()) if (!files.files.has(key) || affected.has(key)) envKeys.delete(key);
  for (const [key, cached] of resolvedReferences) if (affected.has(cached.source) || !files.files.has(cached.source)) resolvedReferences.delete(key);
  for (const source of lookups.keys()) if (affected.has(source) || !files.files.has(source)) lookups.delete(source);
  const json = (file: string): any => {
    const text = files.read(file); if (text === undefined) return undefined;
    configTexts.set(canonical(file), text);
    const parsed = ts.parseConfigFileTextToJson(file, text);
    if (parsed.error) { diagnostics.push({ message: `Invalid JSON configuration: ${path.basename(file)}` }); return undefined; }
    return parsed.config;
  };
  if (!incremental) for (const entry of files.files.values()) {
    if (path.basename(entry.path) !== 'package.json') continue;
    configInputs.add(canonical(entry.path));
    const manifest = json(entry.path);
    if (manifest && typeof manifest === 'object') projects.push({ id: `project:${entry.root.id}:${slash(path.relative(entry.root.path, path.dirname(entry.path)))}`, directory: path.dirname(entry.path), manifest, manifestPath: entry.path });
  }
  projects.sort((a, b) => b.directory.length - a.directory.length || Number(!!b.manifest) - Number(!!a.manifest));
  const projectFor = (file: string) => projects.find(project => within(project.directory, file))!;
  const configHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: process.platform !== 'win32',
    fileExists: file => files.exists(file), readFile: file => {
      const key = canonical(file); configInputs.add(key);
      if (incremental) return configTexts.get(key);
      const text = files.read(file); if (text !== undefined) configTexts.set(key, text); return text;
    },
    readDirectory: (directory, extensions, excludes, includes, depth) => [...files.files.values()].filter(entry => {
      if (!within(directory, entry.path)) return false;
      const relative = slash(path.relative(directory, entry.path));
      if (depth !== undefined && relative.split('/').length > depth + 1) return false;
      const match = (pattern: string) => minimatch(relative, pattern, { dot: true }) || minimatch(relative, `${pattern}/**`, { dot: true });
      return (!extensions || extensions.some(ext => entry.path.endsWith(ext))) && !(excludes ?? []).some(match) && (!includes?.length || includes.some(match));
    }).map(entry => entry.path)
  };
  if (!incremental) for (const entry of files.files.values()) {
    if (!/^(?:ts|js)config(?:\.[^.]+)*\.json$/.test(path.basename(entry.path))) continue;
    configInputs.add(canonical(entry.path));
    const raw = json(entry.path); if (!raw) continue;
    const parsed = ts.parseJsonConfigFileContent(raw, configHost, path.dirname(entry.path), undefined, entry.path);
    configs.push({ path: entry.path, directory: path.dirname(entry.path), options: parsed.options, members: new Set(parsed.fileNames.map(canonical)), raw });
    for (const error of parsed.errors) diagnostics.push({ message: `${path.basename(entry.path)}: configuration issue TS${error.code}; resolution may be incomplete` });
  }
  configs.sort((a, b) => b.directory.length - a.directory.length);
  const configDiagnostics = incremental ? previous!.configDiagnostics.filter(item => !inventoryChanged || !item.message.includes(': configuration issue TS')) : [...diagnostics];
  if (incremental && inventoryChanged) for (const config of configs) {
    const parsed = ts.parseJsonConfigFileContent(config.raw, configHost, config.directory, undefined, config.path);
    config.members = new Set(parsed.fileNames.map(canonical));
    for (const error of parsed.errors) configDiagnostics.push({ message: `${path.basename(config.path)}: configuration issue TS${error.code}; resolution may be incomplete` });
  }
  if (incremental) diagnostics.push(...configDiagnostics);
  const configFor = (file: string): Config | undefined => configs.find(config => config.members.has(canonical(file))) ?? configs.find(config => within(config.directory, file));
  for (const entry of files.files.values()) {
    const project = projectFor(entry.path);
    const node = files.node(entry.path, project.id, { projectRelativePath: slash(path.relative(project.directory, entry.path)), next: !!(project.manifest?.dependencies?.next || project.manifest?.devDependencies?.next) })!;
    node.projectName = project.manifest?.name ?? roots.find(root => root.id === entry.root.id)?.name ?? path.basename(project.directory);
    nodes.set(node.id, node); byPath.set(canonical(entry.path), node);
  }
  let resolvingSource: string | undefined;
  const lookup = (candidate: string) => {
    if (!resolvingSource) return;
    const paths = lookups.get(resolvingSource) ?? new Set<string>(); paths.add(canonical(candidate)); lookups.set(resolvingSource, paths);
  };
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: file => { lookup(file); return files.exists(file); }, readFile: file => { lookup(file); return files.read(file); },
    directoryExists: directory => { lookup(directory); return files.directory(directory); },
    realpath: candidate => files.allowed(candidate) ? candidate : '',
    getCurrentDirectory: () => roots[0]?.path ?? process.cwd(),
    getDirectories: directory => files.allowed(directory) ? [...new Set([...files.files.values()].filter(entry => within(directory, entry.path)).map(entry => path.dirname(entry.path)))] : []
  };
  let contributionRelations: Set<string> | undefined;
  const addRelation = (source: GraphNode, target: GraphNode, reference: Reference, certainty: Relation['certainty'] = 'confirmed') => {
    if (target.kind === 'external') nodes.set(target.id, target);
    const id = relationId(source.id, target.id, reference.kind, reference.specifier ?? reference.envName ?? '');
    contributionRelations?.add(id);
    const existing = relations.get(id);
    if (existing) {
      existing.evidence.push(reference.evidence);
      for (const binding of reference.bindings) if (!existing.bindings.some(item => item.imported === binding.imported && item.local === binding.local && item.typeOnly === binding.typeOnly)) existing.bindings.push(binding);
    } else relations.set(id, { id, sourceId: source.id, targetId: target.id, kind: reference.kind, certainty, specifier: reference.specifier ?? reference.envName, bindings: [...reference.bindings], evidence: [reference.evidence] });
  };
  const external = (project: Project, name: string): GraphNode => {
    const id = `external:${encodeURIComponent(project.id)}:${name}`;
    let node = nodes.get(id);
    if (!node) { node = { id, kind: 'external', projectId: project.id, projectName: project.manifest?.name ?? roots.find(root => within(root.path, project.directory))?.name ?? path.basename(project.directory), label: name, packageName: name, format: 'package' }; nodes.set(id, node); }
    return node;
  };
  const exactNode = (candidate: string) => { lookup(candidate); return byPath.get(canonical(candidate)); };
  const candidates = (base: string, mode: ResolutionMode, sourceExtension: string): string[] => {
    if (mode === 'asset') return [base];
    const extension = path.extname(base);
    const list = [base];
    if (mode === 'config') return extension ? list : [base, `${base}.json`, path.join(base, 'tsconfig.json')];
    const styleExtensions = ['.sass', '.scss'].includes(sourceExtension) ? ['.sass', '.scss', '.css'] : sourceExtension === '.less' ? ['.less'] : sourceExtension === '.styl' ? ['.styl'] : ['.css'];
    const extensions = mode === 'style' ? styleExtensions : ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
    if (!extension) list.push(...extensions.map(ext => `${base}${ext}`));
    if (mode === 'style' && ['.sass', '.scss'].includes(sourceExtension)) {
      const partial = path.join(path.dirname(base), `_${path.basename(base)}`);
      list.push(partial, ...(!extension ? styleExtensions.map(ext => `${partial}${ext}`) : []));
    }
    if (!extension) list.push(...(mode === 'style' ? styleExtensions.flatMap(ext => [`index${ext}`, ...(['.sass', '.scss'].includes(sourceExtension) ? [`_index${ext}`] : [])]) : ['index.ts', 'index.tsx', 'index.js', 'index.json']).map(name => path.join(base, name)));
    return list;
  };
  const findCandidate = (base: string, mode: ResolutionMode, sourceExtension: string): GraphNode | undefined => {
    const found = candidates(base, mode, sourceExtension).map(exactNode).filter((node): node is GraphNode => !!node);
    const unique = [...new Map(found.map(node => [node.id, node])).values()];
    return unique.length === 1 ? unique[0] : undefined;
  };
  const entryValue = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      for (const key of ['source', 'types', 'import', 'default', 'require']) {
        const target = entryValue((value as Record<string, unknown>)[key]); if (target) return target;
      }
    }
    return undefined;
  };
  const uncachedResolve = (sourcePath: string, specifier: string, kind: Reference['kind'], requestedMode: ResolutionMode): { node?: GraphNode; reason?: string } => {
    const project = projectFor(sourcePath); const config = configFor(sourcePath);
    const clean = specifier.replace(/[?#].*$/, '');
    const mode = requestedMode === 'module' && !!path.extname(clean) && !javascript.test(clean) ? 'asset' : requestedMode;
    const find = (base: string) => findCandidate(base, mode, path.extname(sourcePath).toLowerCase());
    if (builtins.has(clean.replace(/^node:/, ''))) return { node: external(project, `node:${clean.replace(/^node:/, '')}`) };
    if (clean.startsWith('node:')) return { reason: 'Unknown Node built-in module name' };
    if (/^(?:https?:|data:|blob:|\/\/)/i.test(clean)) return { reason: 'Remote or embedded resource is not a local file' };
    if (clean.startsWith('/') && kind === 'resource') {
      return { node: findCandidate(path.join(project.directory, 'public', clean.slice(1)), 'asset', ''), reason: 'Public URL has no unique local file; runtime routing may supply it' };
    }
    if (kind === 'resource' && !clean.startsWith('.') && !path.isAbsolute(clean)) {
      const node = find(path.resolve(path.dirname(sourcePath), clean));
      if (node) return { node };
    }
    if (clean.startsWith('.') || path.isAbsolute(clean)) {
      const base = path.resolve(path.dirname(sourcePath), clean);
      if (mode === 'module') {
        const resolved = ts.resolveModuleName(clean, sourcePath, config?.options ?? { moduleResolution: ts.ModuleResolutionKind.Node10, allowJs: true, resolveJsonModule: true }, resolutionHost).resolvedModule;
        if (resolved) { const node = exactNode(resolved.resolvedFileName); if (node) return { node }; }
      }
      return { node: find(base), reason: 'Relative target is missing, excluded, ambiguous or outside the workspace' };
    }
    const paths = config?.options.paths ?? {};
    const matching = Object.entries(paths).filter(([pattern]) => {
      const star = pattern.indexOf('*'); return star < 0 ? pattern === clean : clean.startsWith(pattern.slice(0, star)) && clean.endsWith(pattern.slice(star + 1));
    }).sort(([a], [b]) => b.replace('*', '').length - a.replace('*', '').length);
    for (const [pattern, replacements] of matching) {
      const star = pattern.indexOf('*'); const wildcard = star < 0 ? '' : clean.slice(star, clean.length - (pattern.length - star - 1));
      const baseDirectory = config?.options.baseUrl ?? (config?.options as ts.CompilerOptions & { pathsBasePath?: string })?.pathsBasePath ?? config?.directory ?? project.directory;
      for (const replacement of replacements) {
        const base = path.resolve(baseDirectory, replacement.replace('*', wildcard));
        if (mode === 'module') {
          const resolved = ts.resolveModuleName(clean, sourcePath, config!.options, resolutionHost).resolvedModule;
          if (resolved) { const node = exactNode(resolved.resolvedFileName); if (node) return { node }; }
        }
        const node = find(base); if (node) return { node };
      }
    }
    if (matching.length) return { reason: 'Configured alias has no unique local target' };
    if (config?.options.baseUrl) {
      const node = find(path.resolve(config.options.baseUrl, clean)); if (node) return { node };
    }
    const packageName = clean.startsWith('@') ? clean.split('/').slice(0, 2).join('/') : clean.split('/')[0];
    const local = projects.filter(item => item.manifest?.name === packageName);
    if (local.length > 1) return { reason: 'Multiple local packages share this name' };
    if (local.length === 1) {
      const target = local[0]; const subpath = clean.slice(packageName.length).replace(/^\//, '');
      const exported = target.manifest?.exports;
      const declared = subpath ? entryValue(exported?.[`./${subpath}`]) : entryValue(exported?.['.'] ?? exported) ?? target.manifest?.source ?? target.manifest?.types ?? target.manifest?.module ?? target.manifest?.main;
      const node = find(path.resolve(target.directory, declared ?? (subpath || 'index')));
      return { node, reason: 'Local package entry is missing, unsupported or ambiguous' };
    }
    if (clean.startsWith('#') || clean.startsWith('~') || (clean.startsWith('@') && clean.split('/').length < 2)) return { reason: 'Unconfigured alias or package-import mapping' };
    const dependencies = { ...project.manifest?.dependencies, ...project.manifest?.devDependencies, ...project.manifest?.peerDependencies, ...project.manifest?.optionalDependencies };
    if (Object.hasOwn(dependencies, packageName)) return { node: external(project, packageName) };
    return { reason: 'Bare import is neither a configured alias, local package nor declared dependency' };
  };
  const resolve = (sourcePath: string, specifier: string, kind: Reference['kind'], mode: ResolutionMode = kind === 'resource' ? 'asset' : 'module') => {
    const key = JSON.stringify([canonical(sourcePath), specifier, kind, mode]);
    if (!resolvedReferences.has(key)) {
      resolvingSource = canonical(sourcePath);
      try { resolvedReferences.set(key, { source: resolvingSource, value: uncachedResolve(sourcePath, specifier, kind, mode) }); }
      finally { resolvingSource = undefined; }
    }
    const result = resolvedReferences.get(key)!.value;
    if (result.node?.kind === 'external') nodes.set(result.node.id, result.node);
    return result;
  };

  const env = new Map<string, { node: GraphNode; keys: EnvKey[] }[]>();
  for (const entry of files.files.values()) if (isEnv(entry.path)) {
    const node = byPath.get(canonical(entry.path))!; const list = env.get(node.projectId) ?? [];
    const key = canonical(entry.path);
    if (!envKeys.has(key)) envKeys.set(key, files.env(entry.path));
    list.push({ node, keys: envKeys.get(key)! }); env.set(node.projectId, list);
  }
  const childApps: { name: string; node: GraphNode }[] = [];
  const javascriptResults = new Map<string, { path: string; result: JsResult }>();
  const childRefs: { source: GraphNode; name: string; evidence: Evidence }[] = [];
  const providers: { source: GraphNode; tokenId: string; evidence: Evidence }[] = [];
  const consumers: { source: GraphNode; tokenId: string; evidence: Evidence }[] = [];
  const tokenId = (sourcePath: string, token: TokenRef): string | undefined => {
    const target = token.module ? resolve(sourcePath, token.module, 'import').node : byPath.get(canonical(sourcePath));
    return target ? JSON.stringify([target.id, token.name]) : undefined;
  };
  let processed = 0;
  let reusedSources = 0;
  let reusedContributions = 0;
  const registerJavascript = (source: GraphNode, sourcePath: string, result: ParsedSource) => {
    if (!javascript.test(sourcePath)) return;
    const jsResult = result as JsResult;
    javascriptResults.set(source.id, { path: sourcePath, result: jsResult });
    if (jsResult.childName) childApps.push({ name: jsResult.childName, node: source });
    for (const ref of jsResult.childReferences) childRefs.push({ source, ...ref });
    for (const provider of jsResult.providers) { const id = tokenId(sourcePath, provider.token); if (id) providers.push({ source, tokenId: id, evidence: provider.evidence }); }
    for (const consumer of jsResult.consumers) { const id = tokenId(sourcePath, consumer.token); if (id) consumers.push({ source, tokenId: id, evidence: consumer.evidence }); }
  };
  for (const entry of files.files.values()) {
    const source = byPath.get(canonical(entry.path))!;
    if (isEnv(entry.path)) continue;
    const extension = path.extname(entry.path).toLowerCase();
    const configFile = /^(?:package|(?:ts|js)config(?:\.[^.]+)*)\.json$/.test(path.basename(entry.path));
    if (!javascript.test(entry.path) && !['.css', '.scss', '.html', '.htm', '.sass', '.less', '.styl', '.vue', '.svelte', '.astro', '.mdx', '.graphql', '.gql'].includes(extension) && !configFile) continue;
    const key = canonical(entry.path);
    const cached = incremental && !affected.has(key) ? contributions.get(key) : undefined;
    if (cached) {
      for (const relation of cached.relations) relations.set(relation.id, { ...relation, bindings: [...relation.bindings], evidence: [...relation.evidence] });
      for (const externalNode of cached.externals) nodes.set(externalNode.id, externalNode);
      unresolved.push(...cached.unresolved); diagnostics.push(...cached.diagnostics);
      registerJavascript(source, entry.path, cached.result);
      reusedContributions++;
      continue;
    }
    const unresolvedStart = unresolved.length;
    const diagnosticsStart = diagnostics.length;
    contributionRelations = new Set<string>();
    const text = files.read(entry.path);
    if (text === undefined) { contributions.delete(key); diagnostics.push({ fileId: source.id, message: 'File unavailable or above the 2 MiB text-analysis limit' }); contributionRelations = undefined; continue; }
    const parsed = parseSource(entry.path, text);
    if (parsed.reused) reusedSources++;
    const result = parsed.result;
    for (const message of result.diagnostics) diagnostics.push({ fileId: source.id, message });
    registerJavascript(source, entry.path, result);
    if (configFile) {
      const config = json(entry.path);
      const addConfig = (target: unknown, rule: string) => { if (typeof target === 'string' && (target.startsWith('.') || !target.includes(':'))) result.references.push({ specifier: target.startsWith('.') ? target : `./${target}`, kind: 'config', bindings: [], evidence: { rule } }); };
      if (path.basename(entry.path) === 'package.json') {
        for (const key of ['main', 'module', 'types', 'source', 'browser']) addConfig(config?.[key], `package.json ${key}`);
      } else {
        if (typeof config?.extends === 'string') addConfig(config.extends, 'TypeScript local extends');
        for (const ref of config?.references ?? []) if (ref && typeof ref.path === 'string') addConfig(ref.path.endsWith('.json') ? ref.path : `${ref.path}/tsconfig.json`, 'TypeScript project reference');
      }
    }
    for (const reference of result.references) {
      if (reference.reason) { unresolved.push({ sourceId: source.id, reason: reference.reason, evidence: reference.evidence }); continue; }
      if (reference.kind === 'environment') {
        const targets = (env.get(source.projectId) ?? []).filter(item => item.keys.some(key => key.name === reference.envName));
        if (!targets.length) unresolved.push({ sourceId: source.id, expression: reference.envName, reason: 'No local declaration; variable may be supplied at runtime', evidence: reference.evidence });
        for (const target of targets) addRelation(source, target.node, reference, 'inferred');
      } else if (reference.specifier) {
        const styleImport = /^(?:Stylesheet|Less|Stylus|Indented Sass) @(?:import|use|forward|require)/.test(reference.evidence.rule) && !reference.evidence.rule.includes('url()');
        const mode: ResolutionMode = styleImport ? 'style' : reference.kind === 'resource' ? 'asset' : reference.kind === 'config' && reference.evidence.rule.startsWith('TypeScript') ? 'config' : 'module';
        const resolution = resolve(entry.path, reference.specifier, reference.kind, mode);
        if (resolution.node) addRelation(source, resolution.node, reference, reference.certainty ?? (reference.evidence.rule.startsWith('Static fetch') ? 'inferred' : 'confirmed'));
        else unresolved.push({ sourceId: source.id, expression: reference.specifier, reason: resolution.reason ?? 'Cannot resolve target', evidence: reference.evidence });
      }
    }
    const outgoing = [...contributionRelations].map(id => relations.get(id)!).map(relation => ({ ...relation, bindings: [...relation.bindings], evidence: [...relation.evidence] }));
    contributions.set(key, {
      result, relations: outgoing, unresolved: unresolved.slice(unresolvedStart), diagnostics: diagnostics.slice(diagnosticsStart),
      externals: [...new Set(outgoing.map(relation => relation.targetId))].map(id => nodes.get(id)!).filter(node => node.kind === 'external')
    });
    contributionRelations = undefined;
    if (++processed % 40 === 0) { onProgress(`Analyzed ${processed} source files`); await new Promise<void>(resolve => setImmediate(resolve)); }
  }
  for (const ref of childRefs) {
    const matches = childApps.filter(item => item.name === ref.name);
    const target = matches.length === 1 ? matches[0].node : external(projects.find(item => item.id === ref.source.projectId)!, `child-app:${ref.name}`);
    addRelation(ref.source, target, { specifier: ref.name, kind: 'framework', bindings: [], evidence: ref.evidence }, 'inferred');
  }
  for (const consumer of consumers) {
    const matches = providers.filter(provider => provider.tokenId === consumer.tokenId && provider.source.projectId === consumer.source.projectId);
    for (const provider of matches) if (provider.source.id !== consumer.source.id) addRelation(consumer.source, provider.source, {
      kind: 'framework', specifier: `DI:${consumer.tokenId}`, bindings: [],
      evidence: { ...consumer.evidence, rule: 'Tramvai declared provider candidate; registration, overrides and runtime scope are not proven' }
    }, 'inferred');
    if (!matches.length) unresolved.push({ sourceId: consumer.source.id, reason: 'Tramvai token has no statically declared provider in this project; it may be supplied by a runtime scope', evidence: consumer.evidence });
  }
  for (const project of projects.filter(item => item.manifest?.dependencies?.next || item.manifest?.devDependencies?.next)) {
    const projectFiles = [...files.files.values()].filter(entry => byPath.get(canonical(entry.path))?.projectId === project.id);
    for (const entry of projectFiles) {
      const relative = slash(path.relative(project.directory, entry.path));
      const source = byPath.get(canonical(entry.path))!;
      if (/^(?:src\/)?pages\/(?!api\/).*\.[jt]sx?$/.test(relative) && !/^_/.test(path.basename(entry.path))) {
        const app = projectFiles.find(item => /^(?:src\/)?pages\/_app\.[jt]sx?$/.test(slash(path.relative(project.directory, item.path))));
        if (app) addRelation(source, byPath.get(canonical(app.path))!, { kind: 'framework', bindings: [], evidence: { rule: 'Next.js Pages Router wraps pages in _app; not a source import' } });
      }
      if (/^(?:src\/)?app\/.*\/(?:page|layout|loading|error|not-found|template)\.[jt]sx?$/.test(relative) || /^(?:src\/)?app\/(?:page|layout|loading|error|not-found|template)\.[jt]sx?$/.test(relative)) {
        if (!/^page\./.test(path.basename(entry.path))) continue;
        const directory = path.dirname(entry.path);
        const layouts = projectFiles.filter(item => /^layout\.[jt]sx?$/.test(path.basename(item.path)) && within(path.dirname(item.path), directory) && /^(?:src\/)?app\//.test(slash(path.relative(project.directory, item.path))));
        for (const layout of layouts) addRelation(source, byPath.get(canonical(layout.path))!, { kind: 'framework', bindings: [], evidence: { rule: 'Next.js App Router ancestor layout convention; not a source import' } });
        for (const sibling of projectFiles.filter(item => path.dirname(item.path) === directory && /^(?:loading|error|not-found|template)\.[jt]sx?$/.test(path.basename(item.path)))) addRelation(source, byPath.get(canonical(sibling.path))!, { kind: 'framework', bindings: [], evidence: { rule: 'Next.js App Router segment boundary convention; conditional runtime activation' } }, 'inferred');
      }
    }
  }
  const declarations: DeclarationTarget[] = [];
  const declarationCache = new Map<string, Omit<DeclarationTarget, 'relationId' | 'imported'>>();
  const declaration = (targetId: string, importedName: string, visited: Set<string>): Omit<DeclarationTarget, 'relationId' | 'imported'> | undefined => {
    const key = JSON.stringify([targetId, importedName]);
    if (visited.has(key) || importedName === '*') return undefined;
    if (declarationCache.has(key)) return declarationCache.get(key);
    const target = nodes.get(targetId); const entry = javascriptResults.get(targetId);
    if (!target?.file || !entry) return undefined;
    const nextVisited = new Set(visited).add(key);
    const explicit = entry.result.exports.filter(item => item.name === importedName);
    const exports = explicit.length ? explicit : importedName === 'default' ? [] : entry.result.exports.filter(item => item.name === '*');
    const matches: Omit<DeclarationTarget, 'relationId' | 'imported'>[] = [];
    for (const exported of exports) {
      if (!exported.forwarded) { matches.push({ file: target.file, range: exported.range }); continue; }
      const resolved = resolve(entry.path, exported.forwarded.module, 'reexport').node;
      if (!resolved) continue;
      const found = declaration(resolved.id, exported.forwarded.imported === '*' ? importedName : exported.forwarded.imported, nextVisited);
      if (found) matches.push(found);
    }
    const unique = [...new Map(matches.map(item => [JSON.stringify(item), item])).values()];
    if (unique.length === 1) {
      if (!exports.some(item => item.forwarded)) declarationCache.set(key, unique[0]);
      return unique[0];
    }
    return undefined;
  };
  for (const relation of relations.values()) {
    if (!['import', 'reexport'].includes(relation.kind)) continue;
    for (const importedName of new Set(relation.bindings.map(binding => binding.imported))) {
      const found = declaration(relation.targetId, importedName, new Set());
      if (found) declarations.push({ relationId: relation.id, imported: importedName, ...found });
    }
  }
  onProgress(`${incremental ? 'Incremental' : 'Full'} analysis: ${processed} affected source files; reused ${reusedContributions} contributions; parsed ${processed - reusedSources}, parsing-cache hits ${reusedSources}`);
  const graph: GraphSnapshot = { revision: (previous?.graph.revision ?? 0) + 1, nodes: [...nodes.values()], relations: [...relations.values()], unresolved, diagnostics, declarations, stats: { files: files.files.size, relations: relations.size, elapsedMs: Math.round(performance.now() - started) } };
  return { graph, state: { key: contextKey, files, projects, configs, configDiagnostics, configInputs, configTexts, contributions, resolutionCache: resolvedReferences, lookups, envKeys, graph } };
}

export class AnalyzerSession {
  private state?: SessionState;
  async analyze(roots: WorkspaceRoot[], options: AnalysisOptions, overlays: SourceOverlay[], onProgress: (message: string) => void = () => {}, changedPaths?: string[]): Promise<GraphSnapshot> {
    try {
      const result = await analyzeWorkspaceInternal(roots, options, overlays, onProgress, this.state, changedPaths);
      this.state = result.state;
      return result.graph;
    } catch (error) { this.state = undefined; throw error; }
  }
}

export async function analyzeWorkspace(roots: WorkspaceRoot[], options: AnalysisOptions, overlays: SourceOverlay[], onProgress: (message: string) => void = () => {}): Promise<GraphSnapshot> {
  return new AnalyzerSession().analyze(roots, options, overlays, onProgress);
}

export function reverseIndex(graph: GraphSnapshot): Map<string, Relation[]> {
  const reverse = new Map<string, Relation[]>();
  for (const relation of graph.relations) { const list = reverse.get(relation.targetId) ?? []; list.push(relation); reverse.set(relation.targetId, list); }
  return reverse;
}
