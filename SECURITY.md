# Security notes

Dependency Map analyses local workspace files. It does not execute project code or configuration, and it does not use an external analysis service. Static parsing is not a sandbox for arbitrary untrusted input: open and analyse projects you trust.

Installed `node_modules` trees are excluded from project analysis. Environment variable names may be indexed, but `.env` values are not included in graph data, Webview messages, shared annotations, or logs. Source-map comments in stylesheet input do not cause source maps to be loaded from the filesystem.

## Dependency status

Version 0.2.1 keeps web parsers inside the extension and never loads project plugins or preprocessors. Framework reads enforce the same keys-only/node-only boundaries, including Angular template references. Static-config extraction has depth and total-node limits. Analytical Q scope filters endpoints and declaration/registration provenance; local scope settings are separate from shared annotation JSON v1.

Version 0.2.0 also hard-excludes `.git` from source inventory, resolution, overlays, and navigation, including when custom exclusions are empty. Git integration reads only the cache of an already active built-in provider; product code does not activate the provider, invoke Git, request status refreshes, or read patches. Query witnesses, local task views, and diagnostic export contain references or allowlisted metadata rather than source contents. CommonJS and unsupported export provenance cannot establish a unique ESM declaration.

As of 2026-10-31, version 0.1.2 updates PostCSS and minimatch patches and disables automatic stylesheet source-map loading. A regression test checks that source-map comments cannot cause filesystem probes or reads, including paths outside the input file's directory.

As checked on 2026-11-04 for the 0.2.1 dependency tree, **four moderate npm audit findings** remain, involving `glob`, `minimatch`, `stylus`, and the `@vscode/vsce` packaging dependency; no high/critical finding was reported. These are not a claim of four independent runtime exploits, and their presence should not be treated as a clean audit. The broad automatic fix suggests breaking dependency changes, so it has not been applied blindly.

Relevant upstream advisories:

- [glob cancellation behaviour](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
- [minimatch resource-exhaustion behaviour](https://github.com/advisories/GHSA-g3hv-75wg-m249)

Run `npm audit` against the locked tree for current details. Do not include tokens, environment values, or private project contents in public bug reports.
