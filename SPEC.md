# shopify-offline-preview — Specification

> **Unofficial — not affiliated with or endorsed by Shopify.**

| | |
|---|---|
| Status | Offline renderer, dev inspector, and static browser playground implemented. Real Shopify oracle parity and feature completion remain pending. |
| Date | 2026-10-13 |
| Repository | `verticalbarHQ/shopify-offline-preview` (public) |
| npm package | `@verticalbar/shopify-offline-preview` (CLI command `shopify-offline-preview`), not published yet |
| License | MIT |
| Language | TypeScript, Node.js ≥ 22 and evergreen browsers |

---

## 1. Summary

`shopify-offline-preview` renders a Shopify Online Store 2.0 theme folder together with a local data
snapshot into browsable pages **without a Shopify store, account, or internet connection**. The output
is an approximation built for looking around and making edits. It is not a pixel-exact replica. The
tool shows how each page is assembled (layout, section groups, sections, blocks, snippets, and the
data each part used), and it **does not hide where it differs from Shopify**.

It is used by people (through a dev server with an inspector, or a hosted browser playground) and by
AI coding agents (through a non-interactive CLI with JSON output).

Correctness is not self-asserted. A verification harness renders the same themes with the same data
on a real Shopify development store and compares the results. That comparison is what defines "done".

## 2. Background

### 2.1 Why this does not exist already

- Shopify renders Liquid on its own servers. `shopify theme dev` uploads a hidden development theme and
  runs a local proxy. Each page request is rendered by Shopify, and unsaved local files are sent along
  as `replace_templates[...]` form fields. It needs a store, credentials, and network access. Verified
  in Shopify CLI 4.9.3 (`dist/chunk-XZHUUA6U.js`, `dist/chunk-LIE6QSQ2.js`).
- Shopify's stated reason for not offering local rendering (Slate docs) is that Shopify Liquid features
  are Ruby code "tightly coupled to our databases and servers" and "constantly changing".
- Shopify once shipped an offline theme toolkit, `Shopify/vision` ("Shopify in a box -- for template
  designers"). It was created in 2008, last pushed in 2012, and is now archived and deprecated.
- The core Liquid language is open: `Shopify/liquid` (Ruby) and `liquidjs` (JS, MIT, v10.30.0). The
  Shopify-specific layer is not: objects (`product`, `cart`, …), filters (`image_url`, `money`, `t`, …),
  tags (`section`, `form`, `paginate`, `schema`, `content_for`, …), and the JSON-template and
  section-group assembly rules.

### 2.2 Prior art (measured 2026-10-13)

The table compares each project against the Shopify-only features used by Dawn at commit `258f00f`:
36 Shopify-only filters and 9 Shopify-only tags.

| Project | What it is | Shopify-only filters | Shopify-only tags | Status |
|---|---|---|---|---|
| bosun-ai/snapify | In-memory LiquidJS render plus Playwright visual snapshots | 13 / 36 | 8 / 9 | MIT, v0.3.0, last update 2025-12 |
| Piyushmishra29/liquid-storefront | Self-hosted storefront serving a theme export | 17 / 36 | 4 / 9 (no `form`, `paginate`) | MIT, 0 stars, 2026-08 |
| kirchner-trevor/vscode-shopify-liquid-preview | Single-template preview with fake JSON | — | — | Inactive since 2022 |
| edlaver/liquidjs-shopify-compat | LiquidJS Shopify filters | `money*` only | — | Abandoned 2024 |
| Shopify/liquid-spec | Liquid language conformance suite | — | — | Active; used here as a test input |

None of these verifies its output against Shopify. That verification is this project's main
difference.

## 3. North Star

> **Given only a Shopify theme folder, a person or an AI agent can — without a store, an account, or
> an internet connection — open that theme's pages, see how each page is put together, and try edits.
> Wherever the result differs from Shopify, the tool shows it instead of hiding it.**

The North Star is reached when every acceptance criterion in §10 passes. Release 1.0 ships at that
point.

## 4. Users

| User | Situation | What they need |
|---|---|---|
| **Theme reader/editor** (primary, human) | Has a theme folder (for example a theme export, a client handoff, or a new project). Has no store access yet, or does not want to touch the live store. | Pages up in seconds, a clear map from screen to source file, and edits reflected immediately. |
| **AI coding agent** (target user, first-class) | Edits theme code. Cannot do an interactive Shopify login or run `theme dev`. | A non-interactive CLI with stable JSON output (HTML, section/block tree, diagnostics, data used), so it can edit and then verify its own change. |

## 5. Core user value

1. **Nothing required.** No store, account, login, or network. A theme folder is enough, and default
   data is generated.
2. **Structure is visible.** Every part of a page maps to its layout, section group, section, block,
   snippet, settings, and the data it read.
3. **Differences are shown, not hidden.** Unimplemented features, missing data, external app blocks,
   and unsupported JavaScript endpoints are marked in the page and listed in diagnostics.

## 6. Scope

### 6.1 In scope for 1.0

- Online Store 2.0 themes: JSON templates, section groups, classic section blocks, theme blocks
  (`blocks/`, `content_for 'blocks'`, static blocks via `content_for 'block'`, nested blocks), `@app`
  block placeholders, `{% stylesheet %}`, `{% javascript %}`, `{% style %}`, and `{% schema %}`.
- The page set in §9.3: home, product, collection, page, search, cart (empty and with items), 404,
  blog, and article.
- A Node CLI (`dev`, `render`, `check`, `schema`), a dev server with an inspector, a browser build of
  the core, and a hosted static web playground.
- Local snapshot input prepared through any external export or data-collection path, provided it
  conforms to the published snapshot schema. Real store data is a supported input in 1.0.
- The verification system in §9.

### 6.2 Non-goals

- Pixel-exact output. Screenshot similarity is reported but does not gate.
- Running theme JavaScript's server calls. The page is static only (see §7.4.7).
- Checkout, customer accounts, the password page, and gift cards.
- Running real third-party apps. Apps appear as placeholders.
- Editing settings through a UI. Edits are made to files and reflected by hot reload.
- Vintage (pre-2.0) themes: `.liquid` templates and `{% include %}`-era themes. `check` reports such a
  theme as unsupported.
- Hosting a real store (the direction liquid-storefront takes).
- Fetching or importing data directly from a live store. Data collection and conversion from
  provider-specific exports are external to this library; it consumes local snapshots (§7.1).
- An MCP server and a built-in screenshot command. Agents use the CLI and their own browser tooling.
- Contributing patches upstream to liquidjs. Behavior differences are fixed locally (§8.1).
- Multi-currency and Markets switching. A snapshot has one shop locale and one currency.

## 7. Product behavior

### 7.1 Inputs

- **Theme folder**: the standard theme layout (`layout/`, `templates/`, `sections/`, `blocks/`,
  `snippets/`, `config/`, `locales/`, `assets/`). JSON files are parsed as JSONC because Shopify adds
  a leading comment block. Theme files are never rewritten.
- **Snapshot** (optional): a directory with `snapshot.json` and an `images/` folder, in the
  source-shaped schema of §8.4. When it is omitted, the bundled default fixture is used.
  The snapshot may contain real store data obtained separately. External tools or the user prepare
  it in this schema and place image files locally; the library validates and consumes it without
  store access or credentials. Arbitrary Shopify exports are not accepted directly unless converted
  to this schema outside the library.
- **Scenario** (optional): a named overlay on the snapshot, for example `product-sold-out` (§9.3).

### 7.2 CLI contract

All commands are non-interactive. With `--json`, a command writes exactly one JSON document to
stdout, writes logs to stderr, and emits no ANSI color when stdout is not a TTY. Output ordering is
deterministic.

| Command | Purpose |
|---|---|
| `shopify-offline-preview dev <theme> [--data <dir>] [--scenario <name>] [--design-mode] [--port <n>]` | Starts the dev server and inspector (§7.3). |
| `shopify-offline-preview render <theme> <path> [--data] [--scenario] [--design-mode] [--json] [--out <file>]` | Renders one URL path. JSON output: `{schemaVersion, html, tree, diagnostics, dataUsed, route}`. |
| `shopify-offline-preview check <theme> [--json] [--strict]` | Static coverage (§9.11): the Shopify filters, tags, and objects reachable from each page type, and whether each is implemented, server-only or verified (§9.10). |
| `shopify-offline-preview schema <render\|check\|snapshot>` | Prints the published JSON Schema for that output or input. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success. Diagnostics may still be present in the output. |
| 2 | Usage error. |
| 3 | The theme or snapshot failed to load or validate. |
| 4 | Fatal render failure. |
| 5 | `check --strict` found reachable features that are missing (§9.10), or parts of the theme it could not analyse statically. |

### 7.3 Dev server and inspector

- **Two origins.** The inspector shell is served on one localhost port and the rendered page on
  another. Theme JavaScript therefore cannot reach inspector state. The two communicate through a
  `postMessage` bridge script that is injected only into the served page. Comparison and `render`
  outputs never include the bridge.
- **Layout.** The page is shown in an iframe on the left. The panel on the right shows:
  - the section/block tree, with snippets listed under their callers;
  - diagnostics for the current page;
  - the data paths each node read (for example `product.variants[0].price`).
  The panel can be collapsed. Device-width presets (mobile, tablet, desktop, full) set the iframe
  width, so responsive layouts can be checked even while the panel takes up space.
- **Highlighting.** Hovering a tree node highlights its DOM region in the page, and hovering the page
  selects the node. Section and block regions are highlightable. Snippets are listed but not
  highlighted, because snippet markers could land inside HTML attributes.
- **Hot reload.** A change to a theme file or snapshot file triggers a re-render and an iframe reload.
- **Scenario selector.** Switches between the scenarios defined in the snapshot.
- **Design mode toggle.** Sets `request.design_mode = true`, as Shopify's theme editor does, so themes
  show their own placeholder content for empty settings. It is off by default.
- **Badges.** These conditions are badged in the page and listed in diagnostics:
  - `missing-resource`: a setting points to a handle that is not in the snapshot, or the snapshot
    omits data the theme reads;
  - `not-implemented`: a filter, tag, or object property has no implementation;
  - `liquid-error`;
  - `app-placeholder`;
  - `blocked-endpoint`: theme JavaScript called an unsupported server endpoint;
  - `external-request`: the page loaded a third-party resource. This is listed for information only.

### 7.4 Rendering semantics

1. **Routes.**
   - Resource routes: `/`, `/products/:handle[?variant=]`, `/collections[?page=]`,
     `/collections/:handle[?page=&sort_by=]`, `/collections/all`, `/pages/:handle`,
     `/blogs/:blog[?page=]`, `/blogs/:blog/:article`, `/search?q=`, `/cart`.
   - Any unknown path renders the `404` template.
   - Template choice follows Shopify: the resource's `template_suffix`, or `?view=`.
2. **Assembly.**
   - The layout (`theme.liquid`, or the template's `layout` override) wraps
     `content_for_layout`.
   - JSON templates render their `order`, skipping sections marked `disabled`.
   - Section groups render where the layout calls `{% sections %}`.
   - Section wrapper markup matches Shopify's (`shopify-section`, `shopify-section-group-*`).
   - Setting and default resolution follows Shopify. Any discrepancy found by the oracle (§9) is a
     defect.
3. **Missing data.** A setting that references an absent resource resolves to nil, as on Shopify. The
   page renders as Shopify would and a `missing-resource` diagnostic is recorded. Nothing is
   synthesized. An optional snapshot field that a theme reads but the snapshot omits is reported
   the same way, separately from features that have no implementation (`not-implemented`).
4. **Errors.** Liquid errors render inline the way Shopify renders them (`Liquid error (<file> line
   <n>): …`) and rendering continues. Each one is also recorded as a diagnostic.
5. **Determinism.**
   - `now` comes from `snapshot.meta.now`. The sample store fixes it, so benchmark renders repeat.
   - The timezone is `shop.timezone`.
   - There are no random sources.
   - The same inputs produce byte-identical HTML in Node and in the browser.
6. **Network.** Producing HTML never touches the network.
   - The rendered page may load third-party resources (fonts, theme-embedded scripts). This is
     allowed by default, and each request is listed as an `external-request` diagnostic.
   - Without connectivity, only those resources are missing.
   - "Offline" in this project means it **works without internet**. It does not mean "blocks the
     internet" (§9.9 lane `network-off`).
7. **JavaScript endpoints are not emulated.**
   - These return HTTP 501 with JSON `{"error":"not available offline"}`, and the inspector records a
     `blocked-endpoint` event: `/cart/*.js`, `/cart/add`, `?section_id=` / `?sections=` (Section
     Rendering API), `/search/suggest`, `/recommendations/products`, and `/products/:handle.js`.
   - The cart page renders the cart state stored in the snapshot.
8. **Images.**
   - `image_url` and related filters return local URLs, `/sop/images/<file>?width=&height=&crop=`.
   - The server returns the original bytes and the browser scales them. There is no resizing and no
     native dependency.
   - A missing image is replaced by an SVG placeholder of the requested size.
   - Benchmark fixtures use the same image files that were uploaded to the oracle store.
9. **Fonts.**
   - `font_face` and `font_url` cannot reproduce Shopify font-CDN URLs, which contain hashes.
   - When online, families that also exist on Google Fonts load from there. Otherwise the theme's
     fallback stack applies.
   - This is best effort and is never gated.
10. **Apps.**
    - `@app` blocks and app embeds (`shopify://apps/<app>/blocks/<block>/<id>`) render as labelled
      placeholder elements with the app and block names.
    - Legacy app snippets render whatever the theme code produces from the snapshot. Usually that is
      nothing.
11. **Translations.**
    - The `t` filter reads `locales/<shop.locale>.json`, falls back to `*.default.json`, and supports
      interpolation and pluralization.
    - `shopify.*` keys come from `shopify_system_translations.json` in theme-liquid-docs.
    - A missing key renders as Shopify renders it (`translation missing: <locale>.<key>`).

### 7.5 Browser runtime and playground

- The core (spec, theme, data, render, check) has no Node-only dependencies. All file access
  goes through a `ThemeFileSystem` / `SnapshotSource` interface. Node uses `fs`. The browser uses an
  in-memory tree built from a zip file or from a folder opened with the File System Access API.
- The **web playground** is a static site on GitHub Pages:
  - The user drops a theme zip or opens a folder. Everything is processed inside the browser, and
    theme content is never uploaded.
  - It shows the same inspector as `dev`, with the default fixture or an uploaded snapshot.
  - It has no hot reload. Reloading the folder re-renders.

## 8. Architecture

### 8.1 Liquid engine

`liquidjs` is a pinned dependency. Shopify behavior is layered on top through liquidjs plugins and
overridden filters and tags. Differences that the oracle finds in core behavior (whitespace control,
number arithmetic, truthiness, error mode) are fixed in this layer. Patches are not sent upstream.

If a required behavior cannot be overridden through public extension points, the work stops for an
owner decision between forking and an alternative. It is not worked around silently.

The core language is checked against `Shopify/liquid-spec`.

### 8.2 Generated Shopify spec

`Shopify/theme-liquid-docs` (MIT) publishes `filters.json` (155 filters, 7 deprecated),
`objects.json` (142), `tags.json` (33), and `shopify_system_translations.json`. The files are pinned
to a commit. A generator produces:

- TypeScript types for every object;
- the registry of known filters, tags, and objects used by `check`;
- the conformance corpus inputs (§9.10).

A weekly job, which can also be run by hand, checks whether upstream has changed the pinned files.
When it has, the job fails and names the files. A maintainer then moves the pin, regenerates and
opens the pull request. GitHub Actions does not open pull requests in this repository (owner
decision, 2026-10-18).

### 8.3 Module layout

The repository is a pnpm workspace. It publishes **one** npm package,
`@verticalbar/shopify-offline-preview`, with the CLI bin `shopify-offline-preview` and the subpath
exports `/render`, `/check`, and `/browser`.

```
packages/
  spec/        generated from theme-liquid-docs (types, registry, corpus inputs)
  theme/       ThemeFileSystem, JSONC, theme paths
  data/        snapshot schema (zod → JSON Schema), scenarios, default fixture, derivation of Liquid objects
  render/      routes, assembly, Shopify filters/tags/objects on liquidjs, RenderResult, renderer registration
  check/       static coverage over reachable files
  dev/         Node dev server (two origins, watcher, image route, blocked endpoints) and the inspector UI
  playground/  static site (zip/folder loading, browser runtime)
  cli/         dev | render | check | schema
tools/oracle/  Shopify comparison: store guard, seeding, theme upload, side-by-side capture (not published)
benchmarks.json  pinned benchmark themes: { name, repo, commit }
```

The dialect (Shopify filters, tags and objects) lives in `render/` and `data/`, and the inspector UI
is shared by `dev/` and `playground/`; there are no separate `dialect`, `server` or `inspector`
packages.

### 8.4 Data model — snapshot (source-shaped)

The snapshot holds inputs only, never derived values. This keeps it internally consistent and allows
seeding a store from it directly.

This is also the input contract for data obtained through external tools. Fixture-to-store seeding
is the verification harness's direction, not a restriction on where user snapshots originate.
The library does not implement live-store collection or provider-specific export conversion.

- `meta`: `now`, `schemaVersion`
- `shop`: name, domain, locale, currency, `money_format`, `money_with_currency_format`, timezone,
  and optional metadata such as policies and the social sharing image.
  For benchmarks these are mirrored *from* the oracle store, because some of them cannot be set
  through the API.
- `products[]`: handle, title, `descriptionHtml`, vendor, `productType`, tags, `templateSuffix`,
  `options[]`, `variants[]`, `images[]`, `metafields`.
  - Each variant has a string `id`, `optionValues`, `price`, `compareAtPrice`, `available`, `sku`,
    `barcode`, and `image`. Source `price` and non-null `compareAtPrice` are decimal strings in the
    shop currency; derived Liquid prices are calculated later. Cart lines refer to `productHandle`
    and `variantId`.
  - Each image has `file`, `alt`, `width`, and `height`, and optional `id` and focal point (`null`
    when the merchant set none).
  - Options may list Shopify option value IDs and swatches per value.
  - Optional `media` lists the product's media in order: image entries by file, and videos, external
    videos and 3D models with their preview images and local source files.
  - `metafields` values written as `{type, value}` are typed metafields; other JSON values are
    legacy metafields exposed unchanged. Metaobject fields follow the same rule.
- `collections[]`: handle, title, `descriptionHtml`, image, ordered product handles, sort order,
  `templateSuffix`.
- `pages[]`, `blogs[]` (each with `articles[]`), `menus[]` (nested link lists), `metaobjects[]`.
- Optional `images[]`: uploads identified by their original filename, with local file, alt text,
  dimensions and optional source id/focal-point coordinates. These supply global filename lookups
  and image picker settings. Product images do not stand in for unspecified uploads.
- Optional `placeholderSvgs` and `paymentTypeSvgs`: externally prepared SVG strings keyed by
  documented placeholder names and by payment types. The strings contain the base SVG output without a root class. The renderer consumes them
  offline and applies class arguments without changing artwork bytes. Platform artwork is not
  redistributed with the library; absent entries produce `missing-resource` diagnostics.
- `cart`: lines (variant reference and quantity), note.
- `filters`: the storefront filter configuration used for collection facets.
- Optional `localization`: available countries and languages plus the selected country/language
  codes for the captured storefront context. Availability is source data, not inferred from the
  shop currency or locale. Missing localization remains nil and is diagnosed on access.
- `scenarios`: named overlays (JSON merge patches over the snapshot).

The data package **derives** the Liquid objects: `price`, `price_min` / `price_max`, `available`,
`first_available_variant`, `selected_or_first_available_variant`, `options_with_values`, URLs,
`featured_image`, collection membership, pagination, and search results. Derivation is part of
fidelity and is verified by the oracle.

### 8.5 Render result

`RenderResult` contains:

- `html`;
- `tree`: nodes for layout, section-group, section, block, and snippet, each with
  `{kind, id, type, file, settingsPath, children}`;
- `diagnostics[]`: `{code, severity, file, line, nodeId, message}`;
- `dataUsed`: data paths read, per node, recorded only when inspect mode is on;
- `route`.

The same JSON Schema serves the CLI (`render --json`), the inspector, and the playground.

## 9. Verification system

```
fixture (repo) ──seed──► oracle dev store ◄──push unpublished── benchmark theme (pinned)
                              │                                        │
                   storefront in a browser                  offline dev server, same fixture
                              ▼                                        ▼
                  screenshots + section text ──side by side──► local report ──► findings (OK / fix)
```

Comparing with Shopify is a one-off check that a person judges. It is not a gate. The question is
whether someone looking at both pages would say they are similar (§9.6). A maintainer runs it when a
fresh look is useful, for example before a release or after a large renderer change. Nothing about
it runs in CI.

### 9.1 Oracle store

- The oracle store is a development store in Vertical Bar's Shopify Partner account that is
  **dedicated to this project**; it was created for the comparison on 2026-10-17 (§14). A store
  that is used for anything else is never written to. Further dedicated development stores may be
  created for behavior that depends on the store's country or plan, such as unit prices.
- **Wipe guard.**
  - Destructive operations (wipe and reseed) run only after two checks: the store domain equals the
    one pinned in config, and the shop has the marker metafield `sop.oracle_store = "true"`.
  - The first wipe is a manual step. Existing data is exported first, and the owner confirms at that
    moment. Only after that may the marker be set.
- **Access.**
  - A custom app with Admin API scopes `write_products`, `write_publications`, `write_content`,
    `write_online_store_navigation`, `write_files`, `write_metaobjects`, and `write_themes`.
  - A second custom app, installed only on the dedicated stores, for setup that needs further
    scopes: languages, markets, legal policies and metaobject definitions (for swatches).
  - The storefront password.
  - The maintainer who runs the comparison holds these locally. They are never stored in the
    repository or in CI.
- **Seeding.**
  - Seeding is idempotent and runs from the fixture.
  - Products are published to the Online Store channel.
  - Menus, pages, blogs and articles, and the collection filter configuration are created.
  - Shop-level settings the API cannot set are verified against `snapshot.shop` before capture.
    A mismatch aborts the run.
- **Themes.** Each benchmark theme is pushed **unpublished**
  (`shopify theme push --unpublished`) and viewed through the storefront with
  `preview_theme_id=<id>`. Themes are never published.

### 9.2 Benchmarks

| Theme | Pinned commit (initial candidate) | Notes |
|---|---|---|
| Shopify/dawn | `258f00f` (2026-08-10) | Classic section blocks; 23 files use `block.shopify_attributes`. |
| Shopify/horizon | `5acd1b6` (2026-09-21) | Theme blocks: 45 `content_for 'blocks'`, 63 `content_for 'block'`. 95 block files: 64 emit `shopify_attributes` directly, 18 through snippets, 13 not at all. |

Their licenses allow use only "to develop themes that integrate or interoperate with Shopify". The
files are therefore **never committed**. CI downloads them at the pinned commit. Bumping a pin is a
deliberate PR.

### 9.3 Fixture and scenario matrix

The fixture is a deterministic default dataset committed to the repo. Images are generated pattern
PNGs. The matrix below is rendered for each benchmark theme, 18 renders per theme.

| Page | Scenarios |
|---|---|
| home | default |
| product | default (3 options, mixed sale/non-sale variants), `sold-out`, `single-variant` (Default Title), `no-images`, `long-content` (long title and description, more than 10 images) |
| collection | default (more products than one page), `page-2`, `empty` |
| page | default (rich text) |
| search | `q` matching exactly one product, `q` with no results |
| cart | empty, `with-items` (2 lines, one on sale) |
| 404 | unknown path |
| blog | default (3 articles) |
| article | `with-image`, `without-image` |

Search queries are chosen so that the result set is unambiguous, because Shopify's ranking is not
reproduced. The cart-with-items capture builds a storefront session cart first and then fetches
`/cart`.

### 9.4 Matching sections

Both sides use the unmodified benchmark theme at its pinned commit. Sections are matched by their
`shopify-section` wrapper ids, with the numeric part normalized (`template--\d+__x` →
`template--N__x`). Blocks are not compared on their own; their text is part of their section's text.

### 9.5 Capture

- Both sides load in a real browser at a desktop width (1280 px) and a mobile width (390 px). Theme
  JavaScript runs on both sides.
- For each page the capture records a full-page screenshot, the order of the top-level sections, and
  each section's visible text (`innerText`, NFC-normalized, whitespace collapsed) and height.
- One scenario per page type is enough: home, product, collection, page, search (a query that
  matches one product), cart (with items), 404, blog, and article (with an image).
- `pnpm oracle:visual-compare <config>` runs the capture and writes the report. Its browser lets
  only reads through, apart from the storefront password submission.
- Screenshots, captured text and the report stay on the maintainer's machine. They show benchmark
  theme output, so they are never committed.

### 9.6 What "similar" means

A page is similar when all three of these hold:

1. **Same sections in the same order.** No section is missing and none has moved.
2. **Same main content.** Product names, prices, availability labels, menus, collection names and
   the other text a shopper reads are the same.
3. **The layout does not look broken.** Nothing overlaps, and there are no large gaps or oddly sized
   images.

These differences are allowed:

- Fonts.
- Parts drawn by scripts rather than by the theme's Liquid: product recommendations, dynamic
  checkout buttons, Shopify's search ranking, and other output only Shopify's servers can produce,
  such as the Shop login button (`shopify-server-only`).
- A few pixels of spacing, and differences in image cropping.

The report shows, per section, the text found on only one side and the section heights on both. It
points the reviewer at differences. The judgement stays with the reviewer, and there is no numeric
pass rate.

### 9.7 Findings

Each difference goes into a findings list as **OK** or **fix**. **OK** is an allowed difference, or
a gap in the input data rather than in the renderer. **Fix** items are fixed or filed as issues. The
findings list stays with the maintainer's local results; user documentation does not list them.

**Owner review, 2026-10-18.** The owner reviewed the comparison reports for both benchmarks at 1280
and 390 px and found the pages similar (AC-1). The reports were rebuilt that day from `main` and
covered the §9.3 page types, the extended section templates, extra states (a second collection page,
no search results, an empty cart) and the feature pages. Every **fix** finding is fixed (AC-5).

Before the owner confirmed, the code was checked for anything that would make the comparison match
for the wrong reason:

- The renderer has no branch on a theme, page, product or other resource name.
- The comparison hides only Shopify's preview bar for unpublished themes and the preview's own
  diagnostic overlay.
- The renderer reads no stored Shopify page output. The only Shopify-made content it can draw is
  artwork supplied in the snapshot (`placeholderSvgs`, `paymentTypeSvgs`). It reuses that artwork,
  adding only a class the theme asks for to the SVG root.

The comparison's snapshot did carry two kinds of input that the sample store lacks:

- store settings that the setup API cannot set, such as the money format and time zone;
- Shopify's placeholder artwork in `placeholderSvgs`, which `placeholder_svg_tag` reuses (owner
  approved, 2026-10-18). Without that artwork, placeholders are empty boxes of the same size.

### 9.8 What is not done

- No stored Shopify results gate pull requests.
- No scheduled recapture.
- No private repository for raw captures.

### 9.9 CI lanes

| Lane | Trigger | Network | Gates |
|---|---|---|---|
| `unit` | PR | on | Unit tests, typecheck, lint, generated-spec drift check |
| `parity` | PR | **off** (container `--network none`) | The full matrix for both benchmarks: repeatable renders, static and dynamic coverage, agent contract tests |
| `browser` | PR | **off** for test steps; browsers come preinstalled in the image | Node vs. browser byte-identical HTML over the matrix; playground e2e |
| `license-guard` | PR | on | No repo file hash equals any benchmark theme file; README disclaimer present |
| `docs-drift` | Weekly, and by hand | on | Fails when theme-liquid-docs has changed the pinned files; a maintainer updates the pin and opens the PR (no automatic PR) |
| `agent-eval` | Manual, on a maintainer's machine (not a CI lane) | on | Report only (§9.12) |
| `release` | Tag | on | All of the above green |

### 9.10 Implemented, server-only and verified

`check` gives each Shopify feature it finds three independent facts:

- **Implemented**: the offline renderer provides it. That is a non-stub filter or tag, or an object
  or property that the renderer's objects expose. `check` reads this from the renderer's own
  registration.
- **Server-only**: only Shopify's servers can produce it, or it needs data that a snapshot does not
  carry. Examples are logged-in customers, discounts, selling plans, comments, store pickup and form
  errors. The preview leaves these out by design. They are listed with reasons in
  `packages/spec/src/server-only.ts`.
- **Verified**: a one-off Shopify comparison (§9.5) showed the feature behaving like Shopify. The
  evidence is one of two things:
  - the feature ran in a page pair that the comparison judged similar;
  - a documented filter example whose output matched Shopify's exactly. Of the pinned
    theme-liquid-docs filter examples, 235 have executable `raw_liquid` inputs. They are rendered
    on the oracle store from generated snippets in an alternate template, with paths mapped to
    fixture equivalents.

  `tools/oracle/record-verification.ts` records this evidence in
  `packages/spec/src/verification.ts`. It is information for the reader, not a gate.

A feature is **missing** when it is neither implemented nor server-only. Unknown filters and tags
count as missing, because Shopify rejects them too. A property that Shopify does not document for the
statically inferred type does not count, because static analysis can only approximate a variable's
type.

### 9.11 Coverage

- **Static.** For each page type, find the files reachable from the template: layout, section groups,
  sections, blocks, and statically named `render` targets. Dynamically named renders are flagged.
  Collect the Shopify filters, tags, and object properties they use. The missing count (§9.10) must
  be 0.
- **Dynamic.** Across the full matrix, record what actually executed. Liquid errors and
  not-implemented events must both be 0.

### 9.12 AI agent verification

- **Gating contract tests.**
  - Every `--json` output validates against its published JSON Schema.
  - Every command runs with no TTY and returns the documented exit codes.
  - A scripted scenario passes: copy Dawn, edit the text of one section, run `render --json`, and
    find the change in `tree` and in that section's text. Introduce an unknown filter, run
    `check --json --strict`, and get exit code 5 with the filter listed.
- **Report-only eval.**
  - A fixed task set (10 tasks, for example "show the product type above the product title and
    verify") is run by a headless coding agent that has file access and this CLI, and no store
    credentials.
  - Each task has an assertion script, and the success rate is recorded per run.
  - `pnpm agent:eval` runs it (`tools/agent-eval/`). The tasks use the pinned Dawn theme:

    | Task | The agent must |
    |---|---|
    | `product-type-above-title` | Show the product type above the product title, read from the product's data. |
    | `announcement-text` | Change the announcement bar message. |
    | `trust-badges-section` | Create a section with a heading and three items as blocks, after the main product section. |
    | `fix-liquid-error` | Find and fix a Liquid error planted in the product section. |
    | `new-product-data` | Make a snapshot from the bundled sample store and add a product that renders. |
    | `sale-scenario` | Add a scenario that puts one product on sale, leaving the base data unchanged. |
    | `add-to-cart-label` | Rename the add-to-cart button through the English translations. |
    | `home-section-order` | Report the home page's sections in order, without changing the theme. |
    | `server-only-features` | Report the product template's server-only features, without changing the theme. |
    | `article-iso-date` | Show article dates as year-month-day, read from the article's data. |

  - Isolation:
    - each task runs in a new folder outside the repository, with the package installed from its
      tarball;
    - the agent gets a `HOME` inside that folder and only `PATH`, `TMPDIR`, `LANG` and the
      variables it needs to run, so no store credentials are passed to it;
    - the agent still runs as the maintainer's user without an OS sandbox. For a stronger
      guarantee, run it on a machine or account that holds no store credentials, or in a
      container;
    - after the agent exits, its process group is stopped before the check reads the folder;
    - the checks render with a separate, untouched install.
  - Checks:
    - they read only text that the markup does not hide;
    - where typing a value into the theme could pass, they render again with changed data or
      changed block settings;
    - they compare snapshot changes with the bundled sample store.
  - `--self-test` proves that every check fails on the untouched theme and passes on a known
    solution. It passed for all ten tasks.

#### Recorded runs

Both runs on 2026-10-18 used the following setup:

- the 1.0.0 package tarball built from commit `94011d1` (shasum `3fa3c8a5`);
- pinned Dawn;
- Codex CLI 0.162.1 with model `gpt-6-astra` at high reasoning effort;
- MCP servers and computer use turned off;
- tasks run one at a time, each limited to 20 minutes.

| Task | Run 1 | Run 2 |
|---|---|---|
| `product-type-above-title` | pass, 45 s | pass, 48 s |
| `announcement-text` | pass, 26 s | pass, 26 s |
| `trust-badges-section` | fail, 87 s | pass, 77 s |
| `fix-liquid-error` | pass, 48 s | pass, 41 s |
| `new-product-data` | pass, 52 s | pass, 54 s |
| `sale-scenario` | pass, 56 s | pass, 53 s |
| `add-to-cart-label` | pass, 30 s | pass, 35 s |
| `home-section-order` | pass, 27 s | pass, 46 s |
| `server-only-features` | pass, 28 s | pass, 26 s |
| `article-iso-date` | pass, 34 s | pass, 29 s |
| **Success rate** | **9/10** | **10/10** |

In both runs the agent had the maintainer's real `HOME`; the `HOME` inside the task folder came
later. The logs show the agent's only reads outside its task folder: a Codex skill file under that
`HOME`, read in 11 of the 20 task runs. No credential file was read. Both runs were judged again
with the final checks (`--recheck`), with the same results.

The run 1 failure came from the task's wording, not from the CLI. The prompt said "Add a new section",
and the agent added Dawn's existing Multicolumn section with the heading and three editable column
blocks. The check expects a new section file. Run 2 asked for "a new section file" and used the same
check.

### 9.13 Browser and playground checks

- **Parity.** The browser build renders the whole matrix with HTML **byte-identical** to Node.
- **Playground e2e.**
  - The Dawn and Horizon zips are fetched by the test harness and are not hosted.
  - Every matrix page renders, and the inspector tree equals `RenderResult.tree`.
  - Request interception proves two things. First, the playground issues no request except GETs for
    its own static assets. Second, no request URL or body contains theme file content. Requests that
    the rendered theme itself makes follow §7.4.6 and are listed in the inspector.

## 10. Acceptance criteria (1.0 = North Star reached)

Each criterion is checked by the lane or review named.

| # | Criterion | Verified by |
|---|---|---|
| AC-1 | For Dawn and Horizon at their pinned commits, the comparison (§9.5) finds every §9.3 page type similar (§9.6) at desktop and mobile widths. | Maintainer review (§9.7); owner confirmed 2026-10-18 |
| AC-2 | `check` reports 0 missing Shopify filters, tags, objects or object properties reachable from the §9.3 page types, for both benchmarks. "Missing" is defined in §9.10. | `parity` |
| AC-3 | Rendering the full matrix produces 0 Liquid errors and 0 not-implemented events. | `parity` |
| AC-4 | AC-2 and AC-3 pass with networking disabled. | `parity` (`--network none`) |
| AC-5 | Every **fix** finding from the comparison is fixed or filed as an issue. | Findings list (§9.7); owner confirmed 2026-10-18 |
| AC-6 | The agent contract tests pass (§9.12). | `parity` |
| AC-7 | The browser build output is byte-identical to Node across the matrix. | `browser` |
| AC-8 | Playground e2e passes, including the no-upload request check (§9.13). | `browser` |
| AC-9 | Inspector e2e passes against the dev server for every matrix page. The tree equals `RenderResult.tree`. Every node maps to a source file. The diagnostics list equals the CLI's for the same input. A crafted `missing-resource` scenario and a `blocked-endpoint` call both show badges. Device presets change the iframe width. | `browser` |
| AC-10 | No benchmark theme file is present in the repo, and the README starts with the disclaimer line. | `license-guard` |

AC-1 and AC-5 are judged by a person, not by a CI lane. The agent eval success rate (§9.12) is
report-only.

## 11. Milestones

| # | Milestone | Exit criteria |
|---|---|---|
| M0 | Foundation: workspace, generated spec, `ThemeFileSystem`, `check` (static), JSON Schemas, CI lanes including `network-off` and `license-guard` | `check --json` lists the Shopify features Dawn and Horizon use. The lanes run. |
| M1 | Oracle harness: store guard and first wipe (owner-confirmed), fixture and images, seeding, unpublished theme push, side-by-side comparison | The comparison runs for both themes over the §9.3 page types at desktop and mobile widths. |
| M2 | Dawn parity: dialect, assembly, derivation | AC-1 and AC-5 for Dawn; AC-2 to AC-4. |
| M3 | Horizon parity: theme blocks, static and nested blocks | AC-1 and AC-5 for Horizon; AC-2 to AC-4. |
| M4 | Dev server and inspector (can run in parallel with M2 and M3) | AC-9. |
| M5 | Browser build and playground | AC-7, AC-8. |
| M6 | Agent contract, eval report, docs, release 1.0 | All of §10. npm publish and playground deploy. |

M0 local verification (2026-10-13): generated-spec/schema drift checks, TypeScript, lint, ESM and
browser foundation builds, 17 tests, deterministic static analysis of 11 JSON templates each for
pinned Dawn and Horizon, benchmark-file license guard, and the same foundation checks in a Node 22
container with networking disabled all pass. An offline tarball install, TypeScript consumer,
runtime subpath imports, and installed CLI also pass. Owner-approved repository publication and the
CI cache repair are complete: all three jobs passed in run `38401111761` at commit `744be2a`.
The owner has authorized subsequent pushes during North Star delivery (2026-10-13). Static analysis is
conservative: unresolved argument/resource types and dynamic references remain diagnostics with
`complete: false` for both benchmarks. No renderer parity, real browser e2e, or Shopify-verified
implementation is claimed by M0.

## 12. After 1.0 (recorded, not committed)

- Vintage theme support.
- An MCP server and a screenshot command.
- Emulating cart, variant, and search endpoints.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Shopify output changes, or is nondeterministic | Pinned themes. The comparison is a dated, one-off check, and a person tells real differences from noise. |
| liquidjs internals cannot be overridden | Stop for an owner decision on a fork (§8.1). |
| Oracle store misuse, or an accidental wipe | Domain pin, marker metafield, owner-confirmed first wipe with backup. Credentials stay with the maintainer who runs the comparison. |
| Benchmark theme licensing | Themes are never committed. Screenshots and captured pages stay on the maintainer's machine. |
| The "Shopify" trademark in the name | Accepted by the owner. Disclaimer at the top of the README. No Shopify logos. |
| Browser and playground work enlarges the 1.0 scope | Isomorphic core from M0, so M5 builds on existing structure. |
| Search ranking and recommendations are not reproducible | Unambiguous search fixtures. Recommendations are JavaScript-loaded, so server HTML is empty on both sides. |
| Fonts differ offline | Best-effort Google Fonts mapping, never gated. |

## 14. Prerequisites (owner actions)

1. The oracle store is a development store created for this project (owner decision,
   2026-10-17). Its domain is recorded in the local handoff, not in this specification. Before any
   mutation, verify that it is a development store, pin its domain in the oracle configuration and
   check the marker metafield (§9.1). The store supplied on 2026-10-13 is used for other work and is
   never written to.
2. Create two custom apps: the comparison app with the scopes in §9.1, and the setup app installed
   only on the dedicated stores. Their credentials and the storefront password stay with the
   maintainer who runs the comparison.
3. Create the public repository `verticalbarHQ/shopify-offline-preview`.
4. Publish to npm as `@verticalbar/shopify-offline-preview` under the `@verticalbar` scope (owner
   decision, 2026-10-18), and set up GitHub Pages for the playground.
5. None for the report-only agent eval: it runs a coding-agent CLI on a maintainer's machine, so it
   needs no API key secret (owner decision, 2026-10-18).

## 15. Decision log (interview of 2026-10-13)

| Topic | Decision | Alternatives rejected |
|---|---|---|
| Correctness oracle | Compare with real Shopify renders | Self-diagnostics only (proves "renders", not "renders right"); per-filter only |
| Coverage | Static and scenario-executed | Static only; default-data run only |
| Benchmark themes | Dawn, Horizon | All free themes (not on GitHub, license); a real store theme |
| Pages | Core 4, search/cart/404, blog/article | Account, password, and gift card pages |
| Match signals | Section order and visible text, judged by a person with screenshots (2026-10-17; was section/block tree and text hashes as gates) | HTML skeleton score; tree and text hashes as gates |
| Data parity (verification harness) | Repo fixture → store | Store → repo import first; both directions inside the harness |
| User data input (owner clarification, 2026-10-13) | Accept local snapshots of real store data obtained through external tools; publish and validate the input schema in 1.0 | Built-in live-store importer, including the previously proposed post-1.0 importer |
| Oracle store identity (owner clarification, 2026-10-13) | Owner supplied the domain and admin URL, recorded in the local handoff; development-store status and mutation guards still require verification | Treating the supplied URL or password as permission to wipe, seed, push, or create credentials |
| Previously unreviewed defaults (owner approval, 2026-10-13) | Owner's “proceed” response approves public text hashes, oracle-backed implementation status, weekly recapture and 7-day freshness, Horizon comment markers, two-origin inspector and HTTP 501, best-effort Google Fonts outside gates, 10 agent-eval tasks, and no vintage support. Text hashes, recapture, freshness and comment markers were superseded on 2026-10-17. | Changing these defaults before local M0 |
| Delivery authorization (owner approval, 2026-10-13) | Begin local M0. Public repository creation, every push/PR, store wiping, credentials/secrets, publishing, Pages, and paid API use still require explicit approval at the action boundary | Treating local implementation approval as external delivery authorization |
| Oracle cadence | One-off, when a maintainer runs it (2026-10-17; was stored goldens gating PRs with scheduled recapture) | Live Shopify call on every PR; stored goldens with weekly recapture |
| Golden storage | None. Screenshots and captures stay local (2026-10-17; was public summaries, private raw) | Public summaries with a private raw repository; raw HTML in public |
| Images | Same files on both sides, browser scaling | sharp resizing (native dependency); placeholders only |
| Snapshot shape | Source data plus derivation | Liquid-object shape; Storefront API shape |
| Network | Allowed by default. "Offline" means it works without internet, verified with network disabled. | Block everything by default; renderer-only guarantee |
| JS endpoints | Static only | Read-only endpoints; in-memory cart |
| Inspector | Page iframe plus side panel | In-page overlay; both |
| Editing | Files plus hot reload | Settings panel that saves; settings panel that does not save |
| Missing data | Blank as on Shopify, marked; design-mode toggle | Auto-synthesis; all three modes |
| Agent interface | CLI plus JSON | Screenshot command; MCP server |
| Agent verification | Contract tests gate; real eval is report-only | Eval gates; contract tests only |
| Upstream docs updates (owner decision, 2026-10-18) | A weekly check fails on upstream change, and a maintainer opens the PR | Actions opening pull requests, which the organization does not allow |
| Agent eval runner (owner decision, 2026-10-18) | A coding-agent CLI (Codex) on a maintainer's machine, recorded in §9.12 | A weekly CI lane with an API key secret |
| Engine | liquidjs plus local overrides, no upstream contributions | Fork; own engine |
| Block comparison | Not compared on their own; block text is part of its section's text (2026-10-17; was an instrumented copy on both sides) | Instrumented copy on both sides; theme-editor capture |
| Oracle store | Existing dev store, dedicated and wiped. Superseded on 2026-10-17: the store supplied on 2026-10-13 is used for other work, so the owner approved a new development store dedicated to the comparison (§9.1, §14) | Coexist with prefixes; a new store (the 2026-10-13 choice) |
| Shopify comparison (owner decision, 2026-10-17) | A one-off side-by-side check that a person judges: screenshots of the store and the offline preview at desktop and mobile widths, with text differences extracted to help. Similar means the same sections in the same order, the same main content, and a layout that does not look broken (§9.6). Findings are listed as OK or fix. | Stored goldens gating PRs; weekly recapture; a private raw repository; a numeric pass rate |
| Implemented and verified (owner decisions, 2026-10-17) | "오프라인 프리뷰는 일단 C+B 승인" (23:2x KST): `check` counts a feature as missing only when the preview neither provides it nor classifies it as server-only. Shopify verification is shown separately. Its evidence includes features that ran in the 72 page pairs judged similar. "C 중에선 쉽고 방법이 명백한것만 지원하고, (b)는 해보는게 좋아보임" (23:4x KST): of the features the preview does not provide, only those that are easy and clearly derivable are implemented. The rest are classified as server-only, and ambiguous ones are classified as server-only too. Features the preview provides but no comparison exercised are all to be tried on the dedicated store. | Implemented only with a Shopify-verified example for every feature (the 2026-10-13 rule, which would have required about 400 authored cases); implementing every feature regardless of whether it can work offline |
