import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySourceResult, mergeSourceRegion, sourceRange } from '../../src/analysis/result-utils';
import { extractJavascript } from '../../src/analysis/javascript';

test('embedded ranges preserve UTF-16, CRLF, aliases and immutable parser output', () => {
  const prefix = '<!-- 😀 -->\r\n<script>\r\n';
  const source = 'import {run as go} from "./logic";\r\nexport const value = go;';
  const part = extractJavascript('block.ts', source);
  const original = JSON.stringify(part);
  const result = emptySourceResult();
  mergeSourceRegion(result, part, prefix + source + '</script>', prefix.length);
  assert.equal(result.references[0].evidence.range!.start.line, 2);
  assert.equal(result.exports[0].range.start.line, 3);
  assert.equal(JSON.stringify(part), original);
  assert.deepEqual(sourceRange('😀x\r\ny', 2, 6), { start: { line: 0, character: 2 }, end: { line: 1, character: 1 } });
  const setup = emptySourceResult();
  mergeSourceRegion(setup, part, source, 0, { exports: false });
  assert.equal(setup.exports.length, 0);
  assert.equal(setup.references.length, 1);
});
