# shopify-offline-preview — Specification

> **Unofficial — not affiliated with or endorsed by Shopify.**

| | |
|---|---|
| Status | Offline renderer, dev inspector, and static browser playground implemented. Real Shopify oracle parity and feature completion remain pending. |
| Date | 2026-10-13 |
| Repository | `verticalbarHQ/shopify-offline-preview` (public) |
| npm package (planned) | `shopify-offline-preview` (name unclaimed on npm as of 2026-10-13) |
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
| `shopify-offline-preview check <theme> [--json] [--strict]` | Static coverage (§9.11): the Shopify filters, tags, and objects reachable from each page type, and whether each is implemented. |
| `shopify-offline-preview schema <render\|check\|snapshot>` | Prints the published JSON Schema for that output or input. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success. Diagnostics may still be present in the output. |
| 2 | Usage error. |
| 3 | The theme or snapshot failed to load or validate. |
| 4 | Fatal render failure. |
| 5 | `check --strict` found unimplemented features that are reachable. |

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
   - Resource routes: `/`, `/products/:handle[?variant=]`, `/collections/:handle[?page=&sort_by=]`,
     `/collections/all`, `/pages/:handle`, `/blogs/:blog[?page=]`, `/blogs/:blog/:article`,
     `/search?q=`, `/cart`.
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
   - `now` comes from `snapshot.meta.now`. For benchmarks, this is the golden capture timestamp.
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

- The core (spec, dialect, theme, data, render, check) has no Node-only dependencies. All file access
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

A scheduled job opens a PR when upstream changes.

### 8.3 Module layout

The repository is a pnpm workspace. It publishes **one** npm package with subpath exports:
`shopify-offline-preview` (the CLI bin), `/render`, `/check`, and `/browser`.

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
tools/oracle/  seeding, instrumentation, capture, normalization, comparison, golden PRs (not published)
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
fixture (repo) ──seed──► oracle dev store ◄──push unpublished── instrumented theme copy
                              │                                        ▲
                       capture server HTML                    benchmarks.json (pinned)
                              ▼                                        │
                      normalize → golden summary ──commit (public)     │
                      raw HTML ──► private store                       │
                                                                       │
fixture + theme ──► our renderer ──► normalize → summary ──compare──► PASS / FAIL (+ allowlist)
```

### 9.1 Oracle store

- An existing development store in Vertical Bar's Shopify Partner account is **dedicated to this
  project**.
- **Wipe guard.**
  - Destructive operations (wipe and reseed) run only after two checks: the store domain equals the
    one pinned in config, and the shop has the marker metafield `sop.oracle_store = "true"`.
  - The first wipe is a manual step. Existing data is exported first, and the owner confirms at that
    moment. Only after that may the marker be set.
- **Access.**
  - A custom app with Admin API scopes `write_products`, `write_publications`, `write_content`,
    `write_online_store_navigation`, `write_files`, `write_metaobjects`, and `write_themes`.
  - A Theme Access token for CLI theme pushes, and the storefront password.
  - These are stored as GitHub environment secrets that only `main` and scheduled workflows can read.
- **Seeding.**
  - Seeding is idempotent and runs from the fixture.
  - Products are published to the Online Store channel.
  - Menus, pages, blogs and articles, and the collection filter configuration are created.
  - Shop-level settings the API cannot set are verified against `snapshot.shop` before capture.
    A mismatch aborts the run.
- **Themes.** Each instrumented benchmark copy is pushed **unpublished**
  (`shopify theme push --unpublished`) and captured through the storefront with
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

### 9.4 Instrumented theme copy (comparison mode only)

Shopify emits no block boundaries outside the theme editor. `block.shopify_attributes` "returns no
value outside the theme editor". A transformed copy of each benchmark theme is therefore used on
**both** sides:

1. Every `{{ block.shopify_attributes }}` is replaced with
   `data-sop-block-id="{{ block.id }}" data-sop-block-type="{{ block.type }}"`. This covers classic
   blocks.
2. Every file in `blocks/` is wrapped in
   `<!--sop:block {{ block.id }} {{ block.type }}-->…<!--/sop:block-->`. This covers theme blocks
   that lack `shopify_attributes`.
3. Section boundaries come from Shopify's own `shopify-section` wrappers, which our renderer emits
   identically.

Blocks that are still unmarked after this are counted, reported, and compared only through their
section's text. Normal user mode never instruments a theme.

### 9.5 Capture, normalization, and summaries

- **Capture.** GET the storefront HTML, without executing JavaScript, using the CLI-style session:
  the `_shopify_essential` cookie, the storefront password, and `preview_theme_id`.
- **Stability.** Each page is captured twice. Any difference between the two captures is either
  added to normalization or marks the item unstable. Unstable items fail the capture run; they never
  pass silently.
- **Tree extraction.** Section nodes come from `shopify-section` wrappers, with template-specific
  numeric ids normalized (`template--\d+__x` → `template--N__x`). Block nodes come from the `sop`
  markers. The tree records kind, type, order, and nesting.
- **Text extraction.** Per section, `textContent` is taken with `script`, `style`, `noscript`,
  `template`, and comments excluded. Unicode is NFC-normalized and whitespace collapsed.
- **Public summary.** One file per theme × page × scenario: the tree, plus a SHA-256 hash and a token
  count of each section's normalized text.
- **Private raw store.** The raw HTML and readable normalized text, used for debugging by maintainers.

### 9.6 Comparison

Gating checks:

- The tree must be equal in node kinds, types, order, and nesting.
- Each section's normalized text hash must be equal.

Report-only check: screenshot similarity, per section, at fixed desktop and mobile viewports, with
web fonts and third-party scripts blocked on both sides.

### 9.7 Accepted differences

Ids, URLs, tokens, and whitespace are handled by the normalization rules in §9.5. Any difference that
remains needs an entry in `oracle/accepted-differences.yaml`:

`{id, theme, page, scenario, node selector, kind: tree|text, category, reason, evidence}`

Categories:

- `shopify-server-only`: output that only Shopify's servers can produce, such as `payment_button`,
  `login_button`, and `content_for_header` contents.
- `pending-implementation`: temporary. **Must be empty at 1.0.**

### 9.8 Golden lifecycle

- **PRs.** PR lanes compare against the committed summaries offline. No secrets are needed, so pull
  requests from forks are verified too.
- **Scheduled recapture.** A weekly run on `main` reseeds the store, pushes the themes, and
  recaptures. If a summary changed, it opens a "golden refresh" PR with a diff report linking to the
  private raw store. `main` itself never turns red because Shopify changed.
- **Release.** A release requires a capture no older than 7 days.

### 9.9 CI lanes

| Lane | Trigger | Network | Gates |
|---|---|---|---|
| `unit` | PR | on | Unit tests, typecheck, lint, generated-spec drift check |
| `parity` | PR | **off** (container `--network none`) | The full matrix for both benchmarks: tree and text vs. summaries, static and dynamic coverage, agent contract tests |
| `browser` | PR | **off** for test steps; browsers come preinstalled in the image | Node vs. browser byte-identical HTML over the matrix; playground e2e |
| `license-guard` | PR | on | No repo file hash equals any benchmark theme file; README disclaimer present |
| `oracle-recapture` | Weekly, manual | on + secrets | Store guard, seed, push, capture twice, open golden-refresh PR |
| `docs-drift` | Weekly | on | Regenerate from theme-liquid-docs, open PR on change |
| `agent-eval` | Weekly, manual | on + API key | Report only (§9.12) |
| `release` | Tag | on | All of the above green, plus a capture age of 7 days or less |

### 9.10 Filter conformance corpus and "implemented"

- The pinned theme-liquid-docs data has 245 filter example entries: 235 have nonempty `raw_liquid`
  inputs and 10 have no executable input. Expected outputs are absent. Empty entries are reported
  explicitly and never treated as successful conformance cases; authored supplemental cases retain
  their own provenance.
- The oracle runs these inputs on the oracle store and captures Shopify's outputs. The inputs are
  rendered from generated snippet files in a dedicated alternate template, with paths mapped to
  fixture equivalents.
- A filter, tag, or object property counts as **implemented** only when it is registered **and**
  covered by at least one oracle-verified corpus case. A registered stub does not count.
  **Registered** means the offline renderer provides it: a non-stub filter or tag, or a property
  that the renderer's objects expose (`check` reports it from the renderer's own registration).

### 9.11 Coverage

- **Static.** For each page type, find the files reachable from the template: layout, section groups,
  sections, blocks, and statically named `render` targets. Dynamically named renders are flagged.
  Collect the Shopify filters, tags, and object properties they use. The unimplemented count must be
  0.
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
  - A fixed task set (10 tasks, for example "show the vendor above the product title and verify") is
    run by a headless coding agent that has file access and this CLI, and no store credentials.
  - Each task has an assertion script, and the success rate is recorded per run.

### 9.13 Browser and playground checks

- **Parity.** The browser build renders the whole matrix with HTML **byte-identical** to Node.
- **Playground e2e.**
  - The Dawn and Horizon zips are fetched by the test harness and are not hosted.
  - Every matrix page renders, and the inspector tree equals `RenderResult.tree`.
  - Request interception proves two things. First, the playground issues no request except GETs for
    its own static assets. Second, no request URL or body contains theme file content. Requests that
    the rendered theme itself makes follow §7.4.6 and are listed in the inspector.

## 10. Acceptance criteria (1.0 = North Star reached)

Each criterion is checked automatically by the lane named.

| # | Criterion | Verified by |
|---|---|---|
| AC-1 | For Dawn and Horizon at their pinned commits, across the matrix in §9.3, the tree and each section's text hash equal the golden summaries. The only accepted differences are in category `shopify-server-only`. | `parity` |
| AC-2 | `check` reports 0 unimplemented Shopify filters, tags, or object properties reachable from the §9.3 page types, for both benchmarks. "Implemented" is defined in §9.10. | `parity` |
| AC-3 | Rendering the full matrix produces 0 Liquid errors and 0 not-implemented events. | `parity` |
| AC-4 | AC-1 to AC-3 pass with networking disabled. | `parity` (`--network none`) |
| AC-5 | The golden summaries come from a capture no older than 7 days, and that capture passed its double-capture stability check. | `release` |
| AC-6 | The agent contract tests pass (§9.12). | `parity` |
| AC-7 | The browser build output is byte-identical to Node across the matrix. | `browser` |
| AC-8 | Playground e2e passes, including the no-upload request check (§9.13). | `browser` |
| AC-9 | Inspector e2e passes against the dev server for every matrix page. The tree equals `RenderResult.tree`. Every node maps to a source file. The diagnostics list equals the CLI's for the same input. A crafted `missing-resource` scenario and a `blocked-endpoint` call both show badges. Device presets change the iframe width. | `browser` |
| AC-10 | No benchmark theme file is present in the repo, and the README starts with the disclaimer line. | `license-guard` |

Report-only, never gating: screenshot similarity (§9.6) and the agent eval success rate (§9.12).

## 11. Milestones

| # | Milestone | Exit criteria |
|---|---|---|
| M0 | Foundation: workspace, generated spec, `ThemeFileSystem`, `check` (static), JSON Schemas, CI lanes including `network-off` and `license-guard` | `check --json` lists the Shopify features Dawn and Horizon use. The lanes run. |
| M1 | Oracle harness: store guard and first wipe (owner-confirmed), fixture and images, seeding, instrumentation, capture, normalization, summaries, private raw store, recapture PR job | Golden summaries are committed for both themes × full matrix, and two consecutive recaptures show zero diff. |
| M2 | Dawn parity: dialect, assembly, derivation | AC-1 to AC-4 for Dawn. |
| M3 | Horizon parity: theme blocks, static and nested blocks | AC-1 to AC-4 for Horizon. |
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
| Shopify output changes, or is nondeterministic | Double capture, normalization rules, and weekly recapture with refresh PRs. Pinned themes. |
| Blocks without markers make block comparison incomplete | Two kinds of instrumentation (§9.4). Remaining unmarked blocks are counted and reported, never silently passed. |
| liquidjs internals cannot be overridden | Stop for an owner decision on a fork (§8.1). |
| Oracle store misuse, or an accidental wipe | Domain pin, marker metafield, owner-confirmed first wipe with backup, secrets limited to `main` and scheduled runs. |
| Benchmark theme licensing | Themes are never committed. Public goldens hold only trees and hashes. Raw HTML stays private. |
| The "Shopify" trademark in the name | Accepted by the owner. Disclaimer at the top of the README. No Shopify logos. |
| Browser and playground work enlarges the 1.0 scope | Isomorphic core from M0, so M5 builds on existing structure. |
| Search ranking and recommendations are not reproducible | Unambiguous search fixtures. Recommendations are JavaScript-loaded, so server HTML is empty on both sides. |
| Fonts differ offline | Best-effort Google Fonts mapping, never gated. |

## 14. Prerequisites (owner actions)

1. The owner has supplied the store domain and admin URL (recorded in the local handoff, not as
   credentials in this specification). Before any mutation, verify that it is a development store,
   pin its domain in the oracle configuration, confirm it can be dedicated, export its current data,
   and obtain confirmation for the first wipe at the time it happens.
2. Create the custom app and Theme Access token. Store the secrets in a GitHub environment limited to
   `main` and scheduled workflows.
3. Create the public repository `verticalbarHQ/shopify-offline-preview` and a private repository for
   raw goldens.
4. Set up the npm publishing account and 2FA for `shopify-offline-preview`, and GitHub Pages for the
   playground.
5. Provide an API key secret for the report-only agent eval.

## 15. Decision log (interview of 2026-10-13)

| Topic | Decision | Alternatives rejected |
|---|---|---|
| Correctness oracle | Compare with real Shopify renders | Self-diagnostics only (proves "renders", not "renders right"); per-filter only |
| Coverage | Static and scenario-executed | Static only; default-data run only |
| Benchmark themes | Dawn, Horizon | All free themes (not on GitHub, license); a real store theme |
| Pages | Core 4, search/cart/404, blog/article | Account, password, and gift card pages |
| Match signals (gating) | Section/block tree and visible text | HTML skeleton score. Screenshots demoted to report-only. |
| Data parity (verification harness) | Repo fixture → store | Store → repo import first; both directions inside the harness |
| User data input (owner clarification, 2026-10-13) | Accept local snapshots of real store data obtained through external tools; publish and validate the input schema in 1.0 | Built-in live-store importer, including the previously proposed post-1.0 importer |
| Oracle store identity (owner clarification, 2026-10-13) | Owner supplied the domain and admin URL, recorded in the local handoff; development-store status and mutation guards still require verification | Treating the supplied URL or password as permission to wipe, seed, push, or create credentials |
| Previously unreviewed defaults (owner approval, 2026-10-13) | Owner's “proceed” response approves public text hashes, oracle-backed implementation status, weekly recapture and 7-day freshness, Horizon comment markers, two-origin inspector and HTTP 501, best-effort Google Fonts outside gates, 10 agent-eval tasks, and no vintage support | Changing these defaults before local M0 |
| Delivery authorization (owner approval, 2026-10-13) | Begin local M0. Public repository creation, every push/PR, store wiping, credentials/secrets, publishing, Pages, and paid API use still require explicit approval at the action boundary | Treating local implementation approval as external delivery authorization |
| Oracle cadence | Stored goldens gate PRs; scheduled recapture | Live Shopify call on every PR; manual only |
| Golden storage | Public summaries, private raw | All private; raw HTML in public |
| Images | Same files on both sides, browser scaling | sharp resizing (native dependency); placeholders only |
| Snapshot shape | Source data plus derivation | Liquid-object shape; Storefront API shape |
| Network | Allowed by default. "Offline" means it works without internet, verified with network disabled. | Block everything by default; renderer-only guarantee |
| JS endpoints | Static only | Read-only endpoints; in-memory cart |
| Inspector | Page iframe plus side panel | In-page overlay; both |
| Editing | Files plus hot reload | Settings panel that saves; settings panel that does not save |
| Missing data | Blank as on Shopify, marked; design-mode toggle | Auto-synthesis; all three modes |
| Agent interface | CLI plus JSON | Screenshot command; MCP server |
| Agent verification | Contract tests gate; real eval is report-only | Eval gates; contract tests only |
| Engine | liquidjs plus local overrides, no upstream contributions | Fork; own engine |
| Block comparison | Instrumented copy on both sides | Sections plus text order only; theme-editor capture |
| Oracle store | Existing dev store, dedicated and wiped | Coexist with prefixes; a new store |
| Server-only differences | Normalization plus a categorized allowlist | Normalization only; unrestricted allowlist |
| Drift | Pinned themes and auto-refresh PRs | Fail `main`; report only |
| Packaging | One npm package | Multiple packages |
| Runtime | Node and browser officially, including the playground in 1.0 | Node only; browser-ready structure only |
| License | MIT | Apache-2.0 |
| Spec language | English | Korean |

## 16. References

- Shopify CLI 4.9.3 (`@shopify/cli` on npm): `theme dev` storefront rendering with `replace_templates`
- [Slate — Local development](https://shopify.github.io/slate/docs/local-development)
- [Shopify/vision (archived)](https://github.com/Shopify/vision)
- [Shopify/theme-liquid-docs](https://github.com/Shopify/theme-liquid-docs) (MIT)
- [Shopify/liquid](https://github.com/Shopify/liquid), [Shopify/liquid-spec](https://github.com/Shopify/liquid-spec)
- [harttle/liquidjs](https://github.com/harttle/liquidjs) (MIT)
- [Shopify/dawn](https://github.com/Shopify/dawn), [Shopify/horizon](https://github.com/Shopify/horizon) (restricted licenses)
- [Shopify/theme-tools](https://github.com/Shopify/theme-tools) (MIT; `@shopify/liquid-html-parser`)
- [bosun-ai/snapify](https://github.com/bosun-ai/snapify), [Piyushmishra29/liquid-storefront](https://github.com/Piyushmishra29/liquid-storefront)
- [Shopify Trademarks](https://www.shopify.com/legal/trademarks)
