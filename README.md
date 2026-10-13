Unofficial — not affiliated with or endorsed by Shopify

# shopify-offline-preview

An offline theme reader and editor for Shopify Online Store 2.0 themes, for people and coding agents.

**Status: local M0 foundation implemented and verified.** Rendering, the dev server, inspector, playground, and Shopify oracle
are not implemented yet. No Shopify-verified feature implementation is claimed. This package is
private during development and has not been published.

## Local development

Requires Node.js 22 or newer and pnpm 10.34.7.

```sh
pnpm install --frozen-lockfile
pnpm generate
pnpm verify
node dist/cli.js check /path/to/theme --json
node dist/cli.js check /path/to/theme --json --strict
node dist/cli.js schema snapshot
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

## Bring your own data

Data may come from any external collection or export tool. Prepare a local directory containing
`snapshot.json` and `images/`, following `schemas/snapshot.schema.json`. The library does not collect
live-store data or convert vendor-specific exports. Local snapshot validation is available in the
browser foundation export; `dev --data` and `render --data` arrive with rendering.

Source prices are decimal strings in the shop currency, not floating-point numbers or Liquid's
derived minor-unit prices. Variants have string ids; cart lines refer to a product handle and
variant id. Images use paths relative to `images/`. Schema validation checks source shape; reference
integrity and scenario derivation are future M1/M2 work. The runtime also validates IANA timezone
names, beyond the JSON Schema's string shape. No real customer data belongs in fixtures.

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
pnpm license-guard
pnpm test:network-off
```

Dawn and Horizon are fetched at the full commits in `benchmarks.json` into an OS temporary directory,
outside this project. A local ignored manifest points to them. They are never committed or packaged.
The benchmark check verifies deterministic coverage output, valid result contracts, and no parse or
missing-reference errors. It does **not** assert Shopify render parity.

The Docker command prepares dependencies and benchmarks while online, then runs the foundation checks
in a container with `--network none`. GitHub workflow definitions include unit, network-off, and
license-guard jobs; these run remotely only after repository publication is separately authorized.
Browser foundation tests exercise the browser bundle's analysis in Node; real browser rendering and
playground tests are later milestones.

## License

MIT. Shopify benchmark theme files remain subject to their own licenses and are not redistributed.
