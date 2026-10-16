# Development

Requires Node.js 22 or newer and pnpm 10.34.7. Docker is needed for the network-off and browser
lanes.

```sh
pnpm install --frozen-lockfile
pnpm generate        # generated spec, JSON Schemas and the default fixture
pnpm verify          # generate:check, typecheck, lint, build, unit tests
```

## Layout

| Path | Contents |
|---|---|
| `packages/spec` | Data generated from `Shopify/theme-liquid-docs`: object types, the filter/tag/object registry, corpus inputs, system translations. |
| `packages/theme` | `ThemeFileSystem` (memory and Node), JSONC parsing, theme paths. |
| `packages/data` | Snapshot schema (zod → JSON Schema), scenarios, the default fixture, and derivation of Liquid objects. |
| `packages/render` | Routes, assembly, Shopify filters/tags/objects on `liquidjs`, the render result, renderer registration for `check`. |
| `packages/check` | Static coverage of reachable files and features. |
| `packages/dev` | Dev server (two origins, file watcher, image route, blocked endpoints) and the inspector. |
| `packages/playground` | Static browser playground. |
| `packages/cli` | `render`, `check`, `dev`, `schema`. |
| `tools/` | Build, checks, benchmark fetching; `tools/oracle/` holds the Shopify comparison harness ([oracle.md](oracle.md)). |
| `fixtures/` | Generated default fixture (`fixtures/default`) and the original MIT sample theme. |
| `schemas/` | Published JSON Schemas for render, check and snapshot. |

The core (spec, theme, data, render, check) has no Node-only dependencies; file access goes through
`ThemeFileSystem`, so the same code runs in the playground.

## Generated Shopify documentation

`upstream.json` pins `Shopify/theme-liquid-docs` (MIT). Its raw files and license are kept in
`vendor/theme-liquid-docs/`. `pnpm generate` writes the registry, object types, corpus inputs
(without expected results) and system translations under `packages/spec/src/generated/`;
`pnpm generate:check` fails on drift. Documentation types are optional and nullable; untyped
properties stay `unknown`.

## Benchmarks

`benchmarks.json` pins Shopify's Dawn and Horizon themes. `pnpm benchmarks:fetch` downloads them at
those commits into a temporary directory outside the project and writes an ignored manifest
(`.local/benchmark-paths.json`). They are never committed or packaged; `pnpm license-guard` fails if
any project file matches a benchmark file hash, and checks the README disclaimer.

The fixture matrix renders 18 pages per theme ([SPEC §9.3](../SPEC.md#93-fixture-and-scenario-matrix)).

## Checks

| Command | What it verifies |
|---|---|
| `pnpm test` | Unit tests (`tests/*.test.ts`). Run `pnpm build` first; some tests load the browser bundle. |
| `pnpm benchmarks:check` | Deterministic static `check` output for both benchmarks with valid contracts and no parse or missing-reference errors. |
| `pnpm benchmarks:render-check` | All 36 matrix renders: repeat-run determinism and byte-identical Node and browser output, reporting Liquid errors and unsupported features. |
| `pnpm agent:contract-check` | The agent contract: copy Dawn, edit a section, find the change in `render --json`; an unknown filter makes `check --strict` exit 5; usage/input/fatal failures emit schema-valid JSON with no TTY. |
| `pnpm oracle:offline-check` | The comparison pipeline (instrumented copies, tree/text summaries, double-capture stability) on offline renders. Local pipeline evidence, never a Shopify golden. |
| `pnpm browser:playground-check` | Playground e2e over the matrix: inspector tree, diagnostics, sandbox isolation and no uploads. |
| `pnpm browser:inspector-check` | Dev inspector e2e over the matrix, plus a theme add-to-cart click recorded as `blocked-endpoint`. |
| `pnpm browser:render-smoke` | A loopback page that renders the matrix in the browser. |
| `pnpm language:check --suite-dir <dir>` | Pinned `Shopify/liquid-spec` basics through the real renderer (needs Git and Ruby's YAML loader). |
| `pnpm test:network-off` | Builds `tools/ci/Dockerfile` and runs the foundation checks with `--network none`. |
| `pnpm test:browser-offline` | Builds `tools/ci/browser.Dockerfile` (Chromium installed at build time) and runs every browser check with networking disabled. |

`tools/check-playground-interactions.ts` and `tools/check-inspector-interactions.ts` cover the
interactive flows (zip and folder input, hot reload, highlighting, design mode, 501 endpoints).

None of these checks compares output with Shopify. `pnpm parity:check` does, against captured
goldens; it fails until real captures exist ([oracle.md](oracle.md#parity-check)).

## CI

`.github/workflows/ci.yml` runs on pull requests and `main`:

- `unit`: `pnpm verify`, `benchmarks:fetch`, `agent:contract-check`;
- `network-off`: the foundation checks in a container with `--network none`;
- `license-guard`;
- `browser`: the browser checks in a container with `--network none`.

`.github/workflows/pages.yml` publishes the playground from `main` after
`pnpm pages:artifact-check` confirms the artifact contains no benchmark theme files.
