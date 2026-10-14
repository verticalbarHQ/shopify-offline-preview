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
const imagePathPattern =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL must be rejected in local file paths and their published JSON Schema.
  /^(?!\/)(?!.*[\\\u0000])(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$).+$/;
const image = z.strictObject({
  file: z.string().min(1).regex(imagePathPattern),
  alt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
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
  options: z.array(z.strictObject({ name: z.string(), values: z.array(z.string()) })),
  variants: z.array(variant).min(1),
  images: z.array(image),
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

export const snapshotSchema = z.strictObject({
  meta: z.strictObject({ now: z.iso.datetime({ offset: true }), schemaVersion: z.literal("1.0") }),
  shop: z.strictObject({
    seo: seo.optional(),
    name: z.string(),
    domain: z.string(),
    locale: z.string(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    money_format: z.string(),
    money_with_currency_format: z.string(),
    description: z.string().optional(),
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
  images: z
    .array(
      image.extend({
        filename: z
          .string()
          .min(1)
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Store filenames must reject NUL and line breaks in runtime and JSON Schema.
          .regex(/^(?!\.{1,2}$)[^/\\\u0000\r\n]+$/),
        id: z.string().min(1).optional(),
        focalPoint: z
          .strictObject({
            x: z
              .string()
              .max(30)
              .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/),
            y: z
              .string()
              .max(30)
              .regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/),
          })
          .optional(),
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
          .optional(),
        parentRelationship: z.record(z.string(), z.json()).nullable().optional(),
        itemComponents: z.array(z.record(z.string(), z.json())).optional(),
      }),
    ),
    note: z.string(),
    taxesIncluded: z.boolean().optional(),
    dutiesIncluded: z.boolean().optional(),
  }),
  filters: z.array(
    z.strictObject({
      id: z.string(),
      label: z.string(),
      type: z.enum(["list", "boolean", "price_range"]),
      values: z.array(z.strictObject({ label: z.string(), value: z.string() })),
    }),
  ),
  scenarios: z.record(z.string(), z.json()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export interface SnapshotSource {
  readSnapshot(): Promise<string>;
  readImage(file: string): Promise<Uint8Array>;
}

/** Syntax validation only. Resource/variant reference checks are added with derivation in M1/M2. */
export function parseSnapshot(text: string): Snapshot {
  return snapshotSchema.parse(JSON.parse(text));
}
