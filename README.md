Unofficial — not affiliated with or endorsed by Shopify

# shopify-offline-preview

An offline theme reader and editor for Shopify Online Store 2.0 themes, for people and coding agents.

**Status: initial offline rendering is available locally; Shopify parity is pending.** JSON templates,
layouts, sections/groups, source mappings and isolated snippets are assembled using local snapshots.
Fixture generation and guarded read-only oracle tools exist; no real goldens have been captured.
The dev server, inspector and static browser playground are available with section highlighting;
theme-block fidelity remains pending. No Shopify-verified feature implementation is claimed. This package is
private during development and has not been published.

## Local development

Requires Node.js 22 or newer and pnpm 10.34.7.

```sh
pnpm install --frozen-lockfile
pnpm generate
pnpm verify
node dist/cli.js check /path/to/theme --json
node dist/cli.js check /path/to/theme --json --strict
node dist/cli.js render /path/to/theme /products/example --data /path/to/data --json
node dist/cli.js schema snapshot
node dist/cli.js dev /path/to/theme --data /path/to/data --port 3000
```

`check` walks JSON templates and their layouts, section groups, sections, theme blocks, and statically
named snippets. It lists reachable filters, tags, objects, and object properties with source lines.
Disabled sections are skipped. Dynamic snippet names, unresolved aliases, and parser recovery are
diagnosed and keep coverage incomplete. Type inference is conservative and flow-insensitive; snippet
argument propagation and resource-setting types still need runtime coverage. `known` means present
in the pinned documentation for the inferred object type; unresolved types are not proof that
Shopify lacks a property. `@theme` permits every
theme block, so the static graph includes all files in `blocks/` at those call sites.

All features remain unimplemented until registered **and** covered by an actual Shopify oracle case.
`--strict` exits with 5 for unimplemented features or incomplete coverage. Exit 2 means invalid usage;
exit 3 means an invalid or unsupported theme/input. `check --json` produces one schema-valid JSON
document, including usage and load failures; human-readable errors go to stderr. Results and file
ordering are deterministic.

`render --json` also emits one schema-valid document on success and failure. JSON mode records
snapshot reads per tree node. `--out <file>` writes HTML separately; JSON remains on stdout.
`--scenario <name>` applies an immutable JSON merge patch from the snapshot; `--design-mode` sets
`request.design_mode`. Without `--data`, the bundled synthetic fixture is used. Fatal assembly errors
exit with 4; recoverable Liquid errors appear inline and in diagnostics. Known unsupported filters
emit visible markers and `not-implemented` diagnostics; unknown filters fail explicitly.

Initial rendering is incomplete: theme block execution, classic block tracing, several resource
settings and several Shopify filters remain pending. Prices convert exactly to
hundredths and reject values requiring greater precision. Native LiquidJS behavior still needs
Shopify oracle verification. The feature registry continues to report zero verified implementations.
Theme/section translations, regional locales, plural counts and HTML escaping are handled locally.
Money filters use the snapshot templates; assets, image URL parameters and preload hints use local
files. The server serves the original image bytes and the browser scales them, as specified.

Initial `product`, `customer`, `contact` and `localization` forms render their HTML and initial form
state. Resource lists (`collection.products`, `blog.articles`, `search.results`, `product.variants`)
can be paginated without mutating their source; page links preserve the URL query. Independent
setting-array pagination is diagnosed as pending. Cart lines and exact undiscounted totals derive
from snapshot variant prices and quantities; compare-at prices do not count as discounts. Basic search
matches product, page and article words, with documented prefix/type/availability options. Advanced
query syntax and ambiguous relevance ranking remain explicitly diagnosed.

## Bring your own data

Data may come from any external collection or export tool. Prepare a local directory containing
`snapshot.json` and `images/`, following `schemas/snapshot.schema.json`. The library does not collect
live-store data or convert vendor-specific exports. Local snapshot validation is available in the
browser export, `render --data` and `dev --data`.

Source prices are decimal strings in the shop currency, not floating-point numbers or Liquid's
derived minor-unit prices. Variants have string ids; cart lines refer to a product handle and
variant id. Images use paths relative to `images/`. Schema validation checks source shape; reference
integrity and scenario derivation are also checked by the renderer. The runtime validates IANA timezone
names, beyond the JSON Schema's string shape. No real customer data belongs in fixtures.

## Development inspector

`dev` prints separate loopback origins for the inspector and the theme page. The inspector shows the
renderer tree, diagnostics, snapshot reads and the selected node's source. Hover sections to highlight
their regions; snippets are listed without DOM highlights. Mobile, tablet, desktop and full-width
presets change the iframe width. Scenario and design-mode controls re-render locally. Theme and data
file edits reload the preview. Invalid edits clear the old preview and show the input error.

Unsupported Shopify endpoints return 501 with `{"error":"not available offline"}` and page badges.
The bridge also prevents those requests from reaching the snapshot's shop domain. Third-party resource
requests are listed separately. Bridge markup is added only to the served view, leaving `render` output
unchanged. The inspector rejects cross-origin requests and filesystem escapes.

## Browser playground

`pnpm build` writes the static site to `dist/playground/`. Serve that directory locally with any static
HTTP server; it also works under a static hosting subdirectory. Open a theme zip, drop it onto the
page, or choose a folder. Supply a snapshot zip/folder containing `snapshot.json` and `images/`, or
use the bundled fixture. Theme and snapshot files are processed in browser memory and are never
uploaded. A folder opened through File System Access can be read again with **Reload folder**;
there is no file watcher. Browsers without that API can use the folder input or zip input.

The playground shares the inspector tree, diagnostics, source and controls with `dev`. The theme
runs in an opaque sandboxed iframe and cannot read the inspector's input files. Local assets and
snapshot images use data URLs; module imports use an import map, including cyclic imports. Fetch
and XHR calls to unsupported Shopify endpoints retain the 501 response and diagnostic badges.
Third-party theme requests remain visible separately. Core render output is preserved.

Scoped import maps and circular CSS imports currently fail explicitly rather than changing their
meaning. These are preview-adapter limitations; Shopify rendering parity is still pending.
GitHub Pages has not been configured or deployed.

## Generated Shopify documentation

`upstream.json` pins MIT-licensed theme-liquid-docs. Raw inputs and its license are retained in
`vendor/theme-liquid-docs/`; generated registry, object types, corpus inputs (without invented
expected results), and system translations are under `packages/spec/src/generated/`.
`pnpm generate:check` fails on generated drift. Documentation types are optional and nullable;
untyped properties remain `unknown`. See `THIRD_PARTY_NOTICES.md` for attribution.

## Benchmark and offline verification

```sh
pnpm benchmarks:fetch
pnpm benchmarks:check
pnpm benchmarks:render-check
pnpm agent:contract-check
pnpm browser:render-smoke
pnpm license-guard
pnpm test:network-off
```

Dawn and Horizon are fetched at the full commits in `benchmarks.json` into an OS temporary directory,
outside this project. A local ignored manifest points to them. They are never committed or packaged.
The agent contract check copies Dawn into a temporary directory, edits a real section and verifies
the CLI HTML/tree, then checks that an unknown filter is listed with strict exit 5. Usage, input and
fatal failures also validate against the published schemas with no TTY. The pinned input is preserved.
The static benchmark check verifies deterministic coverage output, valid result contracts, and no parse
or missing-reference errors. The initial rendering check compares repeat runs and Node/browser builds
across all 36 cases while reporting remaining errors and unsupported features. The browser smoke
command starts a loopback-only verification page for those same cases. These checks do **not** assert
Shopify render parity and do not waive acceptance gates.

The Docker command prepares dependencies and benchmarks while online, then runs the foundation checks
in a container with `--network none`. GitHub workflow definitions include unit, network-off, license-guard and browser jobs. The browser lane
checks all 36 playground cases, no-upload behavior, playground interactions and dev-inspector
regressions against the current renderer. Theme-block coverage and real Shopify parity remain pending.

## License

MIT. Shopify benchmark theme files remain subject to their own licenses and are not redistributed.
