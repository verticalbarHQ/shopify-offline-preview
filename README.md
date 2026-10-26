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

Install the published package with Node.js 22 or newer:

```sh
npm install --global @verticalbar/shopify-offline-preview
shopify-offline-preview dev path/to/theme --data path/to/snapshot
```

For a source checkout, use pnpm 10:

```sh
git clone https://github.com/verticalbarHQ/shopify-offline-preview.git
cd shopify-offline-preview
pnpm install --frozen-lockfile
pnpm generate && pnpm build
node dist/cli.js dev fixtures/sample-theme
```

Open the inspector at <http://127.0.0.1:3000/>. To preview your own theme, replace
`fixtures/sample-theme` with your theme folder. Saving a theme file reloads the preview.

Until you add your own data, pages render with a bundled sample store. It has 40 products, a
collection, a page, a blog with three articles, menus and a cart.

The package also exports `@verticalbar/shopify-offline-preview/browser` for in-browser rendering.
Always supply your snapshot when showing backed-up store data; omitting it selects the sample store.

Saved JSON and Liquid templates are supported for the listed page types. A resource's assigned
template or `?view=` can select either format; a missing alternate uses the captured assigned or
default template. Liquid templates use `layout/theme.liquid` unless a quoted `layout` declaration
selects another captured layout or `layout none` omits it. Missing template/layout files remain
errors. Support for a Liquid template does not imply compatibility with every vintage-theme feature.
The static checker follows literal layouts in conditional branches and reports incomplete analysis
when selecting a layout needs runtime coverage.
Liquid template execution has its own render-tree root using the existing `layout` kind and a
`template:<name>` type. Its exact template file, nested nodes and inspected data reads remain
separate from the selected outer layout.

`renderTheme(theme, path, { snapshot, liquidErrors: "omit" })` omits inline Liquid error text
while retaining the same `liquid-error` diagnostics and successful output from the same file.
The default `"inline"` behavior is unchanged. This option does not certify a useful preview:
hosts must still distinguish an empty/error-only page from content they can display.

## Saved backup content (1.0.5)

Hosts displaying captured content can opt into `renderTheme(theme, path, {
  snapshot, liquidErrors: "omit", backupPreview: { standardMoneyFormat: true }
})`. `backupPreview` is optional; ordinary theme development keeps its existing behavior.
This policy reconstructs saved content and does not promise the historical public storefront.

- Unknown product prices and availability remain unknown through Liquid defaults, assignments
  and conditions, including captures and iteration. A capture's direct output preserves its
  known markup; using its uncertain value in a fallback or condition remains restricted.
  A missing value must not become a theme's sample price or sold-out badge.
- Captured money formats remain authoritative. `standardMoneyFormat: true` explicitly permits
  `USD 699.95`-style output when an older snapshot lacks the format. Omit it or use `false` when
  failed new collection of that setting must leave the expression unknown, including downstream
  defaults or captures. The snapshot is unchanged.
- Unknown selected-price values are omitted through granular value guards. Ordinary assignments
  and branches still execute, preserving known product minima, native wrappers, titles, media and
  unrelated body content. An earlier selected-variant alias or an unused `use_variant` argument
  does not erase a later known value. In a bounded price-only snippet, a complete variant set
  with identical prices and compare-at values can use its common product price without selecting
  a variant. A missing product in such a snippet uses decorative blank content and a static bar
  while retaining the supported theme's native price line box. Unrecognized snippet content
  retains granular rendering. Source-proven unit-price regions are omitted when their amount or
  measurement is unknown. The renderer does not rewrite arbitrary HTML numbers.
- An emitted known price in a proven price-only snippet can make its dedicated noninteractive
  `no-js-hidden` wrapper visible. Other hidden content and theme JavaScript stay unchanged.
  For a source-proven Dawn-style `product-variant-picker` select, unknown selection uses a blank,
  disabled, non-product option; actual variant options remain saved content. Known selection
  and unrelated controls are unchanged. No first variant is silently chosen by the browser.
- An unknown selected variant keeps its identity and commercial values unknown. Its uncaptured
  `featured_media` reference does not exclude independently saved product-gallery images.
  Known selected-media references retain the theme's normal duplicate removal.
- A collection's absent `products` is unknown membership; `products: []` is known empty.
  Unknown membership can retain the theme's empty-card layout. Known empty membership does not
  run a collection loop's sample-card `else` branch. Card counts are never invented by the renderer.
- An explicitly missing member uses its original position: provide its handle in both the
  ordered `products` and `missingProducts` arrays, with no corresponding product record.
  Undeclared broken references remain invalid. Filters that discard or reorder these slots
  produce an internal diagnostic and an unknown list, without running sample-empty branches.
  Known-empty semantics survive supported list transformations.

Neutral decoration markers preserve a supported theme's card layout. The empty
`span[data-sop-backup-image-placeholder]` is 24×24 CSS pixels inside a positioning wrapper;
`[data-sop-backup-price-placeholder]` is a static decorative bar. Both are `aria-hidden` and
contain no animation, loading text or product facts. The package includes no host icon artwork.
A host can populate the image marker with its own trusted, licensed static glyph. Older
`snippets/card-product.liquid` media boxes with one `card__inner` boundary are supported even
without `placeholder_svg_tag`; unsupported boundaries produce an internal diagnostic.

This option does not sanitize HTML or sandbox theme scripts. Embedding hosts remain responsible
for their sanitizer, iframe sandbox, CSP, captured-asset ownership and blocked external requests,
including HTML in captured money formats and their own placeholder artwork.

## Fonts in captured themes

System font settings use Shopify's published family, fallback, weight and style metadata.
They do not produce a font URL or `@font-face`; the browser uses fonts installed on its OS.
Supported system families are `mono`, `serif`, `sans-serif`, `sans_serif`, `arial`,
`courier_new`, `garamond`, `lucida_grande`, `monaco`, `palatino`, `system_ui`,
`times_new_roman` and `trebuchet_ms`, with their documented variants.

Historical `helvetica_*` settings retain their original Monotype metadata, including
oblique variants. They are not converted to the replacement `sans_serif` setting.
Because the original CDN files are not captured by this library, `font_face` and
`font_url` return no resource and report `missing-resource`; the CSS family and original
fallback stack still apply. A locally installed Helvetica face is not proof of original
CDN-byte fidelity. Unknown settings and variants remain unsupported.

Custom font files already stored in theme `assets/` can be referenced by the theme's
own `@font-face` and `asset_url`. The host must serve those captured bytes. This library
does not collect new Shopify/CDN font files or modify historical inputs. The existing
Google substitutions for Inter, Assistant, Work Sans and Anonymous Pro are unchanged;
hosts requiring captured resources only must block those external URLs, as for all
other external theme resources.

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
node dist/cli.js dev path/to/theme --data path/to/snapshot
```

The tool never connects to a store. Get your data out with any export tool, then convert it to the
snapshot format. The quickest way to start is to copy the bundled sample store in
`fixtures/default/` and edit it. If a snapshot is invalid, rendering stops and the error names the
field at fault (exit code 3).

A snapshot can also define **scenarios**: named variations of the data, such as a sold-out product
or a full cart. Choose one with `--scenario <name>` or in the inspector.

[The snapshot guide](https://github.com/verticalbarHQ/shopify-offline-preview/blob/main/docs/snapshot.md)
describes every field. `node dist/cli.js schema snapshot` prints the JSON Schema.

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
