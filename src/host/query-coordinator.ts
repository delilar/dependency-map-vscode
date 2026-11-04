import { randomUUID } from 'node:crypto';
import { graphHasQuerySeeds, queryLimits, querySeeds, sameIndex, type ActiveQuery, type IndexState, type QueryRequest, type QueryResult, type QuerySpec } from '../shared/query-model';
import type { GraphSnapshot } from '../shared/model';
import { inScope, scopeSignature, type ScopeSpec } from '../shared/scope';

/** One active analytical intent; branches have independent requests owned by the session. */
export class QueryCoordinator {
  active?: ActiveQuery;
  start(query: QuerySpec, index: IndexState, graph: GraphSnapshot, gitRevision?: number, scope?: ScopeSpec): QueryRequest | undefined {
    if (index.state !== 'ready' || !graphHasQuerySeeds(graph, query) || querySeeds(query).some(id => !inScope(graph.nodes.find(node => node.id === id), scope))) return undefined;
    const requestId = randomUUID();
    const previousResult = this.active?.result?.operation === 'success' ? this.active.result : this.active?.previousResult;
    this.active = { requestId, query, state: 'running', gitRevision, previousResult, queryScopeSignature: scopeSignature(scope) };
    return { type: 'query', apiVersion: 1, requestId, graph: { ...index.version }, query, limits: { ...queryLimits }, gitRevision, scope, queryScopeSignature: scopeSignature(scope) };
  }
  accept(result: QueryResult, index: IndexState, gitRevision?: number, scope?: ScopeSpec): boolean {
    if (!this.active || this.active.state !== 'running' || this.active.requestId !== result.requestId || index.state !== 'ready' || !sameIndex(result.graph, index.version)
      || (result.queryScopeSignature ?? 'all') !== scopeSignature(scope) || this.active.queryScopeSignature !== scopeSignature(scope)
      || this.active.gitRevision !== undefined && (gitRevision !== this.active.gitRevision || result.gitRevision !== this.active.gitRevision)) return false;
    this.active = { ...this.active, state: result.freshness === 'stale' ? 'stale' : result.operation === 'cancelled' ? 'cancelled' : result.operation === 'failed' ? 'failed' : 'ready', result };
    return true;
  }
  invalidate(): void {
    if (this.active) this.active = { ...this.active, state: 'stale', result: this.active.result ? { ...this.active.result, freshness: 'stale' } : undefined, previousResult: this.active.previousResult ? { ...this.active.previousResult, freshness: 'stale' } : undefined };
  }
  cancel(): void {
    if (this.active) this.active = { ...this.active, state: 'cancelled' };
  }
  clear(): void { this.active = undefined; }
}
