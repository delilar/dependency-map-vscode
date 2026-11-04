import type { GraphSnapshot, Relation } from '../shared/model';
import { exportTables } from './export-resolution';

/** Derived tables belong to one published snapshot; no presentation filters enter this index. */
export class GraphQueryIndex {
  readonly nodes: Map<string, GraphSnapshot['nodes'][number]>;
  readonly relations: Map<string, Relation>;
  readonly incoming = new Map<string, Relation[]>();
  readonly outgoing = new Map<string, Relation[]>();
  readonly occurrences = new Map<string, NonNullable<GraphSnapshot['bindingOccurrences']>>();
  readonly symbols;
  private readonly unresolved = new Map<string, number>();
  private readonly baseReasons = new Set<string>();
  private readonly incomingReasons: string[];
  constructor(readonly graph: GraphSnapshot) {
    this.nodes = new Map(graph.nodes.map(node => [node.id, node]));
    this.relations = new Map(graph.relations.map(edge => [edge.id, edge]));
    for (const edge of graph.relations) {
      const incoming = this.incoming.get(edge.targetId) ?? []; incoming.push(edge); this.incoming.set(edge.targetId, incoming);
      const outgoing = this.outgoing.get(edge.sourceId) ?? []; outgoing.push(edge); this.outgoing.set(edge.sourceId, outgoing);
    }
    for (const adjacency of [this.incoming, this.outgoing]) for (const edges of adjacency.values()) edges.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const occurrence of graph.bindingOccurrences ?? []) {
      const rows = this.occurrences.get(occurrence.relationId) ?? []; rows.push(occurrence); this.occurrences.set(occurrence.relationId, rows);
    }
    for (const reference of graph.unresolved) this.unresolved.set(reference.sourceId, (this.unresolved.get(reference.sourceId) ?? 0) + 1);
    this.symbols = exportTables(graph);
    for (const reason of graph.coverageReasons ?? []) this.baseReasons.add(reason);
    if (graph.diagnostics.some(item => !item.fileId)) this.baseReasons.add('configurationDiagnostic');
    this.incomingReasons = this.scopedReasons(this.nodes.keys());
  }
  reasons(scope: Iterable<string>, incoming: boolean, includeFramework = false): string[] {
    const reasons = incoming ? this.incomingReasons : this.scopedReasons(scope);
    return includeFramework ? reasons : reasons.filter(reason => !['frameworkLimited', 'frameworkScopeBoundary'].includes(reason));
  }
  private scopedReasons(scope: Iterable<string>): string[] {
    const reasons = new Set(this.baseReasons);
    for (const id of scope) {
      const node = this.nodes.get(id); if (!node?.file) continue;
      const coverage = this.symbols.coverage.get(id);
      if (!coverage) reasons.add('coverageUnavailable');
      else {
        if (coverage.status === 'failed' || coverage.status === 'skipped') for (const reason of coverage.reasonCodes) reasons.add(reason);
        for (const reason of coverage.reasonCodes) if (['parseDiagnostic', 'configurationDiagnostic', 'unsupportedInternalReferences', 'formatUnavailable', 'unresolvedReference', 'frameworkLimited'].includes(reason)) reasons.add(reason);
      }
      if (this.unresolved.has(id)) reasons.add('unresolvedReference');
    }
    return [...reasons];
  }
}
