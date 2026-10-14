import { z } from "zod";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import type { SeedExecutionContext } from "./seed-execution.js";
import { buildOracleSeedPlan, type SeedTask } from "./seed-plan.js";
import { compileSeedTask, seedBindingKey } from "./seed-requests.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class SeedSourceError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "read-failed"
      | "store-mismatch"
      | "source-changed"
      | "incomplete-source"
      | "source-mismatch"
      | "binding-missing"
      | "unsupported-step",
  ) {
    super(`Oracle seed source verification failed: ${code}`);
    this.name = "SeedSourceError";
  }
}
const gid = z.string().regex(/^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]*\/[1-9]\d*$/),
  money = z.string().regex(/^\d+(?:\.\d+)?$/),
  seo = z.object({ title: z.string().nullable(), description: z.string().nullable() }).nullable(),
  image = z
    .object({
      url: z.string(),
      altText: z.string().nullable(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .nullable(),
  pageInfo = z.object({ hasNextPage: z.boolean() }),
  mediaRef = z.object({
    __typename: z.literal("MediaImage"),
    id: z.string().regex(/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/),
  }),
  variant = z.object({
    id: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/),
    position: z.number().int().positive(),
    selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
    price: money,
    compareAtPrice: money.nullable(),
    sku: z.string().nullable(),
    taxable: z.boolean(),
    inventoryPolicy: z.enum(["DENY", "CONTINUE"]),
    inventoryQuantity: z.number().int().nullable(),
    barcodes: z.object({
      nodes: z.array(z.object({ value: z.string(), type: z.string().nullable() })).max(20),
      pageInfo,
    }),
    media: z.object({ nodes: z.array(mediaRef).max(2), pageInfo }),
    inventoryItem: z.object({
      id: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/),
      sku: z.string().nullable(),
      tracked: z.boolean(),
      requiresShipping: z.boolean(),
      measurement: z.object({
        weight: z.object({ value: z.number().finite().nonnegative(), unit: z.string() }).nullable(),
      }),
      inventoryLevel: z
        .object({
          isActive: z.boolean(),
          location: z.object({ id: z.string().regex(/^gid:\/\/shopify\/Location\/[1-9]\d*$/) }),
          quantities: z.array(z.object({ name: z.string(), quantity: z.number().int() })),
        })
        .nullable(),
    }),
  }),
  common = {
    id: gid,
    handle: z.string(),
    title: z.string(),
    templateSuffix: z.string().nullable(),
  },
  product = z.object({
    ...common,
    __typename: z.literal("Product"),
    descriptionHtml: z.string(),
    vendor: z.string(),
    productType: z.string(),
    tags: z.array(z.string()),
    status: z.string(),
    seo,
    category: z
      .object({
        id: z.string().regex(/^gid:\/\/shopify\/TaxonomyCategory\/[A-Za-z0-9-]+$/),
        name: z.string(),
      })
      .nullable(),
    isGiftCard: z.boolean(),
    requiresSellingPlan: z.boolean(),
    options: z
      .array(
        z.object({
          name: z.string(),
          position: z.number().int().positive(),
          optionValues: z.array(z.object({ name: z.string() })),
        }),
      )
      .max(3),
    media: z.object({
      nodes: z
        .array(mediaRef.extend({ alt: z.string().nullable(), fileStatus: z.string(), image }))
        .max(50),
      pageInfo,
    }),
    variants: z.object({
      nodes: z.array(variant).max(250),
      pageInfo: pageInfo.extend({ endCursor: z.string().nullable() }),
    }),
  });
interface MenuItem {
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  items: MenuItem[];
}
const menuItems: z.ZodType<MenuItem> = z.lazy(() =>
  z.object({
    title: z.string(),
    type: z.string(),
    url: z.string().nullable(),
    resourceId: gid.nullable(),
    items: z.array(menuItems).max(250),
  }),
);
const schemas = {
  Product: product,
  Collection: z.object({
    ...common,
    __typename: z.literal("Collection"),
    descriptionHtml: z.string(),
    sortOrder: z.string(),
    seo,
    image,
  }),
  Page: z.object({
    ...common,
    __typename: z.literal("Page"),
    body: z.string(),
    isPublished: z.boolean(),
    seo,
  }),
  Blog: z.object({ ...common, __typename: z.literal("Blog"), commentPolicy: z.string(), seo }),
  Article: z.object({
    ...common,
    __typename: z.literal("Article"),
    body: z.string(),
    summary: z.string().nullable(),
    author: z.object({ name: z.string() }).nullable(),
    publishedAt: z.string().nullable(),
    isPublished: z.boolean(),
    tags: z.array(z.string()),
    blog: z.object({ id: z.string().regex(/^gid:\/\/shopify\/Blog\/[1-9]\d*$/) }),
    image,
    seo,
  }),
  Menu: z.object({
    __typename: z.literal("Menu"),
    id: gid,
    handle: z.string(),
    title: z.string(),
    items: z.array(menuItems).max(250),
  }),
} as const;
export type SeedSourceKind = keyof typeof schemas;
export type SeedSourceNode = z.infer<(typeof schemas)[SeedSourceKind]>;
const commonSelection = "id handle title templateSuffix";
export const seedSourceSelections: Record<SeedSourceKind, string> = {
  Product: `${commonSelection} descriptionHtml vendor productType tags status seo { title description } category { id name } isGiftCard requiresSellingPlan
    options(first:3) { name position optionValues(byPosition:true) { name } }
    media(first:50) { nodes { __typename id ... on MediaImage { alt fileStatus image { url altText width height } } } pageInfo { hasNextPage } }
    variants(first:50,after:$after) { nodes { id position selectedOptions { name value } price compareAtPrice sku taxable inventoryPolicy inventoryQuantity
      barcodes(first:20) { nodes { value type } pageInfo { hasNextPage } }
      media(first:2) { nodes { __typename id } pageInfo { hasNextPage } }
      inventoryItem { id sku tracked requiresShipping measurement { weight { value unit } }
        inventoryLevel(locationId:$location) { isActive location { id } quantities(names:["available"]) { name quantity } } }
    } pageInfo { hasNextPage endCursor } }`,
  Collection: `${commonSelection} descriptionHtml sortOrder seo { title description } image { url altText width height }`,
  Page: `${commonSelection} body isPublished seo { title description }`,
  Blog: `${commonSelection} commentPolicy seo { title description }`,
  Article: `${commonSelection} body summary author { name } publishedAt isPublished tags blog { id } image { url altText width height } seo { title description }`,
  Menu: "id handle title items { title type url resourceId items { title type url resourceId items { title type url resourceId items { title } } } }",
};

/** Bounded, exact-ID readback; no export, data conversion, writes or ownership registration. */
export async function readOracleSeedSource(
  config: OracleConfig,
  token: string,
  shopId: string,
  kind: SeedSourceKind,
  id: string,
  locationId?: string,
  fetcher: typeof fetch = fetch,
): Promise<SeedSourceNode> {
  let pinned: OracleConfig;
  try {
    pinned = oracleConfigSchema.parse(config);
    if (
      !token.trim() ||
      !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId) ||
      !Object.hasOwn(schemas, kind) ||
      !gid.safeParse(id).success ||
      !id.startsWith(`gid://shopify/${kind}/`) ||
      (kind === "Product" && !/^gid:\/\/shopify\/Location\/[1-9]\d*$/.test(locationId ?? ""))
    )
      throw new Error();
  } catch {
    throw new SeedSourceError("invalid-input");
  }
  let after: string | null = null,
    header: string | undefined,
    first: z.infer<typeof product> | undefined;
  const rows: z.infer<typeof variant>[] = [],
    cursors = new Set<string>();
  for (let page = 0; page < 5; page++) {
    let node: SeedSourceNode;
    try {
      const response = await fetcher(
        `https://${pinned.domain}/admin/api/${pinned.apiVersion}/graphql.json`,
        {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({
            query: `query OfflinePreviewSeedSource($ids:[ID!]!${kind === "Product" ? ",$after:String,$location:ID!" : ""}) { shop { id myshopifyDomain plan { partnerDevelopment } } nodes(ids:$ids) { __typename ... on ${kind} { ${seedSourceSelections[kind]} } } }`,
            variables: {
              ids: [id],
              ...(kind === "Product" ? { after, location: locationId } : {}),
            },
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok || response.headers.get("x-shopify-api-version") !== pinned.apiVersion)
        throw new Error();
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error();
      const parsed = z
        .object({
          data: z.object({
            shop: z.object({
              id: z.string(),
              myshopifyDomain: z.string(),
              plan: z.object({ partnerDevelopment: z.boolean() }),
            }),
            nodes: z.array(z.unknown()).length(1),
          }),
          errors: z.array(z.unknown()).optional(),
        })
        .parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
      if (parsed.errors?.length) throw new Error();
      if (
        parsed.data.shop.id !== shopId ||
        parsed.data.shop.myshopifyDomain !== pinned.domain ||
        !parsed.data.shop.plan.partnerDevelopment
      )
        throw new SeedSourceError("store-mismatch");
      node = schemas[kind].parse(parsed.data.nodes[0]);
      if (node.id !== id) throw new Error();
    } catch (error) {
      if (error instanceof SeedSourceError) throw error;
      throw new SeedSourceError("read-failed");
    }
    if (node.__typename !== "Product") return node;
    const { variants, ...metadata } = node,
      fingerprint = JSON.stringify(metadata);
    if (header !== undefined && header !== fingerprint) throw new SeedSourceError("source-changed");
    header = fingerprint;
    first ??= node;
    rows.push(...variants.nodes);
    if (
      variants.nodes.length > 50 ||
      node.media.pageInfo.hasNextPage ||
      rows.length > 250 ||
      new Set(rows.map((v) => v.id)).size !== rows.length ||
      rows.some((v) => v.barcodes.pageInfo.hasNextPage || v.media.pageInfo.hasNextPage)
    )
      throw new SeedSourceError("incomplete-source");
    if (!variants.pageInfo.hasNextPage)
      return { ...first, variants: { nodes: rows, pageInfo: variants.pageInfo } };
    const cursor = variants.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) throw new SeedSourceError("incomplete-source");
    cursors.add(cursor);
    after = cursor;
  }
  throw new SeedSourceError("incomplete-source");
}

function mismatch(value: boolean) {
  if (value) throw new SeedSourceError("source-mismatch");
}
function same(a: unknown, b: unknown) {
  mismatch(JSON.stringify(a) !== JSON.stringify(b));
}
function decimal(value: string) {
  const [whole = "0", fraction = ""] = value.split(".");
  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "")}`;
}
function assertSeo(
  wanted:
    | { title?: string | null | undefined; description?: string | null | undefined }
    | undefined,
  actual: z.infer<typeof seo>,
) {
  if (!wanted) return;
  for (const field of ["title", "description"] as const)
    if (wanted[field] !== undefined) same(actual?.[field], wanted[field]);
}

/** Checks writable source fields. Generated IDs/timestamps and storefront-only metadata still require calibration. */
function compareOracleSeedSource(
  task: SeedTask,
  actual: SeedSourceNode,
  getBinding: (key: string) => string,
): void {
  compileSeedTask(task, { mode: "create" }); // Reject unsupported source shapes rather than quietly omitting them.
  const get = (kind: string, ...identity: string[]) => {
    try {
      const value = getBinding(seedBindingKey(kind, ...identity));
      if (!value) throw new Error();
      return value;
    } catch {
      throw new SeedSourceError("binding-missing");
    }
  };
  function matchImage(
    wanted: z.infer<typeof snapshotSchema.shape.products.element.shape.images.element> | null,
    observed: z.infer<typeof image>,
  ) {
    if (!wanted) {
      same(observed, null);
      return;
    }
    mismatch(!observed);
    if (!observed) return;
    same(observed.url, get("image-url", wanted.file));
    same(observed.altText, wanted.alt);
    same(observed.width, wanted.width);
    same(observed.height, wanted.height);
  }
  if (task.resource === "product" && actual.__typename === "Product") {
    const wanted = snapshotSchema.shape.products.element.parse(task.source);
    for (const field of [
      "handle",
      "title",
      "descriptionHtml",
      "vendor",
      "productType",
      "templateSuffix",
    ] as const)
      same(actual[field], wanted[field]);
    same(actual.status, "ACTIVE");
    same([...actual.tags].sort(), [...wanted.tags].sort());
    assertSeo(wanted.seo, actual.seo);
    if (wanted.category !== undefined)
      same(actual.category?.id ?? null, wanted.category?.id ?? null);
    if (wanted.giftCard !== undefined) same(actual.isGiftCard, wanted.giftCard);
    if (wanted.requiresSellingPlan !== undefined)
      same(actual.requiresSellingPlan, wanted.requiresSellingPlan);
    const options = [...actual.options].sort((a, b) => a.position - b.position);
    same(
      options.map((o) => ({ name: o.name, values: o.optionValues.map((v) => v.name) })),
      wanted.options,
    );
    same(
      options.map((o) => o.position),
      wanted.options.map((_o, i) => i + 1),
    );
    mismatch(actual.media.pageInfo.hasNextPage);
    same(actual.media.nodes.length, wanted.images.length);
    for (const [index, want] of wanted.images.entries()) {
      const image = actual.media.nodes[index];
      mismatch(
        !image ||
          image.id !== get("image-id", want.file) ||
          image.fileStatus !== "READY" ||
          image.alt !== want.alt,
      );
      if (image) matchImage(want, image.image);
    }
    const variants = [...actual.variants.nodes].sort((a, b) => a.position - b.position);
    mismatch(actual.variants.pageInfo.hasNextPage);
    same(variants.length, wanted.variants.length);
    for (const [index, want] of wanted.variants.entries()) {
      const observed = variants[index];
      mismatch(!observed);
      if (!observed) continue;
      same(observed.position, index + 1);
      const tuple = (values: { name: string; value: string }[]) =>
        JSON.stringify([...values].sort((a, b) => a.name.localeCompare(b.name)));
      same(tuple(observed.selectedOptions), tuple(want.optionValues));
      same(decimal(observed.price), decimal(want.price));
      same(
        observed.compareAtPrice === null ? null : decimal(observed.compareAtPrice),
        want.compareAtPrice === null ? null : decimal(want.compareAtPrice),
      );
      same(observed.sku, want.sku);
      same(observed.inventoryItem.sku, want.sku);
      mismatch(observed.barcodes.pageInfo.hasNextPage);
      same(observed.barcodes.nodes, want.barcode ? [{ value: want.barcode, type: null }] : []);
      mismatch(observed.media.pageInfo.hasNextPage);
      same(
        observed.media.nodes.map((n) => n.id),
        want.image ? [get("image-id", want.image)] : [],
      );
      same(observed.inventoryPolicy, want.inventoryPolicy === "deny" ? "DENY" : "CONTINUE");
      same(observed.inventoryItem.tracked, true);
      same(observed.inventoryQuantity, want.inventoryQuantity);
      const level = observed.inventoryItem.inventoryLevel;
      mismatch(!level?.isActive);
      if (level) {
        same(level.location.id, get("inventory-location"));
        same(level.quantities, [{ name: "available", quantity: want.inventoryQuantity }]);
      }
      if (want.requiresShipping !== undefined)
        same(observed.inventoryItem.requiresShipping, want.requiresShipping);
      if (want.taxable !== undefined) same(observed.taxable, want.taxable);
      if (want.weight !== undefined)
        same(observed.inventoryItem.measurement.weight, { value: want.weight, unit: "GRAMS" });
    }
    return;
  }
  if (task.resource === "page" && actual.__typename === "Page") {
    const wanted = snapshotSchema.shape.pages.element.parse(task.source);
    for (const field of ["handle", "title", "templateSuffix"] as const)
      same(actual[field], wanted[field]);
    same(actual.body, wanted.bodyHtml);
    same(actual.isPublished, true);
    assertSeo(wanted.seo, actual.seo);
    return;
  }
  if (task.resource === "blog" && actual.__typename === "Blog") {
    const wanted = snapshotSchema.shape.blogs.element.omit({ articles: true }).parse(task.source);
    for (const field of ["handle", "title", "templateSuffix"] as const)
      same(actual[field], wanted[field]);
    if (wanted.commentsEnabled !== undefined)
      same(actual.commentPolicy, wanted.commentsEnabled ? "MODERATED" : "CLOSED");
    assertSeo(wanted.seo, actual.seo);
    return;
  }
  if (task.resource === "article" && actual.__typename === "Article") {
    const wanted = snapshotSchema.shape.blogs.element.shape.articles.element.parse(task.source);
    for (const field of ["handle", "title", "templateSuffix"] as const)
      same(actual[field], wanted[field]);
    same(actual.blog.id, get("blog-id", task.identity[0] ?? ""));
    same(actual.body, wanted.bodyHtml);
    same(actual.summary, wanted.excerptHtml);
    same(actual.author?.name, wanted.author);
    same(actual.isPublished, true);
    mismatch(
      !actual.publishedAt ||
        !Number.isFinite(Date.parse(actual.publishedAt)) ||
        Date.parse(actual.publishedAt) !== Date.parse(wanted.publishedAt),
    );
    same([...actual.tags].sort(), [...wanted.tags].sort());
    matchImage(wanted.image, actual.image);
    assertSeo(wanted.seo, actual.seo);
    return;
  }
  if (task.resource === "collection" && actual.__typename === "Collection") {
    const wanted = snapshotSchema.shape.collections.element.parse(task.source),
      template = compileSeedTask(task, { mode: "create" })[0];
    for (const field of ["handle", "title", "descriptionHtml", "templateSuffix"] as const)
      same(actual[field], wanted[field]);
    const input = template?.variables.collection;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new SeedSourceError("invalid-input");
    same(actual.sortOrder, input.sortOrder);
    matchImage(wanted.image, actual.image);
    assertSeo(wanted.seo, actual.seo);
    return;
  }
  if (task.resource === "menu" && actual.__typename === "Menu") {
    const wanted = snapshotSchema.shape.menus.element.parse(task.source);
    same(actual.handle, wanted.handle);
    same(actual.title, wanted.title);
    const types: Record<string, string> = {
      product_link: "PRODUCT",
      collection_link: "COLLECTION",
      page_link: "PAGE",
      blog_link: "BLOG",
      http_link: "HTTP",
    };
    function items(links: typeof wanted.links, nodes: MenuItem[], depth: number) {
      same(links.length, nodes.length);
      mismatch(depth > 3 && links.length > 0);
      for (const [index, link] of links.entries()) {
        const node = nodes[index];
        mismatch(!node);
        if (!node) continue;
        same(node.title, link.title);
        same(node.type, types[link.type]);
        if (link.type === "http_link") {
          same(node.url, link.url);
          same(node.resourceId, null);
        } else
          same(
            node.resourceId,
            get(`${link.type.replace(/_link$/, "")}-id`, link.resourceHandle ?? ""),
          );
        items(link.links, node.items, depth + 1);
      }
    }
    items(wanted.links, actual.items, 1);
    return;
  }
  throw new SeedSourceError("unsupported-step");
}
export function assertOracleSeedSource(
  task: SeedTask,
  actual: SeedSourceNode,
  getBinding: (key: string) => string,
): void {
  try {
    compareOracleSeedSource(task, actual, getBinding);
  } catch (error) {
    if (error instanceof SeedSourceError) throw error;
    throw new SeedSourceError("invalid-input");
  }
}

/** Intended for the executor's mandatory verifyResult callback; other postconditions must be composed separately. */
export function createOracleSeedSourceVerifier(
  config: OracleConfig,
  snapshot: Snapshot,
  shopId: string,
  token: string,
  getBinding: (key: string) => string,
  fetcher: typeof fetch = fetch,
) {
  const pinned = oracleConfigSchema.parse(config),
    plan = buildOracleSeedPlan(pinned, snapshot);
  if (plan.issues.length) throw new SeedSourceError("invalid-input");
  return async (context: SeedExecutionContext, payload: Record<string, unknown>) => {
    const task = plan.states
      .find((s) => s.hash === context.stateHash)
      ?.tasks.find((t) => t.key === context.task.key);
    if (
      !task ||
      task.sourceHash !== context.task.sourceHash ||
      context.fixtureHash !== plan.fixtureHash ||
      context.domain !== pinned.domain ||
      context.apiVersion !== pinned.apiVersion ||
      context.expectedShopId !== shopId
    )
      throw new SeedSourceError("invalid-input");
    const kinds: Partial<Record<SeedTask["resource"], SeedSourceKind>> = {
        product: "Product",
        collection: "Collection",
        page: "Page",
        blog: "Blog",
        article: "Article",
        menu: "Menu",
      },
      kind = kinds[task.resource];
    const operations: Record<SeedSourceKind, readonly string[]> = {
      Product: ["productSet"],
      Collection: ["collectionCreate", "collectionUpdate"],
      Page: ["pageCreate", "pageUpdate"],
      Blog: ["blogCreate", "blogUpdate"],
      Article: ["articleCreate", "articleUpdate"],
      Menu: ["menuCreate", "menuUpdate"],
    };
    if (context.kind !== "task" || !kind || !operations[kind].includes(context.template.operation))
      throw new SeedSourceError("unsupported-step");
    const result = z.object({ id: gid }).safeParse(payload[task.resource]);
    if (!result.success) throw new SeedSourceError("read-failed");
    let location: string | undefined;
    if (kind === "Product")
      try {
        location = getBinding(seedBindingKey("inventory-location"));
      } catch {
        throw new SeedSourceError("binding-missing");
      }
    const actual = await readOracleSeedSource(
      pinned,
      token,
      shopId,
      kind,
      result.data.id,
      location,
      fetcher,
    );
    assertOracleSeedSource(task, actual, getBinding);
  };
}
