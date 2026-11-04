# Dependency Map for VS Code

Explore the imports and consumers of a file without leaving VS Code. Dependency Map provides a navigable file graph for web workspaces: React/Next.js/Tramvai, Vue/Nuxt, Svelte/SvelteKit, Astro, Angular, Markdown/MDX, styles and resources, including local packages and multiple workspace folders.

[Download the latest release](https://github.com/delilar/dependency-map-vscode/releases/latest) · [Report a bug](https://github.com/delilar/dependency-map-vscode/issues)

## Install

1. Download the `.vsix` asset from the [latest GitHub release](https://github.com/delilar/dependency-map-vscode/releases/latest).
2. In desktop VS Code, open **Extensions → … → Install from VSIX** and select the downloaded file.
3. When updating, run **Developer: Reload Window**, then close and reopen any existing Dependency Map tab.

Requires VS Code **1.85.2 or newer**. Windows x64 has been tested; other operating systems and remote workspaces have not been verified. The current interface is in Russian. Installation is through a VSIX, not the Visual Studio Marketplace.

## Use

- Open a project file and click the dependency-map icon in the editor title bar, or run **Dependency Map: Open File Map**.
- Run **Dependency Map: Open Project Map** to explore the workspace.
- An arrow points from the importing file to the imported file. Select an edge to inspect imported names, aliases, type-only bindings, and available evidence.
- Double-click a file to open it. The details panel offers navigation to the import and a declaration when it can be resolved.
- Search by filename, relative path, or imported name, including files hidden by display filters. Filter by direction, format, project, role, folder, or task group.
- Choose a global depth, or right-click a real file node to set its individual depth. Individual depth adds to the global neighbourhood. With both directions enabled, traversal can reach another branch through a shared parent.
- Use the follow-editor switch to follow the active file, or leave it off to keep the current focus pinned.
- Drag the panel dividers or use the arrow keys while a divider is focused to resize the interface.

File details are shown before task controls. On narrow panels, **Поиск / Детали / Задача** switches the lower pane while keeping the graph and selection. Additional filters are grouped under **Дополнительные фильтры**. Long relation lists have a **Показать ещё связи** action. Controls and graph labels follow VS Code's UI font size without resetting the map's zoom.

The default palette identifies six families: code, UI, styles, data/documents, configuration and resources. Language labels distinguish formats within a family; the earlier per-format palette remains available. Task colours use a separate border/stroke and selection remains visible. Folder groups show how many indexed files are explicitly marked, including partial marks. Dashed edges mean inferred relationships; `×N` indicates aggregation.

The initial file view uses a readable zoom. Saved camera settings are restored exactly; choose a file and use **В центр карты** to return from a small overview. **Вписать** fits the visible graph and can make a large project overview small.

## Shared task groups

Create a named group and add selected files or edges. Creating an empty group, saving group properties, and assigning selected elements are separate actions. The colour palette supports HEX input, explicit confirmation, cancellation, and Escape.

Shared groups, marks, and notes are stored in `.vscode/dependency-map.json` using version 1 of the included [schema](schemas/dependency-map.schema.json). Commit that file to share it with teammates. Camera, filters, panel sizes, and individual depths remain local to the workspace.

Changing selection with an edited note offers Save, Discard, or Stay; a failed save retains the text. If reindexing removes the selected file, **Несохранённые заметки** provides the draft for copying or restoring when the file returns. These recovery drafts belong to the open map tab; save or copy them before closing it.

Adding a folder takes a snapshot of its current files; future files are not added automatically. Missing marks are preserved for other branches. Removing a mark also removes its note from that group. Concurrent external edits are checked, but simultaneous writers are not guaranteed conflict-free operation.

For multiple workspace roots, select the coordinating root on first save. Use **Dependency Map: Bind Shared Roots** when saved roots cannot be matched after moving a workspace.

## Investigate a change

Select a file and open **Исследовать зависимости**. Analytical queries pause editor following and use the full available index unless an analytical scope Q is applied. Display filters can hide a result without removing its evidence. Return with **Вернуться к обычной карте**.

- **Impact:** find direct and indirect consumers and statically connected test candidates. Choose depth and whether to include inferred or type-only relations. This does not predict breakage or measure test coverage.
- **Directed branches:** use **Ещё входящие** or **Ещё исходящие** in file details or the context menu. Each action adds one directed step. Collapse removes only that branch's contribution; camera and existing file positions stay in place.
- **Import path:** choose two files to find one directed path of confirmed imports/reexports, including hidden intermediaries. Select the explicit all-dependencies mode to include resources/framework relationships; inferred edges require a separate opt-in. Limits and unknown dependencies are shown explicitly.
- **Symbol focus:** select an export or imported binding to inspect supported aliases, component defaults and reexport provenance across formats. Literal named CommonJS assignments are supported; mutations, object-style CommonJS exports, namespace and ambiguous cases remain labelled. Imports do not prove calls or data flow.
- **Git changes:** inspect cached metadata from an already active built-in Git provider, with separate staged, unstaged, conflict, untracked, and dirty-editor flags. Select a repository or analyse the union of its indexed changed files. Use Source Control to refresh Git itself. The graph represents current files and editor overlays, not staged or historical source text. Deleted rows retain their status without invented old edges.
- **My task view:** explicitly save one local return point per shared group, preview missing references or changed groups, and restore the available view. Contexts stay in VS Code workspace storage; shared JSON v1 is unchanged. Restore pins the map. Unsaved group properties/notes require Save, Discard, or Stay.
- **Versions and freshness:** inspect running host/worker/Webview build identities and index state. Diagnostic copying requires a preview and includes allowlisted versions, reasons, counters, and timings, without source text or absolute paths.

Queries are bounded to 10,000 visited nodes, 50,000 examined relations, and a 1,500 ms soft deadline; depth-based queries accept 1–20 steps. Limits produce an explicit partial result. The analytical canvas displays up to 500 files, with results and evidence available separately. A found witness proves its shown static relationships; an empty result does not prove that a change is safe.

Local package `exports` encapsulates entry points: blocked or missing entries do not fall back to private files. Conditional `exports` / `imports` resolve only with a default fallback and all branches pointing to the same local target; runtime-dependent alternatives remain unresolved.

### Folder boundaries

Open **Области вида V и анализа Q**, choose **Показывать на карте (V)** or **Учитывать при анализе (Q)**, select a workspace root and enter relative folders, one per line (`.` means that root). The editor loads the selected area's current values. **Применить область** changes the selected root while preserving other roots; the add option preserves existing folders too. Test, mock and fixture roles can be excluded separately.

- **V — presentation:** hide files outside the selected folders. Queries retain the full permitted graph, including hidden intermediaries and external test candidates.
- **Q — analytics:** traverse only selected files. A path `feature/A → shared/B → feature/C` cannot cross an excluded B, and no direct A→C edge is invented. Scope applies to Explore, local depth, branches, Path, Impact and export provenance.

Global search still finds outside-Q files and can open them; selecting one does not expand Q. Scope changes invalidate pending results. Local task views preserve the selected scope and palette; shared annotation JSON remains version 1. The older local storage keys are retained for rollback.

## Analysis support

| Input | Support |
| --- | --- |
| JavaScript / TypeScript | AST imports/reexports and bindings; static `require()` / `import()`; aliases/local packages; bounded Vite glob/Webpack context declarations |
| React | Imported JSX bindings/member names, supported static CSS-in-JS and assets; no rendering or call graph |
| Vue 3 | Normal/setup scripts, local component bindings, external block sources, styles/resources and component default export |
| Nuxt 3/4 | Local components/composables, independent auto-import flags, explicit `#imports` / `#components`, source aliases and bounded page/layout conventions |
| Svelte / SvelteKit | Legacy/runes component syntax, instance/module scripts, resources/styles, default component; route loaders/layouts/reset rules and conditional boundaries |
| Astro | Frontmatter imports, mixed-framework components, scripts/styles/resources; page roles and explicit Markdown layouts |
| Angular | Literal decorator resources, standalone/NgModule local scope, selector references and registration provenance; external SDK contents are not scanned |
| Next.js | Pages/App Router conventions, configured page extensions, private folders and conditional boundaries; complex slots/interception remain partial |
| Tramvai | Binding-aware app/child/module/provider declarations and DI candidates; token reexports preserved, runtime registration/overrides remain uncertain |
| Markdown / MDX | Local links, reference images and supported raw HTML; MDX ESM imports/exports and component default, without evaluation |
| CSS / SCSS / Less / Stylus | Static imports, supported partials, and local asset URLs |
| Indented Sass | Bundled parse-only AST, partials and static URLs, including the minimum VS Code host |
| HTML | Local scripts/styles/media, `srcset`, base URL handling and supported inline regions |
| GraphQL | Definitions/spreads in files and literal imported `gql` tags; fragment links only within an explicit document set |
| JSON / configuration | Data nodes; known package/tsconfig/jsconfig fields and bounded static web-config aliases/source/public directories; arbitrary strings are not paths |
| Environment | Variable names and possible source relationships, without values in graph data or logs |
| Images, fonts, media, other resources | File nodes and supported incoming references; binary contents are not parsed |

Framework rules are static subsets exercised with source fixtures, not full framework builds or a guarantee for every major/plugin. The fixtures cover Vue 3, Svelte legacy/runes, Nuxt 3/4, Next Pages/App, Angular NgModule/standalone and SvelteKit route conventions. Unknown registrations, layers, preprocessors, generated modules or incompatible syntax remain partial. `script setup` bindings and Svelte instance props are not ESM named exports. File roles are conventions and do not prove runtime behaviour.

Version-sensitive profiles accept simple major, exact, caret and tilde declarations: Nuxt 3/4, Next 12–16 (App Router from 13), Angular 18–21, SvelteKit 1/2 and Astro 4–6. Complex or conflicting ranges, prereleases and unsupported majors leave framework analysis partial; ordinary imports remain available. This is a static rule profile, not certification of every release in those ranges. Attributes on custom components are not assumed to be native resource references.

For cross-file GraphQL fragments, declare an explicit local collection in the owning `package.json`:

```json
{
  "dependencyMap": {
    "graphqlDocuments": ["src/**/*.graphql", "src/**/*.gql", "src/**/*.ts", "!src/generated/**"]
  }
}
```

A literal `documents` field in `graphql.config.js/ts` is also supported. Fragment names are resolved only in that collection; missing/duplicate names, including duplicates within one file, are reported. Collections accept up to 30 patterns; exceeding the limit reports incomplete analysis instead of dropping selectors. GraphQL `#import` and interpolated tags require loader/runtime semantics and are not evaluated. WASM and shader files remain resource targets; their internal imports are not analysed.

This is a static dependency map. An import does not prove a function call, execution, or test coverage. Dynamic paths, unknown aliases, complex reexports, conditional package exports, and runtime framework behaviour may remain unresolved. Arbitrary data-file strings are not treated as paths.

Analysis runs locally in a worker. Project code and configuration are not executed. Installed `node_modules` trees are excluded from analysis, including their package metadata; local workspace packages are supported. Values from `.env` files are not sent to the graph, Webview, shared annotations, or logs. No external analysis service is used.

Parsers and Astro WASM are included in the VSIX and require no first-use download. Static config extraction accepts documented literals and bounded immutable constants, not arbitrary functions, plugins or preprocessors. Relative Vite alias replacements and unknown loader qualifiers are not guessed into confirmed module exports. Config/source changes and unsaved buffers invalidate the affected analysis.

Tool configurations are kept separate. Ordinary source uses the application profile; explicit test files use the known test profile. Conflicting application/test aliases report partial shared-entry analysis. Arbitrary CLI working directories or `--config` arguments are not evaluated: association with a nested config is marked partial, and an unproven runtime root is not used to confirm root URLs.

Symlink/junction trees are not followed as additional projects. Add a required local package as a workspace folder. Text inputs larger than 2 MiB are skipped with a diagnostic. Default exclusions can be configured through `dependencyMap.exclude`; `node_modules` remains excluded.

## Build from source

Use **Node.js 22** and npm. The extension host and worker are bundled for Node.js 18 to support the minimum VS Code version.

```sh
npm ci
npm run check
npm run package
```

Packaging creates `dependency-map-vscode-<version>.vsix` in the repository root. Generated bundles, installed dependencies, editor test downloads, and VSIX files are not committed to Git. The release asset contains the extension bundles, schema, README, and licences.

Packaging also verifies the archive allowlist, required parser assets, build identity and bundle bytes, then writes a `.vsix.sha256` sidecar. `npm run verify:package` repeats that check against the current build.

For local debugging, run `npm run build`, open this folder in VS Code, and press **F5** using **Run Dependency Map**.

## Tests

```sh
npm test
npm run test:ui
npm run test:integration
npm run test:installed
npm run test:persistence
npm run test:rollback
npm run test:package
npm run probe:parsers
npm run check:release
```

Unit tests use isolated synthetic workspaces. Browser smoke tests use Playwright with Microsoft Edge on Windows; elsewhere install Chromium with `npx playwright install chromium`. The integration runner downloads an official VS Code build and uses temporary workspaces and profiles. Set `VSCODE_VERSION` to test a particular editor version. It does not install into your normal VS Code profile.

`test:installed` installs the built VSIX into an isolated profile before testing the real host/worker/Webview. `test:persistence` checks ordinary editor restarts. `test:rollback` additionally runs the actual archived 0.2.0 bundles after the new version: it checks legacy settings, new local keys and unchanged shared JSON. The previous archive is pinned by SHA256 and downloaded from its GitHub release if it is not present locally.

`check:release` runs packaging, UI, parser probes, installed VS Code 1.85.2 / 1.143.1 and migration/rollback checks in order. Windows CI has separate package, UI and installed-desktop jobs and saves their artifacts. A local pass does not imply that a remote workflow has run.

Optional development tools:

```sh
npm run benchmark -- /path/to/workspace
npm run benchmark -- --synthetic
npm run benchmark:ui
npm run render:project -- /path/to/workspace
```

These tools write local reports under `artifacts/`. They are not included in the release or sent to an external service. The project renderer uses Microsoft Edge.

## Contributing

Install the locked dependencies, keep changes focused, and run checks appropriate to the change. For analysis changes, add a synthetic fixture with independently specified expected relationships. Changes to Webview messages or saved state must update runtime guards and preserve existing shared annotations.

When reporting a bug, include the extension version, VS Code version, operating system, and a minimal example. Review any project paths or configuration before sharing them publicly.

## Security

See [SECURITY.md](SECURITY.md) for analysis boundaries, the 0.1.2 source-map fix, and remaining dependency audit findings.

## Licence

[MIT](LICENSE). Bundled dependency licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
