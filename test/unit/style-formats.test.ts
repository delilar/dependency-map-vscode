import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractAdditionalStyles } from '../../src/analysis/style-formats';
import { analyzeWorkspace } from '../../src/analysis/index';

function paths(extension: string, text: string): string[] {
  const result = extractAdditionalStyles(`style${extension}`, text);
  assert.deepEqual(result.diagnostics, []);
  return result.references.flatMap(reference => reference.specifier ? [reference.specifier] : []).sort();
}

test('Less parser handles import options, comments, nested URLs and media conditions', () => {
  const source = '@import (reference) "./theme.less";\n@import url("./reset.css") screen;\n// @import "./comment.less";\n.a { background: url("./image.png"); mask: url(/icon.svg#mask); content: "url(./fake.svg)"; }';
  assert.deepEqual(paths('.less', source), ['./image.png', './reset.css', './theme.less', '/icon.svg#mask'].sort());
  const result = extractAdditionalStyles('style.less', source);
  assert.equal(result.references.find(reference => reference.specifier === './theme.less')?.evidence.range?.start.line, 0);
});

test('Less variables, interpolation and JavaScript values remain unresolved without execution', () => {
  const result = extractAdditionalStyles('style.less', '@theme: "./dark"; @import "@{theme}/main.less"; .a { mask: url(@icon); background: url(`"./computed.png"`); other: url(var(--asset)); }');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.references.length, 4);
  assert.ok(result.references.every(reference => reference.specifier === undefined && reference.reason?.includes('Computed')));
});

test('Stylus parser extracts quoted @import/@require and URL calls without evaluating use or functions', () => {
  const source = '@import "./base"\n@require "./theme.styl"\nuse("./must-not-execute.cjs")\n.a\n  background url("./image.png")\n  mask url("/icon.svg")\n  content "url(./fake.svg)"\n';
  assert.deepEqual(paths('.styl', source), ['./base', './theme.styl', './image.png', '/icon.svg'].sort());
});

test('Stylus dynamic imports, variable URLs and concatenation do not become confirmed files', () => {
  const result = extractAdditionalStyles('style.styl', 'theme = "./theme"\n@import theme\n.a\n  mask url(image)\n  background url("./" + name)\n');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.references.length, 3);
  assert.ok(result.references.every(reference => !reference.specifier && reference.reason));
});

test('unquoted Stylus URL paths are inferred, while locally bound path parts remain unresolved', () => {
  const result = extractAdditionalStyles('style.styl', 'icon = "other"\n.a\n  background url(images/background.png)\n  mask url(images/icon.svg)\n');
  assert.deepEqual(result.diagnostics, []);
  const inferred = result.references.find(reference => reference.specifier === 'images/background.png');
  assert.equal(inferred?.certainty, 'inferred');
  assert.ok(inferred?.evidence.rule.includes('imported bindings'));
  assert.ok(result.references.some(reference => !reference.specifier && reference.reason));
  assert.ok(!result.references.some(reference => reference.specifier === 'images/icon.svg'));
});

test('indented Sass uses the official parser for modules, imports, partial names and nested URLs', () => {
  const source = '@use "./tokens"\n@forward "../theme"\n@import "./legacy", "./more.css"\n.a\n  background: image-set(url("./a.png") 1x, url("./b.png") 2x)\n  mask: url(/icon.svg)\n  content: "url(./fake.svg)"\n';
  assert.deepEqual(paths('.sass', source), ['tokens', '../theme', './legacy', './more.css', './a.png', './b.png', '/icon.svg'].sort());
});

test('indented Sass variables and interpolation remain unresolved and loops are not executed', () => {
  const source = '$icon: "./dynamic.svg"\n.a\n  mask: url($icon)\n  background: url("./#{$icon}.svg")\n@while true\n  .never-compiled\n    color: red\n';
  const result = extractAdditionalStyles('style.sass', source);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.references.length, 2);
  assert.ok(result.references.every(reference => !reference.specifier && reference.reason));
});

test('external URLs, built-in Sass modules, fragments and data URLs are not local dependencies', () => {
  assert.deepEqual(paths('.less', '@import url("https://example.test/theme.css"); .a { mask:url(#icon); background:url(data:image/png;base64,AAAA); }'), []);
  assert.deepEqual(paths('.styl', '@import "https://example.test/theme.css"\n.a\n  mask url("#icon")\n'), []);
  assert.deepEqual(paths('.sass', '@use "sass:color"\n.a\n  mask: url("#icon")\n  background: url("data:image/png;base64,AAAA")\n'), []);
});

test('parser failures are sanitized and never expose source snippets', () => {
  for (const [extension, source] of [
    ['.less', '.a { mask: url("SECRET_STYLE_SENTINEL'],
    ['.styl', '@import "SECRET_STYLE_SENTINEL'],
    ['.sass', '.a\n  mask: url("SECRET_STYLE_SENTINEL']
  ]) {
    const result = extractAdditionalStyles(`style${extension}`, source);
    assert.ok(result.diagnostics.some(message => message.includes('parse error')), `${extension} reports parse failure`);
    assert.ok(!JSON.stringify(result).includes('SECRET_STYLE_SENTINEL'));
  }
});

test('bundled Sass parser is not disabled by the previous Node 20 version gate', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
  try {
    Object.defineProperty(process.versions, 'node', { value: '18.20.0', configurable: true });
    const result = extractAdditionalStyles('style.sass', '@use "./tokens"\n');
    assert.equal(result.references[0]?.specifier, 'tokens');
    assert.deepEqual(result.diagnostics, []);
  } finally { Object.defineProperty(process.versions, 'node', descriptor); }
});

test('workspace index resolves new stylesheet imports, Sass partials and static assets and retains inferred certainty', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-map-style-formats-'));
  try {
    const entries = {
      'main.less': '@import (reference) "./tokens.less"; .a { mask: url("./icon.svg"); }',
      'tokens.less': '@color: red;',
      'main.sass': '@use "./palette"\n.a\n  mask: url("./icon.svg")\n  background: url($dynamic)\n',
      '_palette.sass': '$color: red\n',
      'main.styl': '@require "./shared.styl"\n.a\n  mask url("./icon.svg")\n  background url(images/background.png)\n',
      'shared.styl': 'color = red\n',
      'icon.svg': '<svg/>',
      'images/background.png': 'binary-placeholder'
    };
    for (const [relative, text] of Object.entries(entries)) {
      const file = path.join(directory, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    }
    const graph = await analyzeWorkspace([{ id: 'styles', name: 'styles', path: directory }], { exclude: [] }, []);
    const filePath = (id: string) => graph.nodes.find(node => node.id === id)?.file?.path;
    const targets = (source: string) => graph.relations.filter(edge => filePath(edge.sourceId) === source).map(edge => filePath(edge.targetId)).sort();
    assert.deepEqual(targets('main.less'), ['icon.svg', 'tokens.less']);
    assert.deepEqual(targets('main.sass'), ['_palette.sass', 'icon.svg']);
    assert.deepEqual(targets('main.styl'), ['icon.svg', 'images/background.png', 'shared.styl']);
    assert.equal(graph.relations.find(edge => edge.specifier === 'images/background.png')?.certainty, 'inferred');
    assert.ok(graph.unresolved.some(reference => filePath(reference.sourceId) === 'main.sass' && reference.reason.includes('Computed')));
    assert.ok(!graph.diagnostics.some(diagnostic => /parse error|not implemented/.test(diagnostic.message)));
  } finally {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('dependency-map-style-formats-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
