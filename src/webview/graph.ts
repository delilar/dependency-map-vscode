import cytoscape, { type Core, type ElementDefinition, type EventObject, type NodeSingular } from 'cytoscape';
import type { GraphNode, GraphSnapshot, Relation, ViewState } from '../shared/model';
import { isTestRole } from '../shared/roles';
import { collectNeighbourhood } from './depth';
import type { GraphAppearance } from './appearance';
import { inScope, scopedGraph } from '../shared/scope';

export interface ProjectedEdge { id: string; sourceId: string; targetId: string; relations: Relation[]; collapsed: boolean }
export interface Projection { nodes: GraphNode[]; edges: ProjectedEdge[] }
export interface ProjectedGroup { id: string; label: string; memberIds: string[]; collapsed: boolean }
export interface GroupedProjection extends Projection { groups: ProjectedGroup[]; parents: Record<string, string> }
export interface ProjectionOptions {
  forcedIds?: Set<string>; markedIds?: Set<string>; format?: string; project?: string; role?: string; folder?: string;
  direction?: 'both' | 'incoming' | 'outgoing';
  queryNodeIds?: Set<string>; queryRelationIds?: Set<string>; branchNodeIds?: Set<string>; branchRelationIds?: Set<string>;
}
export function activeBranchContributions(baseIds: Set<string>, branches: readonly { anchorId: string; result?: { nodeIds: string[]; relationIds: string[] } }[]): { nodeIds: Set<string>; relationIds: Set<string> } {
  const reached = new Set(baseIds), nodeIds = new Set<string>(), relationIds = new Set<string>(), applied = new Set<number>();
  let advanced = true;
  while (advanced) {
    advanced = false;
    branches.forEach((branch, index) => {
      if (applied.has(index) || !branch.result || !reached.has(branch.anchorId)) return;
      applied.add(index); advanced = true;
      for (const id of branch.result.nodeIds) { reached.add(id); nodeIds.add(id); }
      for (const id of branch.result.relationIds) relationIds.add(id);
    });
  }
  return { nodeIds, relationIds };
}

export function displayLabels(nodes: GraphNode[]): Map<string, string> {
  const result = new Map(nodes.map(node => [node.id, node.label]));
  const duplicates = new Map<string, GraphNode[]>();
  for (const node of nodes) duplicates.set(node.label, [...(duplicates.get(node.label) ?? []), node]);
  for (const siblings of duplicates.values()) {
    if (siblings.length < 2) continue;
    const parts = new Map(siblings.map(node => [node.id, (node.file?.path ?? node.packageName ?? node.label).split('/')]));
    const labels = new Map<string, string>();
    for (const node of siblings) {
      const own = parts.get(node.id)!;
      let unique: string | undefined;
      for (let count = Math.min(2, own.length); count <= own.length; count++) {
        const suffix = own.slice(-count).join('/');
        if (siblings.every(other => other.id === node.id || parts.get(other.id)!.slice(-count).join('/') !== suffix)) { unique = suffix; break; }
      }
      labels.set(node.id, unique ?? `${node.projectName ?? node.projectId}/${own.join('/')}`);
    }
    const occurrences = new Map<string, number>();
    for (const node of [...siblings].sort((left, right) => left.id.localeCompare(right.id))) {
      const candidate = labels.get(node.id)!;
      const count = (occurrences.get(candidate) ?? 0) + 1; occurrences.set(candidate, count);
      result.set(node.id, [...labels.values()].filter(label => label === candidate).length > 1 ? `${candidate} [${count}]` : candidate);
    }
  }
  return result;
}

export function searchGraph(graph: GraphSnapshot, query: string): GraphNode[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  const matching = new Set<string>();
  for (const edge of graph.relations) {
    if (edge.bindings.some(binding => `${binding.imported} ${binding.local ?? ''}`.toLocaleLowerCase().includes(term))) {
      matching.add(edge.sourceId); matching.add(edge.targetId);
    }
  }
  return graph.nodes.filter(node => matching.has(node.id)
    || `${node.label} ${node.file?.path ?? ''} ${node.projectName ?? node.projectId}`.toLocaleLowerCase().includes(term));
}

function collapseEdges(graph: GraphSnapshot, protectedIds: Set<string>): Projection {
  const outgoing = new Map<string, Relation[]>();
  for (const edge of graph.relations) outgoing.set(edge.sourceId, [...(outgoing.get(edge.sourceId) ?? []), edge]);
  const barrels = new Set(graph.nodes.filter(node => !protectedIds.has(node.id)
    && (outgoing.get(node.id)?.length ?? 0) > 0
    && outgoing.get(node.id)!.every(edge => edge.kind === 'reexport')).map(node => node.id));
  const hidden = new Set<string>();
  const edges: ProjectedEdge[] = [];
  const paths = (target: string, seen: Set<string>): Relation[][] | undefined => {
    if (!barrels.has(target)) return [[]];
    if (seen.has(target)) return undefined;
    const nextSeen = new Set(seen).add(target);
    const result: Relation[][] = [];
    for (const edge of outgoing.get(target) ?? []) {
      const tails = paths(edge.targetId, nextSeen);
      if (!tails) return undefined;
      result.push(...tails.map(tail => [edge, ...tail]));
    }
    return result;
  };
  for (const edge of graph.relations) {
    const tails = paths(edge.targetId, new Set([edge.sourceId]));
    if (tails?.some(tail => tail.length)) {
      for (const tail of tails) {
        const chain = [edge, ...tail];
        for (const step of tail) hidden.add(step.sourceId);
        edges.push({ id: `view:${JSON.stringify(chain.map(item => item.id))}`, sourceId: edge.sourceId,
          targetId: chain[chain.length - 1].targetId, relations: chain, collapsed: true });
      }
    } else edges.push({ id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, relations: [edge], collapsed: false });
  }
  return { nodes: graph.nodes.filter(node => !hidden.has(node.id)), edges: edges.filter(edge => !hidden.has(edge.sourceId) && !hidden.has(edge.targetId)) };
}

export function projectGraph(graph: GraphSnapshot, view: ViewState, options: ProjectionOptions = {}): Projection {
  graph = scopedGraph(graph, view.queryScope);
  const forced = options.forcedIds ?? new Set<string>();
  const folder = (options.folder ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const protectedIds = new Set(forced);
  if (view.focusId) protectedIds.add(view.focusId);
  let eligible = new Set(graph.nodes.filter(node => forced.has(node.id) || (
    (!view.hideExternal || node.kind !== 'external') && (!view.hideTests || !isTestRole(node.role))
    && (!options.format || node.format === options.format) && (!options.project || node.projectId === options.project)
    && (!options.role || node.role === options.role)
    && (!folder || folder === '.' || !!node.file && (node.file.path === folder || node.file.path.startsWith(`${folder}/`)))
    && (!options.markedIds || options.markedIds.has(node.id))
  )).map(node => node.id));
  if (options.queryNodeIds) eligible = new Set([...eligible].filter(id => options.queryNodeIds!.has(id) || options.branchNodeIds?.has(id) || forced.has(id)));
  else if (view.mode === 'file') {
    const filtered = eligible;
    eligible = collectNeighbourhood({ nodeIds: graph.nodes.map(node => node.id), relations: graph.relations,
      eligibleIds: eligible, focusId: view.focusId, depth: view.depth, direction: options.direction, forcedIds: forced, nodeDepths: view.nodeDepths });
    for (const id of options.branchNodeIds ?? []) if (filtered.has(id)) eligible.add(id);
  }
  for (const id of options.branchNodeIds ?? []) if (eligible.has(id)) protectedIds.add(id);
  for (const id of options.queryNodeIds ?? []) if (eligible.has(id)) protectedIds.add(id);
  for (const id of Object.keys(view.nodeDepths ?? {})) if (eligible.has(id)) protectedIds.add(id);
  if (view.presentationScope) eligible = new Set([...eligible].filter(id => forced.has(id) || inScope(graph.nodes.find(node => node.id === id), view.presentationScope)));
  const subset = { ...graph, nodes: graph.nodes.filter(node => eligible.has(node.id)), relations: graph.relations.filter(edge => eligible.has(edge.sourceId) && eligible.has(edge.targetId)
    && (!options.queryRelationIds || options.queryRelationIds.has(edge.id) || options.branchRelationIds?.has(edge.id))) };
  return view.collapseReexports ? collapseEdges(subset, protectedIds) : { nodes: subset.nodes, edges: subset.relations.map(edge => ({ id: edge.id, sourceId: edge.sourceId,
    targetId: edge.targetId, relations: [edge], collapsed: false })) };
}

export function groupProjection(projection: Projection, groupBy: ViewState['groupBy'], collapsedIds: Set<string>, revealedIds = new Set<string>()): GroupedProjection {
  if (groupBy === 'none') return { ...projection, groups: [], parents: {} };
  const groups = new Map<string, ProjectedGroup>();
  const parents: Record<string, string> = {};
  for (const node of projection.nodes) {
    const folder = node.file?.path.includes('/') ? node.file.path.slice(0, node.file.path.lastIndexOf('/')) : '.';
    const key = groupBy === 'project' ? node.projectId : `${node.file?.rootId ?? node.projectId}/${folder}`;
    const id = `group:${groupBy}:${key}`;
    const group = groups.get(id) ?? { id, label: groupBy === 'project' ? node.projectName ?? node.projectId : `${node.projectName ?? node.projectId}/${folder}`, memberIds: [], collapsed: collapsedIds.has(id) };
    group.memberIds.push(node.id);
    if (revealedIds.has(node.id)) group.collapsed = false;
    groups.set(id, group); parents[node.id] = id;
  }
  const mappedEndpoint = (id: string) => groups.get(parents[id])?.collapsed ? parents[id] : id;
  const edges = new Map<string, ProjectedEdge>();
  for (const edge of projection.edges) {
    const sourceId = mappedEndpoint(edge.sourceId), targetId = mappedEndpoint(edge.targetId);
    const aggregated = sourceId !== edge.sourceId || targetId !== edge.targetId;
    if (sourceId === targetId && aggregated) continue;
    const id = aggregated ? `group-edge:${JSON.stringify([sourceId, targetId])}` : edge.id;
    const previous = edges.get(id);
    const relations = [...new Map([...(previous?.relations ?? []), ...edge.relations].map(item => [item.id, item])).values()];
    edges.set(id, { id, sourceId, targetId, relations, collapsed: aggregated || edge.collapsed });
  }
  return { nodes: projection.nodes.filter(node => !groups.get(parents[node.id])?.collapsed), edges: [...edges.values()], groups: [...groups.values()], parents };
}

export interface SavedCanvas { positions?: Record<string, { x: number; y: number }>; zoom?: number; pan?: { x: number; y: number } }
export interface CanvasSelection { nodeIds: string[]; relationIds: string[] }

export class GraphCanvas {
  private cy: Core;
  private edges = new Map<string, ProjectedEdge>();
  private first = true;
  private themeObserver: MutationObserver;
  private resizeObserver: ResizeObserver;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private retainedPositions: Record<string, { x: number; y: number }> = {};
  private previousProjection?: GroupedProjection;
  private previousFocus?: string;
  private previousMode?: ViewState['mode'];
  private previousAppearance?: GraphAppearance;
  private previousDepthKey = '';
  private matches = new Set<string>();
  private resizeFrame = 0;
  private preserveNextCamera = false;
  constructor(container: HTMLElement, private callbacks: {
    selection: (value: CanvasSelection) => void; open: (nodeId: string) => void; toggleGroup: (groupId: string) => void;
    context: (nodeId: string, point: { x: number; y: number }) => void; save: (state: SavedCanvas) => void;
  }, private restored: SavedCanvas = {}) {
    this.retainedPositions = { ...restored.positions };
    this.cy = cytoscape({ container, elements: [], minZoom: 0.08, maxZoom: 3, boxSelectionEnabled: true,
      zoom: restored.zoom ?? 1, pan: restored.pan ?? { x: 0, y: 0 },
      selectionType: 'additive', wheelSensitivity: 4, layout: { name: 'preset', fit: false } });
    this.applyTheme();
    this.cy.on('select unselect', () => this.callbacks.selection({
      nodeIds: this.cy.nodes(':selected').filter(node => !node.data('group')).map(node => node.id()),
      relationIds: [...new Set(this.cy.edges(':selected').map(edge => this.edges.get(edge.id())?.relations.map(item => item.id) ?? []).flat())]
    }));
    this.cy.on('dbltap', 'node', (event: EventObject) => {
      if (event.target.data('group')) this.callbacks.toggleGroup(event.target.id());
      else this.callbacks.open(event.target.id());
    });
    this.cy.on('mouseover', 'node', (event: EventObject) => { container.title = event.target.data('path') ?? event.target.data('label') ?? ''; });
    this.cy.on('mouseout', 'node', () => { container.title = ''; });
    this.cy.on('cxttap', 'node', (event: EventObject) => {
      if (event.target.data('group')) return;
      const bounds = container.getBoundingClientRect();
      const position = event.renderedPosition ?? event.target.renderedPosition();
      this.callbacks.context(event.target.id(), { x: bounds.left + position.x, y: bounds.top + position.y });
    });
    container.addEventListener('contextmenu', event => event.preventDefault());
    this.cy.on('pan zoom dragfree layoutstop', () => {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => { if (!this.first) this.callbacks.save(this.state()); }, 200);
    });
    this.themeObserver = new MutationObserver(() => this.applyTheme());
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.resizeFrame) this.resizeFrame = requestAnimationFrame(() => { this.resizeFrame = 0; this.cy.resize(); });
    });
    this.resizeObserver.observe(container);
  }
  private applyTheme(): void {
    const styles = getComputedStyle(document.body);
    const token = (name: string, fallback: string) => styles.getPropertyValue(`--vscode-${name}`).trim() || fallback;
    const configuredFont = parseFloat(token('font-size', '13px'));
    const fontScale = Number.isFinite(configuredFont) && configuredFont > 0 ? configuredFont / 13 : 1;
    this.cy.style([
      { selector: 'node', style: { 'background-color': token('button-background', '#3979b7'), 'border-color': token('contrastBorder', '#607080'),
        'border-width': 1, label: 'data(label)', color: token('editor-foreground', '#d6dce5'), 'font-size': 11 * fontScale,
        'text-wrap': 'ellipsis', 'text-max-width': '170px', 'text-valign': 'bottom', 'text-margin-y': 7, width: 23, height: 23 } },
      { selector: 'node[external]', style: { shape: 'diamond', 'background-color': token('disabledForeground', '#7d8590') } },
      { selector: 'node[group]', style: { shape: 'roundrectangle', 'background-opacity': 0.07, 'background-color': token('editor-foreground', '#d6dce5'),
        'border-style': 'dashed', 'text-valign': 'top', 'font-size': 12 * fontScale, padding: '24px' } },
      { selector: 'node[?collapsedGroup]', style: { 'background-opacity': 0.18, width: 60, height: 40, 'text-valign': 'center', 'text-wrap': 'wrap', 'text-max-width': '140px', 'font-size': 10 * fontScale } },
      { selector: 'node[?focus]', style: { 'outline-width': 2, 'outline-color': token('focusBorder', '#00b7ff'), 'outline-offset': 3, width: 31, height: 31 } },
      { selector: 'node[fill]', style: { 'background-color': 'data(fill)' } },
      { selector: 'node[border]', style: { 'border-color': 'data(border)', 'border-width': 4 } },
      { selector: 'node[folderColor]', style: { 'background-color': 'data(folderColor)' } },
      { selector: 'edge', style: { width: 1.1, 'line-color': token('descriptionForeground', '#788897'), 'target-arrow-color': token('descriptionForeground', '#788897'),
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier', opacity: 0.7, 'arrow-scale': 0.7 } },
      { selector: 'edge[inferred]', style: { 'line-style': 'dashed' } },
      { selector: 'edge[collapsed]', style: { label: 'data(aggregation)', 'font-size': 9 * fontScale, 'text-background-opacity': 0.8, 'text-background-color': token('editor-background', '#1e1e1e') } },
      { selector: 'edge[color]', style: { 'line-color': 'data(color)', 'target-arrow-color': 'data(color)', width: 2.5 } },
      { selector: '.search-match', style: { 'text-background-color': token('editor-findMatchHighlightBackground', '#806c00'), 'text-background-opacity': 0.45, 'text-background-padding': '3px' } },
      { selector: ':selected', style: { 'underlay-color': token('focusBorder', '#00b7ff'), 'underlay-opacity': 0.3, 'underlay-padding': 6, opacity: 1 } }
    ]);
  }
  render(projection: GroupedProjection, view: ViewState, appearance: GraphAppearance, matches = new Set<string>(), preserveCamera = false): void {
    if (this.first && !projection.nodes.length && !projection.groups.length) return;
    const previousProjection = this.previousProjection;
    const depthKey = JSON.stringify(Object.entries(view.nodeDepths ?? {}).sort(([left], [right]) => left.localeCompare(right)));
    const sameColors = (left: Map<string, string>, right: Map<string, string>) => left.size === right.size && [...left].every(([id, color]) => right.get(id) === color);
    if (previousProjection && this.previousFocus === view.focusId && this.previousMode === view.mode
      && previousProjection.nodes.length === projection.nodes.length && previousProjection.nodes.every((node, index) => node === projection.nodes[index])
      && previousProjection.edges.length === projection.edges.length && previousProjection.edges.every((edge, index) => {
        const next = projection.edges[index];
        return edge.id === next.id && edge.sourceId === next.sourceId && edge.targetId === next.targetId && edge.collapsed === next.collapsed
          && edge.relations.length === next.relations.length && edge.relations.every((relation, position) => relation === next.relations[position]);
      })
      && previousProjection.groups.length === projection.groups.length && previousProjection.groups.every((group, index) => {
        const next = projection.groups[index];
        return group.id === next.id && group.label === next.label && group.collapsed === next.collapsed;
      })
      && depthKey === this.previousDepthKey && this.previousAppearance
      && sameColors(appearance.nodeFills, this.previousAppearance.nodeFills) && sameColors(appearance.nodeBorders, this.previousAppearance.nodeBorders)
      && sameColors(appearance.edgeColors, this.previousAppearance.edgeColors) && sameColors(appearance.folderColors, this.previousAppearance.folderColors)) {
      this.cy.batch(() => {
        for (const id of this.matches) if (!matches.has(id)) this.cy.getElementById(id).removeClass('search-match');
        for (const id of matches) if (!this.matches.has(id)) this.cy.getElementById(id).addClass('search-match');
      });
      this.matches = new Set(matches);
      this.preserveNextCamera = false;
      return;
    }
    const previous = this.state();
    const positions = { ...this.restored.positions, ...previous.positions };
    const labels = displayLabels(projection.nodes);
    const elements: ElementDefinition[] = [];
    for (const group of projection.groups) {
      const mark = appearance.folderMarks.get(group.id);
      const members = group.memberIds.map(id => positions[id]).filter(Boolean);
      const position = positions[group.id] ?? (members.length ? {
        x: members.reduce((sum, item) => sum + item.x, 0) / members.length,
        y: members.reduce((sum, item) => sum + item.y, 0) / members.length
      } : undefined);
      elements.push({ data: { id: group.id, label: `${group.label} (${group.memberIds.length})${mark?.marked ? ` · задача ${mark.marked}/${mark.total}${mark.marked === mark.total ? ' все' : ' часть'}` : ''}${group.collapsed ? ' ▸' : ''}`,
        group: true, collapsedGroup: group.collapsed, folderColor: appearance.folderColors.get(group.id),
        border: mark?.total && mark.marked === mark.total ? group.memberIds.map(id => appearance.nodeBorders.get(id)).find(Boolean) : undefined }, position });
    }
    for (const node of projection.nodes) {
      const parent = projection.parents[node.id];
      const localDepth = view.nodeDepths?.[node.id];
      elements.push({ data: { id: node.id, label: `${labels.get(node.id)}${view.colorPreset !== 'format' && node.languageId ? ` [${node.languageId}]` : ''}${localDepth ? ` · ${localDepth} ур.` : ''}`, path: node.file?.path ?? node.packageName ?? node.label, parent, external: node.kind === 'external' ? true : undefined,
        focus: node.id === view.focusId, fill: appearance.nodeFills.get(node.id), border: appearance.nodeBorders.get(node.id) }, position: positions[node.id], classes: matches.has(node.id) ? 'search-match' : '' });
    }
    this.edges = new Map(projection.edges.map(edge => [edge.id, edge]));
    for (const edge of projection.edges) elements.push({ data: { id: edge.id, source: edge.sourceId, target: edge.targetId,
      inferred: edge.relations.some(item => item.certainty === 'inferred') ? true : undefined,
      collapsed: edge.collapsed ? true : undefined, aggregation: `×${edge.relations.length}`, color: edge.relations.map(item => appearance.edgeColors.get(item.id)).find(Boolean) } });
    this.cy.batch(() => {
      const desired = new Set(elements.map(item => item.data.id!));
      this.cy.edges().filter(edge => !desired.has(edge.id())).remove();
      const syncData = (current: ReturnType<Core['getElementById']>, data: ElementDefinition['data']) => {
        for (const key of Object.keys(current.data())) if (!['id', 'parent', 'source', 'target'].includes(key) && data[key] === undefined) current.removeData(key);
        current.data(data);
      };
      for (const item of elements.filter(item => item.data.group)) {
        const current = this.cy.getElementById(item.data.id!);
        if (current.length) syncData(current, item.data); else this.cy.add(item);
      }
      for (const item of elements.filter(item => !item.data.group && !item.data.source)) {
        const current = this.cy.getElementById(item.data.id!);
        if (!current.length) this.cy.add(item);
        else {
          if (current.data('parent') !== item.data.parent) current.move({ parent: item.data.parent ?? null });
          syncData(current, item.data);
          current.toggleClass('search-match', matches.has(current.id()));
        }
      }
      this.cy.nodes().filter(node => !desired.has(node.id())).remove();
      for (const item of elements.filter(item => !!item.data.source)) {
        let current = this.cy.getElementById(item.data.id!);
        if (current.length && (current.data('source') !== item.data.source || current.data('target') !== item.data.target)) { current.remove(); current = this.cy.getElementById(item.data.id!); }
        if (current.length) syncData(current, item.data); else this.cy.add(item);
      }
      for (const node of projection.nodes) if (positions[node.id]) this.cy.getElementById(node.id).position(positions[node.id]);
    });
    const newNodes = this.cy.nodes().filter(node => (!node.data('group') || node.data('collapsedGroup')) && !positions[node.id()]);
    if (this.first && Object.keys(positions).length === 0) {
      const restoreCamera = this.restored.zoom !== undefined || this.restored.pan !== undefined;
      this.layout(view.mode, !restoreCamera && view.mode === 'project');
      if (this.restored.zoom !== undefined) this.cy.zoom(this.restored.zoom);
      if (this.restored.pan) this.cy.pan(this.restored.pan);
      if (!restoreCamera && view.mode === 'file') { this.cy.zoom(1); if (view.focusId) this.cy.center(this.cy.getElementById(view.focusId)); }
    }
    else {
      const center = { x: (this.cy.width() / 2 - (previous.pan?.x ?? 0)) / (previous.zoom ?? 1), y: (this.cy.height() / 2 - (previous.pan?.y ?? 0)) / (previous.zoom ?? 1) };
      newNodes.forEach((node, index) => {
        const neighbour = node.connectedEdges().connectedNodes().filter(item => !!positions[item.id()])[0];
        const anchor = neighbour ? positions[neighbour.id()] : center;
        node.position({ x: anchor.x + Math.cos(index * 2.4) * (75 + index * 8), y: anchor.y + Math.sin(index * 2.4) * (75 + index * 8) });
      });
      if (this.first && this.restored.zoom) this.cy.zoom(this.restored.zoom);
      else if (!this.first) this.cy.zoom(previous.zoom ?? 1);
      if (this.first && this.restored.pan) this.cy.pan(this.restored.pan);
      else if (!this.first && previous.pan) this.cy.pan(previous.pan);
    }
    const navigate = !this.first && view.mode === 'file' && (this.previousFocus !== view.focusId || this.previousMode !== view.mode);
    if (projection.nodes.length || projection.groups.length) this.first = false;
    this.previousProjection = projection; this.previousFocus = view.focusId; this.previousAppearance = appearance; this.previousDepthKey = depthKey; this.matches = new Set(matches);
    this.previousMode = view.mode;
    if (navigate && view.focusId && !preserveCamera && !this.preserveNextCamera) this.center(view.focusId);
    this.preserveNextCamera = false;
  }
  select(nodeIds: string[], relationIds: string[] = []): void {
    const desired = new Set(nodeIds.filter(id => this.cy.getElementById(id).length > 0));
    for (const edge of this.edges.values()) if (edge.relations.some(item => relationIds.includes(item.id))) desired.add(edge.id);
    const current = this.cy.elements(':selected');
    if (current.length === desired.size && current.map(item => item.id()).every(id => desired.has(id))) return;
    this.cy.batch(() => { current.unselect(); for (const id of desired) this.cy.getElementById(id).select(); });
  }
  center(nodeId?: string): void {
    const target = nodeId ? this.cy.getElementById(nodeId) : this.cy.elements();
    this.cy.stop();
    if (!target.length) return;
    if (nodeId) {
      const zoom = Math.max(1, this.cy.zoom()), position = (target[0] as NodeSingular).position();
      this.cy.animate({ zoom, pan: { x: this.cy.width() / 2 - position.x * zoom, y: this.cy.height() / 2 - position.y * zoom }, duration: 150 });
    } else this.cy.animate({ fit: { eles: target, padding: Math.min(45, Math.max(8, Math.min(this.cy.width(), this.cy.height()) * 0.12)) }, duration: 150 });
  }
  zoomBy(factor: number): void {
    this.cy.stop(); this.cy.zoom({ level: this.cy.zoom() * factor, renderedPosition: { x: this.cy.width() / 2, y: this.cy.height() / 2 } });
  }
  layout(mode: ViewState['mode'], fit = true): void {
    this.cy.stop();
    this.cy.layout(this.cy.nodes().length > 250
      ? { name: 'grid', avoidOverlap: true, condense: false, padding: 45, fit }
      : mode === 'file' ? { name: 'concentric', concentric: node => node.data('focus') ? 2 : 1, levelWidth: () => 1,
        minNodeSpacing: 35, nodeDimensionsIncludeLabels: true, avoidOverlap: true, padding: 45, fit }
        : { name: 'cose', animate: false, randomize: false, numIter: 300, nodeRepulsion: () => 12000, padding: 45, fit }).run();
  }
  state(): SavedCanvas {
    this.cy.nodes().filter(node => !node.data('group') || node.data('collapsedGroup')).forEach(node => { this.retainedPositions[node.id()] = { ...node.position() }; });
    return { positions: { ...this.retainedPositions }, zoom: this.cy.zoom(), pan: { ...this.cy.pan() } };
  }
  restore(state: SavedCanvas = {}): void {
    this.cy.stop(); this.retainedPositions = { ...state.positions }; this.restored = state; this.preserveNextCamera = true;
    this.cy.batch(() => { for (const [id, position] of Object.entries(state.positions ?? {})) { const node = this.cy.getElementById(id); if (node.length) node.position(position); } });
    if (state.zoom !== undefined) this.cy.zoom(state.zoom);
    if (state.pan) this.cy.pan(state.pan);
  }
  destroy(): void {
    clearTimeout(this.saveTimer); cancelAnimationFrame(this.resizeFrame); this.themeObserver.disconnect(); this.resizeObserver.disconnect();
    this.cy.stop(); this.cy.destroy();
  }
}
