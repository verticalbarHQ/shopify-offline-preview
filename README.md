Unofficial — not affiliated with or endorsed by Shopify

# shopify-offline-preview

An offline theme reader and editor for Shopify Online Store 2.0 themes, for people and coding agents.

**Status: initial offline rendering is available locally; Shopify parity is pending.** JSON templates,
layouts, sections/groups, source mappings and isolated snippets are assembled using local snapshots.
Fixture generation and guarded read-only oracle tools exist; no real goldens have been captured.
The dev server, inspector and static browser playground are available with section, classic block and theme-block highlighting;
Shopify block fidelity remains pending. No Shopify-verified feature implementation is claimed. This package is
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

Dynamic, static and nested theme blocks execute locally with isolated parameters, scoped `closest`
resources, dynamic setting expressions and per-execution source/read mappings. Color scheme groups
resolve ids and defaults; sRGB colors expose RGB, HSL and alpha properties. Other color formats and
properties remain explicitly diagnosed. Global palettes preserve named lookup and value order,
merge new defaults with merchant values, and resolve color references and dynamic setting expressions.
Reference cycles fail visibly; settings cannot execute Liquid logic tags. Classic section block
loops retain native loop control and own their executed snippets and data reads. External app blocks
and embeds appear as labelled placeholders with source mappings and `app-placeholder` diagnostics. Several resource settings and several Shopify filters remain pending. Prices convert exactly to
hundredths and reject values requiring greater precision. Liquid behavior still needs
Shopify oracle verification. Raw schemas, documentation and asset bodies retain their original source
positions without interpreting embedded Liquid examples. Snippets support isolated named arguments
and `with`/`for` bindings through the same parser. The feature registry continues to report zero verified implementations.
Theme/section translations, regional locales, plural counts and HTML escaping are handled locally.
Money filters use the snapshot templates; assets, image URL parameters and preload hints use local
files. `inline_asset_content` reads local SVG, JS and CSS files under the documented 15 KB limit,
keeping their contents literal. MD5 fingerprints run in both browser and Node. HTML preload links
preserve named attributes; the omitted Shopify HTTP Link header is reported as server-only information. The server serves the original image bytes and the browser scales them, as specified.

Initial `product`, `customer`, `contact` and `localization` forms render their HTML and initial form
state. Resource lists (`collection.products`, `blog.articles`, `search.results`, `product.variants`)
can be paginated without mutating their source; page links preserve the URL query. Independent
setting-array pagination is diagnosed as pending. Cart lines and exact undiscounted totals derive
from snapshot variant prices and quantities; compare-at prices do not count as discounts. Basic search
matches product, page and article words, with documented prefix/type/availability options. Advanced
query syntax and ambiguous relevance ranking remain explicitly diagnosed.

## Bring your own data

Data may come from any external collection or export tool. Prepare a local directory containing
`snapshot.json` and `images/`, following `schemas/snapshot.schema.json`. The library does not collect
live-store data or convert vendor-specific exports. Local snapshot validation is available in the
browser export, `render --data` and `dev --data`.

Optional `placeholderSvgs` maps documented placeholder names to externally prepared SVG strings
in `snapshot.json`. Supply each SVG's base output without a root class; the filter preserves its
bytes and applies Shopify's class argument behavior. The catalog stays local, and the library
does not fetch or redistribute platform artwork. A requested name without local SVG data produces
a `missing-resource` diagnostic. Each entry is limited to two million characters.

Optional shop metadata includes `description`, customer account flags, `enabled_payment_types`,
boolean `features`, and `policies` with `title`, `body`, `url` and an optional string `id`.
Omitted metadata stays unavailable and produces a diagnostic when read. Shop product and collection
counts come from the supplied catalog arrays; provide the full storefront catalog for those counts.
`request.visual_preview_mode` is false because the preview renders complete pages.

Font settings recognize Assistant, Inter, Work Sans and Anonymous Pro and their available weights/styles.
`font_face` and `font_url` use fixed Google Fonts WOFF2 URLs for the Latin subset, with an explicit
`shopify-server-only` diagnostic for the CDN substitution. Rendering makes no font requests;
offline the CSS fallback stack applies. Other families and unavailable metadata remain diagnosed.

`stylesheet` bodies are collected once from each rendered section, block or snippet file.
`javascript` bodies are collected from all theme section, block and snippet files and run once,
deferred, with a separate closure and error boundary for each file. Both tags preserve literal code;
use `style` for CSS that evaluates Liquid. Generated CDN URLs are replaced by local inline CSS and
data URL scripts and reported as `shopify-server-only` differences.

Color component filters support RGB, alpha, hue, saturation and lightness with bounded values.
`link_to` preserves label markup, escapes attribute values and adds `nofollow` for Shopify links.

Resources can supply optional string `id` values. Safe decimal IDs become Liquid numbers; larger
or nondecimal IDs remain strings. Variant metadata can include `quantityRule`, decimal-string
`quantityPriceBreaks` and `unitPrice`, `unitPriceMeasurement`, inventory fields and
`storeAvailabilities`. Product metadata can include `giftCard`, `requiresSellingPlan`,
`sellingPlanGroups` and `quantityPriceBreaksConfigured`. Pickup and selling-plan arrays contain
prepared Liquid-shaped JSON objects; the library does not collect or convert their source exports.
Missing metadata remains diagnosed. `variants_count` derives from the supplied variants.

`standard_event_data` supports view payloads for snapshot products and collections, including selected
variant options and prices. Cart view payloads omit Shopify's server session and report that omission;
the cart page continues to render the supplied cart lines.

Optional resource/shop `seo` fields provide a nullable `title` override and the resolved storefront
`description`. A null title uses the resource title or shop name. Supply the resolved description
explicitly: an Admin export's null custom description does not establish the storefront fallback.
Missing SEO metadata remains diagnosed. Cart, search, all-products and 404 titles use Shopify's
English system labels; other locales report the missing system-title translation.

`collections.all` provides the automatic catalog on every route, sorted alphabetically by title.
A supplied collection with handle `all` takes precedence and retains its template suffix and source
order. Iterating `collections` lists the supplied collections; the automatic catalog is a lookup
entry rather than an extra persisted collection.

Pagination supports nested paths to collection products, blog articles, search results and product
variants, including collection settings. It overlays the page slice only within the paginate body
and preserves source tracking and the surrounding scope.

Cart inputs can supply `taxesIncluded`, `dutiesIncluded` and per-line `key`, `instructions`,
`parentRelationship` and `itemComponents`. Keys come from the external snapshot; Shopify hashes are
not invented. Line indices derive from source order, removal URLs use the supplied key and
`item_count_for_variant` totals all matching lines. Cart forms emit initial HTML; submission is
handled by the preview's existing offline endpoint boundary.

`money_amount` emits the plain decimal amount with Shopify-style cent rounding and no locale
separators. `handleize`/`handle` normalize punctuation and Latin accents while retaining other
scripts and underscores.

Date and `time_tag` named formats read `date_formats` from the selected theme locale. English system
patterns are provided; missing formats or other unsupplied locale patterns stay diagnosed. Display
dates use the shop timezone, `<time>` datetime values use UTC, and `now` uses the snapshot timestamp.

Collections expose English sort labels or supplied `sortOptions`; labels describe the available
Shopify choices and do not invent sales rankings. `commentsEnabled` and article `commentsCount`
come from the snapshot. Shop policy aliases resolve supplied policy URLs and remain unavailable
when the policy list itself is absent. Shared collection/search lookups that Shopify returns as nil
retain nil values.

Shopify accelerated checkout and installment terms are omitted with `shopify-server-only` diagnostics.
The preview emits no fake payment controls or server credentials. Payment filters validate their
product/cart form scope; regular forms and snapshot cart content remain available.

Source prices are decimal strings in the shop currency, not floating-point numbers or Liquid's
derived minor-unit prices. Variants have string ids; cart lines refer to a product handle and
variant id. Images use paths relative to `images/`. Schema validation checks source shape; reference
integrity and scenario derivation are also checked by the renderer. The runtime validates IANA timezone
names, beyond the JSON Schema's string shape. No real customer data belongs in fixtures.

Image `alt` accepts a string or null; an optional `id` supplies the classic Liquid image ID.
Product images also accept `mediaId`, `mediaAlt`, and `previewAlt` for their separate media and
preview views. Omitted alt overrides use `alt`; explicit null remains null. A media ID is never
inferred from the classic image ID. Preview image IDs are null. Obtain these values externally;
the offline runtime makes no store requests.

`shop.id` and `shop.permanentDomain` supply Liquid's shop ID and permanent domain separately from
the primary domain. Cart notes, tax/duty flags, line instructions and component lists can explicitly
contain null where observed; omitted optional metadata remains diagnosed when a theme reads it.

## Development inspector

`dev` prints separate loopback origins for the inspector and the theme page. The inspector shows the
renderer tree, diagnostics, snapshot reads and the selected node's source. Hover sections and blocks to highlight
their regions; snippets are listed without DOM highlights. Mobile, tablet, desktop and full-width
Loops inside HTML attributes or scripts are traced without inserting DOM markers. Width
presets change the iframe width. Scenario and design-mode controls re-render locally. Theme and data
file edits reload the preview. Invalid edits clear the old preview and show the input error.

Unsupported Shopify endpoints return 501 with `{"error":"not available offline"}` and page badges.
The bridge also prevents those requests from reaching the snapshot's shop domain. Third-party resource
requests are listed separately. Bridge markup is added only to the served view, leaving `render` output
unchanged. The inspector rejects cross-origin requests and filesystem escapes.

## Browser playground

`pnpm build` writes the static site to `dist/playground/`. Serve that directory locally with any static
HTTP server; it also works under a static hosting subdirectory. Open a theme zip, drop it onto the
page, or choose a folder. Supply a snapshot zip/folder containing `snapshot.json` and `images/`, or
use the bundled fixture. Theme and snapshot files are processed in browser memory and are never
uploaded. A folder opened through File System Access can be read again with **Reload folder**;
there is no file watcher. Browsers without that API can use the folder input or zip input.

The playground shares the inspector tree, diagnostics, source and controls with `dev`. The theme
runs in an opaque sandboxed iframe and cannot read the inspector's input files. Local assets and
snapshot images use data URLs; module imports use an import map, including cyclic imports. Fetch
and XHR calls to unsupported Shopify endpoints retain the 501 response and diagnostic badges.
Third-party theme requests remain visible separately. Core render output is preserved.

Scoped import maps and circular CSS imports currently fail explicitly rather than changing their
meaning. These are preview-adapter limitations; Shopify rendering parity is still pending.
A hosted copy is published from `main` to GitHub Pages at
<https://verticalbarhq.github.io/shopify-offline-preview/>. It is the same static build: themes and
snapshots stay in your browser, and the only bundled data is the synthetic default fixture (no
benchmark theme files). Rendering is approximate; Shopify parity is still pending.

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
pnpm oracle:offline-check
pnpm agent:contract-check
pnpm browser:render-smoke
pnpm browser:playground-check
pnpm browser:inspector-check
pnpm license-guard
pnpm test:network-off
pnpm test:browser-offline
```

Dawn and Horizon are fetched at the full commits in `benchmarks.json` into an OS temporary directory,
outside this project. A local ignored manifest points to them. They are never committed or packaged.
The agent contract check copies Dawn into a temporary directory, edits a real section and verifies
the CLI HTML/tree, then checks that an unknown filter is listed with strict exit 5. Usage, input and
fatal failures also validate against the published schemas with no TTY. The pinned input is preserved.
The static benchmark check verifies deterministic coverage output, valid result contracts, and no parse
or missing-reference errors. Static object inference follows assignment order, restores loop bindings,
and includes types carried between iterations and across branches. Documented `default` and array
filters retain their source types; unknown filter results and untyped caller inputs keep coverage
incomplete. Conditions on menu link `type`, search result `object_type` and `media_type` refine
resource properties in their branches, including short-circuit conditions. Reassignment and loop
shadowing discard stale refinements. Literal discriminator predicates in `where` and `find` also
retain native element constraints through `first`, `map` and loops; merchant product types and
untyped caller values are not treated as menu links. This inference does not mark any feature
oracle-verified. Statically named `render` calls pass named, `with` and `for` argument types into
isolated snippet analysis. Calls with different bindings are analyzed independently; cycles reuse
existing contexts and excessive context growth is reported as incomplete. Caller-local variables
are not inherited. The initial rendering check compares repeat runs and Node/browser builds
across all 36 cases while reporting remaining errors and unsupported features. The browser smoke
command starts a loopback-only verification page for those same cases. These checks do **not** assert
Shopify render parity and do not waive acceptance gates. `oracle:offline-check` instruments temporary
theme copies and runs all 36 cases through the tree/text summary and repeat-capture stability
pipeline. Its output is local pipeline evidence, never a Shopify golden.

`pnpm parity:check [--snapshot <base-snapshot.json>] --case-snapshots <manifest.json> [--release]` compares instrumented offline renders
against actual captures in `oracle/goldens/{dawn,horizon}/`. It requires all 36 cases, the exact theme
pins, paths, scenarios, base-fixture hash, calibrated case-snapshot hashes and comparison-copy file
hashes, and fails on Liquid errors or unimplemented events. It renders each calibrated snapshot
verbatim, including the observed Native clock and identifiers; it does not reapply source overlays.
`--release` also enforces the seven-day capture window. It currently fails because real captures
have not been collected. No foundation CI result substitutes for this gate; static oracle-backed
coverage and any explicitly evidenced server-only differences remain separate requirements.

The Docker command prepares dependencies and benchmarks while online, then runs the foundation checks
in a container with `--network none`. `test:browser-offline` also installs Chromium during the image
build, then runs every browser test in a separate container with networking disabled. GitHub workflow
definitions include unit, network-off, license-guard and browser jobs. The browser lane checks all 36
playground and dev-inspector cases, no-upload behavior, playground interactions and inspector
regressions against the current renderer. Every inspector node maps to an existing source file and
the visible tree matches the render result. Synthetic classic/theme block execution and DOM-range interactions are checked. Real Shopify parity remains pending.

## License

MIT. Shopify benchmark theme files remain subject to their own licenses and are not redistributed.

`structured_data` emits product groups, single default-variant products, variants and articles from
snapshot data. Optional product `category` supplies its taxonomy name (`null` uses `productType`);
article `createdAt` supplies the creation timestamp used by Shopify's structured output. Missing
required metadata remains diagnosed. Product `createdAt`/`publishedAt` and article `updatedAt` also
expose their Liquid properties. Variant shipping, tax, weight and selling-plan fields are optional
source metadata. Product JSON projects storefront fields, excludes inventory quantities/policies,
and avoids circular collection membership. JSON strings are escaped for use inside script elements.
These implementations still require the designated store's oracle verification.


`pnpm oracle:corpus-prepare --path-map <fixture-path-map.json>` prepares a temporary owned theme
for the 235 nonempty pinned filter examples. The map explicitly pairs each original context path
with a fixture-equivalent path of the same page kind. Inputs and decoded source hashes, request
paths and alternate template identities are retained in an ignored local manifest; the ten empty
upstream examples are reported without fabricating code. The command makes no Shopify requests or
uploads. Fixture resource literals and IDs still require explicit calibration against the seeded
store before collection; preparation does not establish conformance.

`pnpm oracle:backup-audit --catalog <archive-dir> --theme <archive-dir>` audits existing partial
pre-wipe exports against `.local/oracle.json`. It checks file hashes, product counts, cursor chains,
nested pagination and the archive inventory without interpreting archived instruction files. Output
contains counts and hashes, with a local report under `.local/results`; it contains no archived
payloads. Exit 2 means integrity or scope findings, and exit 3 means invalid/inaccessible input.
Even exit 0 does not establish complete store coverage, successful restoration, fresh store
identity or action-time owner approval. This utility makes no Shopify requests or mutations.

`pnpm oracle:supplemental-backup-audit --kind <kind> --archive <archive-dir>` checks existing
supplemental exports. Kinds are `collections`, `product-media`, `content`, `inventory`, and
`collection-sources`. All check hashes, counts, duplicate references and the declared file inventory.
Inventory checks every declared quantity state and the parameterized inventory-level owner ID.
Content checks article/blog links, content metafield owners and metaobject definition references.
Collection sources check nested pagination and condition fields against their archived contracts.
These are local structure checks, not proof that an export captured every remote field or page.
Reports contain counts and hashes; exit codes follow `oracle:backup-audit`. Complete store coverage,
remote capture stability, successful restoration and wipe authorization remain separate evidence,
even when the local archive passes. This development utility makes no Shopify requests and is not
a store importer for the SDK.

`pnpm oracle:seed-prepare --snapshot <snapshot.json> --images <fixture-png-dir>` prepares a local desired-state plan for the
entire 18-request benchmark matrix. It groups identical persistent states, keeps session carts
separate, orders resource dependencies and reports ambiguous image metadata, inventory and menu
references. The private plan retains source payloads under `.local/results`; stdout contains
counts, hashes and blocker codes. These tasks are source-shaped preparation data, not executable
Admin API requests. Real IDs, generated timestamps, image processing and shop settings require
calibration. The command makes no requests, uploads or mutations and does not authorize a wipe.
The fixture image files must be local PNGs with dimensions matching their snapshot metadata.
Their exact byte hashes are recorded for later upload and calibration; symlinks are rejected.

`pnpm oracle:seed-requests-prepare --snapshot <snapshot.json> --images <fixture-png-dir>
--admin-schema <retained-2026-10-input-schema.json>` compiles local create/update request templates
and validates their input contracts. Private output retains payloads and unresolved dependency
references; stdout contains counts and status. Real resource IDs, processed image URLs, the inventory
location and Online Store publication must resolve before a request can be formed. Collection
membership updates require observed members and an owned source ID; manual ordering uses only
necessary sequential moves and requires a completed reorder job. This tool has no network transport
and does not execute mutations or grant authorization. Server behavior and read-back calibration
remain unverified until the guarded oracle setup runs.

The internal oracle runtime also prepares isolated storefront carts from owned, verified and
published fixture variants. It refuses existing carts, requires a separate authorization callback
for each session write, and keeps cookies and cart tokens in memory. Cart captures recheck source
state and the actual cart before and after both HTML reads. Observed line keys and response order
can be applied to a calibrated case snapshot; this alone does not establish Shopify parity or
capture readiness. These tools remain outside the published offline SDK.

Comparison copies can opt into `instrumentTheme(root, { captureContext: true })`. The reserved
snippet records Native request identity, cart context and epoch time in the same HTML response.
`captureCartContext` checks its uploaded source alongside the full theme files and requires stable
non-clock context across both captures. Calibrated snapshots use the first observed Native time;
the captured section text remains subject to the ordinary stability check. Applying this context
still requires separate resource, image and complete-case evidence.

`captureSeededCase` on the internal state driver captures an already owned fixture state. It reads
the complete state, shop settings, generated fields and Native image views on both sides of the
isolated session capture, then assembles the calibrated snapshot and HTML as an opaque receipt.
The receipt retains separate base-fixture and case-snapshot hashes, the original request (including
pagination/search parameters), and raw-response hashes. Theme-pin verification, offline parity,
full matrix coverage and release freshness remain separate gates.

`preparePinnedBenchmarkTheme` downloads the locked public source into temporary storage and prepares
the comparison copy. `createBenchmarkThemeVerifier` checks its complete uploaded file inventory;
`readOracleAllThemeFiles` supplies paginated inventory and body reads bracketed by a second inventory.
Fresh capture challenges bind those checks to the actual response pair. `makeGoldenArtifact` accepts
only assembled case receipts carrying this theme evidence and emits hashes rather than raw input.
`savePrivateCaseArchive` keeps the calibrated snapshots and manifest under ignored `.local` with
owner-only permissions. The parity loader checks their exact inventory, scope, capture clock and
fingerprints against the public goldens before rendering.

`openOracleBenchmarkUploader` in `tools/oracle/theme-upload.ts` connects a prepared copy to an
unpublished CLI push. A mandatory authorization callback must establish backup/restoration,
the owner-confirmed manual first wipe and upload approval. It checks the pinned development store
and marker, stages only recognized theme files in a private directory, and runs the CLI without
interactive authentication or inherited theme flags. It then checks the returned theme's role,
complete uploaded bytes and store identity before recording private metadata. The returned file
verifier supplies fresh capture checks. Its separate private journal prevents another CLI invocation
after success or an uncertain dispatched outcome, including after reopen; unresolved outcomes require
operator inspection. Opening it performs no upload, and it never publishes or deletes a theme.

`openOracleNativeImageProbeUploader` uses the same guarded lane for the fixed product, collection
and article image probes. Each kind has its own journal scope. Their default and alternate layouts
include Shopify's required header/layout objects, and the CLI staging directory includes the standard
theme folders. These probes contain expressions rather than expected fixture identities. Their file
verifier returns no benchmark receipt, so a probe upload cannot certify a pinned theme or a golden.

`preparePinnedFilterCorpus` binds the full filter input set to the vendored spec commit and generated
source hash, plus the explicit fixture paths and dependency files. The preparation CLI records those
hashes with its private manifest. `openOracleFilterCorpusUploader` accepts the in-memory preparation
receipt and uses the same guarded upload lane; serialized flags cannot authorize a source. A source
receipt establishes neither fixture calibration nor Shopify conformance.

Corpus output travels as canonical UTF-8 Base64 inside the generated HTML payload, preserving closing
script tags and Unicode without changing the upstream example. Both layouts include the required
Shopify header. Offline verification reports the exact generated layout's header omission separately
as `harnessDiagnosticCodes`; server omissions, errors and unsupported behavior inside the example
remain conformance blockers. Output hashes always refer to the decoded captured output.

The seeding transport in `tools/oracle/seed-execution.ts` accepts only steps compiled from its
validated fixture matrix. It requires trusted authorization, dependency ownership verification and
read-back verification callbacks. Each attempt rechecks the pinned shop ID/domain, development-store
status, marker and operation scopes. Explicit pre-execution throttles permit at most four attempts;
lost responses, other server errors and failed postconditions require reconciliation before another
write. Errors expose fixed codes, without API messages or credential values. This component creates
no approvals or credentials and has no live CLI. Backup/restoration, owner-confirmed first wipe,
staged upload handling and the actual verification integration remain prerequisites.

Content source verification reads page, blog and article SEO from the typed
`global.title_tag` and `global.description_tag` metafields. Their create/update payloads use
`MetafieldInput`, because these Admin API resources have no `seo` field. A null fixture value
requires an absent metafield on readback; the helper does not delete an existing SEO metafield,
and a conflicting value fails the mandatory postcondition.

`tools/oracle/seed-identities.ts` reads exact resource-ID batches with a fresh development-store
identity check and verifies expected handles, variant parents/options, collection source/app and
complete membership/order, article parents, active locations and publication catalog/app relations.
Processed images require expected URL/dimensions and an original-byte SHA-256 check using a
credential-free Shopify asset download. The expectations must come from prior verified seeding or
read-back provenance; matching a handle or tag alone does not create ownership or mutation approval.
This reader performs no writes and is separate from the offline SDK. Full source-field calibration
and the trusted seeding callback integration still remain to be completed.

The in-memory binding ledger in `tools/oracle/seed-binding-ledger.ts` records only opaque
`executeVerified` results followed by resource identity reads. Hand-built objects, serialized
`verified` flags, changed fixture/store scopes and failed reads cannot add owned bindings. Product
variant aliases are rebuilt from complete option tuples; removed aliases are discarded atomically.
Its prewrite callback rechecks recorded dependencies and fully enumerates handles before creation.
Environment location/publication choices are verified separately and do not grant mutation approval.
Durable provenance recovery, platform-default menu bootstrap, staged-upload receipts, full source
calibration and live authorization integration remain unfinished; no live seeding CLI is provided.

`captureSeededCorpusCase` uses the same complete before/after state checks as benchmark capture.
It accepts only an opaque pinned corpus source, binds its alternate view to the exact base resource
and query, and checks the full uploaded corpus inventory. Its required context snippet reads the
Native clock and cart from the captured response. `inspectCorpusCapture` derives provenance and
hashes from that receipt; `saveVerifiedCorpusCapture` saves its calibrated snapshot next to the
private raw responses and outputs. `replayCorpusCapture` uses that exact snapshot and source.
Corpus receipts cannot mint benchmark goldens. Resource literals inside the original examples
still require explicit calibration; successful capture alone does not prove those literals exist.

The lower-level corpus capture helper uses the same pinned-development-store and unpublished-theme guards as
page capture, extracts one exact JSON string payload, and requires two identical outputs. Public
observations contain hashes and provenance, with raw HTML and readable outputs kept private.
Observations are not automatically converted into registered implementation evidence. Native
server output that changes between captures requires evidenced normalization or an explicit
server-only disposition before it can qualify; unstable output is never silently accepted.

`tools/oracle/verify-corpus.ts` replays a captured case against the supplied snapshot without
network access. It requires the original and decoded input hashes, mapped request, fixture hash and
upstream pin to match the observation. Both the output hash and UTF-8 byte count must match;
Liquid errors, unsupported behavior, server-only omissions and missing resources prevent a pass.
The helper returns hashes and diagnostic codes without readable output. A successful comparison
alone does not populate the implementation registry or prove coverage of other filters, tags or
object properties in the same example.

`pluralize` selects the supplied singular label only for numeric one, including `1.0`.
It preserves the selected value and requires both labels; numeric strings select the plural label.
This follows the English selection rule and does not translate or generate plural forms.

Collection link filters (`url_for_type`, `url_for_vendor`, `link_to_type`, `link_to_vendor`,
`within`, `sort_by`) generate catalog URLs and anchors from snapshot values. They retain existing
URL queries and fragments, escape HTML attributes, and preserve label markup. `within` accepts a
snapshot collection object; strings and other objects leave the supplied URL unchanged. Empty
catalog labels produce `Unknown Type` or `Unknown Vendor`. These filters also await oracle coverage.

Snapshots may supply an optional top-level `images` array for uploads referenced by filename:

```json
{
  "images": [{
    "filename": "header.png", "file": "uploaded/header.png",
    "alt": "Store header", "width": 640, "height": 320,
    "id": "101", "focalPoint": {"x": "0.5", "y": "0.5"}
  }]
}
```

`file` is relative to the snapshot's `images/` directory. `filename` is the original upload name;
product images are not automatically added to this directory. Filenames must be unique, and a
shared local file must have consistent image metadata. Optional focal-point coordinates are exact
decimal strings from 0 through 1; omitted ids or presentation metadata remain diagnosed when used.
The same objects back `images['header.png']` and image picker settings such as
`shopify://shop_images/header.png`, including dynamic sources. `default` retains a selected image's
properties. A missing picker resolves to nil with a resource diagnostic; a missing filename lookup
uses Shopify's truthy empty-image behavior. Image filters produce local URLs and never fetch files.

Corpus preparation accepts `--environment <fixture-dependencies.json>` alongside `--path-map`.
The environment contains `files` entries with `path`, `encoding` (`utf8` or canonical `base64`),
`content`, and `provenance: "authored-fixture"`. Dependencies may supply assets, locale JSON and
`config/settings_schema.json` / `settings_data.json`; they cannot replace generated layouts,
templates, sections or snippets. Raw files stay in the private manifest and temporary theme.

Each case binds the exact byte contents of its generated harness and dependencies with
`harnessHash`. Capture requires a `readThemeFiles` adapter and checks uploaded file hashes before
and after the two HTML requests. `readOracleThemeFiles` provides a read-only Admin API adapter using
existing credentials, sequential batches and credential-free Shopify CDN reads. Wrong roles,
partial file lists, changed bytes and redirects fail capture. Offline replay requires the same
environment and hash; readable dependency content is excluded from public observations. No app,
token, upload or store mutation is performed by preparation or these read helpers.

Core language overrides match reference behavior for `contains nil` / `contains false` (always false) and `replace`
with an empty search string (insertion at every Unicode character boundary, including both ends).
Ordinary replacement patterns retain the pinned engine's behavior. These fixes do not establish
complete Liquid language conformance or Shopify oracle coverage.

`truncatewords` adds an ending only when the input exceeds the word limit. Short and exact-boundary
strings preserve their original whitespace; truncation splits on ASCII whitespace, keeping
nonbreaking spaces within words. Counts use integer conversion, including integer string bases
and separators; float or invalid counts report inline Liquid errors. Nil input stays nil, and an
explicit nil ending is empty. Arrays and plain hashes use inspected text during filter coercion.

Numeric literals preserve integer/float identity through assignments, nested tags, render arguments
and dynamic settings. Integer division floors the result; either float operand retains a fractional
result. Arithmetic keeps float results such as `3.0 | times: 2` as `6.0`, and `json` preserves finite
float number lexemes, including nested values, without converting them to strings. Integer division
by zero and all modulo by zero report Liquid errors. Float division by zero displays `Infinity`.

Dates without an explicit timezone use `shop.timezone`; explicit offsets identify an instant
that is displayed in shop time. Parsing and formatting do not consult the host timezone.
During daylight saving changes, nonexistent local times advance across the gap and repeated
times select their first occurrence. Empty or nil positional date formats preserve the input
text. `time_tag` uses a UTC datetime attribute and shop-local display text.

Cycle counters share an evaluated name across candidate lists, share literal values across quote
styles, and keep unnamed variable cycles independent per parsed tag. Render calls isolate counters;
includes share their caller's counters. Direct range arguments display their bounds, while array
arguments concatenate their values. Core language conformance remains under audit.

Ranges preserve their `start..end` display through assignments and expose numeric iteration,
`join` and JSON arrays. An inverted range keeps its endpoints and survives `default` while
iterating zero times. String filters use the bounds text; array filters enumerate the numbers,
and `concat` still requires an array as its second argument. Dynamic bounds are evaluated in
their actual scope and reject float values. Failed range assignments retain the prior value
and produce a source diagnostic. Endpoint precision and preview resource limits remain enforced.

Quoted Liquid literals retain backslashes without decoding escape sequences. The first matching
quote ends the literal value; use the opposite quote style to include quotation marks. Public
tokenizer adapters preserve the original source text and positions for outputs, assignments,
tag/filter arguments, property keys, multiline Liquid statements and dynamic settings.
Keywords followed by a dot or bracket resolve as variable names (for example `blank.foo` or
`empty[1]`); their standalone literal meaning is preserved.
Special literal comparisons treat nil as blank and keep the empty/blank sentinels distinct in
either operand order, while preserving ordinary value comparisons.
Plain JSON hashes supplied in snapshots display as `{"key"=>"value"}` in outputs and `echo`.
Outer arrays concatenate their elements, while arrays inside a hash retain inspected notation.
The `json` filter keeps its JSON serialization contract, and resource Drops retain their own
display behavior. A range used as a lookup key does not alias its `start..end` string.
Selection filters (`where`, `reject`, `find`, `find_index`, `has`) read literal properties
from each item. They flatten nested input arrays, preserve item order and avoid caller-global
fallbacks. String items support literal fragment, character-index and range lookups; a nil
target selects truthy property values. Invalid scalar lookups produce source diagnostics.

Nested loops expose `forloop.parentloop`, including multi-level parent metadata and live saved
references. Includes share the caller's loop context; isolated render calls start their own root
loop context. Inspector loop instrumentation preserves these relationships through loop control
and scope restoration.
The standalone `reversed` keyword is recognized immediately after the collection, before named
`limit` and `offset` attributes.

`tablerow` emits Shopify's row/cell boundaries and whitespace, exposes live `tablerowloop` metadata,
and consumes break/continue within the table loop. Empty arrays emit an empty row; nil/false
collections emit nothing. Cell rendering preserves snippet markup and inspector block ownership.

Includes support dynamic filenames, `with` / `for` bindings and aliases. Named parameters are
evaluated in order, so later parameters can use earlier ones. Included snippets share caller
variables and counters, and propagate break/continue to a calling loop. Array bindings repeat
in the shared scope without creating a new `forloop`; temporary bindings restore afterwards.
Snippet loading uses the same source parser, asset collection and inspector as render calls.
Preview nesting is bounded to 100 inspector frames; deeper recursion produces a Liquid diagnostic.

`pnpm language:check --suite-dir <clean-liquid-spec-checkout>` audits the pinned
`Shopify/liquid-spec@84bf25e0edbca5f7e530574788b0f875ab331f50` basics inputs through the real SDK
renderer with isolated snippet bindings. It requires Git and Ruby's standard YAML loader for this
dev command; the published renderer does not use Ruby. Only a clean checkout at that commit is
accepted. Source files remain outside the repo and package. The metadata-only report identifies
the canonical suite clock (`2024-01-01T00:01:58Z`, UTC) used for the audit alongside
failing and unexercised cases, and the command exits 1 if either exists. It does not replace the
complete language suite or designated Shopify oracle. Test Drop constructor directives, which cannot
be instantiated by the snapshot JSON bridge, are reported as unexercised rather than treated as
ordinary objects or passing examples.
