import { performance } from 'node:perf_hooks';
import type { Relation } from '../shared/model';
import type { EvidencePath, ExportResolution, QueryRequest, QueryResult, SymbolNamespace } from '../shared/query-model';
import { querySeeds } from '../shared/query-model';
import { GraphQueryIndex } from './graph-query-index';
import { resolveExportAsync } from './export-resolution';
import { scopedGraph, scopeSignature } from '../shared/scope';

class Budget {
  readonly reasons = new Set<string>();
  readonly visited = new Set<string>();
  examined = 0;
  stopped = false;
  private readonly start = performance.now();
  private lastYield = this.start;
  private operations = 0;
  constructor(readonly request: QueryRequest, private readonly cancelled: () => boolean) {}
  async check(force = false): Promise<boolean> {
    if (this.stopped) return false;
    if (force || ++this.operations % 64 === 0 || performance.now() - this.lastYield >= 8) {
      await new Promise<void>(resolve => setImmediate(resolve)); this.lastYield = performance.now();
    }
    if (this.cancelled()) return this.stop('cancelled');
    if (performance.now() - this.start >= this.request.limits.deadlineMs) return this.stop('deadlineLimit');
    return true;
  }
  stop(reason: string): false { this.reasons.add(reason); this.stopped = true; return false; }
  visit(id: string): boolean {
    if (this.visited.has(id)) return true;
    if (this.visited.size >= this.request.limits.maxNodes) return this.stop('nodeLimit');
    this.visited.add(id); return true;
  }
  examine(): boolean {
    if (this.examined >= this.request.limits.maxRelations) return this.stop('relationLimit');
    this.examined++; return true;
  }
}

const importEdge = (edge: Relation) => edge.certainty === 'confirmed' && (edge.kind === 'import' || edge.kind === 'reexport');
const pureType = (edge: Relation) => edge.bindings.length > 0 && edge.bindings.every(binding => binding.typeOnly);
const endpoint = (candidate: ExportResolution['candidates'][number]) => JSON.stringify([candidate.fileId, candidate.name, candidate.namespace]);

export async function executeQuery(index: GraphQueryIndex, request: QueryRequest, isCancelled: () => boolean = () => false): Promise<QueryResult> {
  if (request.scope) index = new GraphQueryIndex(scopedGraph(index.graph, request.scope));
  const budget = new Budget(request, isCancelled);
  const query = request.query;
  const seeds = [...new Set(querySeeds(query))];
  const missing = seeds.filter(id => !index.nodes.get(id)?.file);
  const witnesses: EvidencePath[] = [];
  let nodeIds: string[] = [], relationIds: string[] = [];
  let outcome: 'found' | 'notFoundWithinScope' | 'notFoundWithinLimits' | 'unknown' = 'unknown';
  let resolution: ExportResolution = { status: 'unresolved', reasonCodes: ['exportMissing'], candidates: [] };
  const directIds: string[] = [], indirectIds: string[] = [], testIds: string[] = [];
  const scopeReasons = new Set<string>();
  if (missing.length) scopeReasons.add('missingSeed');
  if (!missing.length && await budget.check(true)) {
    if (query.kind === 'symbol') {
      const resolve = (fileId: string, name: string, namespace: SymbolNamespace) => resolveExportAsync(index.symbols, fileId, name, namespace, async step =>
        await budget.check() && (!step.fileId || budget.visit(step.fileId)) && (!step.relationId || budget.examine()));
      resolution = await resolve(query.fileId, query.exported, query.namespace);
      for (const reason of resolution.reasonCodes) scopeReasons.add(reason);
      const selected = new Set(resolution.candidates.map(endpoint));
      const visibleNodes = new Set<string>(), visibleRelations = new Set<string>();
      const include = (id: string) => { if (!budget.visit(id)) return false; visibleNodes.add(id); return true; };
      include(query.fileId);
      for (const candidate of resolution.candidates) for (const relationId of candidate.relationIds) {
        if (!await budget.check()) break;
        const edge = index.relations.get(relationId);
        if (edge && include(edge.sourceId) && include(edge.targetId)) visibleRelations.add(edge.id);
      }
      type SymbolState = { fileId: string; name: string; namespace: SymbolNamespace; nodeIds: string[]; relationIds: string[] };
      const queue: SymbolState[] = [{ fileId: query.fileId, name: query.exported, namespace: query.namespace, nodeIds: [query.fileId], relationIds: [] }];
      const provenancePath = async (target: string, allowed: string[]): Promise<EvidencePath | undefined> => {
        const queue = [query.fileId], seen = new Set(queue), previous = new Map<string, { nodeId: string; relationId: string }>();
        const adjacency = new Map<string, Relation[]>();
        for (const id of allowed) {
          if (!await budget.check()) return undefined;
          const edge = index.relations.get(id); if (!edge) continue;
          const list = adjacency.get(edge.sourceId) ?? []; list.push(edge); adjacency.set(edge.sourceId, list);
        }
        for (let cursor = 0; cursor < queue.length && !seen.has(target); cursor++) for (const edge of adjacency.get(queue[cursor]) ?? []) {
          if (!await budget.check()) return undefined;
          if (seen.has(edge.targetId)) continue;
          seen.add(edge.targetId); queue.push(edge.targetId); previous.set(edge.targetId, { nodeId: edge.sourceId, relationId: edge.id });
        }
        if (!seen.has(target)) return undefined;
        const nodeIds = [target], relationIds: string[] = []; let cursor = target;
        while (previous.has(cursor)) { const step = previous.get(cursor)!; nodeIds.unshift(step.nodeId); relationIds.unshift(step.relationId); cursor = step.nodeId; }
        return { nodeId: target, nodeIds, relationIds, depth: relationIds.length };
      };
      // The selected barrel's provenance and its origin are both explicit starting points.
      for (const candidate of resolution.candidates) if (candidate.fileId !== query.fileId) {
        const path = await provenancePath(candidate.fileId, candidate.relationIds);
        if (path) queue.push({ fileId: candidate.fileId, name: candidate.name, namespace: query.namespace, nodeIds: path.nodeIds, relationIds: path.relationIds });
        else scopeReasons.add('provenancePathMissing');
      }
      const seen = new Set<string>();
      for (let cursor = 0; cursor < queue.length && resolution.status === 'resolved' && !budget.stopped; cursor++) {
        const state = queue[cursor], key = JSON.stringify([state.fileId, state.name, state.namespace]);
        if (seen.has(key)) continue; seen.add(key);
        for (const edge of index.incoming.get(state.fileId) ?? []) {
          if (!await budget.check() || !budget.examine()) break;
          if (!importEdge(edge) && !(edge.kind === 'framework' && edge.symbolDependency && edge.certainty === 'confirmed')) continue;
          const occurrences = index.occurrences.get(edge.id) ?? [];
          const relevant = occurrences.filter(row => (row.imported === state.name || row.imported === '*') && !(state.namespace === 'value' && row.typeOnly));
          if (!relevant.length) {
            if (!occurrences.length && edge.bindings.some(binding => binding.imported === state.name || binding.imported === '*')) scopeReasons.add('unsupportedBinding');
            continue;
          }
          let accepted = false;
          for (const occurrence of relevant) {
            if (occurrence.imported === '*' && edge.kind === 'import') { scopeReasons.add('namespaceImport'); continue; }
            const entries = (index.symbols.exports.get(edge.sourceId) ?? []).filter(entry => entry.forwarded?.relationId === edge.id
              && (entry.kind === 'star' || entry.forwarded.imported === state.name)
              && !(state.namespace === 'value' && entry.namespace === 'type'));
            if (edge.kind === 'reexport' && !entries.length) { scopeReasons.add('unsupportedBinding'); continue; }
            for (const entry of entries) {
              const exported = entry.kind === 'star' ? state.name : entry.name;
              const next = await resolve(edge.sourceId, exported, state.namespace);
              if (next.status !== 'resolved' || !next.candidates.some(candidate => selected.has(endpoint(candidate)))) {
                for (const reason of next.reasonCodes) scopeReasons.add(reason);
                scopeReasons.add(next.status === 'ambiguous' ? 'ambiguousConsumerExport' : 'partialConsumerExport'); continue;
              }
              accepted = true;
              queue.push({ fileId: edge.sourceId, name: exported, namespace: state.namespace,
                nodeIds: [...state.nodeIds, edge.sourceId], relationIds: [...state.relationIds, edge.id] });
            }
            if ((edge.kind === 'import' || edge.symbolDependency) && occurrence.imported === state.name) accepted = true;
          }
          if (!accepted || !include(edge.sourceId) || !include(edge.targetId)) continue;
          visibleRelations.add(edge.id);
          if (!witnesses.some(path => path.nodeId === edge.sourceId)) witnesses.push({ nodeId: edge.sourceId, nodeIds: [...state.nodeIds, edge.sourceId], relationIds: [...state.relationIds, edge.id], depth: state.relationIds.length + 1 });
        }
      }
      if (resolution.status === 'ambiguous') scopeReasons.add('ambiguousExport');
      nodeIds = [...visibleNodes]; relationIds = [...visibleRelations];
      for (const reason of index.reasons(budget.visited, true, true)) scopeReasons.add(reason);
    } else {
      const pathQuery = query.kind === 'path';
      const incoming = query.kind === 'impact' || query.kind === 'neighbourhood' && query.direction === 'incoming';
      const maxDepth = pathQuery ? Infinity : query.depth;
      const queue: { id: string; depth: number }[] = [];
      const predecessors = new Map<string, { previous: string; relationId: string }>();
      const discoveredRelations = new Set<string>();
      const roots = pathQuery ? [query.fromId] : seeds;
      for (const id of roots) if (budget.visit(id)) queue.push({ id, depth: 0 });
      let found = pathQuery && query.fromId === query.toId;
      const policy = (edge: Relation) => query.kind === 'impact' ? (query.includeInferred || edge.certainty === 'confirmed') && (query.includeTypes || !pureType(edge))
        : query.kind === 'path' ? (query.includeInferred || edge.certainty === 'confirmed') && (query.mode === 'all' || edge.kind === 'import' || edge.kind === 'reexport') : true;
      for (let cursor = 0; cursor < queue.length && !budget.stopped && !found; cursor++) {
        const item = queue[cursor], edges = (incoming ? index.incoming : index.outgoing).get(item.id) ?? [];
        for (const edge of edges) {
          if (!await budget.check() || !budget.examine()) break;
          if (!policy(edge)) continue;
          const target = incoming ? edge.sourceId : edge.targetId;
          if (!index.nodes.has(target)) { scopeReasons.add('missingTarget'); continue; }
          if (item.depth >= maxDepth) {
            if (!budget.visited.has(target)) scopeReasons.add('depthLimit');
            continue;
          }
          if (!budget.visit(target)) break;
          discoveredRelations.add(edge.id);
          if (!roots.includes(target) && !predecessors.has(target)) {
            predecessors.set(target, { previous: item.id, relationId: edge.id }); queue.push({ id: target, depth: item.depth + 1 });
          }
          if (pathQuery && target === query.toId) { found = true; break; }
        }
      }
      const witness = (id: string): EvidencePath => {
        const nodes = [id], relations: string[] = []; let cursor = id;
        while (predecessors.has(cursor)) { const step = predecessors.get(cursor)!; relations.unshift(step.relationId); nodes.unshift(step.previous); cursor = step.previous; }
        return { nodeId: id, nodeIds: nodes, relationIds: relations, depth: relations.length };
      };
      for (const reason of index.reasons(budget.visited, incoming, query.kind !== 'path' || query.mode === 'all')) scopeReasons.add(reason);
      if (pathQuery) {
        if (found) { const path = witness(query.toId); witnesses.push(path); nodeIds = path.nodeIds; relationIds = path.relationIds; outcome = 'found'; }
      } else {
        nodeIds = [...budget.visited]; relationIds = [...discoveredRelations];
        for (const id of budget.visited) {
          if (seeds.includes(id)) continue;
          const path = witness(id); witnesses.push(path);
          if (query.kind === 'impact') {
            (path.depth === 1 ? directIds : indirectIds).push(id);
            if (index.nodes.get(id)?.role === 'test') testIds.push(id);
          }
        }
        if (nodeIds.some(id => !seeds.includes(id))) outcome = 'found';
      }
    }
  }
  const reasonCodes = [...new Set([...scopeReasons, ...budget.reasons])];
  const limited = reasonCodes.some(reason => ['nodeLimit', 'relationLimit', 'deadlineLimit', 'depthLimit'].includes(reason));
  if (outcome !== 'found') outcome = limited ? 'notFoundWithinLimits' : reasonCodes.length ? 'unknown' : 'notFoundWithinScope';
  const operation = budget.reasons.has('cancelled') ? 'cancelled' as const : 'success' as const;
  const coverage = operation === 'cancelled' || reasonCodes.length ? 'partial' as const : 'complete' as const;
  const base = { type: 'queryResult' as const, requestId: request.requestId, graph: request.graph, operation,
    coverage: missing.length ? 'unknown' as const : coverage, freshness: 'current' as const, reasonCodes, limits: request.limits,
    visitedNodes: budget.visited.size, examinedRelations: budget.examined, nodeIds, relationIds, witnesses,
    queryScopeSignature: scopeSignature(request.scope),
    ...(request.gitRevision === undefined ? {} : { gitRevision: request.gitRevision }) };
  if (query.kind === 'impact') return { ...base, kind: 'impact', outcome, directIds, indirectIds, testIds };
  if (query.kind === 'symbol') return { ...base, kind: 'symbol', outcome: resolution.status, resolution };
  return { ...base, kind: query.kind, outcome };
}
