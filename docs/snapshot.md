# Snapshot format

A snapshot is the store data a theme renders with. It is a folder:

```text
my-store/
  snapshot.json
  images/          image, video and 3D model files referenced from snapshot.json
```

Pass it with `--data my-store` to `dev` or `render`, or open it in the playground with **Snapshot
zip** or **Snapshot folder**. The JSON Schema is `schemas/snapshot.schema.json`, also printed by
`shopify-offline-preview schema snapshot`.

A snapshot holds what a merchant enters in the Shopify admin: products, prices, collections and so
on. It does not hold what Liquid computes from that data, such as `product.price_min`, `available`,
URLs, collection membership, pagination or search results. The preview computes those itself.

## A minimal snapshot

```json
{
  "meta": { "now": "2026-01-15T12:00:00Z", "schemaVersion": "1.0" },
  "shop": {
    "name": "Example Store",
    "domain": "example.com",
    "locale": "en",
    "currency": "USD",
    "money_format": "${{amount}}",
    "money_with_currency_format": "${{amount}} USD",
    "timezone": "America/New_York"
  },
  "products": [
    {
      "handle": "shirt",
      "title": "Shirt",
      "descriptionHtml": "<p>A plain shirt.</p>",
      "vendor": "Example",
      "productType": "Shirts",
      "tags": [],
      "templateSuffix": null,
      "options": [{ "name": "Size", "values": ["S", "M"] }],
      "variants": [
        {
          "id": "1001", "optionValues": [{ "name": "Size", "value": "S" }],
          "price": "25.00", "compareAtPrice": null, "available": true,
          "sku": "SHIRT-S", "barcode": "", "image": null
        },
        {
          "id": "1002", "optionValues": [{ "name": "Size", "value": "M" }],
          "price": "25.00", "compareAtPrice": null, "available": false,
          "sku": "SHIRT-M", "barcode": "", "image": null
        }
      ],
      "images": [{ "file": "shirt.png", "alt": "Shirt", "width": 64, "height": 64 }],
      "metafields": {}
    }
  ],
  "collections": [],
  "pages": [],
  "blogs": [],
  "menus": [
    {
      "handle": "main-menu",
      "title": "Main menu",
      "links": [
        { "title": "Shirt", "url": "/products/shirt", "type": "product_link", "resourceHandle": "shirt", "links": [] }
      ]
    }
  ],
  "metaobjects": [],
  "cart": { "lines": [], "note": null },
  "filters": [],
  "scenarios": {}
}
```

With `images/shirt.png` next to it, `/products/shirt` renders. For a complete example, see the
bundled sample store in `fixtures/default/`.

## Missing data

Most fields are optional. When a theme reads data that the snapshot does not have, the value is
unavailable. This does not assert that the store had no such data. The render reports `missing-resource`,
naming what was missing. For example:

```text
missing-resource: Setting collection references a resource absent from the snapshot.
missing-resource: Resolved SEO description for shop is absent from the snapshot.
```

Add the data to make the diagnostic go away. Some fields can be `null`, meaning the store has
nothing there. Examples are an image without a focal point, a shop without a social sharing image,
and an option value without a swatch. `null` is data, not missing data, so it produces no
diagnostic.

The following fields may be omitted when an export did not capture them: shop name, locale and
both money formats; variant availability and image association; image width/height; media preview
images; article publication dates and images; collection images and product membership; menu
resource handles; and storefront filters. SKU and barcode accept explicit `null` for known absence.
Omission never means `false`, `null` or an empty array. Derived values that need missing inputs are
unavailable too, with diagnostics when accessed. Date/translation/money output is omitted when its
required locale or format is unknown. Lists with unknown publication dates retain source order and
report the missing ordering metadata. Theme code may itself raise Liquid errors when it divides by
an unknown image ratio or passes a missing image to `image_url`; those errors remain visible.

Oracle tools that prepare store changes still require complete input via `completeSnapshotSchema`.
They reject incomplete backups rather than synthesizing values for writes.

## Conventions

- **Prices** are decimal strings in the shop currency, such as `"12.50"`, never numbers. A price
  that needs more precision than a hundredth is rejected.
- **IDs** are strings. IDs made only of digits become numbers in Liquid if they fit; other IDs stay
  strings.
- **Files** are paths relative to `images/`. A missing image file renders as a placeholder of
  the requested size.
- **Times** are ISO 8601 with an offset. `meta.now` is the time the page is rendered at: `now`,
  `today` and every relative date use it. Dates are shown in `shop.timezone`, an IANA zone name:
  `{{ article.published_at }}` prints like `2026-10-12 20:00:00 -0400`, as on Shopify.

## Top-level fields

| Field | Contents |
|---|---|
| `meta` | `now` and `schemaVersion` (`"1.0"`). |
| `shop` | Shop settings. See [Shop](#shop). |
| `localization` | Optional. Available countries and languages. See [Localization](#localization). |
| `products` | See [Products](#products). |
| `collections`, `pages`, `blogs`, `menus` | See [Collections, pages, blogs and menus](#collections-pages-blogs-and-menus). |
| `metaobjects` | See [Metafields and metaobjects](#metafields-and-metaobjects). |
| `images` | Optional. Files uploaded to the store's Files page. See [Uploaded files](#uploaded-files). |
| `cart` | The cart shown on `/cart` and in cart drawers. See [Cart](#cart). |
| `filters` | The store's search and discovery filters. See [Storefront filters](#storefront-filters). |
| `placeholderSvgs`, `paymentTypeSvgs` | Optional SVG artwork. See [Shopify artwork](#shopify-artwork). |
| `scenarios` | Named variations of the data. See [Scenarios](#scenarios). |

## Shop

Required: `name`, `domain` (the primary domain), `locale`, `currency`, `money_format`,
`money_with_currency_format` and `timezone`.

The optional fields are these:

- `id`, `permanentDomain` and `description`;
- `seo` (`title`, `description`);
- `customer_accounts_enabled` and `customer_accounts_optional`;
- `enabled_payment_types` and `features` (booleans);
- `policies`: `title`, `body` and a `url` under `/policies/`;
- `socialSharingImage`: an image, or `null`.

`shop.products_count` and `shop.collections_count` count what the snapshot contains.

`seo` exists on the shop and on products, collections, pages, blogs and articles. It has two fields:

- `title`: the custom title, or `null` to use the resource's own title.
- `description`: the description the storefront shows. Set it explicitly. An empty custom
  description in the admin does not tell what the storefront actually shows.

## Localization

`localization` has these fields:

- `availableCountries`: each with `isoCode` and optionally `name` and `currency` (`isoCode`,
  `symbol`, `name`);
- `availableLanguages`: each with `isoCode` and optionally `name`, `endonymName`, `primary` and
  `rootUrl`;
- `country` and `language`: the selected codes, which must be in the lists above.

Without it, theme reads of `localization` report `missing-resource`. `request.locale` is the
listed language that matches `shop.locale`.

## Products

Required: `handle`, `title`, `descriptionHtml`, `vendor`, `productType`, `tags`, `templateSuffix`
(or `null`), `options`, `variants` (at least one), `images` and `metafields`.

The optional fields are these:

- `id`, `createdAt`, `publishedAt`, `category` and `seo`;
- `giftCard`, `requiresSellingPlan`, `sellingPlanGroups` and `quantityPriceBreaksConfigured`;
- `media`, described below.

**Options** have a `name` and `values`. They can also have these, each with one entry per value in
the same order:

- `valueIds`: Shopify's option value IDs;
- `swatches`: `{ "color": "#rrggbb" | null, "image": <image> | null }`, or `null` for a value
  without a swatch.

**Variants** require these fields:

- `id`;
- `optionValues`: one `{name, value}` per option;
- `price` and `compareAtPrice` (or `null`);
- `available`, `sku` and `barcode`;
- `image`: the `file` of one of the product's images, or `null`.

Variants can also have these:

- `requiresShipping`, `taxable` and `weight`;
- `inventoryManagement`, `inventoryPolicy` and `inventoryQuantity`;
- `unitPrice` and `unitPriceMeasurement`;
- `quantityRule` and `quantityPriceBreaks`;
- `requiresSellingPlan`, `sellingPlanAllocations` and `storeAvailabilities`. Write selling plans
  and pickup availability in their Liquid shape.

**Images** require `file`, `alt` (or `null`), `width` and `height`. The optional fields are these:

- `id`;
- `focalPoint`: `{ "x": "0.5", "y": "0.3" }`, as fractions of the width and height, or `null`;
- `mediaId`, `mediaAlt` and `previewAlt`, when the image's media entry has its own ID or alt text.

**Media** is optional. It lists the product's media in storefront order. Without it, the media are
the product's images. Each entry has a `mediaType`:

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

Every product image appears exactly once as an `image` entry. Video and model files go in
`images/` with the images.

## Metafields and metaobjects

`metafields` maps namespace → key → value. It exists on products, pages, blogs and articles. A
value can take two forms:

- **Typed**: `{"type": "<metafield type>", "value": <value>}`, with exactly those two keys. It
  behaves like a Shopify metafield. It has `value`, `type` and `list?`, outputs its value, and
  works with `metafield_tag`.
- **Plain**: any other JSON value. It is passed to Liquid as it is.

Reference types such as `product_reference` and `list.collection_reference` are not resolved.
Reading their `value` reports `not-implemented`.

`metaobjects` entries have `type`, `handle` and `fields`. Themes read them as
`metaobjects.<type>.<handle>`. Their `fields` follow the same two forms as metafields.

## Collections, pages, blogs and menus

**Collections** require these fields:

- `handle`, `title`, `descriptionHtml`, `image` (or `null`) and `templateSuffix`;
- `products`: product handles, in the collection's order;
- `sortOrder`: the default `sort_by`.

The optional fields are `id`, `seo` and `sortOptions`. `sortOptions` holds the sort labels as
`{value, name}`; without it, English labels are used. `collections.all` contains every product
unless you supply a collection with the handle `all`. Looping over `collections` (as on
`/collections`) follows the snapshot's order; Shopify lists collections by title, so keep them in
title order to see the same list.

**Pages** require `handle`, `title`, `bodyHtml`, `templateSuffix` and `metafields`. The optional
fields are `id` and `seo`.

**Blogs** require `handle`, `title`, `templateSuffix`, `metafields` and `articles`. The optional
fields are `id`, `seo`, `commentsEnabled` and `commentsModerated` (whether comments wait for approval).

**Articles** require these fields: `handle`, `title`, `bodyHtml`, `excerptHtml`, `author`,
`publishedAt`, `image`, `tags`, `templateSuffix` and `metafields`. The optional fields are `id`,
`createdAt`, `updatedAt`, `commentsCount` and `seo`. A blog lists its articles newest first by `publishedAt`, as
Shopify does; articles published at the same moment list the higher `id` first.

**Menus** have `handle`, `title` and `links`. Each link has `title`, `url`, `type`,
`resourceHandle` and nested `links`. The preview works out these from the URLs and the current
page:

- whether a link is current or active;
- its levels;
- the linked resource.

Most themes read `main-menu` and `footer`, and some read `customer-account-main-menu`.

## Uploaded files

`images` lists files uploaded to the store, which themes reach through image pickers
(`shopify://shop_images/header.png`) or `images['header.png']`:

```json
{
  "images": [{
    "filename": "header.png", "file": "uploaded/header.png",
    "alt": "Store header", "width": 640, "height": 320,
    "id": "101", "focalPoint": {"x": "0.5", "y": "0.5"}
  }]
}
```

`filename` is the name in the store and must be unique. `file` is the path under `images/`. Product
images are not added to this list automatically.

## Cart

`cart.lines` lists `productHandle`, `variantId` and `quantity`. `cart.note` is a string or `null`.

Lines can also have `key`, `instructions`, `parentRelationship` and `itemComponents`. The cart can
also have `taxesIncluded` and `dutiesIncluded`.

Totals are the sum of variant prices times quantities. Compare-at prices are not discounts.

## Storefront filters

`filters` lists the store's filters. Each filter has these fields:

- `id`, one of these forms:
  - `filter.p.vendor`, `filter.p.product_type` or `filter.p.tag`;
  - `filter.v.availability` or `filter.v.price`;
  - `filter.v.option.<name>`;
  - `filter.p.m.<namespace>.<key>`;
- `label`;
- `type`: `list`, `boolean` or `price_range`;
- `values`: `{label, value}` entries;
- `operator` (optional): `AND` or `OR`, how the store combines several selected values. Only tag
  and metafield list filters have this setting; other filters always use `OR`.

Collection pages use them for `collection.filters`. They also apply `filter.…` and `sort_by` URL
parameters to the collection's products. As on Shopify, a collection with no products and a search
whose terms match no product offer no filters.

## Shopify artwork

The preview does not ship Shopify's artwork. To render it, supply the SVG markup yourself:

- `placeholderSvgs`, keyed by placeholder name, for `placeholder_svg_tag`;
- `paymentTypeSvgs`, keyed by the entries of `shop.enabled_payment_types`, for
  `payment_type_svg_tag`.

Give each SVG without a `class` on its root element; the filter adds the class. A missing entry
renders nothing and reports `missing-resource`.

## Scenarios

`scenarios` maps names to JSON merge patches over the rest of the snapshot. A patch can mark a
product sold out, empty a collection or fill the cart. Choose a scenario with `--scenario <name>`
or with the inspector's scenario selector; the snapshot file itself is not changed. The bundled
sample store defines these scenarios:

- `sold-out`, `single-variant`, `no-images` and `long-content`;
- `empty`;
- `with-items`;
- `with-image` and `without-image`.
