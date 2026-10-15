import { createHash } from "node:crypto";
import { z } from "zod";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

const id = z.string().regex(/^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]*\/[1-9]\d*$/);
const pageInfo = z.object({ hasNextPage: z.boolean() });
const productRef = z.object({ id, handle: z.string() });
const products = z.object({ nodes: z.array(productRef).max(250), pageInfo });
const selection = z.object({ product: productRef, variantIds: z.array(id).nullable() });
const selections = z.object({ nodes: z.array(selection).max(250), pageInfo });
const rules = z.object({ conditions: z.array(z.object({ __typename: z.string() })), selections });
const source = z.object({
  __typename: z.literal("CollectionConditionsSource"),
  id,
  title: z.string(),
  shareable: z.boolean(),
  targetType: z.string(),
  app: z.object({ id }).nullable(),
  inclusion: rules,
  exclusion: rules
    .extend({
      selections: z.object({
        nodes: z.array(z.object({ product: productRef })).max(250),
        pageInfo,
      }),
    })
    .nullable(),
});
const options = z.array(z.object({ name: z.string(), value: z.string() }));
const nodeSchemas = {
  Product: productRef.extend({ __typename: z.literal("Product"), tags: z.array(z.string()) }),
  ProductVariant: z.object({
    __typename: z.literal("ProductVariant"),
    id,
    product: productRef.extend({ tags: z.array(z.string()) }),
    selectedOptions: options,
  }),
  Collection: productRef.extend({
    __typename: z.literal("Collection"),
    sortOrder: z.string(),
    products,
    sources: z.array(source),
  }),
  Page: productRef.extend({ __typename: z.literal("Page") }),
  Blog: productRef.extend({ __typename: z.literal("Blog") }),
  Article: productRef.extend({ __typename: z.literal("Article"), blog: productRef }),
  Menu: productRef.extend({ __typename: z.literal("Menu") }),
  MediaImage: z.object({
    __typename: z.literal("MediaImage"),
    id,
    alt: z.string().nullable().optional(),
    fileStatus: z.string(),
    image: z
      .object({
        url: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .nullable(),
    originalSource: z
      .object({ url: z.string().nullable(), fileSize: z.number().int().nonnegative().nullable() })
      .nullable(),
  }),
  Location: z.object({ __typename: z.literal("Location"), id, isActive: z.boolean() }),
  Publication: z.object({
    __typename: z.literal("Publication"),
    id,
    catalog: z
      .object({
        __typename: z.literal("AppCatalog"),
        id,
        apps: z.object({ nodes: z.array(z.object({ id })).max(50), pageInfo }),
      })
      .nullable(),
  }),
} as const;
export type SeedIdentityKind = keyof typeof nodeSchemas;
export type SeedIdentityNode = z.infer<(typeof nodeSchemas)[SeedIdentityKind]>;
export const seedIdentitySelections: Record<SeedIdentityKind, string> = {
  Product: "id handle tags",
  ProductVariant: "id product { id handle tags } selectedOptions { name value }",
  Collection: `id handle sortOrder products(first:250,sortKey:MANUAL) { nodes { id handle } pageInfo { hasNextPage } }
    sources { __typename id ... on CollectionConditionsSource { title shareable targetType app { id }
      inclusion { conditions { __typename } selections(first:250) { nodes { product { id handle } variantIds } pageInfo { hasNextPage } } }
      exclusion { conditions { __typename } selections(first:250) { nodes { product { id handle } } pageInfo { hasNextPage } } }
    } }`,
  Page: "id handle",
  Blog: "id handle",
  Article: "id handle blog { id handle }",
  Menu: "id handle",
  MediaImage: "id alt fileStatus image { url width height } originalSource { url fileSize }",
  Location: "id isActive",
  Publication:
    "id catalog { __typename id ... on AppCatalog { apps(first:50) { nodes { id } pageInfo { hasNextPage } } } }",
};
export class SeedIdentityError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "resource-unavailable"
      | "store-mismatch"
      | "binding-mismatch"
      | "incomplete-membership",
  ) {
    super(`Oracle seed identity verification failed: ${code}`);
    this.name = "SeedIdentityError";
  }
}

/** Exact read-only identity batches. Results stay private; a match does not create ownership evidence. */
export async function readOracleSeedIdentities(
  config: OracleConfig,
  token: string,
  expectedShopId: string,
  kind: SeedIdentityKind,
  ids: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<SeedIdentityNode[]> {
  try {
    oracleConfigSchema.parse(config);
    if (
      !token.trim() ||
      !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(expectedShopId) ||
      !Object.hasOwn(nodeSchemas, kind) ||
      !ids.length ||
      ids.length > 1000 ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (value) => !id.safeParse(value).success || !value.startsWith(`gid://shopify/${kind}/`),
      )
    )
      throw new Error("Invalid input");
  } catch {
    throw new SeedIdentityError("invalid-input");
  }
  const output: SeedIdentityNode[] = [];
  const batchSize = kind === "Collection" || kind === "Publication" ? 1 : 50;
  for (let start = 0; start < ids.length; start += batchSize) {
    const requested = ids.slice(start, start + batchSize);
    let document: {
      shop: { id: string; myshopifyDomain: string; plan: { partnerDevelopment: boolean } };
      nodes: unknown[];
    };
    try {
      const response = await fetcher(
        `https://${config.domain}/admin/api/${config.apiVersion}/graphql.json`,
        {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({
            query: `query OfflinePreviewSeedIdentities($ids:[ID!]!) { shop { id myshopifyDomain plan { partnerDevelopment } } nodes(ids:$ids) { __typename ... on ${kind} { ${seedIdentitySelections[kind]} } } }`,
            variables: { ids: requested },
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok || response.headers.get("x-shopify-api-version") !== config.apiVersion)
        throw new Error("Response unavailable");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Body bound");
      const parsed = z
        .object({
          data: z.object({
            shop: z.object({
              id,
              myshopifyDomain: z.string(),
              plan: z.object({ partnerDevelopment: z.boolean() }),
            }),
            nodes: z.array(z.unknown()),
          }),
          errors: z.array(z.unknown()).optional(),
        })
        .parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
      if (parsed.errors?.length) throw new Error("Query failed");
      document = parsed.data;
    } catch {
      throw new SeedIdentityError("resource-unavailable");
    }
    if (
      document.shop.id !== expectedShopId ||
      document.shop.myshopifyDomain !== config.domain ||
      !document.shop.plan.partnerDevelopment
    )
      throw new SeedIdentityError("store-mismatch");
    try {
      const nodes = document.nodes.map((node) => nodeSchemas[kind].parse(node));
      if (
        nodes.length !== requested.length ||
        new Set(nodes.map((n) => n.id)).size !== nodes.length ||
        nodes.some((n) => !requested.includes(n.id))
      )
        throw new Error("Incomplete batch");
      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (const value of requested) {
        const node = byId.get(value);
        if (!node) throw new Error("Missing node");
        output.push(node);
      }
    } catch {
      throw new SeedIdentityError("resource-unavailable");
    }
  }
  return output;
}

export type ExpectedSeedIdentity =
  | { kind: "Product"; id: string; handle: string; requiredTag: string }
  | {
      kind: "ProductVariant";
      id: string;
      productId: string;
      productHandle: string;
      requiredTag: string;
      selectedOptions: { name: string; value: string }[];
    }
  | {
      kind: "Collection";
      id: string;
      handle: string;
      sourceId: string;
      sourceAppId: string | null;
      members: { id: string; handle: string }[];
      ordered: boolean;
    }
  | { kind: "Page" | "Blog" | "Menu"; id: string; handle: string }
  | { kind: "Article"; id: string; handle: string; blogId: string; blogHandle: string }
  | { kind: "MediaImage"; id: string; url: string; width: number; height: number }
  | { kind: "Location"; id: string }
  | { kind: "Publication"; id: string; catalogId: string; appId: string };

/** Expectations must come from prior verified seeding/read-back, never from a coincidental handle match. */
export function assertOracleSeedIdentity(
  expected: ExpectedSeedIdentity,
  actual: SeedIdentityNode,
): void {
  if (actual.__typename !== expected.kind || actual.id !== expected.id)
    throw new SeedIdentityError("binding-mismatch");
  function mismatch(condition: boolean) {
    if (condition) throw new SeedIdentityError("binding-mismatch");
  }
  if (expected.kind === "Product" && actual.__typename === "Product")
    mismatch(actual.handle !== expected.handle || !actual.tags.includes(expected.requiredTag));
  else if (expected.kind === "ProductVariant" && actual.__typename === "ProductVariant") {
    const canonical = (rows: { name: string; value: string }[]) =>
      JSON.stringify([...rows].sort((a, b) => a.name.localeCompare(b.name)));
    mismatch(
      actual.product.id !== expected.productId ||
        actual.product.handle !== expected.productHandle ||
        !actual.product.tags.includes(expected.requiredTag) ||
        new Set(actual.selectedOptions.map((o) => o.name)).size !== actual.selectedOptions.length ||
        new Set(expected.selectedOptions.map((o) => o.name)).size !==
          expected.selectedOptions.length ||
        canonical(actual.selectedOptions) !== canonical(expected.selectedOptions),
    );
  } else if (expected.kind === "Collection" && actual.__typename === "Collection") {
    const owned = actual.sources.find((s) => s.id === expected.sourceId);
    if (
      actual.products.pageInfo.hasNextPage ||
      owned?.inclusion.selections.pageInfo.hasNextPage ||
      owned?.exclusion?.selections.pageInfo.hasNextPage
    )
      throw new SeedIdentityError("incomplete-membership");
    mismatch(
      actual.handle !== expected.handle ||
        actual.sources.length !== 1 ||
        !owned ||
        owned.title !== "SOP fixture membership" ||
        owned.shareable ||
        owned.targetType !== "PRODUCTS" ||
        (owned.app?.id ?? null) !== expected.sourceAppId ||
        owned.inclusion.conditions.length > 0 ||
        (owned.exclusion?.conditions.length ?? 0) > 0 ||
        (owned.exclusion?.selections.nodes.length ?? 0) > 0 ||
        owned.inclusion.selections.nodes.some((s) => s.variantIds?.length),
    );
    const members = (rows: { id: string; handle: string }[]) =>
      rows.map((r) => JSON.stringify([r.id, r.handle]));
    const desired = members(expected.members),
      present = members(actual.products.nodes);
    mismatch(
      new Set(desired).size !== desired.length ||
        new Set(present).size !== present.length ||
        JSON.stringify(expected.ordered ? present : [...present].sort()) !==
          JSON.stringify(expected.ordered ? desired : [...desired].sort()),
    );
    const picked = members(owned?.inclusion.selections.nodes.map((s) => s.product) ?? []);
    mismatch(
      new Set(picked).size !== picked.length ||
        JSON.stringify([...picked].sort()) !== JSON.stringify([...desired].sort()) ||
        (expected.ordered && actual.sortOrder !== "MANUAL"),
    );
  } else if (expected.kind === "Article" && actual.__typename === "Article")
    mismatch(
      actual.handle !== expected.handle ||
        actual.blog.id !== expected.blogId ||
        actual.blog.handle !== expected.blogHandle,
    );
  else if (expected.kind === "MediaImage" && actual.__typename === "MediaImage")
    mismatch(
      actual.fileStatus !== "READY" ||
        !actual.image ||
        actual.image.url !== expected.url ||
        actual.image.width !== expected.width ||
        actual.image.height !== expected.height,
    );
  else if (expected.kind === "Location" && actual.__typename === "Location")
    mismatch(!actual.isActive);
  else if (expected.kind === "Publication" && actual.__typename === "Publication") {
    if (actual.catalog?.apps.pageInfo.hasNextPage)
      throw new SeedIdentityError("incomplete-membership");
    mismatch(
      !actual.catalog ||
        actual.catalog.id !== expected.catalogId ||
        actual.catalog.apps.nodes.length !== 1 ||
        actual.catalog.apps.nodes[0]?.id !== expected.appId,
    );
  } else if (
    (expected.kind === "Page" || expected.kind === "Blog" || expected.kind === "Menu") &&
    (actual.__typename === "Page" || actual.__typename === "Blog" || actual.__typename === "Menu")
  )
    mismatch(actual.handle !== expected.handle);
  else throw new SeedIdentityError("binding-mismatch");
}

/** A processed image ID is accepted only with the expected original bytes, using credential-free GET. */
export async function verifyOracleSeedImageBytes(
  actual: Extract<SeedIdentityNode, { __typename: "MediaImage" }>,
  expected: { sha256: string; bytes: number },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (
    actual.fileStatus !== "READY" ||
    !actual.originalSource?.url ||
    actual.originalSource.fileSize !== expected.bytes ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1 ||
    expected.bytes > 32 * 1024 * 1024
  )
    throw new SeedIdentityError("binding-mismatch");
  let bytes: ArrayBuffer;
  try {
    const url = new URL(actual.originalSource.url);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !["cdn.shopify.com", "shopify-shop-assets.storage.googleapis.com"].includes(url.hostname)
    )
      throw new Error("Unsafe URL");
    const response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error("Asset unavailable");
    const size = response.headers.get("content-length");
    if (size !== null && Number(size) > 32 * 1024 * 1024) throw new Error("Asset bound");
    bytes = await response.arrayBuffer();
  } catch {
    throw new SeedIdentityError("resource-unavailable");
  }
  if (
    bytes.byteLength !== expected.bytes ||
    createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== expected.sha256
  )
    throw new SeedIdentityError("binding-mismatch");
}

/** Read the complete variant list for one actual parent before rebinding fixture variant identities. */
export async function readOracleSeedVariants(
  config: OracleConfig,
  token: string,
  expectedShopId: string,
  productId: string,
  fetcher: typeof fetch = fetch,
): Promise<Extract<SeedIdentityNode, { __typename: "ProductVariant" }>[]> {
  try {
    oracleConfigSchema.parse(config);
    if (
      !token.trim() ||
      !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(expectedShopId) ||
      !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(productId)
    )
      throw new Error("Input");
  } catch {
    throw new SeedIdentityError("invalid-input");
  }
  let data: {
    shop: { id: string; myshopifyDomain: string; plan: { partnerDevelopment: boolean } };
    product: {
      id: string;
      handle: string;
      tags: string[];
      variants: {
        nodes: {
          __typename: "ProductVariant";
          id: string;
          selectedOptions: { name: string; value: string }[];
        }[];
        pageInfo: { hasNextPage: boolean };
      };
    };
  };
  try {
    const response = await fetcher(
      `https://${config.domain}/admin/api/${config.apiVersion}/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({
          query: `query OfflinePreviewSeedVariants($id:ID!) { shop { id myshopifyDomain plan { partnerDevelopment } } product(id:$id) { id handle tags variants(first:250) { nodes { __typename id selectedOptions { name value } } pageInfo { hasNextPage } } } }`,
          variables: { id: productId },
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok || response.headers.get("x-shopify-api-version") !== config.apiVersion)
      throw new Error("Response");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Bound");
    const parsed = z
      .object({
        data: z.object({
          shop: z.object({
            id,
            myshopifyDomain: z.string(),
            plan: z.object({ partnerDevelopment: z.boolean() }),
          }),
          product: productRef.extend({
            tags: z.array(z.string()),
            variants: z.object({
              nodes: z
                .array(
                  z.object({
                    __typename: z.literal("ProductVariant"),
                    id,
                    selectedOptions: options,
                  }),
                )
                .max(250),
              pageInfo,
            }),
          }),
        }),
        errors: z.array(z.unknown()).optional(),
      })
      .parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
    if (parsed.errors?.length) throw new Error("Query");
    data = parsed.data;
  } catch {
    throw new SeedIdentityError("resource-unavailable");
  }
  if (
    data.shop.id !== expectedShopId ||
    data.shop.myshopifyDomain !== config.domain ||
    !data.shop.plan.partnerDevelopment ||
    data.product.id !== productId
  )
    throw new SeedIdentityError("store-mismatch");
  if (data.product.variants.pageInfo.hasNextPage)
    throw new SeedIdentityError("incomplete-membership");
  if (
    new Set(data.product.variants.nodes.map((v) => v.id)).size !==
    data.product.variants.nodes.length
  )
    throw new SeedIdentityError("binding-mismatch");
  const parent = { id: data.product.id, handle: data.product.handle, tags: data.product.tags };
  return data.product.variants.nodes.map((v) => ({ ...v, product: structuredClone(parent) }));
}

/** Full bounded enumeration, not a search filter that could silently miss a colliding handle. */
export async function assertOracleSeedHandleAbsent(
  config: OracleConfig,
  token: string,
  expectedShopId: string,
  kind: "Product" | "Collection" | "Page" | "Blog" | "Menu" | "Article",
  handle: string,
  fetcher: typeof fetch = fetch,
  blogId?: string,
): Promise<void> {
  const roots = {
    Product: "products",
    Collection: "collections",
    Page: "pages",
    Blog: "blogs",
    Menu: "menus",
    Article: "articles",
  };
  try {
    oracleConfigSchema.parse(config);
    if (
      !token.trim() ||
      !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(expectedShopId) ||
      !Object.hasOwn(roots, kind) ||
      !handle ||
      (kind === "Article" && !/^gid:\/\/shopify\/Blog\/[1-9]\d*$/.test(blogId ?? ""))
    )
      throw new Error("Input");
  } catch {
    throw new SeedIdentityError("invalid-input");
  }
  let after: string | null = null;
  const cursors = new Set<string>(),
    seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    let shop: { id: string; myshopifyDomain: string; plan: { partnerDevelopment: boolean } },
      connection: {
        nodes: { id: string; handle: string }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    try {
      const selection = `${roots[kind]}(first:100,after:$after) { nodes { id handle } pageInfo { hasNextPage endCursor } }`;
      const response = await fetcher(
        `https://${config.domain}/admin/api/${config.apiVersion}/graphql.json`,
        {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({
            query: `query OfflinePreviewSeedAbsence($after:String${kind === "Article" ? ",$blog:ID!" : ""}) { shop { id myshopifyDomain plan { partnerDevelopment } } ${kind === "Article" ? `blog(id:$blog) { id ${selection} }` : selection} }`,
            variables: { after, ...(kind === "Article" ? { blog: blogId } : {}) },
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok || response.headers.get("x-shopify-api-version") !== config.apiVersion)
        throw new Error("Response");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("Bound");
      const parsed = z
        .object({
          data: z.record(z.string(), z.unknown()),
          errors: z.array(z.unknown()).optional(),
        })
        .parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
      if (parsed.errors?.length) throw new Error("Query");
      shop = z
        .object({
          id,
          myshopifyDomain: z.string(),
          plan: z.object({ partnerDevelopment: z.boolean() }),
        })
        .parse(parsed.data.shop);
      const parent =
        kind === "Article" ? z.object({ id, articles: z.unknown() }).parse(parsed.data.blog) : null;
      if (parent && parent.id !== blogId) throw new Error("Parent mismatch");
      connection = z
        .object({
          nodes: z.array(productRef).max(100),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        })
        .parse(parent ? parent.articles : parsed.data[roots[kind]]);
    } catch {
      throw new SeedIdentityError("resource-unavailable");
    }
    if (
      shop.id !== expectedShopId ||
      shop.myshopifyDomain !== config.domain ||
      !shop.plan.partnerDevelopment
    )
      throw new SeedIdentityError("store-mismatch");
    for (const node of connection.nodes) {
      if (seen.has(node.id)) throw new SeedIdentityError("incomplete-membership");
      seen.add(node.id);
      if (node.handle === handle) throw new SeedIdentityError("binding-mismatch");
    }
    if (!connection.pageInfo.hasNextPage) return;
    after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new SeedIdentityError("incomplete-membership");
    cursors.add(after);
  }
  throw new SeedIdentityError("incomplete-membership");
}
