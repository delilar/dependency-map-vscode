import { randomUUID } from 'node:crypto';
import { graphHasQuerySeeds, queryLimits, sameIndex, type ActiveQuery, type IndexState, type QueryRequest, type QueryResult, type QuerySpec } from '../shared/query-model';
import type { GraphSnapshot } from '../shared/model';

/** One active analytical intent; branches have independent requests owned by the session. */
export class QueryCoordinator {
  active?: ActiveQuery;
  start(query: QuerySpec, index: IndexState, graph: GraphSnapshot, gitRevision?: number): QueryRequest | undefined {
    if (index.state !== 'ready' || !graphHasQuerySeeds(graph, query)) return undefined;
    const requestId = randomUUID();
    const previousResult = this.active?.result?.operation === 'success' ? this.active.result : this.active?.previousResult;
    this.active = { requestId, query, state: 'running', gitRevision, previousResult };
    return { type: 'query', apiVersion: 1, requestId, graph: { ...index.version }, query, limits: { ...queryLimits }, gitRevision };
  }
  accept(result: QueryResult, index: IndexState, gitRevision?: number): boolean {
    if (!this.active || this.active.state !== 'running' || this.active.requestId !== result.requestId || index.state !== 'ready' || !sameIndex(result.graph, index.version)
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
