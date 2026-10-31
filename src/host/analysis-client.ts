import { Worker } from 'node:worker_threads';
import type { AnalyzeRequest, AnalysisReply } from '../shared/protocol';
import type { GraphSnapshot } from '../shared/model';

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
  constructor(private readonly workerPath: string) {}

  analyze(request: Omit<AnalyzeRequest, 'type' | 'generation'>, progress: (message: string) => void): Promise<GraphSnapshot | undefined> {
    this.cancel();
    const generation = this.generation;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.pending = { generation, resolve, reject, progress };
      worker.postMessage({ ...request, type: 'analyze', generation } satisfies AnalyzeRequest);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerPath);
    this.worker = worker;
    worker.on('message', (reply: AnalysisReply) => {
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
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(undefined);
    if (pending && this.worker) {
      const worker = this.worker;
      this.worker = undefined;
      void worker.terminate();
    }
  }

  dispose(): void {
    this.cancel();
    if (this.worker) { void this.worker.terminate(); this.worker = undefined; }
  }
}
