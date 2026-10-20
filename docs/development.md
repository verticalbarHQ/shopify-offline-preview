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

`pnpm docs:drift-check` compares the vendored files with upstream's default branch and fails when
they differ. The `docs-drift` workflow runs it every Monday and can be started by hand; it does
not open pull requests. To take an upstream change, run `pnpm docs:drift-check --update`, which
writes the new files and moves the pin. Then run `pnpm generate`, review the generated changes and
open a pull request.

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
| `pnpm package:check` | Builds and installs the npm tarball in a temporary project outside the checkout, then checks the CLI, schemas, dev server assets, ESM imports and TypeScript declarations without `skipLibCheck`. |
| `pnpm benchmarks:check` | `check` output for both benchmark themes is deterministic, matches its schema, has no parse or missing-file errors, and has no missing Shopify features. |
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

- `unit`: `pnpm verify`, the installed-package check, `benchmarks:fetch`, `agent:contract-check` and `pages:artifact-check`;
- `network-off`: the main checks in a container without networking;
- `browser`: the browser checks in a container without networking;
- `license-guard`.

`.github/workflows/docs-drift.yml` runs `pnpm docs:drift-check` every Monday and on demand (see
[Generated Shopify data](#generated-shopify-data)).

`.github/workflows/pages.yml` publishes the playground from `main`. Before that,
`pnpm pages:artifact-check` confirms that the artifact contains no benchmark theme files or
names. The `unit` job runs the same check on pull requests.

## Publishing to npm

The root package is `@verticalbar/shopify-offline-preview`; the workspace packages are internal.
Use a clean, reviewed commit with green CI. The public declarations reference `liquidjs`, whose
types require `@types/node`, so Node types are a production dependency.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm package:check
mkdir -p .local
npm pack --pack-destination .local
npm publish .local/verticalbar-shopify-offline-preview-1.0.0.tgz --access public --registry=https://registry.npmjs.org
```

Use the version in `package.json` for the tarball name. `prepack` rebuilds `dist` from scratch.
Publishing requires an npm login with write access
to `@verticalbar`, including any authentication challenge npm requests. Publish the inspected
tarball so its bytes are the same ones recorded for the release.

After publishing, verify `npm view @verticalbar/shopify-offline-preview version dist.integrity`,
install the registry package in an empty directory and run `npx shopify-offline-preview schema snapshot`.
Tag the published source commit `v<version>` only after the registry check succeeds. If a bad
version is released, deprecate it and publish a corrected patch version; never reuse its number.

## Agent eval

`pnpm agent:eval` measures how well a coding agent completes ten theme tasks with only this
package's CLI and file access (SPEC §9.12). It is a report, not a check, and it does not run in CI.

```sh
pnpm agent:eval --package @verticalbar/shopify-offline-preview@1.0.0 --self-test
pnpm agent:eval --package @verticalbar/shopify-offline-preview@1.0.0 \
  --agent 'codex exec --skip-git-repo-check "$(cat "$PROMPT_FILE")" < /dev/null' --env CODEX_HOME
```

Each task runs in a new folder outside the repository with a copy of the pinned Dawn theme and the
package installed from npm.

- The agent command runs there with `sh -c`, and `$PROMPT_FILE` holds the prompt.
- The agent gets a `HOME` inside the folder and only `PATH`, `TMPDIR`, `LANG` and the variables
  named with `--env`.
- It still runs as your user without an OS sandbox. Run it on a machine or account that holds no
  store credentials, or in a container.
- After the agent exits, its process group is stopped, and the task's check script renders the
  result with an untouched copy of the CLI to decide pass or fail.

Two other modes skip the agent:

- `--self-test` proves that each check fails on the untouched theme and passes on a known solution.
- `--recheck <results.json>` judges a finished run's folders again with the current checks, using
  the package and theme recorded with that run.

The tasks and checks are in `tools/agent-eval/tasks.ts`; results go to `.local/agent-eval/`.

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
before the capture, such as the preview's diagnostic badges. `setup` lists paths visited once on that
side before the captures, such as `/cart/add?id=<variant id>&quantity=2` to fill the cart. The report shows benchmark theme
output, so keep it out of the repository; `.local/` is ignored.

None of the commands below changes a store.

| Command | Purpose |
|---|---|
| `pnpm oracle:visual-compare <config>` | Captures and compares two origins as described above. The browser blocks every request that is not a read, including requests from the pages' own scripts, apart from the storefront password submission. |
| `pnpm oracle:record-verification <config>` | Re-renders the pages a comparison judged similar and records which Shopify features ran, plus the documented filter examples that matched Shopify exactly, in `packages/spec/src/verification.ts`. `check` reports these features as `verified`. A theme entry can carry its own `data`, `pages` and `date`, for a comparison on another store or day. |
| `pnpm oracle:seed-prepare` | Plans the store state for the benchmark pages from a snapshot and its images. |
| `pnpm oracle:seed-requests-prepare` | Compiles that plan into Admin API requests and validates them against an Admin API schema. |
| `pnpm oracle:backup-audit`, `pnpm oracle:supplemental-backup-audit` | Audit the store exports taken before the store is wiped. |
| `pnpm oracle:corpus-prepare` | Builds a theme that runs the documented filter examples, so Shopify's outputs can be captured. |

The modules that do change a store follow these rules:

- Before every operation, they confirm the pinned development store and its marker metafield
  `sop.oracle_store = "true"`.
- They push themes unpublished and never publish or delete them.
- They keep raw store responses in owner-only files under the ignored `.local/` directory.
