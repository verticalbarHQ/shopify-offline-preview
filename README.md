Unofficial — not affiliated with or endorsed by Shopify

# shopify-offline-preview

An offline theme reader and editor for Shopify Online Store 2.0 themes, for people and coding agents.

**Status: initial offline rendering is available locally; Shopify parity is pending.** JSON templates,
layouts, sections/groups, source mappings and isolated snippets are assembled using local snapshots.
Fixture generation and guarded read-only oracle tools exist; no real goldens have been captured.
The dev server and inspector are available with section highlighting; theme-block fidelity and the
playground remain pending. No Shopify-verified feature implementation is claimed. This package is
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
settings, cart/search derivation and Shopify filters remain pending. Prices convert exactly to
hundredths and reject values requiring greater precision. Native LiquidJS behavior still needs
Shopify oracle verification. The feature registry continues to report zero verified implementations.

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
pnpm browser:render-smoke
pnpm license-guard
pnpm test:network-off
```

Dawn and Horizon are fetched at the full commits in `benchmarks.json` into an OS temporary directory,
outside this project. A local ignored manifest points to them. They are never committed or packaged.
The static benchmark check verifies deterministic coverage output, valid result contracts, and no parse
or missing-reference errors. The initial rendering check compares repeat runs and Node/browser builds
across all 36 cases while reporting remaining errors and unsupported features. The browser smoke
command starts a loopback-only verification page for those same cases. These checks do **not** assert
Shopify render parity and do not waive acceptance gates.

The Docker command prepares dependencies and benchmarks while online, then runs the foundation checks
in a container with `--network none`. GitHub workflow definitions include unit, network-off, and
license-guard jobs. Remote M0 CI passed at `744be2a`; the owner authorizes subsequent pushes during North Star delivery. Browser contract tests also exercise the renderer without Node globals; the loopback smoke
page checks real browser execution. Inspector browser checks cover the initial renderer; theme-block coverage and playground e2e remain pending.

## License

MIT. Shopify benchmark theme files remain subject to their own licenses and are not redistributed.
