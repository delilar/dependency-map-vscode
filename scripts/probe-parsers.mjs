import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parserPlugin, buildParserAssets } from './parser-build.mjs';
await mkdir('.test-dist', { recursive: true });
const source = `import assert from 'node:assert/strict';
import {extractComponent} from '../src/analysis/components';
import {extractDocument} from '../src/analysis/documents';
import {extractAdditionalStyles} from '../src/analysis/style-formats';
(async()=>{
for(const [file,text] of [['card.vue','<script setup>import x from "./x";</script><template><div/></template>'],['card.svelte','<script>import x from "./x";</script><div/>']]){const value=await extractComponent(file,text);assert(value.references.some(r=>r.specifier==='./x'),file);}
for(const [file,text] of [['page.astro','---\\nimport X from "./x";\\n---\\n<X/>'],['page.mdx','import X from "./x";\\n\\n<X/>'],['query.graphql','query Q {user {...User}} fragment User on User {id}']]){const value=await extractDocument(file,text);assert(value.diagnostics.length===0,JSON.stringify(value.diagnostics));assert(file.endsWith('graphql')?value.graphql.definitions.length===2:value.references.some(r=>r.specifier==='./x'),file);}
const sass=extractAdditionalStyles('style.sass','@use "palette"\\n.x\\n  color: red');assert(sass.references.some(r=>r.specifier==='palette'),JSON.stringify(sass));
const angular=await import('@angular/compiler');assert(angular.parseTemplate('<app-card [title]="name"/>','inline.html').nodes.length===1);
console.log(JSON.stringify({node:process.versions.node,vue:true,svelte:true,astro:true,mdx:true,graphql:true,sass:true,angular:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});`;
await writeFile('.test-dist/parser-probe.ts', source);
await buildParserAssets('.test-dist');
await build({ entryPoints: ['.test-dist/parser-probe.ts'], outfile: '.test-dist/parser-probe.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node18', keepNames: true, plugins: [parserPlugin] });
const executable = process.env.PARSER_PROBE_EXECUTABLE ?? process.execPath;
const result = spawnSync(executable, [path.resolve('.test-dist/parser-probe.cjs'), ...(process.env.PARSER_PROBE_EXECUTABLE ? ['--ms-enable-electron-run-as-node'] : [])], { env: { ...process.env, ...(process.env.PARSER_PROBE_EXECUTABLE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, encoding: 'utf8', windowsHide: true });
console.log(result.stdout); if (result.stderr) console.error(result.stderr); if (result.error) console.error(result.error);
if (result.status !== 0) console.error(JSON.stringify({ status: result.status, signal: result.signal }));
if (result.status !== 0) throw new Error('Parser runtime probe failed');
