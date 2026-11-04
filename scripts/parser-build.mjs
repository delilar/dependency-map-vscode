import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);

export const parserPlugin = {
  name: 'packaged-astro-parser',
  setup(builder) {
    builder.onResolve({ filter: /^@astrojs\/compiler$/ }, () => ({ path: './parsers/astro/index.cjs', external: true }));
  },
};

export async function buildParserAssets(directory) {
  const parserDirectory = path.join(directory, 'parsers', 'astro');
  await mkdir(parserDirectory, { recursive: true });
  // Astro's Go shim defines a readonly global fs; Sass requires this shim to remain writable.
  const banner = { js: "if(!globalThis.fs)Object.defineProperty(globalThis,'fs',{value:require('node:fs'),writable:true,configurable:true});" };
  const result = await build({ entryPoints: [require.resolve('@astrojs/compiler')], outfile: path.join(parserDirectory, 'index.cjs'), bundle: true, platform: 'node', target: 'node18', format: 'cjs', metafile: true, banner });
  await copyFile(require.resolve('@astrojs/compiler/astro.wasm'), path.join(directory, 'parsers', 'astro.wasm'));
  return result;
}
