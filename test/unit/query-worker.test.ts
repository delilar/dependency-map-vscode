import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnalysisClient } from '../../src/host/analysis-client';
import { queryLimits, type QueryRequest } from '../../src/shared/query-model';

test('query cancellation settles without terminating the reusable analysis worker; late reply is ignored', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-map-query-worker-'));
  const worker = path.join(directory, 'worker.cjs');
  await fs.writeFile(worker, `const {parentPort,threadId}=require('node:worker_threads'); let runs=0;
    parentPort.on('message',r=> {
      if(r.type==='cancelQuery') return;
      if(r.type==='analyze') {runs++; parentPort.postMessage({type:'snapshot',generation:r.generation,graph:{revision:0,nodes:[],relations:[],unresolved:[],diagnostics:[],stats:{files:runs,relations:0,elapsedMs:threadId}}});return;}
      setTimeout(()=>parentPort.postMessage({type:'queryResult',requestId:r.requestId,graph:r.graph,kind:'path',operation:'success',coverage:'complete',freshness:'current',reasonCodes:[],limits:r.limits,visitedNodes:1,examinedRelations:0,nodeIds:[],relationIds:[],witnesses:[],outcome:'found'}),30);
    });`);
  const client = new AnalysisClient(worker);
  try {
    const graph = await client.analyze({ roots: [], options: { exclude: [] }, overlays: [] }, () => {});
    const request: QueryRequest = { type: 'query', apiVersion: 1, requestId: 'old', graph: { epoch: 'a', revision: graph!.revision, scopeRevision: 1 }, query: { kind: 'path', fromId: 'a', toId: 'a' }, limits: queryLimits };
    const old = client.query(request); client.cancelQuery('old'); assert.equal(await old, undefined);
    const result = await client.query({ ...request, requestId: 'new' }); assert.equal(result?.requestId, 'new');
    const next = await client.analyze({ roots: [], options: { exclude: [] }, overlays: [] }, () => {});
    assert.equal(next?.stats.files, 2); assert.equal(next?.stats.elapsedMs, graph?.stats.elapsedMs);
    const pending = client.query({ ...request, requestId: 'disposed', graph: { ...request.graph, revision: next!.revision } });
    client.dispose(); assert.equal(await pending, undefined);
  } finally { client.dispose(); const rel=path.relative(os.tmpdir(),directory); assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); await fs.rm(directory,{recursive:true,force:true}); }
});
