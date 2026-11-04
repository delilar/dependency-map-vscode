import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDocument, extractEmbeddedGraphQL } from '../../src/analysis/documents';

test('Markdown resolves local links and reference images without treating code fences as imports', async () => {
  const text = '# Guide\n\n[Component](./Card.vue#props)\n\n![Logo][brand]\n\n[brand]: ./logo.svg\n\n```js\nimport Nope from "./never.ts";\n```\n\n[remote](https://example.com)\n';
  const result = (await extractDocument('guide.md', text))!;
  assert.deepEqual(result.references.map(row => row.specifier).sort(), ['./Card.vue#props', './logo.svg']);
  assert.equal(result.exports.length, 0);
  assert(result.references.every(row => row.evidence.range));
  assert.equal(result.diagnostics.length, 0);
});

test('embedded GraphQL uses value bindings and physical ranges, excluding shadowed tags', async () => {
  const text = 'import {gql as q} from "@apollo/client";\nconst doc=q`fragment User on User {id}`;\nfunction other(q){return q`fragment Hidden on User {name}`;}';
  const result = await extractEmbeddedGraphQL('query.ts', text);
  assert.deepEqual(result.graphql?.definitions.map(item => item.name), ['User']);
  assert.equal(result.graphql?.definitions[0].range.start.line, 1);
  const markdown = (await extractDocument('page.md', '---\nlayout: ../layouts/Main.astro\n---\n\n<img src="./image.svg">'))!;
  assert.equal(markdown.layout, '../layouts/Main.astro');
  assert(markdown.references.some(reference => reference.specifier === './image.svg'));
});

test('MDX preserves ESM provenance, component use, document default and physical ranges', async () => {
  const text = 'import Card from "./Card.vue";\r\nexport { value as answer } from "./logic.ts";\r\n\r\n# Привет 😀\r\n\r\n<Card image="./cover.png" />\r\n\r\n![Logo](./logo.svg)\r\n';
  const result = (await extractDocument('page.mdx', text))!;
  assert(result.references.some(row => row.kind === 'import' && row.specifier === './Card.vue'));
  assert(result.references.some(row => row.kind === 'reexport' && row.specifier === './logic.ts'));
  assert(result.references.some(row => row.specifier === './logo.svg'));
  assert(result.exports.some(row => row.name === 'default'));
  assert(result.exports.some(row => row.name === 'answer' && row.forwarded?.imported === 'value'));
  const template = result.references.find(row => row.evidence.rule.includes('component') && row.specifier === './Card.vue');
  assert(template);
  assert.equal(template.evidence.range?.start.line, 5);
  assert.equal(result.diagnostics.length, 0);
});

test('MDX expressions are parsed but never evaluated and code fences stay documentation', async () => {
  const text = 'export const value = (() => { throw new Error("never execute"); })();\n\n```js\nimport Wrong from "./wrong.ts"\n```\n\n<img src={"./asset.svg"} />\n';
  const result = (await extractDocument('page.mdx', text))!;
  assert(result.exports.some(row => row.name === 'value'));
  assert(result.references.some(row => row.specifier === './asset.svg'));
  assert(!result.references.some(row => row.specifier === './wrong.ts'));
});

test('MDX module blocks share imported bindings across Markdown paragraphs', async () => {
  const result = (await extractDocument('page.mdx', 'import Card from "./Card.vue";\n\n# Heading\n\nexport { Card as Special };\n'))!;
  const forwarded = result.exports.find(row => row.name === 'Special');
  assert.equal(forwarded?.forwarded?.module, './Card.vue');
  assert.equal(forwarded?.forwarded?.imported, 'default');
  assert.equal(forwarded?.range.start.line, 4);
});

test('MDX static expression imports are references, while arbitrary component props are not resource proofs', async () => {
  const text = 'import Card from "./Card.vue";\n\n{import("./data.json")}\n\n<Card src="./not-proven.png" />';
  const result = (await extractDocument('page.mdx', text))!;
  assert(result.references.some(row => row.specifier === './data.json'));
  assert(!result.references.some(row => row.specifier === './not-proven.png'));
});

test('Astro extracts physical frontmatter, mixed components and style/script resources', async () => {
  const text = '---\r\nimport Card from "./Card.vue";\r\nexport const title = "Привет 😀";\r\n---\r\n<Card />\r\n<img src="./logo.svg" />\r\n<script>import { run } from "./client.ts";</script>\r\n<style lang="scss">@use "./theme"; .icon { background: url("./icon.svg"); }</style>\r\n';
  const result = (await extractDocument('page.astro', text))!;
  for (const expected of ['./Card.vue', './logo.svg', './client.ts', './theme', './icon.svg']) assert(result.references.some(row => row.specifier === expected), expected);
  assert(result.exports.some(row => row.name === 'default'));
  const card = result.references.find(row => row.kind === 'import' && row.specifier === './Card.vue')!;
  assert.equal(card.evidence.range?.start.line, 1);
  const client = result.references.find(row => row.kind === 'import' && row.specifier === './client.ts')!;
  assert.equal(client.evidence.range?.start.line, 6);
  assert(!result.references.some(row => row.specifier?.includes('astro:')));
});

test('Astro unsupported languages and malformed documents give bounded diagnostics', async () => {
  const result = (await extractDocument('page.astro', '<style lang="unknown">import "./wrong";</style><img src="./ok.svg" />'))!;
  assert(result.references.some(row => row.specifier === './ok.svg'));
  assert(!result.references.some(row => row.specifier === './wrong'));
  assert(result.diagnostics.length > 0);
  const malformed = (await extractDocument('bad.mdx', 'import SECRET from "./x";\n\n<div>\n'))!;
  assert(malformed.diagnostics.length > 0);
  assert(!malformed.diagnostics.join(' ').includes('SECRET'));
});

test('Astro byte offsets map Unicode positions and non-JavaScript data scripts are not parsed', async () => {
  const text = '<p>Привет 😀</p><img src="./logo.svg" />\n<script type="text/plain">import Fake from "./fake.ts";</script>\n<Card src="./unknown-prop.png" />';
  const result = (await extractDocument('page.astro', text))!;
  const logo = result.references.find(row => row.specifier === './logo.svg')!;
  assert.equal(logo.evidence.range?.start.character, text.indexOf('src='));
  assert(!result.references.some(row => row.specifier === './fake.ts'));
  assert(!result.references.some(row => row.specifier === './unknown-prop.png'));
});

test('GraphQL preserves definitions/spreads without inventing universal file imports', async () => {
  const text = '#import "./not-a-standard-import.graphql"\nfragment CardFields on Card { id ...Details }\nquery Cards { cards { ...CardFields } }';
  const result = (await extractDocument('cards.graphql', text))!;
  assert.deepEqual(result.graphql?.definitions.map(row => [row.name, row.kind]), [['CardFields', 'fragment'], ['Cards', 'operation']]);
  assert.deepEqual(result.graphql?.spreads.map(row => row.name), ['Details', 'CardFields']);
  assert.equal(result.references.length, 0);
  assert.equal(result.exports.length, 0);
  const bad = (await extractDocument('bad.gql', 'query SECRET {'))!;
  assert(bad.diagnostics.length > 0);
  assert(!bad.diagnostics.join(' ').includes('SECRET'));
});

test('document adapter ignores unrelated file formats', async () => {
  assert.equal(await extractDocument('data.json', '{}'), undefined);
});
