# Rendering behaviour

This page describes what the offline renderer reproduces and what it reports instead. Everything
here is implemented locally from Shopify's documentation, the benchmark themes and platform
conventions. None of it has been compared with a real Shopify render yet
([SPEC §9](../SPEC.md#9-verification-system)); [Unverified expectations](#unverified-expectations)
lists the choices most likely to need correction.

Rendering uses the pinned `liquidjs` engine with Shopify's objects, filters and tags layered on top.
Producing HTML never touches the network, and the same inputs produce byte-identical HTML in Node
and in the browser build.

## Routes and templates

- Paths: `/`, `/products/<handle>[?variant=]`, `/collections/<handle>[?page=&sort_by=&filter…]`,
  `/collections/all`, `/pages/<handle>`, `/blogs/<blog>[?page=]`, `/blogs/<blog>/<article>`,
  `/search?q=`, `/cart`. Any other path renders the `404` template.
- The template is the resource's `templateSuffix` or the `?view=` alternate. When that alternate is
  not in the theme, the renderer falls back to the assigned template and then the default one, and
  reports `missing-resource`.
- `template` outputs `product` or `product.alt` and has `name`, `suffix` and `directory`.
- `routes` provides the standard storefront paths (`/cart`, `/cart/add`, `/search`, …) for the
  primary locale. `account_profile_url` and `storefront_login_url` depend on the store's account
  host and are diagnosed.

## Page assembly

- The layout (`theme.liquid`, or the template's `layout` override, or none) wraps
  `content_for_layout`. JSON templates render their `order`, skipping disabled sections. Section
  groups render where the layout calls `{% sections %}`. Wrappers use Shopify's
  `shopify-section` / `shopify-section-group-*` markup and the schema's `tag` and `class`.
- Classic section blocks, theme blocks (`blocks/`, `content_for 'blocks'`), static blocks
  (`content_for 'block'`) and nested blocks run with isolated parameters, scoped `closest`
  resources and their own source mapping. Classic block loops keep native loop control.
- App blocks and app embeds (`shopify://apps/...`) render as labelled placeholders with
  `app-placeholder` diagnostics.
- `{% stylesheet %}` bodies are collected once per rendered file; `{% javascript %}` bodies from all
  section, block and snippet files run once, deferred, each with its own closure and error boundary.
  Both keep literal code (use `{% style %}` for CSS with Liquid). Shopify's generated CDN bundle
  URLs are replaced by local inline CSS and data-URL scripts (`shopify-server-only`).
- Snippets: `render` with named, `with` and `for` arguments in an isolated scope; `include` shares
  the caller's variables and loop control. Dynamic snippet names render a visible marker. Nesting is
  limited to 100 inspector frames.

## Settings

Theme, section and block settings resolve their values and schema defaults:

| Setting type | Value |
|---|---|
| `color`, `color_background` | Colours expose RGB, HSL and alpha properties; other formats are diagnosed. |
| `color_scheme`, `color_scheme_group`, `color_palette` | Schemes resolve by id with defaults; palettes keep named lookup and order, merge merchant values over new defaults and resolve colour references. |
| `font_picker` | Assistant, Inter, Work Sans and Anonymous Pro with their weights and styles. `font_face` / `font_url` use fixed Google Fonts URLs (`shopify-server-only`); others are diagnosed. |
| `image_picker` | Uploaded images from the snapshot's `images`; absent ones are nil with `missing-resource`. |
| `product`, `collection`, `page`, `blog`, `link_list`, `article` | The snapshot resource (`article` stores `<blog>/<article>`); absent handles are nil with `missing-resource`. |
| `product_list`, `collection_list` | Arrays of snapshot resources with `count`. |
| `url` | `shopify://products/…`, `collections/…`, `pages/…`, `blogs/…[/…]` become storefront paths; other `shopify://` forms are diagnosed. |
| `liquid` | The code renders when read, in a child of the section or block scope: it sees the section's variables, and its assignments stay inside. |
| `video_url` | Outputs the URL and exposes `id` and `type` (`youtube` / `vimeo`). |
| `video`, `metaobject`, `metaobject_list` | Diagnosed as not implemented; the value is nil. |

Dynamic sources (`{{ product.title }}` in a setting value) resolve in their scope; Liquid logic tags
inside other setting values are not executed and are diagnosed. Reference cycles fail visibly.

## Objects

The snapshot becomes Shopify's objects: `shop`, `product`, `collection(s)`, `all_products`, `page(s)`,
`blog(s)`, `article(s)`, `cart`, `search`, `linklists`, `metaobjects`, `localization`, `request`,
`routes`, `images`, `settings`, `section`, `block`, `form`, `paginate`, `closest` and the page
globals (`page_title`, `page_description`, `canonical_url`, `page_image`, `content_for_header`,
`powered_by_link`, `current_page`, `handle`).

Every documented object reports what it cannot answer. Reading a property that the object does
not have produces `not-implemented` (or `missing-resource` when the snapshot simply omits that
field). Lookups by merchant-defined keys — settings, metafield namespaces, dictionary handles — are
plain nil when absent, as on Shopify. Globals without offline state are explicit: `customer`,
`self` and `current_tags` are nil (no customer session, metaobject page or tag route),
`recommendations` reports `performed?: false`, checkout button globals are `shopify-server-only`,
and `theme`, `scripts` and the country option tag globals are diagnosed.

Highlights of what is derived:

- **Products:** prices in hundredths, availability, `selected_or_first_available_variant`,
  `options_with_values` with `product_option_value` objects (`selected`, `available` constrained by
  earlier selections, the matching `variant`, `id`, `swatch`), `media` including videos, external
  videos and 3D models, and `featured_media`.
- **Menus:** link `current`, `active`, `child_active`, `child_current`, `levels`, a title-based
  `handle`, and the linked resource as `object`.
- **Metafields:** typed metafields expose `value`, `type` and `list?`; see
  [snapshot.md](snapshot.md#metafields-and-metaobjects).
- **Page metadata:** `canonical_url` is `https://<shop domain><path>` with `?page=` only past page 1;
  `page_image` is the product, collection or article image, else the shop's social sharing image.
- **Cart:** line items, quantities and exact undiscounted totals from the snapshot; cart and
  product forms render their initial HTML, and submissions go to the blocked-endpoint boundary.

## Collections and search

- The viewed collection applies `sort_by` (title, price, creation date) and the snapshot's storefront
  filters (vendor, product type, tag, availability, variant option, product metafield, price range)
  to `collection.products`. `products_count` is the filtered count and `all_products_count` the full
  one. Filters expose values with `active`, facet `count`, `url_to_add` / `url_to_remove`, and
  `active_values`; URLs keep other parameters and drop `page`.
- Orders and filters the snapshot cannot decide (a requested best-selling or manual order, creation
  order without dates, an unknown filter) are diagnosed and leave the snapshot order or results
  unchanged.
- `collections.all` is the automatic catalog sorted by title; a supplied `all` collection wins.
- Search matches product, page and article words with the documented `type`, prefix and
  availability options. Advanced query syntax and ambiguous relevance ranking are diagnosed.
  Storefront filters are not applied to search results.
- Pagination slices collection products, blog articles, search results and product variants
  (including collection settings) without changing their source; page links keep the query.

## Filters

Implemented filters cover money formatting (from the snapshot's formats), `t` with theme,
section and Shopify system translations, dates and `time_tag` (shop time zone, theme
`date_formats`), colour manipulation, `link_to` and catalog link filters, `handleize`, `json`,
`structured_data`, `image_url` / `image_tag` / preload hints (local URLs; the browser scales the
original bytes), asset URLs and `inline_asset_content`, `placeholder_svg_tag`,
`payment_type_svg_tag`, `metafield_tag` (text, number, boolean, colour, URL, JSON, money and
single-line text lists), `unit_price_with_measurement`, `default_pagination`, and the media filters
(`media_tag`, `video_tag`, `external_video_url`, `external_video_tag`, `model_viewer_tag`).

`check` lists which documented filters are registered. The rest render
`[not implemented: filter <name>]` with a `not-implemented` diagnostic; unknown filter names fail
explicitly. `payment_button`, `payment_terms` and `login_button` output nothing and report
`shopify-server-only`.

## Liquid language

Behaviour checked against `Shopify/liquid-spec` where `liquidjs` differs:

- `contains nil` / `contains false` are false; `replace` with an empty search string inserts at every
  character boundary.
- Integer and float identity survives assignments, arguments and settings; integer division floors,
  float division keeps fractions, division by zero follows Liquid.
- `default` returns the kept object itself (a colour or font setting keeps its properties).
- Ranges keep their `start..end` display; `cycle` groups follow Liquid naming rules; `tablerow` and
  nested `forloop.parentloop` metadata are reproduced.
- Quoted literals keep backslashes; keywords followed by a dot or bracket are variable names; plain
  hashes display as `{"key"=>"value"}`.
- `truncatewords`, `pluralize`, selection filters (`where`, `find`, …) and `date` parsing follow
  Liquid's rules for edge cases.

`pnpm language:check` audits the pinned liquid-spec basics; it does not replace the full suite.

## Not reproduced offline

- Checkout, accelerated checkout buttons, Shop Pay installments, the Shop login button and
  customer accounts.
- `content_for_header` scripts and Shopify's HTTP `Link` preload header.
- App code (apps appear as placeholders) and theme JavaScript server calls: `/cart/*.js`,
  `/cart/add`, the Section Rendering API (`?section_id=`, `?sections=`), `/search/suggest`,
  `/recommendations/products` and `/products/<handle>.js` answer HTTP 501.
- Shopify's font CDN, localized system strings for non-English locales, multi-currency and Markets.
- Without internet access, theme scripts that import Shopify's CDN cannot run. Horizon's import
  map loads `@shopify/events` from `cdn.shopify.com`, so offline its interactive components
  (variant picker, add to cart, drawers) stay inactive; the rendered HTML is unaffected.
- `format_address`, comment lists, discounts and other features listed as unregistered by `check`.
- Absolute image URLs: offline image URLs are root-relative (`/sop/images/…`), so a theme that
  prefixes `http:` (for example for `og:image`) produces `http:/sop/images/…`.

## Unverified expectations

These follow documentation or platform convention but are the most likely to differ from Shopify:

- route paths, menu link `handle` and `active` rules, the template fallback order, `template`
  output;
- facet counts (each filter's own selection excluded), the price sort basis (lowest variant
  price), the `OR` operator for multi-value filters, canonical URL query handling;
- the markup of `default_pagination`, `metafield_tag`, `unit_price_with_measurement`, the media
  filters and `new_comment` forms (element structure is documented; attribute order, default
  labels and player parameters are not);
- `shop_locale.direction` for languages outside the common right-to-left set.
