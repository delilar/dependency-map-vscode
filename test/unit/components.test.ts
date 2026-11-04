import assert from 'node:assert/strict';
import test from 'node:test';
import { extractComponent } from '../../src/analysis/components';

test('Vue normal/setup scripts, template assets and styles share physical source ranges', async () => {
  const text = '<!-- emoji 🙂 -->\r\n<script lang="ts">\r\nimport { run } from "./logic"; export const named = run;\r\n</script>\r\n<script setup lang="ts">\r\nimport Card from "./Card.vue"; const privateState = 1;\r\n</script>\r\n<template><Card/><img src="./photo.png"/></template>\r\n<style lang="scss">@use "./theme"; .x { background: url("./bg.svg") }</style>';
  const result = (await extractComponent('Panel.vue', text))!;
  assert(result.references.some(ref => ref.specifier === './logic'));
  assert(result.references.some(ref => ref.specifier === './Card.vue'));
  assert(result.references.some(ref => ref.specifier === './photo.png'));
  assert(result.references.some(ref => ref.specifier === './theme'));
  assert(result.references.some(ref => ref.specifier === './bg.svg'));
  assert(result.exports.some(entry => entry.name === 'default'));
  assert(result.exports.some(entry => entry.name === 'named'));
  assert(!result.exports.some(entry => entry.name === 'privateState'));
  assert.equal(result.references.find(ref => ref.specifier === './logic')!.evidence.range!.start.line, 2);
  assert.equal(result.references.find(ref => ref.specifier === './Card.vue')!.evidence.range!.start.line, 5);
  assert(result.references.some(ref => ref.specifier === './Card.vue' && ref.evidence.rule.includes('template')));
  assert.equal(result.diagnostics.length, 0);
});

test('Vue external blocks remain physical references without re-owning their contents', async () => {
  const result = (await extractComponent('feature/Panel.vue', '<script src="../shared/logic.ts"></script><template src="../shared/view.html"></template><style src="../shared/theme.scss"></style>'))!;
  assert.deepEqual(result.references.map(ref => ref.specifier).sort(), ['../shared/logic.ts', '../shared/theme.scss', '../shared/view.html']);
  assert(!result.references.some(ref => ref.specifier === './sibling'));
  assert.equal(result.exports.filter(entry => entry.name === 'default').length, 1);
});

test('Vue unsupported blocks retain safe sibling imports and expose a bounded reason', async () => {
  const result = (await extractComponent('Panel.vue', '<script setup>import Card from "./Card.vue"</script><template lang="pug">Card</template><docs>sentinel private documentation</docs><style lang="unknown">secret value</style>'))!;
  assert(result.references.some(ref => ref.specifier === './Card.vue'));
  assert(result.diagnostics.some(reason => reason.includes('template')));
  assert(result.diagnostics.some(reason => reason.includes('custom')));
  assert(result.diagnostics.some(reason => reason.includes('style')));
  assert(!result.diagnostics.join(' ').includes('sentinel'));
  assert(!result.diagnostics.join(' ').includes('secret value'));
});

test('Vue implicit template names respect v-for and slot bindings', async () => {
  const result = (await extractComponent('Panel.vue', '<script setup>const price = 1; const entries = []</script><template><AutoCard/>{{ formatMoney(price) }}<div v-for="formatMoney in entries">{{ formatMoney }}</div><template #default="{ slotValue }">{{ slotValue }}</template></template>'))!;
  const names = result.implicitNames ?? [];
  assert(names.some(item => item.name === 'AutoCard' && item.kind === 'component'));
  assert.equal(names.filter(item => item.name === 'formatMoney').length, 1);
  assert(!names.some(item => ['price', 'entries', 'slotValue'].includes(item.name)));
});

test('Svelte module exports differ from instance props and default component', async () => {
  const text = '<!-- 🙂 -->\r\n<script context="module" lang="ts">\r\nexport const shared = 1; import { util } from "./util";\r\n</script>\r\n<script lang="ts">\r\nimport Card from "./Card.svelte"; export let title: string = "hello";\r\n</script>\r\n<Card/><img src="./image.png"/><style>.x { background: url("./bg.svg") }</style>';
  const result = (await extractComponent('Panel.svelte', text))!;
  assert(result.exports.some(entry => entry.name === 'shared'));
  assert(result.exports.some(entry => entry.name === 'default'));
  assert(!result.exports.some(entry => entry.name === 'title'));
  for (const specifier of ['./util', './Card.svelte', './image.png', './bg.svg']) assert(result.references.some(ref => ref.specifier === specifier), specifier);
  assert.equal(result.references.find(ref => ref.specifier === './Card.svelte')!.evidence.range!.start.line, 5);
  assert(result.references.some(ref => ref.specifier === './Card.svelte' && ref.evidence.rule.includes('template')));
  assert.equal(result.diagnostics.length, 0);
});

test('Svelte runes and dynamic components are parsed without evaluating code', async () => {
  const result = (await extractComponent('Panel.svelte', '<script>import Card from "./Card.svelte"; let count = $state(0);</script><Card value={count}/><svelte:component this={factory()}/><img src={"./photo.png"}/>'))!;
  assert(result.references.some(ref => ref.specifier === './Card.svelte'));
  assert(result.references.some(ref => ref.specifier === './photo.png'));
  assert(!result.references.some(ref => ref.specifier?.includes('factory')));
  assert(result.references.some(ref => ref.reason?.includes('component')));
});

test('component parser failures report no source content and non-components are ignored', async () => {
  const result = (await extractComponent('Broken.svelte', '<script>const SECRET_SENTINEL = ;</script>'))!;
  assert(result.diagnostics.length > 0);
  assert(!JSON.stringify(result).includes('SECRET_SENTINEL'));
  assert.equal(await extractComponent('plain.ts', 'export const x = 1'), undefined);
});

test('Svelte style preprocessors use guarded parse-only adapters and retain sibling scripts', async () => {
  const result = (await extractComponent('Panel.svelte', '<script>import Card from "./Card.svelte"</script><Card/><style lang="scss">@use "./theme"; $color: red; .x { color: $color }</style>'))!;
  assert(result.references.some(ref => ref.specifier === './Card.svelte'));
  assert(result.references.some(ref => ref.specifier === './theme' && ref.resolutionMode === 'style' && ref.sourceExtension === '.scss'));
  assert.equal(result.diagnostics.length, 0);
  const partial = (await extractComponent('Broken.svelte', '<script>import Card from "./Card.svelte"</script>{#if'))!;
  assert(partial.references.some(ref => ref.specifier === './Card.svelte'));
  assert(partial.diagnostics.length > 0);
});

test('Vue Options API registration and namespace member templates retain binding identity', async () => {
  const result = (await extractComponent('Panel.vue', '<script>import Card from "./Card.vue"; import Unused from "./Unused.vue"; export default { components: { LocalCard: Card } }</script><template><LocalCard/><Unused/></template>'))!;
  assert(result.references.some(ref => ref.specifier === './Card.vue' && ref.evidence.rule.includes('template')));
  assert(!result.references.some(ref => ref.specifier === './Unused.vue' && ref.evidence.rule.includes('template')));
  const namespace = (await extractComponent('Panel.vue', '<script setup>import * as UI from "./ui"</script><template><UI.Card/></template>'))!;
  const usage = namespace.references.find(ref => ref.evidence.rule.includes('template'))!;
  assert.equal(usage.bindings[0].imported, 'Card');
  assert.equal(usage.specifier, './ui');
});

test('Svelte each/slot locals do not become imported template bindings', async () => {
  const result = (await extractComponent('Panel.svelte', '<script>import Card from "./Card.svelte"; import Wrapper from "./Wrapper.svelte"; let cards = [];</script>{#each cards as Card}<Card/>{/each}<Wrapper let:Card><Card/></Wrapper>'))!;
  assert(!result.references.some(ref => ref.specifier === './Card.svelte' && ref.evidence.rule.includes('template')));
});
