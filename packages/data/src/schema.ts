import { z } from "zod";
import { placeholderNames } from "./placeholders.js";

const handle = z.string().min(1);
// Source prices use decimal currency units, like Admin API exports; no float conversion at input.
const money = z.string().regex(/^\d+(?:\.\d+)?$/);
const metafields = z.record(z.string(), z.record(z.string(), z.json()));
const seo = z.strictObject({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
const filterValues = z.array(z.strictObject({ label: z.string(), value: z.string() }));
const configurableFilterId = /^filter\.(?:p\.tag|[pv]\.m\..+)$/;
const localization = z
  .strictObject({
    availableCountries: z.array(
      z.strictObject({
        isoCode: z.string().min(1),
        name: z.string().optional(),
        currency: z
          .strictObject({
            isoCode: z.string(),
            symbol: z.string().optional(),
            name: z.string().optional(),
          })
          .optional(),
      }),
    ),
    availableLanguages: z.array(
      z.strictObject({
        isoCode: z.string().min(1),
        name: z.string().optional(),
        endonymName: z.string().optional(),
        primary: z.boolean().optional(),
        rootUrl: z.string().optional(),
      }),
    ),
    country: z.string(),
    language: z.string(),
  })
  .refine(
    (value) => value.availableCountries.some((country) => country.isoCode === value.country),
    "Selected localization country must be available",
  )
  .refine(
    (value) => value.availableLanguages.some((language) => language.isoCode === value.language),
    "Selected localization language must be available",
  );
const imagePathPattern =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL must be rejected in local file paths and their published JSON Schema.
  /^(?!\/)(?!.*[\\\u0000])(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$).+$/;
const fraction = z
  .string()
  .max(30)
  .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/);
const image = z.strictObject({
  file: z.string().min(1).regex(imagePathPattern),
  alt: z.string().nullable(),
  id: z.string().min(1).nullable().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  // Exact decimal fractions of the width and height; null when the merchant set none.
  focalPoint: z.strictObject({ x: fraction, y: fraction }).nullable().optional(),
});
const localFile = z.string().min(1).regex(imagePathPattern);
const mediaBase = {
  id: z.string().min(1).optional(),
  alt: z.string().nullable(),
  previewImage: image,
};
/**
 * Product media in storefront order. Image entries name a product image by file; other media keep
 * their local source files under `images/`, like images.
 */
const productMedia = z.discriminatedUnion("mediaType", [
  z.strictObject({ mediaType: z.literal("image"), file: localFile }),
  z.strictObject({
    mediaType: z.literal("video"),
    ...mediaBase,
    duration: z.number().int().nonnegative().optional(),
    sources: z
      .array(
        z.strictObject({
          file: localFile,
          format: z.string().min(1),
          mimeType: z.string().min(1),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        }),
      )
      .min(1),
  }),
  z.strictObject({
    mediaType: z.literal("external_video"),
    ...mediaBase,
    host: z.enum(["youtube", "vimeo"]),
    externalId: z
      .string()
      .min(1)
      .regex(/^[\w-]+$/),
  }),
  z.strictObject({
    mediaType: z.literal("model"),
    ...mediaBase,
    sources: z
      .array(
        z.strictObject({
          file: localFile,
          format: z.string().min(1),
          mimeType: z.string().min(1),
        }),
      )
      .min(1),
  }),
]);
export type ProductMedia = z.infer<typeof partialMedia>;
const variant = z.strictObject({
  id: z.string().min(1),
  optionValues: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  price: money,
  compareAtPrice: money.nullable(),
  available: z.boolean(),
  sku: z.string(),
  barcode: z.string(),
  image: z.string().nullable(),
  requiresShipping: z.boolean().optional(),
  taxable: z.boolean().optional(),
  weight: z.number().nonnegative().optional(),
  requiresSellingPlan: z.boolean().optional(),
  sellingPlanAllocations: z.array(z.record(z.string(), z.json())).optional(),
  quantityRule: z
    .strictObject({
      min: z.number().int().positive(),
      max: z.number().int().positive().nullable(),
      increment: z.number().int().positive(),
    })
    .optional(),
  quantityPriceBreaks: z
    .array(z.strictObject({ minimumQuantity: z.number().int().positive(), price: money }))
    .optional(),
  unitPrice: money.nullable().optional(),
  unitPriceMeasurement: z
    .strictObject({
      measured_type: z.enum(["volume", "weight", "length", "area", "count"]),
      quantity_unit: z.string(),
      quantity_value: z.number().positive(),
      reference_unit: z.string(),
      reference_value: z.number().positive(),
    })
    .nullable()
    .optional(),
  inventoryManagement: z.string().nullable().optional(),
  inventoryPolicy: z.enum(["deny", "continue"]).optional(),
  inventoryQuantity: z.number().int().optional(),
  storeAvailabilities: z.array(z.record(z.string(), z.json())).optional(),
});
const product = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }).optional(),
  publishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  category: z.strictObject({ name: z.string(), id: z.string().optional() }).nullable().optional(),
  seo: seo.optional(),
  id: z.string().min(1).optional(),
  handle,
  title: z.string(),
  descriptionHtml: z.string(),
  vendor: z.string(),
  productType: z.string(),
  tags: z.array(z.string()),
  templateSuffix: z.string().nullable(),
  options: z.array(
    z
      .strictObject({
        name: z.string(),
        values: z.array(z.string()),
        // Per value, in `values` order: Shopify option value IDs and swatches (null: none).
        valueIds: z.array(z.string().min(1)).optional(),
        swatches: z
          .array(
            z
              .strictObject({
                color: z.string().nullable(),
                image: image.nullable(),
              })
              .nullable(),
          )
          .optional(),
      })
      .refine(
        (option) =>
          [option.valueIds, option.swatches].every(
            (list) => list === undefined || list.length === option.values.length,
          ),
        "Option value IDs and swatches must list one entry per value",
      ),
  ),
  variants: z.array(variant).min(1),
  images: z.array(
    image.extend({
      mediaId: z.string().min(1).optional(),
      mediaAlt: z.string().nullable().optional(),
      previewAlt: z.string().nullable().optional(),
    }),
  ),
  // Omitted: the product's media are its images, in order.
  media: z.array(productMedia).optional(),
  metafields,
  giftCard: z.boolean().optional(),
  requiresSellingPlan: z.boolean().optional(),
  sellingPlanGroups: z.array(z.record(z.string(), z.json())).optional(),
  quantityPriceBreaksConfigured: z.boolean().optional(),
});
const page = z.strictObject({
  seo: seo.optional(),
  id: z.string().min(1).optional(),
  handle,
  title: z.string(),
  bodyHtml: z.string(),
  templateSuffix: z.string().nullable(),
  metafields,
});
const article = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  commentsCount: z.number().int().nonnegative().optional(),
  seo: seo.optional(),
  id: z.string().min(1).optional(),
  handle,
  title: z.string(),
  bodyHtml: z.string(),
  excerptHtml: z.string(),
  author: z.string(),
  publishedAt: z.iso.datetime({ offset: true }),
  image: image.nullable(),
  tags: z.array(z.string()),
  templateSuffix: z.string().nullable(),
  metafields,
});
const menuLink: z.ZodType<MenuLink> = z.lazy(() =>
  z.strictObject({
    title: z.string(),
    url: z.string(),
    type: z.string(),
    resourceHandle: z.string().nullable(),
    links: z.array(menuLink),
  }),
);
export interface MenuLink {
  title: string;
  url: string;
  type: string;
  resourceHandle: string | null;
  links: MenuLink[];
}

export const completeSnapshotSchema = z.strictObject({
  meta: z.strictObject({ now: z.iso.datetime({ offset: true }), schemaVersion: z.literal("1.0") }),
  shop: z.strictObject({
    id: z.string().min(1).optional(),
    permanentDomain: z.string().min(1).optional(),
    seo: seo.optional(),
    name: z.string(),
    domain: z.string(),
    locale: z.string(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    money_format: z.string(),
    money_with_currency_format: z.string(),
    description: z.string().optional(),
    // Online Store social sharing image (`page_image` outside resource pages); null when unset.
    socialSharingImage: image.nullable().optional(),
    customer_accounts_enabled: z.boolean().optional(),
    customer_accounts_optional: z.boolean().optional(),
    enabled_payment_types: z.array(z.string().min(1)).optional(),
    features: z.record(z.string(), z.boolean()).optional(),
    policies: z
      .array(
        z.strictObject({
          id: z.string().min(1).optional(),
          title: z.string(),
          body: z.string(),
          url: z.string().regex(/^\/policies\//),
        }),
      )
      .optional(),
    timezone: z.string().refine((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, "Invalid IANA timezone"),
  }),
  placeholderSvgs: z
    .partialRecord(z.enum(placeholderNames), z.string().min(1).max(2_000_000))
    .optional(),
  // Payment icon SVGs keyed by `shop.enabled_payment_types` entries, prepared like placeholders.
  paymentTypeSvgs: z.record(z.string().min(1), z.string().min(1).max(2_000_000)).optional(),
  localization: localization.optional(),
  images: z
    .array(
      image.extend({
        filename: z
          .string()
          .min(1)
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Store filenames must reject NUL and line breaks in runtime and JSON Schema.
          .regex(/^(?!\.{1,2}$)[^/\\\u0000\r\n]+$/),
      }),
    )
    .optional(),
  products: z.array(product),
  collections: z.array(
    z.strictObject({
      sortOptions: z.array(z.strictObject({ value: z.string(), name: z.string() })).optional(),
      seo: seo.optional(),
      id: z.string().min(1).optional(),
      handle,
      title: z.string(),
      descriptionHtml: z.string(),
      image: image.nullable(),
      products: z.array(handle),
      sortOrder: z.string(),
      templateSuffix: z.string().nullable(),
    }),
  ),
  pages: z.array(page),
  blogs: z.array(
    z.strictObject({
      commentsEnabled: z.boolean().optional(),
      commentsModerated: z.boolean().optional(),
      seo: seo.optional(),
      id: z.string().min(1).optional(),
      handle,
      title: z.string(),
      articles: z.array(article),
      templateSuffix: z.string().nullable(),
      metafields,
    }),
  ),
  menus: z.array(z.strictObject({ handle, title: z.string(), links: z.array(menuLink) })),
  metaobjects: z.array(
    z.strictObject({ type: z.string(), handle, fields: z.record(z.string(), z.json()) }),
  ),
  cart: z.strictObject({
    lines: z.array(
      z.strictObject({
        productHandle: handle,
        variantId: z.string(),
        quantity: z.number().int().positive(),
        key: z.string().min(1).optional(),
        instructions: z
          .strictObject({ can_remove: z.boolean(), can_update_quantity: z.boolean() })
          .nullable()
          .optional(),
        parentRelationship: z.record(z.string(), z.json()).nullable().optional(),
        itemComponents: z.array(z.record(z.string(), z.json())).nullable().optional(),
      }),
    ),
    note: z.string().nullable(),
    taxesIncluded: z.boolean().nullable().optional(),
    dutiesIncluded: z.boolean().nullable().optional(),
  }),
  filters: z.array(
    z.union([
      z.strictObject({
        id: z.string(),
        label: z.string(),
        type: z.enum(["list", "boolean", "price_range"]),
        values: filterValues,
      }),
      // The merchant's AND/OR choice exists only where a filter has a configurable operator.
      z.strictObject({
        id: z.string().regex(configurableFilterId),
        label: z.string(),
        type: z.literal("list"),
        operator: z.enum(["AND", "OR"]),
        values: filterValues,
      }),
    ]),
  ),
  scenarios: z.record(z.string(), z.json()),
});
/** Complete inputs remain required by the oracle store seeders; preview accepts partial backups. */
export type CompleteSnapshot = z.infer<typeof completeSnapshotSchema>;
const partialImage = image.partial({ width: true, height: true });
const partialMedia = z.discriminatedUnion("mediaType", [
  productMedia.options[0],
  productMedia.options[1].extend({ previewImage: partialImage.optional() }),
  productMedia.options[2].extend({ previewImage: partialImage.optional() }),
  productMedia.options[3].extend({ previewImage: partialImage.optional() }),
]);
const partialMenuLink: z.ZodType<PartialMenuLink> = z.lazy(() =>
  z.strictObject({
    title: z.string(),
    url: z.string(),
    type: z.string(),
    resourceHandle: z.string().nullable().optional(),
    links: z.array(partialMenuLink),
  }),
);
export interface PartialMenuLink extends Omit<MenuLink, "resourceHandle" | "links"> {
  resourceHandle?: string | null | undefined;
  links: PartialMenuLink[];
}
export const snapshotSchema = completeSnapshotSchema.extend({
  shop: completeSnapshotSchema.shape.shop
    .partial({
      name: true,
      locale: true,
      money_format: true,
      money_with_currency_format: true,
    })
    .extend({ socialSharingImage: partialImage.nullable().optional() }),
  products: z.array(
    product.extend({
      variants: z
        .array(
          variant.partial({ available: true, image: true }).extend({
            sku: z.string().nullable(),
            barcode: z.string().nullable(),
          }),
        )
        .min(1),
      images: z.array(product.shape.images.element.partial({ width: true, height: true })),
      media: z.array(partialMedia).optional(),
      options: z.array(
        z
          .strictObject({
            ...product.shape.options.element.shape,
            swatches: z
              .array(
                z
                  .strictObject({ color: z.string().nullable(), image: partialImage.nullable() })
                  .nullable(),
              )
              .optional(),
          })
          .refine(
            (option) =>
              [option.valueIds, option.swatches].every(
                (list) => list === undefined || list.length === option.values.length,
              ),
            "Option value IDs and swatches must list one entry per value",
          ),
      ),
    }),
  ),
  collections: z.array(
    completeSnapshotSchema.shape.collections.element.partial({ products: true }).extend({
      image: partialImage.nullable().optional(),
    }),
  ),
  blogs: z.array(
    completeSnapshotSchema.shape.blogs.element.extend({
      articles: z.array(
        article
          .partial({ publishedAt: true })
          .extend({ image: partialImage.nullable().optional() }),
      ),
    }),
  ),
  menus: z.array(z.strictObject({ handle, title: z.string(), links: z.array(partialMenuLink) })),
  images: z
    .array(
      completeSnapshotSchema.shape.images.unwrap().element.partial({ width: true, height: true }),
    )
    .optional(),
  filters: completeSnapshotSchema.shape.filters.optional(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

/**
 * Shopify lets merchants combine selected values with AND only for tag and metafield list filters;
 * every other filter uses OR.
 */
export function filterOperatorConfigurable(filter: { id: string; type: string }): boolean {
  return filter.type === "list" && configurableFilterId.test(filter.id);
}

export interface SnapshotSource {
  readSnapshot(): Promise<string>;
  readImage(file: string): Promise<Uint8Array>;
}

/** Syntax validation only. Resource/variant reference checks are added with derivation in M1/M2. */
export function parseSnapshot(text: string): Snapshot {
  return snapshotSchema.parse(JSON.parse(text));
}

/** Complete source data is required for oracle store writes, never filled from defaults. */
export function parseCompleteSnapshot(text: string): CompleteSnapshot {
  return completeSnapshotSchema.parse(JSON.parse(text));
}
