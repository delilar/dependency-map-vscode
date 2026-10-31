import type { AnalysisOptions, GraphSnapshot, SourceOverlay, ViewState, WorkspaceRoot } from './model';
import { isQuerySpec, type AnalyticsState, type BuildIdentity, type IndexVersion, type QueryRequest, type QueryResult, type QuerySpec, type TaskContextData } from './query-model';

export interface AnalyzeRequest { type: 'analyze'; generation: number; roots: WorkspaceRoot[]; options: AnalysisOptions; overlays: SourceOverlay[]; changedPaths?: string[]; graphVersion?: IndexVersion }
export type WorkerRequest = AnalyzeRequest | QueryRequest | { type: 'cancelQuery'; requestId: string };
export type WorkerReply = AnalysisReply | QueryResult | { type: 'workerReady'; build: BuildIdentity };
export type AnalysisReply =
  | { type: 'snapshot'; generation: number; graph: GraphSnapshot }
  | { type: 'progress'; generation: number; message: string }
  | { type: 'error'; generation: number; message: string };

export interface SavedUiState {
  canvas?: { positions?: Record<string, { x: number; y: number }>; pan?: { x: number; y: number }; zoom?: number };
  query?: string; format?: string; project?: string; direction?: string; role?: string; folder?: string;
  groupOnly?: boolean; collapsedGroupIds?: string[];
  showGroupColors?: boolean;
  panelSizes?: { leftWidth?: number; rightWidth?: number; toolbarHeight?: number; leftTopHeight?: number; rightTopHeight?: number; narrowCanvasHeight?: number };
}

export type UiMessage =
  | { type: 'ready'; build?: BuildIdentity }
  | { type: 'rebuild' | 'cancel' | 'cancelQuery' | 'leaveAnalysis' }
  | { type: 'startQuery'; query: QuerySpec }
  | { type: 'branch'; nodeId: string; direction: 'incoming' | 'outgoing'; action: 'expand' | 'collapse' }
  | { type: 'gitState'; action: 'observe' | 'sourceControl' | 'impact'; repoId?: string }
  | { type: 'taskContext'; action: 'save' | 'preview' | 'restore' | 'delete'; groupId: string; data?: TaskContextData }
  | { type: 'diagnostics'; action: 'preview' | 'copy' | 'reload' }
  | { type: 'openFile' | 'focusFile'; nodeId: string }
  | { type: 'openEvidence'; relationId: string }
  | { type: 'openDeclaration'; relationId: string; imported: string }
  | { type: 'saveLocalState'; state: SavedUiState; contextToken?: string }
  | { type: 'setView'; view: ViewState }
  | { type: 'setNodeDepth'; nodeId: string; depth: number | null }
  | { type: 'resetNodeDepths' }
  | { type: 'annotation'; action: string; requestId?: string; groupId?: string; name?: string; color?: string; note?: string; nodeIds?: string[]; relationIds?: string[] };
export interface HostState {
  type: 'state'; graph: GraphSnapshot; view: ViewState; status: string;
  annotations: unknown; annotationError?: string;
  analytics?: AnalyticsState;
}
export interface AnnotationResult {
  type: 'annotationResult'; requestId: string; ok: boolean; action: string; groupId?: string;
  files: number; relations: number; skipped: number; message: string;
}
export type HostMessage = HostState | { type: 'status'; status: string; revision: number; analytics?: AnalyticsState } | AnnotationResult | { type: 'diagnostics'; text: string };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, max = 20000): value is string => typeof value === 'string' && value.length <= max;
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export function isBuildIdentity(value: unknown): value is BuildIdentity {
  return record(value) && onlyKeys(value, ['extensionVersion', 'buildId', 'protocolVersion', 'capabilities'])
    && bounded(value.extensionVersion, 100) && bounded(value.buildId, 100) && Number.isSafeInteger(value.protocolVersion) && Number(value.protocolVersion) >= 1
    && Array.isArray(value.capabilities) && value.capabilities.length <= 30 && value.capabilities.every(cap => bounded(cap, 100));
}
export function isTaskContextData(value: unknown): value is TaskContextData {
  if (!record(value) || !onlyKeys(value, ['view', 'ui', 'query', 'branches', 'selection']) || !isViewState(value.view) || !isSavedUiState(value.ui)
    || value.query !== undefined && !isQuerySpec(value.query) || !Array.isArray(value.branches) || value.branches.length > 200 || !record(value.selection)) return false;
  const selection = value.selection;
  return value.branches.every(branch => record(branch) && onlyKeys(branch, ['id', 'anchorId', 'direction', 'depth']) && bounded(branch.id) && bounded(branch.anchorId) && ['incoming', 'outgoing'].includes(String(branch.direction)) && Number.isInteger(branch.depth) && Number(branch.depth) >= 1 && Number(branch.depth) <= 20)
    && onlyKeys(selection, ['nodeIds', 'relationIds']) && ['nodeIds', 'relationIds'].every(key => {
      const ids = selection[key];
      return Array.isArray(ids) && ids.length <= 10000 && ids.every(id => bounded(id));
    });
}
export function isSavedUiState(value: unknown): value is SavedUiState {
  if (!record(value) || Object.keys(value).some(key => !['canvas', 'query', 'format', 'project', 'direction', 'role', 'folder', 'groupOnly', 'collapsedGroupIds', 'showGroupColors', 'panelSizes'].includes(key))) return false;
  if (!['query', 'format', 'project', 'direction', 'role', 'folder'].every(key => value[key] === undefined || bounded(value[key], 4096))) return false;
  if (value.groupOnly !== undefined && typeof value.groupOnly !== 'boolean') return false;
  if (value.showGroupColors !== undefined && typeof value.showGroupColors !== 'boolean') return false;
  if (value.panelSizes !== undefined && (!record(value.panelSizes)
    || !Object.entries(value.panelSizes).every(([key, size]) => ['leftWidth', 'rightWidth', 'toolbarHeight', 'leftTopHeight', 'rightTopHeight', 'narrowCanvasHeight'].includes(key)
      && typeof size === 'number' && Number.isFinite(size) && size >= 0 && size <= 10000))) return false;
  if (value.collapsedGroupIds !== undefined && (!Array.isArray(value.collapsedGroupIds) || value.collapsedGroupIds.length > 10000 || !value.collapsedGroupIds.every(id => bounded(id)))) return false;
  if (value.canvas === undefined) return true;
  const canvas = value.canvas;
  if (!record(canvas) || Object.keys(canvas).some(key => !['positions', 'pan', 'zoom'].includes(key))) return false;
  const point = (value: unknown) => record(value) && Object.keys(value).every(key => ['x', 'y'].includes(key)) && ['x', 'y'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && Math.abs(Number(value[key])) <= 1e9);
  return (canvas.zoom === undefined || typeof canvas.zoom === 'number' && Number.isFinite(canvas.zoom) && canvas.zoom > 0 && canvas.zoom <= 100)
    && (canvas.pan === undefined || point(canvas.pan))
    && (canvas.positions === undefined || record(canvas.positions) && Object.keys(canvas.positions).length <= 10000 && Object.entries(canvas.positions).every(([id, position]) => bounded(id) && point(position)));
}
export function isViewState(value: unknown): value is ViewState {
  if (!record(value) || Object.keys(value).some(key => !['mode', 'focusId', 'follow', 'depth', 'hideExternal', 'hideTests', 'groupBy', 'collapseReexports', 'activeGroupId', 'nodeDepths'].includes(key))) return false;
  return ['file', 'project'].includes(String(value.mode)) && typeof value.follow === 'boolean'
    && Number.isInteger(value.depth) && Number(value.depth) >= 1 && Number(value.depth) <= 20
    && typeof value.hideExternal === 'boolean' && typeof value.hideTests === 'boolean'
    && ['none', 'folder', 'project'].includes(String(value.groupBy)) && typeof value.collapseReexports === 'boolean'
    && (value.nodeDepths === undefined || record(value.nodeDepths) && Object.keys(value.nodeDepths).length <= 200 && Object.entries(value.nodeDepths).every(([id, depth]) => bounded(id) && id.startsWith('file:') && Number.isInteger(depth) && Number(depth) >= 1 && Number(depth) <= 20))
    && (value.focusId === undefined || bounded(value.focusId)) && (value.activeGroupId === undefined || bounded(value.activeGroupId, 200));
}
export function isUiMessage(value: unknown): value is UiMessage {
  if (!record(value)) return false;
  switch (value.type) {
    case 'ready': return onlyKeys(value, ['type', 'build']) && (value.build === undefined || isBuildIdentity(value.build));
    case 'rebuild': case 'cancel': case 'resetNodeDepths': case 'cancelQuery': case 'leaveAnalysis': return onlyKeys(value, ['type']);
    case 'startQuery': return onlyKeys(value, ['type', 'query']) && isQuerySpec(value.query);
    case 'branch': return onlyKeys(value, ['type', 'nodeId', 'direction', 'action']) && bounded(value.nodeId) && value.nodeId.startsWith('file:') && ['incoming', 'outgoing'].includes(String(value.direction)) && ['expand', 'collapse'].includes(String(value.action));
    case 'gitState': return onlyKeys(value, ['type', 'action', 'repoId']) && ['observe', 'sourceControl', 'impact'].includes(String(value.action)) && (value.repoId === undefined || bounded(value.repoId, 200));
    case 'diagnostics': return onlyKeys(value, ['type', 'action']) && ['preview', 'copy', 'reload'].includes(String(value.action));
    case 'taskContext': return onlyKeys(value, ['type', 'action', 'groupId', 'data']) && ['save', 'preview', 'restore', 'delete'].includes(String(value.action)) && bounded(value.groupId, 200) && (value.data === undefined || isTaskContextData(value.data)) && (value.action !== 'save' || isTaskContextData(value.data));
    case 'openFile': case 'focusFile': return bounded(value.nodeId);
    case 'openEvidence': return bounded(value.relationId);
    case 'openDeclaration': return bounded(value.relationId) && bounded(value.imported, 1000);
    case 'saveLocalState': return onlyKeys(value, ['type', 'state', 'contextToken']) && isSavedUiState(value.state) && (value.contextToken === undefined || bounded(value.contextToken, 200));
    case 'setView': return isViewState(value.view);
    case 'setNodeDepth': return bounded(value.nodeId) && value.nodeId.startsWith('file:') && (value.depth === null || Number.isInteger(value.depth) && Number(value.depth) >= 1 && Number(value.depth) <= 20);
    case 'annotation':
      return ['createGroup', 'createGroupAndMark', 'updateGroup', 'deleteGroup', 'mark', 'unmark', 'note', 'markFolder'].includes(String(value.action))
        && (value.requestId === undefined || bounded(value.requestId, 200))
        && ['groupId', 'name', 'color', 'note'].every(key => value[key] === undefined || bounded(value[key], key === 'note' ? 10000 : 200))
        && ['nodeIds', 'relationIds'].every(key => value[key] === undefined || (Array.isArray(value[key]) && value[key].length <= 20000 && value[key].every((id: unknown) => bounded(id))));
    default: return false;
  }
}
