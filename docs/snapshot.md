# Snapshot format

A snapshot is the store data a theme renders with: a folder containing `snapshot.json` and an
`images/` folder. The JSON Schema is `schemas/snapshot.schema.json` (or
`shopify-offline-preview schema snapshot`). `render --data`, `dev --data` and the browser
playground validate it before rendering; reference integrity (handles, variant IDs, image files)
is checked by the renderer as well.

The snapshot holds **source data only**: what a merchant or the Admin API would show. Liquid
values such as `price_min`, `available`, `options_with_values`, URLs, collection membership,
pagination and search results are derived from it ([SPEC §8.4](../SPEC.md#84-data-model--snapshot-source-shaped)).
The library never contacts a store; obtain the data with any export or collection tool and convert
it to this shape. Do not put real customer data in fixtures.

## Missing data

Optional fields stay optional. When a theme reads one that the snapshot omits, the value is nil
and the render reports `missing-resource` with the message
`Object property <type>.<property> is absent from the snapshot.` Supplying the field removes the
diagnostic. Where Shopify itself can have "nothing", the schema accepts `null` to say so
explicitly (for example `focalPoint: null`, `socialSharingImage: null`, a `null` swatch).

## Conventions

- **Prices** are decimal strings in the shop currency (`"12.50"`), never floats. Liquid prices are
  derived in hundredths; values that need more precision are rejected.
- **IDs** are optional strings. Safe decimal IDs become Liquid numbers; larger or non-decimal IDs
  stay strings. A media ID is never inferred from an image ID.
- **Images** use paths relative to `images/`. A referenced file that is missing renders as an SVG
  placeholder of the requested size, in `dev` and in the playground.
- **Times** are ISO 8601 with an offset. `meta.now` is the render clock (`now`, `today`); display
  times use `shop.timezone` (an IANA name), never the host clock.

## Top-level fields

| Field | Contents |
|---|---|
| `meta` | `now`, `schemaVersion` (`"1.0"`). |
| `shop` | Name, primary `domain`, `locale`, `currency`, `money_format`, `money_with_currency_format`, `timezone`, and optional metadata below. |
| `localization` | Optional available countries and languages and the selected `country` / `language`. |
| `products`, `collections`, `pages`, `blogs` | Catalog and content, below. |
| `menus` | Link lists by handle, with nested `links`. |
| `metaobjects` | Entries with `type`, `handle` and `fields`. |
| `images` | Optional uploaded files by original filename (image pickers, `images['name.png']`). |
| `cart` | Lines (`productHandle`, `variantId`, `quantity`) and `note`. |
| `filters` | Storefront filter configuration for collection facets. |
| `placeholderSvgs`, `paymentTypeSvgs` | Optional platform artwork you supply as SVG strings. |
| `scenarios` | Named JSON merge patches applied with `--scenario`. |

## Shop

Optional shop metadata: `id`, `permanentDomain`, `description`, `seo`, `customer_accounts_enabled`,
`customer_accounts_optional`, `enabled_payment_types`, boolean `features`, `policies` (`title`,
`body`, `url` under `/policies/`, optional `id`), and `socialSharingImage` (an image, or `null`
when the store has none; it becomes `page_image` outside product, collection and article pages).
Shop product and collection counts come from the supplied arrays, so supply the full catalog for
accurate counts.

`seo` on the shop and on resources supplies a nullable `title` override and the resolved storefront
`description`. A null title falls back to the resource title or shop name. Supply the resolved
description explicitly; an Admin export's empty custom description does not tell what the storefront
shows.

## Localization

`localization` lists `availableCountries` (`isoCode`, optional `name` and `currency` with `isoCode`,
`symbol`, `name`) and `availableLanguages` (`isoCode`, optional `name`, `endonymName`, `primary`,
`rootUrl`), plus the selected `country` and `language`, which must be listed. Availability is source
data; it is not guessed from the shop currency or locale. Without it, `localization` is nil and
diagnosed. `request.locale` is the listed language matching `shop.locale`; its `direction` (`ltr` or
`rtl`) is derived from the language code. `cart.currency` takes its `name` and `symbol` from the
selected country's currency when that is the shop currency.

## Products

A product has `handle`, `title`, `descriptionHtml`, `vendor`, `productType`, `tags`,
`templateSuffix`, `options`, `variants` (at least one), `images`, `metafields` and optional metadata
(`id`, `createdAt`, `publishedAt`, `category`, `seo`, `giftCard`, `requiresSellingPlan`,
`sellingPlanGroups`, `quantityPriceBreaksConfigured`, `media`).

- **Options** have a `name` and `values`. Optional `valueIds` and `swatches` list one entry per
  value, in order: Shopify option value IDs, and swatches (`{ "color": "#hex" | null, "image":
  image | null }`, or `null` for a value without a swatch).
- **Variants** have a string `id`, `optionValues` (`{name, value}` per option), `price`,
  `compareAtPrice` (or `null`), `available`, `sku`, `barcode` and `image` (an image `file` of the same
  product, or `null`). Optional: `requiresShipping`, `taxable`, `weight`, `requiresSellingPlan`,
  `sellingPlanAllocations`, `quantityRule`, `quantityPriceBreaks`, `unitPrice`,
  `unitPriceMeasurement`, `inventoryManagement`, `inventoryPolicy`, `inventoryQuantity`,
  `storeAvailabilities`. Selling-plan and pickup arrays are prepared Liquid-shaped JSON.
- **Images** have `file`, `alt` (string or `null`), `width`, `height`, and optional `id`,
  `focalPoint` (`{x, y}` exact decimal fractions from 0 to 1, or `null` when none was set — Shopify
  then reports the centre and `image_tag` adds no `object-position`), `mediaId`, `mediaAlt` and
  `previewAlt` for the separate media and preview views.
- **Media** (optional) lists the product's media in storefront order. Without it, the media are the
  images. Each entry has a `mediaType`:

  ```json
  [
    { "mediaType": "image", "file": "shirt.png" },
    {
      "mediaType": "video", "id": "71", "alt": "Walkthrough", "duration": 4000,
      "previewImage": { "file": "poster.png", "alt": null, "width": 640, "height": 320 },
      "sources": [
        { "file": "clip.mp4", "format": "mp4", "mimeType": "video/mp4", "width": 640, "height": 320 }
      ]
    },
    {
      "mediaType": "external_video", "alt": null, "host": "youtube", "externalId": "abc123",
      "previewImage": { "file": "yt.png", "alt": null, "width": 480, "height": 360 }
    },
    {
      "mediaType": "model", "alt": "Needle",
      "previewImage": { "file": "model.png", "alt": null, "width": 512, "height": 512 },
      "sources": [{ "file": "needle.glb", "format": "glb", "mimeType": "model/gltf-binary" }]
    }
  ]
  ```

  Every product image must appear exactly once as an `image` entry. Video and model source files
  live under `images/` like images and are served locally.

## Metafields and metaobjects

`metafields` maps namespace → key → value on products, pages, blogs and articles. A value written
as `{"type": "<Shopify metafield type>", "value": <Liquid value>}` (exactly those two keys) is a
**typed metafield**: it exposes `value`, `type` and `list?`, outputs its value, and works with
`metafield_tag`. Reference types (`product_reference`, `list.collection_reference`, …) are not
resolved offline; reading their `value` is diagnosed and returns nil. Any other JSON value is a
legacy metafield and is exposed unchanged.

`metaobjects` entries are available as `metaobjects.<type>.<handle>`, with `system.type`,
`system.handle`, and per type `values` and `values_count`. Their `fields` follow the same rule:
typed values become metafields, other JSON is exposed as is.

## Collections, pages, blogs and menus

- **Collections:** `handle`, `title`, `descriptionHtml`, `image` (or `null`), `products` (ordered
  handles), `sortOrder` (the default `sort_by`), `templateSuffix`, optional `id`, `seo` and
  `sortOptions` (localized `{value, name}` labels; English labels are used otherwise).
  `collections.all` exists automatically unless you supply a collection with handle `all`.
- **Pages:** `handle`, `title`, `bodyHtml`, `templateSuffix`, `metafields`, optional `id`, `seo`.
- **Blogs:** `handle`, `title`, `templateSuffix`, `metafields`, `articles`, optional `id`, `seo`,
  `commentsEnabled`. Articles have `handle`, `title`, `bodyHtml`, `excerptHtml`, `author`,
  `publishedAt`, `image`, `tags`, `templateSuffix`, `metafields` and optional `id`, `createdAt`,
  `updatedAt`, `commentsCount`, `seo`.
- **Menus:** `handle`, `title` and `links` (`title`, `url`, `type`, `resourceHandle`, nested
  `links`). Link state (`current`, `active`, child state, `levels`), a title-based `handle` and the
  linked resource `object` are derived from the URLs. Stores usually have `main-menu`, `footer` and
  `customer-account-main-menu`, and themes read them by handle.

## Uploaded images

Optional top-level `images` entries describe uploads referenced by filename:

```json
{
  "images": [{
    "filename": "header.png", "file": "uploaded/header.png",
    "alt": "Store header", "width": 640, "height": 320,
    "id": "101", "focalPoint": {"x": "0.5", "y": "0.5"}
  }]
}
```

`file` is relative to `images/`; `filename` is the original upload name and must be unique. Product
images are not added to this list automatically. The same objects back `images['header.png']` and
image picker settings such as `shopify://shop_images/header.png`. A missing picker resolves to nil
with `missing-resource`; a missing filename lookup returns Shopify's truthy empty image.

## Cart

Lines refer to a product handle and a variant ID and have a quantity. Optional per-line `key`,
`instructions`, `parentRelationship` and `itemComponents`, and cart-level `taxesIncluded` /
`dutiesIncluded`, can be `null` where that was observed. Keys come from the snapshot; Shopify's
hashes are not invented. Totals are exact sums of variant prices; compare-at prices are not
discounts.

## Storefront filters

`filters` lists the store's filter configuration: `id` (`filter.p.vendor`, `filter.p.product_type`,
`filter.p.tag`, `filter.v.availability`, `filter.v.option.<name>`, `filter.p.m.<namespace>.<key>`,
`filter.v.price`), `label`, `type` (`list`, `boolean` or `price_range`) and `values`
(`{label, value}`). See [rendering.md](rendering.md#collections-and-search) for how they apply.

## Platform artwork

Shopify artwork is not redistributed. To render it, supply SVG strings yourself:

- `placeholderSvgs` keyed by documented placeholder names, for `placeholder_svg_tag`;
- `paymentTypeSvgs` keyed by `shop.enabled_payment_types` entries, for `payment_type_svg_tag`.

Give each SVG's base output without a root `class`; the filter inserts the class argument and keeps
the artwork bytes. Each entry is limited to two million characters. A missing entry renders nothing
and reports `missing-resource`.

## Scenarios

`scenarios` maps names to JSON merge patches over the snapshot. `--scenario <name>` and the
inspector's scenario selector apply one without changing the source. The bundled fixture defines
`sold-out`, `single-variant`, `no-images`, `long-content`, `empty`, `with-items`, `with-image` and
`without-image`, used by the benchmark matrix ([SPEC §9.3](../SPEC.md#93-fixture-and-scenario-matrix)).
