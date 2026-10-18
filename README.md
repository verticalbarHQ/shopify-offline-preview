Unofficial — not affiliated with or endorsed by Shopify

# shopify-offline-preview

Preview a Shopify Online Store 2.0 theme on your own machine, with no store, no Shopify account and
no internet connection. It renders the theme's pages from local store data. For each part of a
page it shows which section, block or snippet produced it and which data it read. Wherever the
preview cannot render what Shopify would, it flags the spot instead of leaving it out silently.

There are three ways to use it:

- a **browser playground**, with nothing to install;
- a **dev server** with an inspector, while you work on a theme;
- a **CLI** with JSON output, for scripts, CI and coding agents.

## Try it

### In your browser

Open <https://verticalbarhq.github.io/shopify-offline-preview/>. It starts with a small sample
theme. To see your own theme, choose **Theme zip** or **Theme folder**, or drop a zip onto the page.
Your files are processed in the browser and are never uploaded.

### On your machine

You need Node.js 22 or newer.

```sh
npx @verticalbar/shopify-offline-preview dev path/to/your-theme
```

Open the inspector at <http://127.0.0.1:3000/>. Saving a theme file reloads the preview.

To keep it in a project, install it as a development dependency. The command is then
`shopify-offline-preview`:

```sh
npm install --save-dev @verticalbar/shopify-offline-preview
npx shopify-offline-preview dev path/to/your-theme
```

Until you add your own data, pages render with a bundled sample store. It has 40 products, a
collection, a page, a blog with three articles, menus and a cart.

### From source

The repository also has a small sample theme. You need Node.js 22 or newer and pnpm 10.

```sh
git clone https://github.com/verticalbarHQ/shopify-offline-preview.git
cd shopify-offline-preview
pnpm install --frozen-lockfile
pnpm generate && pnpm build
node dist/cli.js dev fixtures/sample-theme
```

## The inspector

The page is on the left. The panel on the right has these parts:

- **Theme tree**: the layout, section groups, sections and blocks in render order, with snippets
  listed under the file that rendered them. Hover over a node to outline it on the page. Hover over
  the page to select a node.
- **Diagnostics**: everything the preview flagged on this page (see below).
- **Page activity**: blocked endpoint calls and requests to other sites, recorded while the page
  runs.
- **Data used**: the snapshot paths the selected node read, such as `products[0].variants[0].price`.
- **Source**: the file behind the selected node.

The toolbar has these controls:

- a path field, to go to another page;
- page width: mobile, tablet, desktop or full;
- a scenario selector (see [Use your own store data](#use-your-own-store-data));
- design mode, which sets `request.design_mode` as Shopify's theme editor does, so themes show
  their placeholder content.

The page runs on its own origin, so theme JavaScript cannot reach the inspector.

## Reading diagnostics

Each diagnostic has a code, a severity, the source file and line, and a message. Diagnostics are
listed in the inspector panel and in `render --json`. Most are also shown as badges on the page.

| Code | Meaning | What to do |
|---|---|---|
| `missing-resource` | The theme asked for data that the snapshot doesn't have, such as a product handle, a menu, an image file, an optional field or a translation. The value is empty, as it would be on a store without that data. | Add the data to your snapshot if the page should show it. |
| `not-implemented` | The theme uses a Shopify filter, tag or object property that the preview does not provide. The filter's output is replaced with `[not implemented: …]`. | Nothing. Your theme is fine; the preview differs from Shopify here. |
| `liquid-error` | A Liquid error, shown inline the way Shopify shows it: `Liquid error (sections/hero line 12): …`. | Fix the theme code. |
| `shopify-server-only` | Content that only Shopify's servers produce, such as checkout buttons and `content_for_header` scripts. It is left out. | Nothing. |
| `app-placeholder` | An app block or app embed. It is shown as a labelled placeholder. | Nothing. |
| `blocked-endpoint` | Theme JavaScript called a Shopify server endpoint, such as `/cart/add` or the Section Rendering API. The call returns HTTP 501. | Nothing. |
| `external-request` | The page loaded something from another site, such as fonts or scripts. | Nothing. |

## Use your own store data

Store data comes from a **snapshot**: a folder with a `snapshot.json` file and an `images/` folder.

```sh
shopify-offline-preview dev path/to/theme --data path/to/snapshot
```

The tool never connects to a store. Get your data out with any export tool, then convert it to the
snapshot format. The quickest way to start is to copy the bundled sample store and edit it. It is
in the package at `fixtures/default/`, for example
`node_modules/@verticalbar/shopify-offline-preview/fixtures/default/`. If a snapshot is invalid, rendering stops and the error names the
field at fault (exit code 3).

A snapshot can also define **scenarios**: named variations of the data, such as a sold-out product
or a full cart. Choose one with `--scenario <name>` or in the inspector.

[docs/snapshot.md](docs/snapshot.md) describes every field. `shopify-offline-preview schema snapshot`
prints the JSON Schema.

## Commands

```text
shopify-offline-preview dev    <theme> [--data <dir>] [--scenario <name>] [--design-mode] [--port <n>]
shopify-offline-preview render <theme> <path> [--data <dir>] [--scenario <name>] [--design-mode] [--json] [--out <file>]
shopify-offline-preview check  <theme> [--json] [--strict]
shopify-offline-preview schema <render|check|snapshot>
```

In a source checkout, run each command as `node dist/cli.js <command> …`.

**`dev`** starts the inspector on `127.0.0.1:<port>` and the preview on the next port. The default
port is 3000. It re-renders when theme or snapshot files change.

**`render`** renders one storefront path. It prints the HTML to stdout and the diagnostics to
stderr. `--out <file>` writes the HTML to a file instead.

- **Paths.** These paths render:
  - `/`;
  - `/products/<handle>`;
  - `/collections`, `/collections/<handle>` and `/collections/all`;
  - `/pages/<handle>`;
  - `/blogs/<blog>` and `/blogs/<blog>/<article>`;
  - `/search?q=…`;
  - `/cart`.

  Any other path renders the 404 template.
- **Query parameters.** `?variant=`, `?page=`, `?sort_by=`, `?filter.…=` and `?view=` work as they
  do on a store.
- **JSON output.** `--json` prints a single object instead:
  - `html`;
  - `tree`: the section and block tree;
  - `diagnostics`;
  - `dataUsed`: the snapshot paths each tree node read;
  - `route`: the path, page type and template.

**`check`** reads a theme without rendering it. For each template it lists:

- the files the template reaches;
- the Shopify filters, tags, objects and properties those files use, with file and line.

Each feature has these flags:

- `implemented` (also `registered`): the preview provides the feature.
- `serverOnly`: only Shopify's servers produce it, for example a logged-in customer or a discount.
  The preview leaves it out by design.
- `verified`: a comparison with a real Shopify store showed it behaving like Shopify. `oracleCases`
  names those comparisons.

`unimplementedCount` counts the features that are neither implemented nor server-only.

**`schema`** prints the JSON Schema for `render --json`, `check --json` or the snapshot.

Commands never prompt for input. With `--json`, a command prints exactly one JSON document that
matches its schema, even when it fails. Messages go to stderr.

| Exit code | Meaning |
|---|---|
| 0 | Success. Diagnostics may still be present. |
| 2 | Usage error. |
| 3 | The theme or snapshot could not be loaded or is invalid. |
| 4 | Rendering failed. |
| 5 | `check --strict` found one of these: a reachable feature that is neither implemented nor server-only, or part of the theme it could not analyse. |

## Contributing

[docs/development.md](docs/development.md) covers the repository layout, the test suites and CI.
[SPEC.md](SPEC.md) records the project's goals and design.

## License

MIT. Shopify's Dawn and Horizon themes are used only as test inputs. They are downloaded at pinned
commits when checks run, and are never committed or redistributed. The generated Shopify
documentation data comes from the MIT-licensed `Shopify/theme-liquid-docs`; see
`THIRD_PARTY_NOTICES.md`.
