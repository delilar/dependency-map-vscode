import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeWorkspace, AnalyzerSession, WorkspaceFiles } from '../../src/analysis/index';
import type { GraphSnapshot } from '../../src/shared/model';

function comparable(graph: GraphSnapshot): unknown {
  const sorted = <T>(values: T[]) => [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { nodes: sorted(graph.nodes), relations: sorted(graph.relations), unresolved: sorted(graph.unresolved), diagnostics: sorted(graph.diagnostics), declarations: sorted(graph.declarations ?? []) };
}

test('partial directory inventory keeps physical casing through creation and case-only rename', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-analysis-dir-'));
  const roots = [{ id: 'root', name: 'fixture', path: directory }];
  try {
    fs.mkdirSync(path.join(directory, 'src'));
    fs.writeFileSync(path.join(directory, 'src/main.ts'), 'import {Card} from "./Components/Card";');
    const session = new AnalyzerSession();
    await session.analyze(roots, { exclude: [] }, []);
    const components = path.join(directory, 'src/Components');
    fs.mkdirSync(components);
    fs.writeFileSync(path.join(components, 'Card.tsx'), 'export const Card = () => null;');
    let incremental = await session.analyze(roots, { exclude: [] }, [], undefined, [components]);
    assert(incremental.nodes.some(node => node.file?.path === 'src/Components/Card.tsx'));
    assert.deepEqual(comparable(incremental), comparable(await analyzeWorkspace(roots, { exclude: [] }, [])));
    const renamed = path.join(directory, 'src/components');
    fs.renameSync(components, renamed);
    incremental = await session.analyze(roots, { exclude: [] }, [], undefined, [components, renamed]);
    assert(incremental.nodes.some(node => node.file?.path === 'src/components/Card.tsx'));
    assert.deepEqual(comparable(incremental), comparable(await analyzeWorkspace(roots, { exclude: [] }, [])));

    const inventory = new WorkspaceFiles(roots, [], []); inventory.scan();
    fs.writeFileSync(path.join(renamed, 'useCard.ts'), 'export function useCard() {}');
    const overlayPath = process.platform === 'win32' ? path.join(renamed, 'useCard.ts').toLowerCase() : path.join(renamed, 'useCard.ts');
    inventory.updateOverlays([{ path: overlayPath, text: 'export function useCard() {}', version: 1 }]); inventory.update([]);
    assert([...inventory.files.values()].some(entry => path.relative(directory, entry.path).replace(/\\/g, '/') === 'src/components/useCard.ts'));
  } finally {
    const resolved = path.resolve(directory), relative = path.relative(path.resolve(os.tmpdir()), resolved);
    assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && path.basename(resolved).startsWith('dependency-map-analysis-dir-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
