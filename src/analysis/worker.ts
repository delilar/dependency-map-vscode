import { parentPort } from 'node:worker_threads';
import { AnalyzerSession } from './index';
import type { AnalyzeRequest, AnalysisReply, WorkerRequest } from '../shared/protocol';
import { buildInfo } from '../shared/build-info';
import { isQueryRequest, sameIndex, type IndexVersion, type QueryRequest, type QueryResult } from '../shared/query-model';
import { GraphQueryIndex } from './graph-query-index';
import { executeQuery } from './graph-queries';
import { scopeSignature } from '../shared/scope';

if (!parentPort) throw new Error('Analysis worker requires a parent port');
const port = parentPort;
let latest = -1;
let session = new AnalyzerSession();
let queue = Promise.resolve();
let published: { index: GraphQueryIndex; version: IndexVersion } | undefined;
const queries = new Map<string, { cancelled: boolean }>();
port.postMessage({ type: 'workerReady', build: buildInfo });
function unavailable(request: QueryRequest, reason: string): QueryResult {
  const common = { type: 'queryResult' as const, requestId: request.requestId, graph: request.graph, operation: 'failed' as const, coverage: 'unknown' as const, freshness: 'stale' as const, reasonCodes: [reason], limits: request.limits, visitedNodes: 0, examinedRelations: 0, nodeIds: [], relationIds: [], witnesses: [], gitRevision: request.gitRevision, queryScopeSignature: scopeSignature(request.scope) };
  switch (request.query.kind) {
    case 'impact': return { ...common, kind: 'impact', outcome: 'unknown', directIds: [], indirectIds: [], testIds: [] };
    case 'symbol': return { ...common, kind: 'symbol', outcome: 'unresolved', resolution: { status: 'unresolved', reasonCodes: [reason], candidates: [] } };
    default: return { ...common, kind: request.query.kind, outcome: 'unknown' };
  }
}
port.on('message', (request: WorkerRequest) => {
  if (request?.type === 'cancelQuery') { const token = queries.get(request.requestId); if (token) token.cancelled = true; return; }
  if (request?.type === 'query') {
    if (!isQueryRequest(request)) return;
    if (queries.size >= 201 || queries.has(request.requestId)) { port.postMessage(unavailable(request, 'queryQueueLimit')); return; }
    const token = { cancelled: false }; queries.set(request.requestId, token);
    queue = queue.then(async () => {
      try {
        if (token.cancelled) return;
        if (!published || !sameIndex(published.version, request.graph)) { port.postMessage(unavailable(request, 'indexVersionMismatch')); return; }
        const result = await executeQuery(published.index, request, () => token.cancelled);
        if (!token.cancelled) port.postMessage(result);
      } catch { port.postMessage({ ...unavailable(request, 'queryFailed'), operation: 'failed' }); }
      finally { queries.delete(request.requestId); }
    });
    return;
  }
  if (!request || request.type !== 'analyze' || !Number.isInteger(request.generation) || request.generation <= latest || !Array.isArray(request.roots) || !Array.isArray(request.overlays) || (request.changedPaths !== undefined && (!Array.isArray(request.changedPaths) || request.changedPaths.some(value => typeof value !== 'string')))) return;
  latest = request.generation;
  published = undefined;
  for (const token of queries.values()) token.cancelled = true;
  queue = queue.then(async () => {
    if (request.generation !== latest) return;
    const reply = (message: AnalysisReply) => { if (request.generation === latest) port.postMessage(message); };
    try {
      const graph = await session.analyze(request.roots, request.options, request.overlays, message => reply({ type: 'progress', generation: request.generation, message }), request.changedPaths);
      if (request.generation !== latest) { session = new AnalyzerSession(); return; }
      graph.revision = request.generation;
      published = { index: new GraphQueryIndex(graph), version: request.graphVersion ?? { epoch: 'legacy', revision: graph.revision, scopeRevision: 0 } };
      reply({ type: 'snapshot', generation: request.generation, graph });
    } catch {
      session = new AnalyzerSession();
      reply({ type: 'error', generation: request.generation, message: 'Workspace analysis failed. Rebuild to retry; no project code was executed.' });
    }
  });
});
