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
import { formatCapabilities } from './formats';
import type { BindingOccurrence, FileCoverage } from '../shared/query-model';
import { exportTables, resolveExport } from './export-resolution';
import { extractComponent } from './components';
import { extractDocument, extractEmbeddedGraphQL } from './documents';
import { emptySourceResult, mergeSourceRegion } from './result-utils';
import { readStaticConfig, splitSpecifier, webConfigPattern } from './web-context';
import { fileMetadata } from '../shared/file-metadata';
import { applyFrameworks } from './frameworks';
import { frameworkProfile } from './framework-profile';
import { symbolContributions } from './symbol-contributions';
export { formatCapabilities } from './formats';

const slash = (value: string) => value.replace(/\\/g, '/');
const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (parent: string, child: string) => { const relative = path.relative(canonical(parent), canonical(child)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const javascript = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const isEnv = (value: string) => /^\.env(?:\.|$)/i.test(path.basename(value));
const forbiddenPath = (value: string) => slash(value).split('/').some(part => ['.git', 'node_modules'].includes(part.toLowerCase()));
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const maxTextBytes = 2 * 1024 * 1024;
type ParsedSource = JsResult;
const parsedCache = new Map<string, { text: string; result: ParsedSource }>();
let parsedCacheBytes = 0;
let parsedCacheWorkspace = '';

async function parseSource(file: string, text: string): Promise<{ result: ParsedSource; reused: boolean }> {
  const key = canonical(file);
  const previous = parsedCache.get(key);
  const reused = previous?.text === text;
  let original = previous?.result;
  if (!reused) {
    try {
      original = javascript.test(file) ? extractJavascript(file, text) : await extractComponent(file, text) ?? await extractDocument(file, text) ?? { ...emptySourceResult(), ...extractResources(file, text) };
      if (javascript.test(file) && /(?:graphql-tag|@apollo\/client|@urql\/core|['"]urql['"])/.test(text)) mergeSourceRegion(original, await extractEmbeddedGraphQL(file, text), text, 0);
    } catch {
      original = { ...emptySourceResult(), diagnostics: ['Parser unavailable or failed; file analysis is incomplete'], capabilityReasons: ['parserFailed'] };
    }
  }
  if (!reused) {
    if (previous) { parsedCacheBytes -= previous.text.length * 2; parsedCache.delete(key); }
    parsedCache.set(key, { text, result: original! }); parsedCacheBytes += text.length * 2;
    while (parsedCacheBytes > 32 * 1024 * 1024 || parsedCache.size > 2000) {
      const oldest = parsedCache.keys().next().value as string | undefined;
      if (!oldest) break;
      parsedCacheBytes -= parsedCache.get(oldest)!.text.length * 2; parsedCache.delete(oldest);
    }
  }
  const result = { ...original!, references: original!.references.map(reference => ({ ...reference })), diagnostics: [...original!.diagnostics] };
  return { result, reused };
}

export class WorkspaceFiles {
  readonly files = new Map<string, { path: string; root: WorkspaceRoot; physical: boolean }>();
  readonly readReasons = new Map<string, 'textLimit' | 'readFailed'>();
  readonly inventoryFailures = new Set<string>();
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
    if (forbiddenPath(key)) return false;
    const root = this.roots.find(item => within(item.path, candidate));
    if (!root) return false;
    const relative = slash(path.relative(root.path, candidate));
    if (forbiddenPath(relative)) return false;
    if (this.exclude.some(pattern => relative.split('/').includes(pattern) || minimatch(relative, pattern, { dot: true }) || minimatch(relative, `${pattern}/**`, { dot: true }))) return false;
    let allowed = true;
    try {
      const physical = fs.realpathSync(candidate);
      allowed = !forbiddenPath(physical) && this.roots.some(item => within(item.path, physical));
    } catch { /* Missing candidates are safe to test but cannot resolve. */ }
    this.safeCache.set(key, allowed);
    return allowed;
  }
  scan(): void {
    this.files.clear(); this.safeCache.clear(); this.readReasons.clear(); this.inventoryFailures.clear();
    this.scanTargets(this.roots.map(root => root.path));
  }
  update(changes: string[]): void {
    this.safeCache.clear();
    for (const [key, entry] of this.files) if (changes.some(changed => within(changed, entry.path))) this.files.delete(key);
    for (const key of this.readReasons.keys()) if (changes.some(changed => within(changed, key))) this.readReasons.delete(key);
    for (const key of this.inventoryFailures) if (changes.some(changed => within(changed, key))) this.inventoryFailures.delete(key);
    this.scanTargets(changes);
  }
  private scanTargets(targets: string[]): void {
    const seen = new Set<string>();
    const walk = (directory: string) => {
      if (!this.allowed(directory) || seen.has(canonical(directory))) return;
      seen.add(canonical(directory));
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); this.inventoryFailures.delete(canonical(directory)); }
      catch { this.inventoryFailures.add(canonical(directory)); return; }
      for (const entry of entries) {
        if (forbiddenPath(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (!this.allowed(full) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const root = this.roots.find(item => within(item.path, full));
          if (root) this.files.set(canonical(full), { path: full, root, physical: true });
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
          if (root) this.files.set(canonical(actual), { path: actual, root, physical: true });
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.inventoryFailures.add(canonical(candidate)); }
    }
    for (const overlay of this.overlay.values()) {
      const root = this.roots.find(item => within(item.path, overlay.path));
      if (root && this.allowed(overlay.path)) {
        const key = canonical(overlay.path);
        let physical = this.files.get(key)?.path;
        let exists = this.files.get(key)?.physical ?? false;
        if (!physical) {
          try { physical = fs.realpathSync.native(overlay.path); exists = fs.lstatSync(physical).isFile(); } catch { /* Unsaved new files have no physical path yet. */ }
        }
        this.files.set(key, { path: physical ?? path.resolve(overlay.path), root, physical: exists });
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
    const key = canonical(candidate);
    this.readReasons.delete(key);
    const overlay = this.overlay.get(canonical(candidate));
    if (overlay?.text !== undefined) {
      if (overlay.text.length * 2 > maxTextBytes) { this.readReasons.set(key, 'textLimit'); return undefined; }
      return overlay.text;
    }
    try {
      if (fs.statSync(candidate).size > maxTextBytes) { this.readReasons.set(key, 'textLimit'); return undefined; }
      return fs.readFileSync(candidate, 'utf8');
    } catch { this.readReasons.set(key, 'readFailed'); return undefined; }
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
    const format = isEnv(entry.path) ? '.env' : path.extname(entry.path).toLowerCase() || '(none)';
    return { id: fileId(file), file, projectId, kind: 'file', label: basename, format, ...role, ...fileMetadata(format, role?.role) };
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
const changesProjectContext = (file: string) => /^(?:package\.json|(?:ts|js)config(?:\.[^.]+)*\.json|pnpm-workspace\.yaml|lerna\.json|angular\.json|\.graphqlrc(?:\..*)?)$/.test(path.basename(file)) || webConfigPattern.test(path.basename(file));

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
  if (inventoryChanged && previous) for (const [key, contribution] of previous.contributions) if (contribution.result.globs?.length) affected.add(key);
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
  const semanticOccurrences: BindingOccurrence[] = [];
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
  const staticConfigs = new Map<string, ReturnType<typeof readStaticConfig>>();
  type ToolConfig = { config: Record<string, any>; partial: boolean; directory: string; ambiguous?: boolean };
  type WebContext = ToolConfig & { aliases: { find: string; replacement?: string }[]; extensions?: string[]; publicDirectory: string; sourceRoot: string; vite: boolean; associationUnknown: boolean; nuxt?: number; sourceDirectory: string; toolConfigs: Record<string, ToolConfig> };
  const configRecords = new Map<string, { file: string; tool: string; parsed: ReturnType<typeof readStaticConfig> }[]>();
  for (const project of projects) {
    const records: { file: string; tool: string; parsed: ReturnType<typeof readStaticConfig> }[] = [];
    for (const entry of files.files.values()) {
      if (projectFor(entry.path).id !== project.id || !webConfigPattern.test(path.basename(entry.path))) continue;
      configInputs.add(canonical(entry.path));
      const text = files.read(entry.path);
      const parsed = text === undefined ? { partial: true } : readStaticConfig(entry.path, text);
      staticConfigs.set(canonical(entry.path), parsed);
      records.push({ file: entry.path, tool: path.basename(entry.path).split('.config')[0].toLowerCase(), parsed });
    }
    configRecords.set(project.id, records);
  }
  const createWebContext = (project: Project, sourcePath: string): WebContext => {
    const toolConfigs: Record<string, ToolConfig> = Object.create(null);
    const records = (configRecords.get(project.id) ?? []).filter(record => within(path.dirname(record.file), sourcePath));
    for (const tool of new Set(records.map(record => record.tool))) {
      const matching = records.filter(record => record.tool === tool).sort((a, b) => path.dirname(b.file).length - path.dirname(a.file).length);
      const directory = path.dirname(matching[0].file);
      const nearest = matching.filter(record => canonical(path.dirname(record.file)) === canonical(directory));
      const ambiguous = nearest.length !== 1 || !nearest[0].parsed.value;
      toolConfigs[tool] = { config: ambiguous ? {} : nearest[0].parsed.value!, partial: ambiguous || nearest[0].parsed.partial, directory, ambiguous };
    }
    const dependencies = { ...project.manifest?.peerDependencies, ...project.manifest?.optionalDependencies, ...project.manifest?.dependencies, ...project.manifest?.devDependencies };
    const frameworkTools = [['nuxt', 'nuxt'], ['next', 'next'], ['@sveltejs/kit', 'svelte'], ['astro', 'astro']].filter(([dependency]) => Object.hasOwn(dependencies, dependency)).map(([, tool]) => tool);
    const applications = ['nuxt', 'next', 'svelte', 'astro', 'vite', 'webpack'].filter(tool => toolConfigs[tool]);
    const nearestDirectory = applications.map(tool => toolConfigs[tool].directory).sort((a, b) => b.length - a.length)[0];
    const nearestApplications = applications.filter(tool => canonical(toolConfigs[tool].directory) === canonical(nearestDirectory ?? project.directory));
    const ownConfig = records.find(record => canonical(record.file) === canonical(sourcePath));
    // shortcut: explicit test files use test context; shared source keeps its application profile until entry contexts are modeled.
    const testTool = classifyFile(sourcePath)?.role === 'test' ? ['vitest', 'jest', 'playwright', 'cypress'].filter(tool => toolConfigs[tool]) : [];
    let tool = ownConfig?.tool;
    let ambiguous = false;
    if (!tool && testTool.length) { tool = testTool.length === 1 ? testTool[0] : undefined; ambiguous = testTool.length > 1; }
    if (!tool && !ambiguous) {
      const preferred = frameworkTools.length === 1 ? frameworkTools[0] : undefined;
      if (preferred && (!nearestDirectory || canonical(nearestDirectory) === canonical(project.directory) || nearestApplications.includes(preferred))) tool = preferred;
      else if (nearestApplications.length === 1) tool = nearestApplications[0];
      else if (nearestApplications.length > 1 || frameworkTools.length > 1) ambiguous = true;
      else if (dependencies.vite && !dependencies.webpack) tool = 'vite';
      else if (dependencies.webpack && !dependencies.vite) tool = 'webpack';
    }
    const selected = tool ? toolConfigs[tool] : undefined;
    ambiguous ||= selected?.ambiguous ?? false;
    const config = selected?.config ?? {};
    const directory = selected?.directory ?? project.directory;
    const associationUnknown = !!selected && canonical(directory) !== canonical(project.directory);
    const nuxtProfile = frameworkProfile(project.manifest, 'nuxt', [3, 4]);
    const nuxt = tool === 'nuxt' && nuxtProfile.status === 'supported' ? nuxtProfile.major : undefined;
    const nuxtConfig = toolConfigs.nuxt?.config ?? {};
    const sourceDirectory = path.resolve(toolConfigs.nuxt?.directory ?? project.directory, typeof nuxtConfig.srcDir === 'string' ? nuxtConfig.srcDir : nuxt && nuxt >= 4 ? 'app' : '.');
    const aliases: { find: string; replacement?: string }[] = [];
    const addAlias = (find: unknown, replacement: unknown, relative = false) => {
      if (typeof find !== 'string' || !find) { aliases.push({ find: '' }); return; }
      aliases.push({ find, replacement: typeof replacement === 'string' && (path.isAbsolute(replacement) || relative) ? path.resolve(directory, replacement) : undefined });
    };
    for (const [value, relative] of [[config.alias, !!nuxt], [config.resolve?.alias, false], [config.kit?.alias, true]] as const) {
      if (Array.isArray(value)) for (const item of value) addAlias(item?.find, item?.replacement, relative);
      else if (value && typeof value === 'object') for (const [find, replacement] of Object.entries(value)) addAlias(find, replacement, relative);
    }
    if (nuxt) for (const find of ['~', '@', '~~', '@@']) addAlias(find, find.length === 2 ? project.directory : sourceDirectory);
    if (tool === 'svelte' && frameworkProfile(project.manifest, '@sveltejs/kit', [1, 2]).status === 'supported') addAlias('$lib', typeof config.kit?.files?.lib === 'string' ? config.kit.files.lib : 'src/lib', true);
    const extensions = Array.isArray(config.resolve?.extensions) && config.resolve.extensions.every((value: unknown) => typeof value === 'string' && /^\.[a-z]+$/i.test(value)) ? config.resolve.extensions as string[] : undefined;
    const sourceRoot = path.resolve(directory, typeof config.root === 'string' ? config.root : '.');
    const publicDirectory = path.resolve(sourceRoot, typeof config.publicDir === 'string' ? config.publicDir : tool === 'svelte' ? 'static' : 'public');
    return { aliases, extensions, publicDirectory, sourceRoot, config, partial: ambiguous || associationUnknown || selected?.partial === true, ambiguous, associationUnknown, directory, vite: tool === 'vite', nuxt, sourceDirectory, toolConfigs };
  };
  const webContexts = new Map(projects.map(project => [project.id, createWebContext(project, project.directory)]));
  const sourceWebContexts = new Map<string, WebContext>();
  const webContextFor = (file: string) => {
    const key = canonical(file);
    if (!sourceWebContexts.has(key)) sourceWebContexts.set(key, createWebContext(projectFor(file), file));
    return sourceWebContexts.get(key)!;
  };
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
    if (reference.symbolDependency && reference.occurrences) for (const occurrence of reference.occurrences) semanticOccurrences.push({ relationId: id, ...occurrence });
    contributionRelations?.add(id);
    const existing = relations.get(id);
    if (existing) {
      existing.evidence.push(reference.evidence);
      for (const binding of reference.bindings) if (!existing.bindings.some(item => item.imported === binding.imported && item.local === binding.local && item.typeOnly === binding.typeOnly)) existing.bindings.push(binding);
    } else relations.set(id, { id, sourceId: source.id, targetId: target.id, kind: reference.kind, certainty, specifier: reference.specifier ?? reference.envName, bindings: [...reference.bindings], evidence: [reference.evidence], ...(reference.provenanceIds?.length ? { provenanceIds: reference.provenanceIds } : {}), ...(reference.symbolDependency ? { symbolDependency: true } : {}) });
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
    const extensions = mode === 'style' ? styleExtensions : ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte', '.astro', '.mdx'];
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
  const entryValue = (value: unknown, depth = 0): string | undefined => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 30) {
      const entries = Object.entries(value);
      if (!Object.hasOwn(value, 'default') || entries.some(([key]) => key.startsWith('.'))) return undefined;
      // shortcut: accept identical condition targets; add condition profiles when a runtime target is configured.
      const targets = entries.map(([, branch]) => entryValue(branch, depth + 1));
      if (targets[0] && targets.every(target => target === targets[0])) return targets[0];
    }
    return undefined;
  };
  const uncachedResolve = (sourcePath: string, specifier: string, kind: Reference['kind'], requestedMode: ResolutionMode, sourceExtension?: string): { node?: GraphNode; reason?: string } => {
    const project = projectFor(sourcePath); const config = configFor(sourcePath);
    const clean = splitSpecifier(specifier).path;
    const web = webContextFor(sourcePath);
    if (web.associationUnknown) {
      const source = exactNode(sourcePath), message = 'Nearest nested configuration does not establish the runtime entry or working directory; configuration-dependent analysis is partial';
      if (source && !diagnostics.some(item => item.fileId === source.id && item.message === message)) diagnostics.push({ fileId: source.id, message });
    }
    const mode = requestedMode === 'module' && !!path.extname(clean) && !javascript.test(clean) ? 'asset' : requestedMode;
    const find = (base: string) => {
      if (mode === 'module' && web.extensions && !path.extname(base)) {
        for (const extension of web.extensions) { const node = exactNode(`${base}${extension}`); if (node) return node; }
      }
      return findCandidate(base, mode, sourceExtension ?? path.extname(sourcePath).toLowerCase());
    };
    if (builtins.has(clean.replace(/^node:/, ''))) return { node: external(project, `node:${clean.replace(/^node:/, '')}`) };
    if (clean.startsWith('node:')) return { reason: 'Unknown Node built-in module name' };
    if (/^(?:https?:|data:|blob:|\/\/)/i.test(clean)) return { reason: 'Remote or embedded resource is not a local file' };
    if (clean.startsWith('/') && (kind === 'resource' || /\.html?$/i.test(sourcePath) || web.vite && ['import', 'reexport'].includes(kind))) {
      if (web.associationUnknown && !path.isAbsolute(typeof web.config.root === 'string' ? web.config.root : '')) return { reason: 'Nested configuration location does not establish the runtime source/public root' };
      const urlNode = (directory: string, targetMode: ResolutionMode = 'asset') => {
        const target = path.join(directory, clean.slice(1));
        return within(directory, target) ? findCandidate(target, targetMode, sourceExtension ?? '') : undefined;
      };
      const publicNode = web.config.publicDir === false ? undefined : urlNode(web.publicDirectory);
      const sourceNode = web.vite ? urlNode(web.sourceRoot, mode) : undefined;
      const targets = [...new Map([publicNode, sourceNode].filter((node): node is GraphNode => !!node).map(node => [node.id, node])).values()];
      return { node: !web.ambiguous && targets.length === 1 ? targets[0] : undefined, reason: 'Root URL has no unique permitted source/public file; runtime routing may supply it' };
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
    if (web.ambiguous) {
      const source = exactNode(sourcePath);
      if (source && !diagnostics.some(item => item.fileId === source.id && item.message === 'Application configuration is ambiguous or unavailable')) diagnostics.push({ fileId: source.id, message: 'Application configuration is ambiguous or unavailable' });
      return { reason: 'Application configuration is ambiguous or unavailable; no tool context was guessed' };
    }
    const alias = web.aliases.find(alias => !alias.find || clean === alias.find || clean.startsWith(alias.find + '/'));
    if (alias) {
      if (alias.replacement && classifyFile(sourcePath)?.role !== 'test' && !webConfigPattern.test(path.basename(sourcePath))) {
        const applicationTarget = canonical(path.join(alias.replacement, clean.slice(alias.find.length)));
        const testConflict = ['vitest', 'jest', 'playwright', 'cypress'].some(tool => {
          const config = web.toolConfigs[tool]?.config;
          const value = config?.resolve?.alias ?? config?.alias;
          const entries = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value).map(([find, replacement]) => ({ find, replacement })) : [];
          const other = entries.find(item => typeof item?.find === 'string' && (clean === item.find || clean.startsWith(item.find + '/')));
          return !!other && (typeof other.replacement !== 'string' || !path.isAbsolute(other.replacement) || canonical(path.join(other.replacement, clean.slice(other.find.length))) !== applicationTarget);
        });
        const source = exactNode(sourcePath);
        const message = 'Alias target depends on application/test entry context; this graph uses the application profile and is partial for shared entry analysis';
        if (testConflict && source && !diagnostics.some(item => item.fileId === source.id && item.message === message)) diagnostics.push({ fileId: source.id, message });
      }
      return { node: alias.replacement ? find(path.join(alias.replacement, clean.slice(alias.find.length))) : undefined, reason: alias.replacement ? 'Static web alias has no unique permitted target' : 'Relative alias replacement is tool-specific and is not converted to an absolute path' };
    }
    if (clean.startsWith('#') && project.manifest?.imports) {
      const mappings = Object.entries(project.manifest.imports as Record<string, unknown>).filter(([key]) => key === clean || key.includes('*') && clean.startsWith(key.split('*')[0]) && clean.endsWith(key.split('*')[1]));
      if (mappings.length === 1) {
        const [key, value] = mappings[0];
        const target = typeof value === 'string' ? value : entryValue(value);
        if (target?.startsWith('./')) {
          const wildcard = key.includes('*') ? clean.slice(key.indexOf('*'), clean.length - key.split('*')[1].length) : '';
          const destination = path.resolve(project.directory, target.replace('*', wildcard));
          return { node: within(project.directory, destination) ? find(destination) : undefined, reason: 'Package imports mapping has no unique permitted local target' };
        }
      }
      return { reason: 'Package imports mapping is missing, conditional or ambiguous' };
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
      const hasExports = Object.hasOwn(target.manifest ?? {}, 'exports');
      const declared = hasExports ? entryValue(subpath ? exported?.[`./${subpath}`] : exported?.['.'] ?? exported)
        : subpath || (target.manifest?.source ?? target.manifest?.types ?? target.manifest?.module ?? target.manifest?.main);
      if (hasExports && !declared?.startsWith('./')) return { reason: 'Local package exports entry is blocked, conditional or unsupported' };
      const destination = path.resolve(target.directory, declared ?? (subpath || 'index'));
      const node = within(target.directory, destination) ? find(destination) : undefined;
      return { node, reason: 'Local package entry is missing, unsupported or ambiguous' };
    }
    if (clean.startsWith('#') || clean.startsWith('~') || (clean.startsWith('@') && clean.split('/').length < 2)) return { reason: 'Unconfigured alias or package-import mapping' };
    const dependencies = { ...project.manifest?.dependencies, ...project.manifest?.devDependencies, ...project.manifest?.peerDependencies, ...project.manifest?.optionalDependencies };
    if (Object.hasOwn(dependencies, packageName)) return { node: external(project, packageName) };
    return { reason: 'Bare import is neither a configured alias, local package nor declared dependency' };
  };
  const resolve = (sourcePath: string, specifier: string, kind: Reference['kind'], mode: ResolutionMode = kind === 'resource' ? 'asset' : 'module', sourceExtension?: string) => {
    const key = JSON.stringify([canonical(sourcePath), specifier, kind, mode, sourceExtension]);
    if (!resolvedReferences.has(key)) {
      resolvingSource = canonical(sourcePath);
      try { resolvedReferences.set(key, { source: resolvingSource, value: uncachedResolve(sourcePath, specifier, kind, mode, sourceExtension) }); }
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
    if (!javascript.test(entry.path) && formatCapabilities[extension]?.mode !== 'references' && !configFile) continue;
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
    const parsed = await parseSource(entry.path, text);
    if (parsed.reused) reusedSources++;
    const result = parsed.result;
    for (const glob of result.globs ?? []) {
      const manifest = projectFor(entry.path).manifest;
      const viteProfile = ([['vite', [4, 5, 6, 7]], ['nuxt', [3, 4]], ['astro', [4, 5, 6]], ['@sveltejs/kit', [1, 2]]] as const).some(([name, majors]) => frameworkProfile(manifest, name, majors).status === 'supported');
      if (glob.kind === 'vite' && !viteProfile || glob.kind === 'webpack' && frameworkProfile(manifest, 'webpack', [4, 5]).status !== 'supported') { result.diagnostics.push('Module collection requires a known compatible Vite/Webpack project profile'); continue; }
      if (glob.patterns.some(pattern => !pattern.startsWith('!') && forbiddenPath(pattern))) { result.diagnostics.push('Module collection includes a forbidden dependency tree; no files are read'); continue; }
      let matches = 0;
      for (const candidate of files.files.values()) {
        const relative = './' + slash(path.relative(path.dirname(entry.path), candidate.path));
        let matched = false;
        if (glob.kind === 'vite') {
          const positive = glob.patterns.filter(pattern => !pattern.startsWith('!')), negative = glob.patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));
          const sourceRoot = webContextFor(entry.path).sourceRoot;
          const match = (pattern: string) => (!pattern.startsWith('/') || within(sourceRoot, candidate.path)) && minimatch(pattern.startsWith('/') ? '/' + slash(path.relative(sourceRoot, candidate.path)) : relative, pattern, { dot: true });
          matched = positive.some(match) && !negative.some(match);
        } else {
          const directory = path.resolve(path.dirname(entry.path), glob.patterns[0]);
          const local = './' + slash(path.relative(directory, candidate.path));
          matched = within(directory, candidate.path) && (glob.recursive || !local.slice(2).includes('/'));
          if (matched && glob.regexp) { try { matched = new RegExp(glob.regexp.source, glob.regexp.flags).test(local); } catch { matched = false; } }
        }
        if (matched && candidate.path !== entry.path) {
          if (++matches > 10000) { result.diagnostics.push('Module collection target limit reached; analysis is partial'); break; }
          result.references.push({ kind: 'import', specifier: relative + (glob.query ? glob.query.startsWith('?') ? glob.query : '?' + glob.query : ''), bindings: [], evidence: glob.evidence });
        }
      }
    }
    for (const message of result.diagnostics) diagnostics.push({ fileId: source.id, message });
    registerJavascript(source, entry.path, result);
    const staticConfig = staticConfigs.get(canonical(entry.path))?.value;
    if (staticConfig) {
      const basename = path.basename(entry.path);
      const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      const localConfig = (value: unknown, rule: string, baseDirectory = path.dirname(entry.path)) => {
        for (let target of strings(value).slice(0, 1000)) {
          if (/[*!?{}]/.test(target) || !target) continue;
          if (target.startsWith('<rootDir>/')) target = target.slice(10);
          if (!path.isAbsolute(target) && !target.startsWith('@') && !target.startsWith('#') && !/^[a-z]+:/i.test(target)) target = './' + slash(path.relative(path.dirname(entry.path), path.resolve(baseDirectory, target)));
          result.references.push({ kind: 'config', specifier: target, bindings: [], resolutionMode: 'module', evidence: { rule } });
        }
      };
      const projectDirectory = projectFor(entry.path).directory;
      if (/^(?:vite|vitest)\.config\./.test(basename)) for (const field of ['setupFiles', 'globalSetup']) localConfig(staticConfig.test?.[field], `Vitest literal test.${field}`, path.resolve(projectDirectory, typeof staticConfig.root === 'string' ? staticConfig.root : '.'));
      if (/^(?:jest|playwright)\.config\./.test(basename)) for (const field of ['setupFiles', 'setupFilesAfterEnv', 'globalSetup', 'globalTeardown']) localConfig(staticConfig[field], `Test configuration literal ${field}`, path.resolve(path.dirname(entry.path), typeof staticConfig.rootDir === 'string' ? staticConfig.rootDir : '.'));
      if (/^cypress\.config\./.test(basename)) for (const profile of ['e2e', 'component']) localConfig(staticConfig[profile]?.supportFile, `Cypress literal ${profile}.supportFile`, projectDirectory);
      if (/^(?:vite|webpack)\.config\./.test(basename)) {
        const value = staticConfig.entry ?? staticConfig.build?.lib?.entry;
        const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value).flatMap(item => strings(item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>).import : item)) : strings(value);
        localConfig(entries, 'Build configuration literal entry', path.resolve(projectDirectory, typeof staticConfig.context === 'string' ? staticConfig.context : typeof staticConfig.root === 'string' ? staticConfig.root : '.'));
      }
    }
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
        const mode: ResolutionMode = reference.resolutionMode ?? (styleImport ? 'style' : reference.kind === 'resource' ? 'asset' : reference.kind === 'config' && reference.evidence.rule.startsWith('TypeScript') ? 'config' : 'module');
        const qualifier = splitSpecifier(reference.specifier).qualifier;
        const keys = qualifier.startsWith('?') ? [...new URLSearchParams(qualifier.slice(1)).keys()] : [];
        const loaderValue = keys.some(key => ['raw', 'url', 'worker', 'sharedworker', 'init', 'inline', 'no-inline'].includes(key));
        const unknownLoader = keys.some(key => !['raw', 'url', 'worker', 'sharedworker', 'init', 'inline', 'no-inline', 'import'].includes(key));
        if ((loaderValue || unknownLoader) && ['import', 'reexport'].includes(reference.kind)) reference.kind = 'resource';
        if (unknownLoader) unresolved.push({ sourceId: source.id, expression: reference.specifier, reason: 'Unknown loader qualifier; physical source may be shown but its imported value and exports are not assumed', evidence: reference.evidence });
        const resolution = resolve(entry.path, reference.specifier, reference.kind, loaderValue || unknownLoader ? 'asset' : mode, reference.sourceExtension);
        if (resolution.node) addRelation(source, resolution.node, reference, reference.certainty ?? (unknownLoader || reference.evidence.rule.startsWith('Static fetch') ? 'inferred' : 'confirmed'));
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
  let initialTables: ReturnType<typeof exportTables> | undefined;
  const declarationTables = () => initialTables ??= exportTables({ revision: 0, nodes: [...nodes.values()], relations: [...relations.values()], unresolved: [], diagnostics: [], ...symbolContributions([...relations.values()], javascriptResults),
    coverage: [...javascriptResults].map(([fileId, entry]) => ({ fileId, status: 'parsed', reasonCodes: entry.result.unsupportedExports ? ['unsupportedCommonJs'] : [], unresolvedCount: 0,
      symbols: javascript.test(entry.path) || ['.vue', '.svelte', '.astro', '.mdx'].includes(path.extname(entry.path)) ? entry.result.diagnostics.length ? 'limited' : 'available' : 'unavailable' })),
    stats: { files: files.files.size, relations: relations.size, elapsedMs: 0 } });
  await applyFrameworks({
    files: [...files.files.values()].map(entry => ({ node: byPath.get(canonical(entry.path))!, path: entry.path, result: javascriptResults.get(byPath.get(canonical(entry.path))!.id)?.result })),
    projects: projects.map(project => ({ ...project, context: webContexts.get(project.id)! })),
    read: file => !isEnv(file) && (javascript.test(file) || formatCapabilities[path.extname(file).toLowerCase()]?.mode === 'references') ? files.read(file) : undefined, add: addRelation,
    diagnostic: (source, message) => diagnostics.push({ fileId: source.id, message, capability: 'framework' }),
    resolveDeclaration: (sourcePath, module, imported) => {
      const target = resolve(sourcePath, module, 'import').node;
      if (!target?.file) return undefined;
      const result = resolveExport(declarationTables(), target.id, imported, 'value');
      if (result.status !== 'resolved') return undefined;
      const candidate = result.candidates[0];
      const provenanceIds = [...new Set([target.id, candidate.fileId, ...candidate.relationIds.flatMap(id => { const edge = relations.get(id); return edge ? [edge.sourceId, edge.targetId] : []; })])];
      return { fileId: candidate.fileId, name: candidate.name, range: candidate.range, provenanceIds };
    },
  });
  for (let index = unresolved.length - 1; index >= 0; index--) {
    const reference = unresolved[index];
    if (!['#imports', '#components'].includes(reference.expression ?? '')) continue;
    const bindings = javascriptResults.get(reference.sourceId)?.result.references.filter(item => item.specifier === reference.expression).flatMap(item => item.bindings) ?? [];
    const edges = [...relations.values()].filter(edge => edge.sourceId === reference.sourceId && ['import', 'reexport'].includes(edge.kind) && edge.specifier === reference.expression);
    if (bindings.length && bindings.every(binding => edges.some(edge => edge.bindings.some(item => item.imported === binding.imported)))) unresolved.splice(index, 1);
  }
  const coverage: FileCoverage[] = [];
  const diagnosticFiles = new Set(diagnostics.filter(item => item.capability !== 'framework').map(item => item.fileId));
  const frameworkLimited = new Set(diagnostics.filter(item => item.capability === 'framework').map(item => item.fileId));
  const unresolvedCounts = new Map<string, number>();
  for (const reference of unresolved) unresolvedCounts.set(reference.sourceId, (unresolvedCounts.get(reference.sourceId) ?? 0) + 1);
  for (const entry of files.files.values()) {
    const node = byPath.get(canonical(entry.path))!;
    const readReason = files.readReasons.get(canonical(entry.path));
    const format = formatCapabilities[node.format];
    const configFile = /^(?:package|(?:ts|js)config(?:\.[^.]+)*)\.json$/.test(path.basename(entry.path));
    const nodeOnly = format?.mode === 'node-only' && !configFile || !format && !configFile;
    const result = javascriptResults.get(node.id)?.result;
    const sourceLike = /\.(?:py|go|rs|java|kt|cs|rb|php|pug|hbs|twig|erb|ejs|coffee|glsl|vert|frag)$/i.test(entry.path);
    const reasonCodes = readReason ? [readReason] : nodeOnly ? [sourceLike ? 'unsupportedInternalReferences' : 'resourceNode'] : [];
    reasonCodes.push(...(result?.capabilityReasons ?? []));
    if (diagnosticFiles.has(node.id) && !nodeOnly) reasonCodes.push(configFile ? 'configurationDiagnostic' : 'parseDiagnostic');
    if (frameworkLimited.has(node.id)) reasonCodes.push('frameworkLimited');
    if (result?.diagnostics.some(message => message.startsWith('JavaScript/TypeScript parse error'))) reasonCodes.push('scriptParseDiagnostic');
    if (result?.unsupportedExports) reasonCodes.push('unsupportedCommonJs');
    const unresolvedCount = unresolvedCounts.get(node.id) ?? 0;
    if (unresolvedCount) reasonCodes.push('unresolvedReference');
    const hasSymbols = javascript.test(entry.path) || ['.vue', '.svelte', '.astro', '.mdx'].includes(node.format);
    coverage.push({ fileId: node.id, status: readReason === 'readFailed' ? 'failed' : readReason ? 'skipped' : nodeOnly ? 'nodeOnly' : 'parsed', reasonCodes, unresolvedCount, symbols: !hasSymbols || result?.unsupportedExports ? 'unavailable' : result ? result.diagnostics.length ? 'limited' : 'available' : 'unavailable' });
  }
  const { exports, bindingOccurrences } = symbolContributions([...relations.values()], javascriptResults, semanticOccurrences);
  coverage.sort((a, b) => a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0);
  const declarations: DeclarationTarget[] = [];
  const symbolGraph: GraphSnapshot = { revision: 0, nodes: [...nodes.values()], relations: [...relations.values()], unresolved, diagnostics, exports, coverage, stats: { files: files.files.size, relations: relations.size, elapsedMs: 0 } };
  const tables = exportTables(symbolGraph);
  const canonicalToken = (id: string): { id: string | undefined; provenance: string[] } => {
    const [file, name] = JSON.parse(id) as [string, string];
    const resolution = resolveExport(tables, file, name, 'value');
    if (resolution.status !== 'resolved') return { id: resolution.status === 'ambiguous' ? undefined : id, provenance: [file] };
    const candidate = resolution.candidates[0];
    const provenance = [...new Set([file, candidate.fileId, ...candidate.relationIds.flatMap(id => { const edge = relations.get(id); return edge ? [edge.sourceId, edge.targetId] : []; })])];
    return { id: JSON.stringify([candidate.fileId, candidate.name]), provenance };
  };
  for (const consumer of consumers) {
    const token = canonicalToken(consumer.tokenId);
    const matches = token.id ? providers.filter(provider => canonicalToken(provider.tokenId).id === token.id && provider.source.projectId === consumer.source.projectId) : [];
    for (const provider of matches) if (provider.source.id !== consumer.source.id) addRelation(consumer.source, provider.source, {
      kind: 'framework', specifier: `DI:${token.id}`, bindings: [], provenanceIds: [...new Set([...token.provenance, ...canonicalToken(provider.tokenId).provenance])],
      evidence: { ...consumer.evidence, rule: 'Tramvai declared provider candidate; registration, overrides and runtime scope are not proven' }
    }, 'inferred');
    if (!matches.length) {
      unresolved.push({ sourceId: consumer.source.id, reason: 'Tramvai token has no unique statically declared provider in this project; it may be supplied by a runtime scope', evidence: consumer.evidence });
      const row = coverage.find(row => row.fileId === consumer.source.id);
      if (row) { row.unresolvedCount++; if (!row.reasonCodes.includes('unresolvedReference')) row.reasonCodes.push('unresolvedReference'); }
    }
  }
  for (const relation of relations.values()) {
    if (!['import', 'reexport'].includes(relation.kind)) continue;
    for (const binding of relation.bindings) {
      if (binding.imported === '*') continue;
      const resolution = resolveExport(tables, relation.targetId, binding.resolvedImported ?? binding.imported, binding.typeOnly ? 'type' : 'both');
      const found = resolution.status === 'resolved' ? resolution.candidates[0] : undefined;
      const file = found ? nodes.get(found.fileId)?.file : undefined;
      if (found?.range && file && !declarations.some(item => item.relationId === relation.id && item.imported === binding.imported)) declarations.push({ relationId: relation.id, imported: binding.imported, file, range: found.range });
    }
  }
  onProgress(`${incremental ? 'Incremental' : 'Full'} analysis: ${processed} affected source files; reused ${reusedContributions} contributions; parsed ${processed - reusedSources}, parsing-cache hits ${reusedSources}`);
  const graph: GraphSnapshot = { revision: (previous?.graph.revision ?? 0) + 1, nodes: [...nodes.values()], relations: [...relations.values()], unresolved, diagnostics, declarations, coverage, exports, bindingOccurrences,
    coverageReasons: files.inventoryFailures.size ? ['inventoryReadFailed'] : [],
    physicalFileIds: [...files.files.values()].filter(entry => entry.physical).map(entry => byPath.get(canonical(entry.path))!.id).sort(),
    stats: { files: files.files.size, relations: relations.size, elapsedMs: Math.round(performance.now() - started) } };
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
