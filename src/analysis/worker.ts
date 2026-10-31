import { parentPort } from 'node:worker_threads';
import { AnalyzerSession } from './index';
import type { AnalyzeRequest, AnalysisReply } from '../shared/protocol';

if (!parentPort) throw new Error('Analysis worker requires a parent port');
const port = parentPort;
let latest = -1;
let session = new AnalyzerSession();
let queue = Promise.resolve();
port.on('message', (request: AnalyzeRequest) => {
  if (!request || request.type !== 'analyze' || !Number.isInteger(request.generation) || request.generation <= latest || !Array.isArray(request.roots) || !Array.isArray(request.overlays) || (request.changedPaths !== undefined && (!Array.isArray(request.changedPaths) || request.changedPaths.some(value => typeof value !== 'string')))) return;
  latest = request.generation;
  queue = queue.then(async () => {
    if (request.generation !== latest) return;
    const reply = (message: AnalysisReply) => { if (request.generation === latest) port.postMessage(message); };
    try {
      const graph = await session.analyze(request.roots, request.options, request.overlays, message => reply({ type: 'progress', generation: request.generation, message }), request.changedPaths);
      if (request.generation !== latest) { session = new AnalyzerSession(); return; }
      graph.revision = request.generation;
      reply({ type: 'snapshot', generation: request.generation, graph });
    } catch {
      session = new AnalyzerSession();
      reply({ type: 'error', generation: request.generation, message: 'Workspace analysis failed. Rebuild to retry; no project code was executed.' });
    }
  });
});
