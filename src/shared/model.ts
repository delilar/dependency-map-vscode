export interface WorkspaceRoot { id: string; name: string; path: string }
export interface FileRef { rootId: string; path: string }
export interface Position { line: number; character: number }
export interface SourceRange { start: Position; end: Position }
export type RelationKind = 'import' | 'reexport' | 'resource' | 'config' | 'framework' | 'environment';
export interface Evidence { rule: string; range?: SourceRange }
export interface Binding { imported: string; local?: string; typeOnly: boolean }
export interface GraphNode {
  id: string; label: string; kind: 'file' | 'external'; projectId: string;
  format: string; role?: string; roleReason?: string; file?: FileRef; packageName?: string; projectName?: string;
}
export interface Relation {
  id: string; sourceId: string; targetId: string; kind: RelationKind;
  certainty: 'confirmed' | 'inferred'; specifier?: string;
  bindings: Binding[]; evidence: Evidence[];
}
export interface UnresolvedReference {
  sourceId: string; reason: string; expression?: string; evidence: Evidence;
}
export interface Diagnostic { fileId?: string; message: string }
export interface DeclarationTarget { relationId: string; imported: string; file: FileRef; range: SourceRange }
export interface GraphSnapshot {
  revision: number; nodes: GraphNode[]; relations: Relation[];
  unresolved: UnresolvedReference[]; diagnostics: Diagnostic[];
  stats: { files: number; relations: number; elapsedMs: number };
  declarations?: DeclarationTarget[];
  coverage?: import('./query-model').FileCoverage[];
  exports?: import('./query-model').ExportEntry[];
  bindingOccurrences?: import('./query-model').BindingOccurrence[];
  physicalFileIds?: string[];
  coverageReasons?: string[];
}
export interface EnvKey { name: string; range?: SourceRange }
export interface SourceOverlay { path: string; version: number; text?: string; envKeys?: EnvKey[] }
export interface AnalysisOptions { exclude: string[] }
export interface ViewState {
  mode: 'file' | 'project'; focusId?: string; follow: boolean; depth: number;
  hideExternal: boolean; hideTests: boolean; groupBy: 'none' | 'folder' | 'project';
  collapseReexports: boolean; activeGroupId?: string; nodeDepths?: Record<string, number>;
}
export function fileId(file: FileRef): string {
  return `file:${encodeURIComponent(file.rootId)}:${file.path.replace(/\\/g, '/')}`;
}
export function relationId(sourceId: string, targetId: string, kind: RelationKind, specifier = ''): string {
  return JSON.stringify([sourceId, targetId, kind, specifier]);
}
export function emptyGraph(): GraphSnapshot {
  return { revision: 0, nodes: [], relations: [], unresolved: [], diagnostics: [], stats: { files: 0, relations: 0, elapsedMs: 0 } };
}
export function initialView(): ViewState {
  return { mode: 'file', follow: false, depth: 1, hideExternal: true, hideTests: false, groupBy: 'none', collapseReexports: false };
}
