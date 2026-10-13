import { validateSnapshotReferences } from "./scenarios.js";
import { type Snapshot, snapshotSchema } from "./schema.js";

export const fixtureNow = "2026-10-13T00:00:00Z";
export const fixtureProductHandle = "sop-matrix-needle";
export const imageFiles = Array.from(
  { length: 16 },
  (_, i) => `pattern-${String(i + 1).padStart(2, "0")}.png`,
);
function image(index: number) {
  return {
    file: imageFiles[index] ?? "pattern-01.png",
    alt: `Synthetic pattern ${index + 1}`,
    width: 64,
    height: 64,
  };
}
function variantMetadata() {
  return {
    requiresShipping: true,
    taxable: true,
    weight: 0,
    requiresSellingPlan: false,
    sellingPlanAllocations: [],
    quantityRule: { min: 1, max: null, increment: 1 },
    quantityPriceBreaks: [],
    unitPrice: null,
    unitPriceMeasurement: null,
    inventoryManagement: "shopify",
    inventoryPolicy: "deny" as const,
    inventoryQuantity: 10,
    storeAvailabilities: [],
  };
}

/** Original synthetic content only; no benchmark code or customer content. */
export function defaultFixture(): Snapshot {
  const products: Snapshot["products"] = Array.from({ length: 40 }, (_, i) => ({
    createdAt: fixtureNow,
    publishedAt: fixtureNow,
    category: null,
    seo: {
      title: null,
      description: `Original synthetic product ${i + 1} for offline theme verification.`,
    },
    id: String(100001 + i),
    handle: i === 0 ? fixtureProductHandle : `sop-product-${String(i + 1).padStart(2, "0")}`,
    title: i === 0 ? "SOP Matrix Needle" : `SOP Product ${String(i + 1).padStart(2, "0")}`,
    descriptionHtml: `<p>Original synthetic product ${i + 1} for offline theme verification.</p>`,
    vendor: "Example Studio",
    productType: "Test Goods",
    tags: ["sop-fixture", i % 2 ? "blue" : "red"],
    templateSuffix: null,
    options: [{ name: "Title", values: ["Default Title"] }],
    variants: [
      {
        ...variantMetadata(),
        id: `sop-variant-${i + 1}`,
        optionValues: [{ name: "Title", value: "Default Title" }],
        price: `${10 + i}.00`,
        compareAtPrice: null,
        available: true,
        sku: `SOP-${i + 1}`,
        barcode: "",
        image: imageFiles[i % 16] ?? null,
      },
    ],
    images: [image(i % 16)],
    metafields: {},
    giftCard: false,
    requiresSellingPlan: false,
    sellingPlanGroups: [],
    quantityPriceBreaksConfigured: false,
  }));
  const main = products[0];
  if (!main) throw new Error("Fixture product is missing");
  main.options = [
    { name: "Color", values: ["Red", "Blue"] },
    { name: "Size", values: ["Small", "Large"] },
    { name: "Material", values: ["Cotton", "Linen"] },
  ];
  main.variants =
    main.options[0]?.values.flatMap(
      (color, c) =>
        main.options[1]?.values.flatMap(
          (size, s) =>
            main.options[2]?.values.map((material, m) => {
              const index = c * 4 + s * 2 + m;
              return {
                ...variantMetadata(),
                inventoryQuantity: index === 7 ? 0 : 10,
                id: `sop-main-${index + 1}`,
                optionValues: [
                  { name: "Color", value: color },
                  { name: "Size", value: size },
                  { name: "Material", value: material },
                ],
                price: index % 2 ? "18.00" : "12.50",
                compareAtPrice: index % 2 ? null : "20.00",
                available: index !== 7,
                sku: `SOP-MAIN-${index + 1}`,
                barcode: "",
                image: imageFiles[c] ?? null,
              };
            }) ?? [],
        ) ?? [],
    ) ?? [];
  main.images = [image(0), image(1)];
  const snapshot: Snapshot = {
    meta: { now: fixtureNow, schemaVersion: "1.0" },
    shop: {
      seo: { title: null, description: "A synthetic catalog for local theme development." },
      name: "Offline Example Shop",
      domain: "example.test",
      locale: "en",
      currency: "USD",
      money_format: "USD {{amount}}",
      money_with_currency_format: "USD {{amount}}",
      timezone: "UTC",
      description: "A synthetic catalog for local theme development.",
      customer_accounts_enabled: false,
      customer_accounts_optional: true,
      enabled_payment_types: [],
      features: { "follow_on_shop?": false },
      policies: [],
    },
    products,
    collections: [
      {
        seo: { title: null, description: "Original synthetic collection." },
        id: "200001",
        handle: "sop-catalog",
        title: "Example Catalog",
        descriptionHtml: "<p>Original synthetic collection.</p>",
        image: image(0),
        products: products.map((p) => p.handle),
        sortOrder: "manual",
        templateSuffix: null,
      },
    ],
    pages: [
      {
        seo: { title: null, description: "Original offline examples from Example Studio." },
        id: "300001",
        handle: "about",
        title: "About Example Studio",
        bodyHtml:
          "<h2>Offline examples</h2><p>Rich text with <strong>bold</strong> and <em>emphasis</em>.</p>",
        templateSuffix: null,
        metafields: {},
      },
    ],
    blogs: [
      {
        commentsEnabled: false,
        seo: { title: null, description: "Original example journal." },
        id: "400001",
        handle: "news",
        title: "Example Journal",
        templateSuffix: null,
        metafields: {},
        articles: Array.from({ length: 3 }, (_, i) => ({
          commentsCount: 0,
          seo: { title: null, description: `Original example article ${i + 1}.` },
          id: String(500001 + i),
          handle: `story-${i + 1}`,
          title: `Example Story ${i + 1}`,
          bodyHtml: `<p>Original example article ${i + 1}.</p>`,
          excerptHtml: `<p>Story ${i + 1} excerpt.</p>`,
          author: "Example Author",
          createdAt: fixtureNow,
          updatedAt: fixtureNow,
          publishedAt: fixtureNow,
          image: i === 1 ? null : image(i),
          tags: ["example"],
          templateSuffix: null,
          metafields: {},
        })),
      },
    ],
    menus: [
      {
        handle: "main-menu",
        title: "Main menu",
        links: [
          { title: "Home", url: "/", type: "http_link", resourceHandle: null, links: [] },
          {
            title: "Catalog",
            url: "/collections/sop-catalog",
            type: "collection_link",
            resourceHandle: "sop-catalog",
            links: [],
          },
          {
            title: "About",
            url: "/pages/about",
            type: "page_link",
            resourceHandle: "about",
            links: [],
          },
        ],
      },
      { handle: "footer", title: "Footer", links: [] },
    ],
    metaobjects: [],
    cart: { lines: [], note: "", taxesIncluded: false, dutiesIncluded: false },
    filters: [],
    scenarios: {},
  };
  const overlayProduct = (product: Snapshot["products"][number]) => ({
    products: [product, ...products.slice(1)],
  });
  const soldOut = structuredClone(main);
  soldOut.variants.forEach((v) => {
    v.available = false;
    v.inventoryQuantity = 0;
  });
  const firstVariant = main.variants[0];
  if (!firstVariant) throw new Error("Fixture variants are missing");
  const single = structuredClone(main);
  single.options = [{ name: "Title", values: ["Default Title"] }];
  single.variants = [
    { ...firstVariant, optionValues: [{ name: "Title", value: "Default Title" }] },
  ];
  const noImages = structuredClone(main);
  noImages.images = [];
  noImages.variants.forEach((v) => {
    v.image = null;
  });
  const long = structuredClone(main);
  long.title = "SOP Matrix Needle — ".repeat(12).trim();
  long.descriptionHtml = `<p>${"Original long-content example. ".repeat(80)}</p>`;
  long.images = imageFiles.map((_, i) => image(i));
  snapshot.scenarios = snapshotSchema.shape.scenarios.parse({
    "sold-out": overlayProduct(soldOut),
    "single-variant": overlayProduct(single),
    "no-images": overlayProduct(noImages),
    "long-content": overlayProduct(long),
    empty: {
      collections: snapshot.collections.map((collection) => ({ ...collection, products: [] })),
    },
    "with-items": {
      cart: {
        lines: [
          {
            productHandle: main.handle,
            variantId: main.variants[0]?.id ?? "",
            quantity: 2,
            key: "sop-main-1:00000000000000000000000000000001",
            instructions: { can_remove: true, can_update_quantity: true },
            parentRelationship: null,
            itemComponents: [],
          },
          {
            productHandle: products[1]?.handle ?? "",
            variantId: products[1]?.variants[0]?.id ?? "",
            quantity: 1,
            key: "sop-variant-2:00000000000000000000000000000002",
            instructions: { can_remove: true, can_update_quantity: true },
            parentRelationship: null,
            itemComponents: [],
          },
        ],
        note: "Example cart note",
      },
    },
    "with-image": {
      blogs: snapshot.blogs.map((blog) => ({
        ...blog,
        articles: blog.articles.map((article, i) =>
          i === 0 ? { ...article, image: image(0) } : article,
        ),
      })),
    },
    "without-image": {
      blogs: snapshot.blogs.map((blog) => ({
        ...blog,
        articles: blog.articles.map((article, i) =>
          i === 0 ? { ...article, image: null } : article,
        ),
      })),
    },
  });
  const valid = snapshotSchema.parse(snapshot);
  validateSnapshotReferences(valid);
  return valid;
}

export interface MatrixCase {
  id: string;
  page: string;
  scenario: string;
  path: string;
}
const cases: readonly Omit<MatrixCase, "id">[] = [
  { page: "home", scenario: "default", path: "/" },
  ...["default", "sold-out", "single-variant", "no-images", "long-content"].map((scenario) => ({
    page: "product",
    scenario,
    path: `/products/${fixtureProductHandle}`,
  })),
  { page: "collection", scenario: "default", path: "/collections/sop-catalog" },
  { page: "collection", scenario: "default", path: "/collections/sop-catalog?page=2" },
  { page: "collection", scenario: "empty", path: "/collections/sop-catalog" },
  { page: "page", scenario: "default", path: "/pages/about" },
  { page: "search", scenario: "default", path: "/search?q=Matrix%20Needle" },
  { page: "search", scenario: "default", path: "/search?q=zzzxnevermatch983147" },
  { page: "cart", scenario: "default", path: "/cart" },
  { page: "cart", scenario: "with-items", path: "/cart" },
  { page: "404", scenario: "default", path: "/sop-missing-page" },
  { page: "blog", scenario: "default", path: "/blogs/news" },
  { page: "article", scenario: "with-image", path: "/blogs/news/story-1" },
  { page: "article", scenario: "without-image", path: "/blogs/news/story-1" },
];
export const benchmarkMatrix: readonly MatrixCase[] = cases.map((item, index) => ({
  id: `${String(index + 1).padStart(2, "0")}-${item.page}-${item.scenario}`,
  ...item,
}));
