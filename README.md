Unofficial — not affiliated with or endorsed by Shopify

# shopify-offline-preview

Open a Shopify Online Store 2.0 theme without a store, an account, or an internet connection. The
tool renders the theme's pages from a local data snapshot, shows how each page is assembled
(layout, section groups, sections, blocks, snippets and the data they read), and marks every place
where it cannot reproduce Shopify instead of hiding it. People use it through a dev server and a
browser playground; coding agents use a non-interactive CLI with JSON output.

**Status.** Rendering, the dev inspector and the browser playground work locally on the pinned Dawn
and Horizon benchmarks. Output is an approximation: no page has yet been compared with a real
Shopify render, so no feature is claimed as Shopify-verified ([SPEC §9](SPEC.md#9-verification-system)).
The npm package is private during development and has not been published.

## Try it

- **In the browser:** <https://verticalbarhq.github.io/shopify-offline-preview/> opens the bundled
  sample theme. Drop a theme zip or folder (and optionally a snapshot) onto the page. Everything is
  processed in the browser; nothing is uploaded.
- **Locally** (Node.js 22+, pnpm 10.34.7):

  ```sh
  pnpm install --frozen-lockfile
  pnpm generate && pnpm build
  node dist/cli.js dev /path/to/theme --data /path/to/snapshot   # inspector + preview
  node dist/cli.js render /path/to/theme /products/example --json  # one page as JSON
  node dist/cli.js check /path/to/theme --json                     # static feature coverage
  node dist/cli.js schema snapshot                                 # input JSON Schema
  ```

Without `--data`, a bundled synthetic store (40 products, a collection, a page, a blog, menus and
a cart scenario) is used.

## Reading the result

Every render returns diagnostics. They appear as badges in the inspector and in `render --json`.

| Code | Meaning | What to do |
|---|---|---|
| `not-implemented` | A Shopify filter, tag, object property or behaviour has no offline implementation. Filters print `[not implemented: …]` where they would output. | Nothing in the theme is wrong; the preview differs here. |
| `missing-resource` | The snapshot does not supply the data or resource the theme asked for (a handle, an optional field, a translation, placeholder artwork). The value is nil, as Shopify renders a missing resource. | Add the data to the snapshot if the page depends on it. |
| `shopify-server-only` | Output only Shopify's servers can produce (checkout buttons, `content_for_header` scripts, font CDN URLs). It is omitted. | Expected; informational. |
| `app-placeholder` | An app block or embed, shown as a labelled placeholder. | Expected; apps do not run offline. |
| `liquid-error` | A Liquid error, rendered inline the way Shopify renders it. | Fix the theme code. |
| `blocked-endpoint` | Theme JavaScript called a server endpoint (`/cart/add`, Section Rendering API, …). It returns HTTP 501 offline. | Expected; endpoints are not emulated. |
| `external-request` | The page loaded a third-party resource (fonts, scripts). | Informational. |

## Your own data

A snapshot is a folder with `snapshot.json` and an `images/` folder, following
`schemas/snapshot.schema.json` (`node dist/cli.js schema snapshot`). Prepare it with any export or
collection tool; the library never contacts a store. See [docs/snapshot.md](docs/snapshot.md) for
the format, including typed metafields, product media, localization and the optional fields that
remove `missing-resource` diagnostics.

## Commands

| Command | Purpose |
|---|---|
| `render <theme> <path> [--data <dir>] [--scenario <name>] [--design-mode] [--json] [--out <file>]` | Renders one storefront path. `--json` prints `{schemaVersion, html, tree, diagnostics, dataUsed, route}`; `--out` writes the HTML to a file. |
| `check <theme> [--json] [--strict]` | Lists the filters, tags, objects and properties reachable from each JSON template, with source lines. `registered` says whether the offline renderer provides a feature; `implemented` additionally requires a Shopify oracle case, so it is `false` until oracle results exist. |
| `dev <theme> [--data <dir>] [--scenario <name>] [--design-mode] [--port <n>]` | Starts the inspector and the preview on two loopback origins, with hot reload. |
| `schema <render\|check\|snapshot>` | Prints the published JSON Schema. |

All commands are non-interactive. With `--json`, a command prints exactly one schema-valid JSON
document, also on failure; human-readable errors go to stderr. Exit codes: `0` success
(diagnostics may still be present), `2` usage error, `3` invalid theme or snapshot, `4` fatal render
failure, `5` `check --strict` found unimplemented features or incomplete coverage.

## Inspector and playground

`dev` shows the page in an iframe next to the section/block tree, the diagnostics and the snapshot
paths each node read. Hover a section or block to highlight it on the page; snippets are listed
under their callers. Width presets (mobile, tablet, desktop, full), the scenario selector and the
design-mode toggle re-render locally, and theme or snapshot edits reload the preview. The page runs
on its own origin, so theme JavaScript cannot reach the inspector; unsupported Shopify endpoints
answer HTTP 501 and are badged.

`pnpm build` also writes the static playground to `dist/playground/`. It shares the inspector and
runs the theme in an opaque sandboxed iframe. Theme assets and snapshot images become data URLs and
module imports use an import map. Scoped import maps and circular CSS imports fail explicitly.

## How rendering works

[docs/rendering.md](docs/rendering.md) describes what the renderer derives from the snapshot, how
templates, settings and blocks are resolved, which Shopify behaviour is reproduced, and what stays
diagnosed. In short: JSON templates, layouts, section groups, classic and theme blocks, snippets,
forms, pagination, collection sorting and filtering, search, menus, metafields, product media and
most display filters run offline; checkout, customer accounts, app code and server-generated
content do not.

## Development

[docs/development.md](docs/development.md) covers the generated Shopify documentation, the
benchmark themes, and the checks CI runs (unit, network-off container, browser container, license
guard). [docs/oracle.md](docs/oracle.md) describes the internal tools for comparing renders with a
real Shopify development store; they are not part of the published package.

The product specification and acceptance criteria are in [SPEC.md](SPEC.md).

## License

MIT. Shopify's Dawn and Horizon themes are used only as test inputs; they are downloaded at pinned
commits for checks and are never committed or redistributed. Generated Shopify documentation data
comes from the MIT-licensed `Shopify/theme-liquid-docs`; see `THIRD_PARTY_NOTICES.md`.
