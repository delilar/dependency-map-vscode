# Dependency Map for VS Code

Explore the imports and consumers of a file without leaving VS Code. Dependency Map provides a navigable file graph for frontend workspaces, including React, Next.js, Tramvai, local packages, and multiple workspace folders.

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

File fills identify formats, while task colours use file borders and edge strokes. Folder groups have stable colours. Selecting an edge keeps its task colour visible.

The initial file view uses a readable zoom. Saved camera settings are restored exactly; choose a file and use **В центр карты** to return from a small overview. **Вписать** fits the visible graph and can make a large project overview small.

## Shared task groups

Create a named group and add selected files or edges. Creating an empty group, saving group properties, and assigning selected elements are separate actions. The colour palette supports HEX input, explicit confirmation, cancellation, and Escape.

Shared groups, marks, and notes are stored in `.vscode/dependency-map.json` using version 1 of the included [schema](schemas/dependency-map.schema.json). Commit that file to share it with teammates. Camera, filters, panel sizes, and individual depths remain local to the workspace.

Adding a folder takes a snapshot of its current files; future files are not added automatically. Missing marks are preserved for other branches. Removing a mark also removes its note from that group. Concurrent external edits are checked, but simultaneous writers are not guaranteed conflict-free operation.

For multiple workspace roots, select the coordinating root on first save. Use **Dependency Map: Bind Shared Roots** when saved roots cannot be matched after moving a workspace.

## Investigate a change (0.2.0)

Select a file and open **Исследовать зависимости**. Analytical queries pause editor following and use the full available index; display filters can hide a result without removing its evidence. Return with **Вернуться к обычной карте**.

- **Impact:** find direct and indirect consumers and statically connected test candidates. Choose depth and whether to include inferred or type-only relations. This does not predict breakage or measure test coverage.
- **Directed branches:** use **Ещё входящие** or **Ещё исходящие** in file details or the context menu. Each action adds one directed step. Collapse removes only that branch's contribution; camera and existing file positions stay in place.
- **Import path:** choose two files to find one directed path of confirmed imports/reexports, including intermediate files hidden by display filters. Limits and unknown dependencies are shown explicitly.
- **Symbol focus:** select an export or imported binding to inspect supported ESM aliases and reexport provenance. Ambiguous stars, CommonJS, namespaces, missing modules, and unsupported cases remain labelled. Imports do not prove calls or data flow.
- **Git changes:** inspect cached metadata from an already active built-in Git provider, with separate staged, unstaged, conflict, untracked, and dirty-editor flags. Select a repository or analyse the union of its indexed changed files. Use Source Control to refresh Git itself. The graph represents current files and editor overlays, not staged or historical source text. Deleted rows retain their status without invented old edges.
- **My task view:** explicitly save one local return point per shared group, preview missing references or changed groups, and restore the available view. Contexts stay in VS Code workspace storage; shared JSON v1 is unchanged. Restore pins the map. Unsaved group properties/notes require Save, Discard, or Stay.
- **Versions and freshness:** inspect running host/worker/Webview build identities and index state. Diagnostic copying requires a preview and includes allowlisted versions, reasons, counters, and timings, without source text or absolute paths.

Queries are bounded to 10,000 visited nodes, 50,000 examined relations, and a 1,500 ms soft deadline; depth-based queries accept 1–20 steps. Limits produce an explicit partial result. The analytical canvas displays up to 500 files, with results and evidence available separately. A found witness proves its shown static relationships; an empty result does not prove that a change is safe.

## Analysis support

| Input | Support |
| --- | --- |
| JavaScript / TypeScript | AST-based imports and reexports; named/default/namespace/type-only bindings; static `require()` and `import()`; local aliases and package resolution |
| React | Imports plus supported static JSX, CSS-in-JS, and asset references |
| Next.js | Static Pages/App Router conventions, shown separately from source imports |
| Tramvai | Supported app/child-app/module/provider declarations; uncertain DI/runtime relationships remain labelled |
| CSS / SCSS / Less / Stylus | Static imports, supported partials, and local asset URLs |
| Indented Sass | Parse-only analysis requires extension-host Node.js 20.19+; older runtimes receive a diagnostic while the file remains indexed |
| HTML | Supported static local scripts, styles, and resource references |
| JSON / configuration | File nodes and known references, including supported package and tsconfig/jsconfig fields |
| Environment | Variable names and possible source relationships, without values in graph data or logs |
| Images, fonts, media, other resources | File nodes and supported incoming references; binary contents are not parsed |

Vue, Svelte, Astro, MDX, and GraphQL can appear as indexed files or reference targets; their internal dependency syntax is not analysed. File roles are conventions inferred from names, paths, and formats; they do not prove runtime behaviour.

This is a static dependency map. An import does not prove a function call, execution, or test coverage. Dynamic paths, unknown aliases, complex reexports, conditional package exports, and runtime framework behaviour may remain unresolved. Arbitrary data-file strings are not treated as paths.

Analysis runs locally in a worker. Project code and configuration are not executed. Installed `node_modules` trees are excluded from analysis, including their package metadata; local workspace packages are supported. Values from `.env` files are not sent to the graph, Webview, shared annotations, or logs. No external analysis service is used.

Symlink/junction trees are not followed as additional projects. Add a required local package as a workspace folder. Text inputs larger than 2 MiB are skipped with a diagnostic. Default exclusions can be configured through `dependencyMap.exclude`; `node_modules` remains excluded.

## Build from source

Use **Node.js 22** and npm. The extension host and worker are bundled for Node.js 18 to support the minimum VS Code version.

```sh
npm ci
npm run check
npm run package
```

Packaging creates `dependency-map-vscode-<version>.vsix` in the repository root. Generated bundles, installed dependencies, editor test downloads, and VSIX files are not committed to Git. The release asset contains the extension bundles, schema, README, and licences.

For local debugging, run `npm run build`, open this folder in VS Code, and press **F5** using **Run Dependency Map**.

## Tests

```sh
npm test
npm run test:ui
npm run test:integration
npm run test:persistence
```

Unit tests use isolated synthetic workspaces. Browser smoke tests use Playwright with Microsoft Edge on Windows; elsewhere install Chromium with `npx playwright install chromium`. The integration runner downloads an official VS Code build and uses temporary workspaces and profiles. Set `VSCODE_VERSION` to test a particular editor version. It does not install into your normal VS Code profile.

`test:persistence` launches ordinary isolated VS Code sessions to check storage across restarts. Build/packaging tests run in the repository's Windows CI workflow.

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
