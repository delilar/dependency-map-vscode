import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Worker } from 'node:worker_threads';
import { AnalysisClient } from '../../src/host/analysis-client';

const workerSource = `
const { parentPort, threadId } = require('node:worker_threads');
let count = 0;
parentPort.on('message', request => {
  count++;
  const generation = request.generation;
  const command = request.options.exclude[0];
  const graph = {
    revision: -1,
    nodes: [{ id: 'probe', label: threadId + ':' + count, kind: 'external', projectId: 'probe', format: 'package' }],
    relations: [], unresolved: [], diagnostics: [],
    stats: { files: count, relations: 0, elapsedMs: 0 }
  };
  if (command === 'crash') throw new Error('Synthetic worker crash');
  if (command === 'error') return parentPort.postMessage({ type: 'error', generation, message: 'Synthetic analysis error' });
  if (command === 'hold') return parentPort.postMessage({ type: 'progress', generation, message: 'ready' });
  if (command === 'stale') {
    parentPort.postMessage({ type: 'progress', generation: generation - 1, message: 'stale progress' });
    parentPort.postMessage({ type: 'snapshot', generation: generation - 1, graph: { ...graph, nodes: [] } });
    parentPort.postMessage({ type: 'progress', generation, message: 'current progress' });
    return setTimeout(() => parentPort.postMessage({ type: 'snapshot', generation, graph }), 20);
  }
  parentPort.postMessage({ type: 'snapshot', generation, graph });
});
`;

const request = (command = 'success') => ({ roots: [], overlays: [], options: { exclude: [command] } });
async function withClient(run: (client: AnalysisClient) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dependency-map-worker-'));
  const workerPath = path.join(directory, 'worker.cjs');
  await writeFile(workerPath, workerSource);
  const client = new AnalysisClient(workerPath);
  try { await run(client); }
  finally { client.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
}

test('successful analyses reuse the real worker and assign increasing graph revisions', { timeout: 5000 }, async () => {
  await withClient(async client => {
    const first = await client.analyze(request(), () => {});
    const second = await client.analyze(request(), () => {});
    assert.ok(first && second);
    const [firstThread, firstCount] = first.nodes[0].label.split(':');
    const [secondThread, secondCount] = second.nodes[0].label.split(':');
    assert.equal(firstThread, secondThread, 'worker persists across completed requests');
    assert.equal(firstCount, '1');
    assert.equal(secondCount, '2');
    assert.ok(second.revision > first.revision);
  });
});

test('cancel settles a pending analysis and the next request gets a fresh worker', { timeout: 5000 }, async () => {
  await withClient(async client => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const pending = client.analyze(request('hold'), message => { if (message === 'ready') ready(); });
    await started;
    client.cancel();
    assert.equal(await pending, undefined);
    const next = await client.analyze(request(), () => {});
    assert.ok(next);
    assert.equal(next.stats.files, 1, 'cancelled worker state is not reused');
  });
});

test('a superseding request settles the previous promise without replacing its result with a late generation', { timeout: 5000 }, async () => {
  await withClient(async client => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const previous = client.analyze(request('hold'), () => ready());
    await started;
    const progress: string[] = [];
    const current = client.analyze(request('stale'), message => progress.push(message));
    assert.equal(await previous, undefined);
    const graph = await current;
    assert.ok(graph);
    assert.equal(graph.nodes.length, 1, 'stale snapshot with empty nodes is ignored');
    assert.deepEqual(progress, ['current progress']);
  });
});

test('worker crash rejects the pending request and permits a retry', { timeout: 5000 }, async () => {
  await withClient(async client => {
    await assert.rejects(client.analyze(request('crash'), () => {}), /worker stopped unexpectedly/i);
    const graph = await client.analyze(request(), () => {});
    assert.ok(graph);
    assert.equal(graph.stats.files, 1);
  });
});

test('analysis error rejects only that request and leaves the worker reusable', { timeout: 5000 }, async () => {
  await withClient(async client => {
    await assert.rejects(client.analyze(request('error'), () => {}), /Synthetic analysis error/);
    const graph = await client.analyze(request(), () => {});
    assert.ok(graph);
    assert.equal(graph.stats.files, 2, 'healthy worker survives a reported analysis failure');
  });
});

test('dispose settles active work and actually terminates its worker', { timeout: 5000 }, async () => {
  await withClient(async client => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const pending = client.analyze(request('hold'), () => ready());
    await started;
    const worker = Reflect.get(client, 'worker') as Worker | undefined;
    assert.ok(worker, 'fixture has a live worker');
    const exited = once(worker, 'exit');
    client.dispose();
    assert.equal(await pending, undefined);
    await exited;
    assert.equal(worker.threadId, -1);
  });
});

test('dispose also terminates an idle reusable worker', { timeout: 5000 }, async () => {
  await withClient(async client => {
    await client.analyze(request(), () => {});
    const worker = Reflect.get(client, 'worker') as Worker | undefined;
    assert.ok(worker, 'completed request retained its worker');
    const exited = once(worker, 'exit');
    client.dispose();
    await exited;
    assert.equal(worker.threadId, -1);
  });
});
