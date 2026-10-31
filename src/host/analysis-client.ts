import { Worker } from 'node:worker_threads';
import type { AnalyzeRequest, WorkerReply } from '../shared/protocol';
import type { GraphSnapshot } from '../shared/model';
import { sameIndex, type BuildIdentity, type QueryRequest, type QueryResult } from '../shared/query-model';

interface PendingAnalysis {
  generation: number;
  progress: (message: string) => void;
  resolve: (graph: GraphSnapshot | undefined) => void;
  reject: (error: Error) => void;
}

export class AnalysisClient {
  private worker?: Worker;
  private generation = 0;
  private pending?: PendingAnalysis;
  private readonly queries = new Map<string, { request: QueryRequest; resolve: (result: QueryResult | undefined) => void }>();
  constructor(private readonly workerPath: string, private readonly onWorkerReady: (build: BuildIdentity | undefined) => void = () => {}) {}

  analyze(request: Omit<AnalyzeRequest, 'type' | 'generation'>, progress: (message: string) => void): Promise<GraphSnapshot | undefined> {
    this.cancel();
    const generation = this.generation;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.pending = { generation, resolve, reject, progress };
      worker.postMessage({ ...request, type: 'analyze', generation, ...(request.graphVersion ? { graphVersion: { ...request.graphVersion, revision: generation } } : {}) } satisfies AnalyzeRequest);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerPath);
    this.worker = worker;
    worker.on('message', (reply: WorkerReply) => {
      if (this.worker !== worker) return;
      if (reply.type === 'workerReady') { this.onWorkerReady(reply.build); return; }
      if (reply.type === 'queryResult') {
        const query = this.queries.get(reply.requestId);
        if (!query || !sameIndex(query.request.graph, reply.graph)) return;
        this.queries.delete(reply.requestId); query.resolve(reply); return;
      }
      const pending = this.pending;
      if (this.worker !== worker || !pending || reply.generation !== pending.generation) return;
      if (reply.type === 'progress') pending.progress(reply.message);
      if (reply.type === 'snapshot') {
        this.pending = undefined;
        pending.resolve({ ...reply.graph, revision: pending.generation });
      }
      if (reply.type === 'error') {
        this.pending = undefined;
        pending.reject(new Error(reply.message));
      }
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.cancelQueries();
      this.onWorkerReady(undefined);
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(new Error('Analysis worker stopped unexpectedly. Rebuild to retry.'));
    };
    worker.on('error', failed);
    worker.on('exit', failed);
    return worker;
  }

  cancel(): void {
    this.generation++;
    this.cancelQueries();
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(undefined);
    if (pending && this.worker) {
      const worker = this.worker;
      this.worker = undefined;
      void worker.terminate();
    }
  }

  query(request: QueryRequest): Promise<QueryResult | undefined> {
    if (!this.worker || this.pending || this.queries.size >= 201) return Promise.resolve(undefined);
    this.cancelQuery(request.requestId);
    const worker = this.worker;
    return new Promise(resolve => {
      this.queries.set(request.requestId, { request, resolve });
      try { worker.postMessage(request); }
      catch { this.queries.delete(request.requestId); resolve(undefined); }
    });
  }

  cancelQuery(requestId: string): void {
    const pending = this.queries.get(requestId);
    if (!pending) return;
    this.queries.delete(requestId);
    this.worker?.postMessage({ type: 'cancelQuery', requestId });
    pending.resolve(undefined);
  }

  cancelQueries(): void { for (const requestId of [...this.queries.keys()]) this.cancelQuery(requestId); }

  dispose(): void {
    this.cancel();
    if (this.worker) { void this.worker.terminate(); this.worker = undefined; }
  }
}
