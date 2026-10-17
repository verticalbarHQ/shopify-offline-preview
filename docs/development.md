# Development

You need Node.js 22 or newer and pnpm 10.34.7. The container checks also need Docker.

```sh
pnpm install --frozen-lockfile
pnpm generate        # generated Shopify data, JSON Schemas and the sample store
pnpm verify          # generate:check, typecheck, lint, build and unit tests
```

## Layout

| Path | Contents |
|---|---|
| `packages/spec` | Data generated from `Shopify/theme-liquid-docs`: object types, the filter/tag/object registry, filter examples and system translations. |
| `packages/theme` | `ThemeFileSystem` (in memory and Node), JSONC parsing, theme paths. |
| `packages/data` | The snapshot schema (zod, exported as JSON Schema), scenarios, the sample store, and the Liquid objects built from a snapshot. |
| `packages/render` | Routes, page assembly, Shopify filters, tags and objects on `liquidjs`, and the render result. |
| `packages/check` | Static analysis behind `check`. |
| `packages/dev` | The dev server and the inspector. |
| `packages/playground` | The browser playground. |
| `packages/cli` | The `render`, `check`, `dev` and `schema` commands. |
| `tools/` | Build scripts, checks and benchmark fetching. `tools/oracle/` holds the Shopify comparison tools. |
| `fixtures/` | The sample store (`fixtures/default`, generated) and the sample theme. |
| `schemas/` | The published JSON Schemas. |

The core packages (spec, theme, data, render, check) use no Node-only APIs. File access goes
through `ThemeFileSystem`, so the same code runs in the playground.

## Generated Shopify data

`upstream.json` pins `Shopify/theme-liquid-docs` (MIT), whose files are kept in
`vendor/theme-liquid-docs/`. `pnpm generate` writes the generated data to
`packages/spec/src/generated/`, and `pnpm generate:check` fails if it is out of date.

## Benchmark themes

`benchmarks.json` pins Shopify's Dawn and Horizon themes. `pnpm benchmarks:fetch` downloads them
into a temporary directory outside the repository. Their licenses do not allow redistribution, so
they are never committed or packaged. `pnpm license-guard` fails if any repository file matches a
benchmark file, or if the README's first line is not the disclaimer.

The benchmark checks render 18 pages per theme: home, product, collection, page, search, cart, 404,
blog and article, in several scenarios of the sample store.

## Checks

| Command | What it checks |
|---|---|
| `pnpm test` | Unit tests in `tests/`. Run `pnpm build` first; some tests load the browser bundle. |
| `pnpm benchmarks:check` | `check` output for both benchmark themes is deterministic, matches its schema, and has no parse or missing-file errors. |
| `pnpm benchmarks:render-check` | All 36 benchmark renders are repeatable and byte-identical between Node and the browser build. |
| `pnpm agent:contract-check` | The CLI contract: copy Dawn, edit a section, and find the edit in `render --json`; `check --strict` exits 5 on an unknown filter; every failure prints schema-valid JSON without a TTY. |
| `pnpm browser:playground-check` | The playground across the benchmark pages: inspector tree, diagnostics, sandboxing, and no uploads. |
| `pnpm browser:inspector-check` | The dev inspector across the benchmark pages, including an add-to-cart click recorded as `blocked-endpoint`. |
| `pnpm browser:render-smoke` | A local page that renders the benchmark pages in the browser. |
| `pnpm language:check --suite-dir <dir>` | Basic `Shopify/liquid-spec` cases through the renderer. Needs Git and Ruby. |
| `pnpm oracle:offline-check` | The comparison pipeline (instrumented copies, summaries, repeat stability) on offline renders. |
| `pnpm test:network-off` | Runs the main checks in a Docker container with networking disabled. |
| `pnpm test:browser-offline` | Runs the browser checks in a Docker container with networking disabled. |

`tools/check-playground-interactions.ts` and `tools/check-inspector-interactions.ts` cover the
interactive flows: zip and folder input, hot reload, highlighting, design mode and blocked
endpoints.

## CI

`.github/workflows/ci.yml` runs on pull requests and on `main`:

- `unit`: `pnpm verify`, `benchmarks:fetch`, `agent:contract-check` and `pages:artifact-check`;
- `network-off`: the main checks in a container without networking;
- `browser`: the browser checks in a container without networking;
- `license-guard`.

`.github/workflows/pages.yml` publishes the playground from `main`. Before that,
`pnpm pages:artifact-check` confirms that the artifact contains no benchmark theme files or
names. The `unit` job runs the same check on pull requests.

## Shopify comparison tools

`tools/oracle/` holds the tools for comparing the preview with a real Shopify store. They are
development tools and are not part of the package. [SPEC §9](../SPEC.md#9-verification-system)
describes the check: a one-off, side-by-side look that a person judges, not a CI gate.

1. Seed a dedicated Shopify development store from the sample store.
2. Push the benchmark themes as unpublished themes.
3. Start the dev server on the same theme and data, then run `pnpm oracle:visual-compare <config>`.
   It opens each page on both sides at desktop and mobile widths and writes a local report: the two
   screenshots side by side, the section order, and the text found on only one side.
4. Go through the report and list each difference as OK or fix.

The config names the two origins, the widths and the pages:

```json
{
  "out": ".local/visual-compare",
  "widths": [1280, 390],
  "sides": [
    {
      "label": "Shopify",
      "origin": "https://<store>.myshopify.com",
      "passwordEnv": "SOP_STOREFRONT_PASSWORD",
      "params": { "preview_theme_id": "<unpublished theme id>" }
    },
    { "label": "Offline preview", "origin": "http://127.0.0.1:3001", "hide": ["#sop-diagnostic-badges"] }
  ],
  "pages": [{ "name": "home", "path": "/" }, { "name": "product", "path": "/products/<handle>" }]
}
```

`passwordEnv` names the environment variable that holds the storefront password. `params` are added
to every page on that side, which is how the store shows an unpublished theme. `hide` hides elements
before the capture, such as the preview's diagnostic badges. The report shows benchmark theme
output, so keep it out of the repository; `.local/` is ignored.

None of the commands below changes a store.

| Command | Purpose |
|---|---|
| `pnpm oracle:visual-compare <config>` | Captures and compares two origins as described above. The browser blocks every request that is not a read, including requests from the pages' own scripts, apart from the storefront password submission. |
| `pnpm oracle:seed-prepare` | Plans the store state for the benchmark pages from a snapshot and its images. |
| `pnpm oracle:seed-requests-prepare` | Compiles that plan into Admin API requests and validates them against an Admin API schema. |
| `pnpm oracle:backup-audit`, `pnpm oracle:supplemental-backup-audit` | Audit the store exports taken before the store is wiped. |
| `pnpm oracle:corpus-prepare` | Builds a theme that runs the documented filter examples, so Shopify's outputs can be captured. |

The modules that do change a store follow these rules:

- Before every operation, they confirm the pinned development store and its marker metafield
  `sop.oracle_store = "true"`.
- They push themes unpublished and never publish or delete them.
- They keep raw store responses in owner-only files under the ignored `.local/` directory.
