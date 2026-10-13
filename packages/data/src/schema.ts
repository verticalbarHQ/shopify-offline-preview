import { z } from "zod";

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
  products: z.array(product),
  collections: z.array(
    z.strictObject({
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
      }),
    ),
    note: z.string(),
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
