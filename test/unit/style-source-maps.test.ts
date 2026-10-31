import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('stylesheet parsers never probe or load source maps named by input comments', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-map-source-maps-'));
  const app = path.join(directory, 'app'); fs.mkdirSync(app);
  const maps = [path.join(directory, 'outside.map'), path.join(app, 'inside.map')];
  const mapContents = JSON.stringify({ version: 3, sources: ['private.ts'], names: [], mappings: '', sourcesContent: ['PRIVATE_SOURCE_MAP_SENTINEL'] });
  for (const map of maps) fs.writeFileSync(map, mapContents);
  const probes: string[] = [];
  const record = (file: unknown) => { if (maps.includes(path.resolve(String(file)))) probes.push(String(file)); };
  const read = fs.readFileSync; const exists = fs.existsSync;
  context.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => { record(args[0]); return read(...args); });
  context.mock.method(fs, 'existsSync', (...args: Parameters<typeof fs.existsSync>) => { record(args[0]); return exists(...args); });
  try {
    // Import after the spies: PostCSS captures fs functions when its module loads.
    const { extractResources } = require('../../src/analysis/resources') as typeof import('../../src/analysis/resources');
    for (const extension of ['css', 'scss', 'less', 'sass']) for (const reference of ['inside.map', '../outside.map']) {
      const source = extension === 'sass' ? `/*# sourceMappingURL=${reference} */\n.a\n  color: red\n`
        : `.a { color: red; }\n/*# sourceMappingURL=${reference} */`;
      const result = extractResources(path.join(app, `style.${extension}`), source);
      assert.deepEqual(result.diagnostics, [], extension);
      assert.ok(!JSON.stringify(result).includes('PRIVATE_SOURCE_MAP_SENTINEL'));
    }
    assert.deepEqual(probes, [], 'source map comments must not trigger filesystem access');
  } finally {
    const relative = path.relative(os.tmpdir(), directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-source-maps-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
