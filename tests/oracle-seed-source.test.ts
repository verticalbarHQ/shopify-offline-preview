import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import {
  createOracleSeedExecutor,
  type SeedExecutionContext,
} from "../tools/oracle/seed-execution.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";
import { compileSeedTask, seedBindingKey } from "../tools/oracle/seed-requests.js";
import {
  assertOracleSeedSource,
  createOracleSeedSourceVerifier,
  readOracleSeedSource,
  SeedSourceError,
  type SeedSourceNode,
} from "../tools/oracle/seed-source.js";

// Independently authored server responses. No theme, credential or store capture is used.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1",
  locationId = "gid://shopify/Location/1",
  snapshot = defaultFixture(),
  plan = buildOracleSeedPlan(config, snapshot),
  state = plan.states[0];
assert.ok(state);
const productTask = state.tasks.find((t) => t.resource === "product");
assert.ok(productTask);
const source = snapshotSchema.shape.products.element.parse(productTask.source),
  productId = "gid://shopify/Product/1",
  bindings = new Map<string, string>([
    [seedBindingKey("inventory-location"), locationId],
    [seedBindingKey("blog-id", "journal"), "gid://shopify/Blog/1"],
  ]);
for (const task of state.tasks) {
  if (task.resource === "image") {
    const file = task.identity[0];
    assert.ok(file);
    bindings.set(seedBindingKey("image-id", file), `gid://shopify/MediaImage/${bindings.size + 1}`);
    bindings.set(
      seedBindingKey("image-url", file),
      `https://cdn.shopify.com/authored/${bindings.size}.png`,
    );
  }
  if (["product", "collection", "page", "blog"].includes(task.resource)) {
    const handle = task.identity[0];
    assert.ok(handle);
    bindings.set(
      seedBindingKey(`${task.resource}-id`, handle),
      `gid://shopify/${task.resource[0]?.toUpperCase()}${task.resource.slice(1)}/${bindings.size + 1}`,
    );
  }
}
const get = (key: string) => {
    const value = bindings.get(key);
    if (!value) throw new Error("Missing authored binding");
    return value;
  },
  code = (name: string) => (error: unknown) =>
    error instanceof SeedSourceError && error.code === name,
  shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } };
function reply(node: unknown, store = shop, version = "2026-10") {
  return Response.json(
    { data: { shop: store, nodes: [node] } },
    { headers: { "x-shopify-api-version": version } },
  );
}
function image(wanted: (typeof source.images)[number] | null) {
  return wanted
    ? {
        url: get(seedBindingKey("image-url", wanted.file)),
        altText: wanted.alt,
        width: wanted.width,
        height: wanted.height,
      }
    : null;
}
function product(): Extract<SeedSourceNode, { __typename: "Product" }> {
  return {
    __typename: "Product",
    id: productId,
    handle: source.handle,
    title: source.title,
    templateSuffix: source.templateSuffix,
    descriptionHtml: source.descriptionHtml,
    vendor: source.vendor,
    productType: source.productType,
    tags: [...source.tags].reverse(),
    status: "ACTIVE",
    seo: { title: source.seo?.title ?? null, description: source.seo?.description ?? null },
    category: null,
    isGiftCard: false,
    requiresSellingPlan: false,
    options: source.options.map((o, index) => ({
      name: o.name,
      position: index + 1,
      optionValues: o.values.map((name) => ({ name })),
    })),
    media: {
      nodes: source.images.map((wanted) => ({
        __typename: "MediaImage",
        id: get(seedBindingKey("image-id", wanted.file)),
        alt: wanted.alt,
        fileStatus: "READY",
        image: image(wanted),
      })),
      pageInfo: { hasNextPage: false },
    },
    variants: {
      nodes: source.variants.map((v, index) => ({
        id: `gid://shopify/ProductVariant/${index + 1}`,
        position: index + 1,
        selectedOptions: [...v.optionValues].reverse(),
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        sku: v.sku,
        taxable: v.taxable ?? true,
        inventoryPolicy: v.inventoryPolicy === "continue" ? "CONTINUE" : "DENY",
        inventoryQuantity: v.inventoryQuantity ?? 0,
        barcodes: {
          nodes: v.barcode ? [{ value: v.barcode, type: null }] : [],
          pageInfo: { hasNextPage: false },
        },
        media: {
          nodes: v.image
            ? [{ __typename: "MediaImage", id: get(seedBindingKey("image-id", v.image)) }]
            : [],
          pageInfo: { hasNextPage: false },
        },
        inventoryItem: {
          id: `gid://shopify/InventoryItem/${index + 1}`,
          sku: v.sku,
          tracked: true,
          requiresShipping: v.requiresShipping ?? true,
          measurement: { weight: { value: v.weight ?? 0, unit: "GRAMS" } },
          inventoryLevel: {
            isActive: true,
            location: { id: locationId },
            quantities: [{ name: "available", quantity: v.inventoryQuantity ?? 0 }],
          },
        },
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

test("product source compares all written values using precise decimal money and ordered options/variants", () => {
  const actual = product();
  actual.variants.nodes.reverse();
  const first = actual.variants.nodes.find((v) => v.position === 1);
  assert.ok(first);
  // Decimal trailing zeros preserve the amount only after a decimal separator.
  first.price = source.variants[0]?.price.includes(".")
    ? `${source.variants[0].price}00`
    : `${source.variants[0]?.price}.00`;
  assertOracleSeedSource(productTask, actual, get);
  const task = structuredClone(productTask),
    wanted = snapshotSchema.shape.products.element.parse(task.source);
  const variant = wanted.variants[0];
  assert.ok(variant);
  variant.price = "9007199254740993.1234567890123456789";
  task.source = wanted;
  first.price = "9007199254740993.123456789012345678900";
  assertOracleSeedSource(task, actual, get);
  first.price = "9007199254740993.1234567890123456788";
  assert.throws(() => assertOracleSeedSource(task, actual, get), code("source-mismatch"));
});
test("changes in price, stock, barcode, shipping, images, option order or content cannot create source equality", () => {
  const mutations: ((node: ReturnType<typeof product>) => void)[] = [
    (n) => {
      n.title = "changed";
    },
    (n) => {
      n.descriptionHtml += "changed";
    },
    (n) => {
      n.status = "DRAFT";
    },
    (n) => {
      n.tags.push("foreign");
    },
    (n) => {
      n.options.reverse();
      const first = n.options[0];
      if (first) first.position = 1;
    },
    (n) => {
      const v = n.variants.nodes[0];
      assert.ok(v);
      v.price = "99999.99";
    },
    (n) => {
      const v = n.variants.nodes[0];
      assert.ok(v);
      v.inventoryQuantity = (v.inventoryQuantity ?? 0) + 1;
    },
    (n) => {
      const v = n.variants.nodes[0];
      assert.ok(v);
      v.inventoryItem.tracked = false;
    },
    (n) => {
      const v = n.variants.nodes[0];
      assert.ok(v?.inventoryItem.inventoryLevel);
      v.inventoryItem.inventoryLevel.location.id = "gid://shopify/Location/2";
    },
    (n) => {
      const v = n.variants.nodes[0];
      assert.ok(v);
      v.barcodes.nodes.push({ value: "foreign", type: null });
    },
    (n) => {
      n.media.nodes.reverse();
    },
    (n) => {
      const v = n.variants.nodes[0];
      assert.ok(v);
      v.sku = "changed";
    },
    (n) => {
      const v = n.variants.nodes[0];
      assert.ok(v);
      v.inventoryItem.requiresShipping = false;
    },
    (n) => {
      const v = n.variants.nodes[0];
      assert.ok(v);
      v.taxable = false;
    },
    (n) => {
      const v = n.variants.nodes[0];
      assert.ok(v);
      v.inventoryItem.measurement.weight = { value: 1, unit: "GRAMS" };
    },
  ];
  for (const mutate of mutations) {
    const actual = product();
    mutate(actual);
    assert.throws(() => assertOracleSeedSource(productTask, actual, get), code("source-mismatch"));
  }
});
test("missing bindings and unsupported source contracts cannot be treated as verified values", async () => {
  assert.throws(
    () =>
      assertOracleSeedSource(productTask, product(), () => {
        throw new Error("private source detail");
      }),
    code("binding-missing"),
  );
  const task = structuredClone(productTask),
    wanted = snapshotSchema.shape.products.element.parse(task.source);
  wanted.metafields = { private: { unsupported: "sensitive authored value" } };
  task.source = wanted;
  assert.throws(
    () => assertOracleSeedSource(task, product(), get),
    (error) => code("invalid-input")(error) && !String(error).includes("sensitive"),
  );
  const actual = product(),
    variant = actual.variants.nodes[0];
  assert.ok(variant);
  variant.inventoryItem.id = "gid://shopify/Product/1";
  await assert.rejects(
    readOracleSeedSource(
      config,
      "authored-token",
      shopId,
      "Product",
      productId,
      locationId,
      async () => reply(actual),
    ),
    code("read-failed"),
  );
  let calls = 0;
  await assert.rejects(
    readOracleSeedSource(
      config,
      "authored-token",
      shopId,
      "Product",
      productId,
      undefined,
      async () => {
        calls++;
        return reply(product());
      },
    ),
    code("invalid-input"),
  );
  assert.equal(calls, 0);
});
test("variant paging has a fixed page limit even with unique cursors", async () => {
  let calls = 0;
  await assert.rejects(
    readOracleSeedSource(
      config,
      "authored-token",
      shopId,
      "Product",
      productId,
      locationId,
      async () => {
        calls++;
        const actual = product(),
          variant = actual.variants.nodes[0];
        assert.ok(variant);
        variant.id = `gid://shopify/ProductVariant/${calls}`;
        actual.variants.nodes = [variant];
        actual.variants.pageInfo = { hasNextPage: true, endCursor: String(calls) };
        return reply(actual);
      },
    ),
    code("incomplete-source"),
  );
  assert.equal(calls, 5);
});
test("product pagination reads exact pinned IDs, traverses cursors and retains full source", async () => {
  const full = product();
  let calls = 0;
  const actual = await readOracleSeedSource(
    config,
    "authored-token",
    shopId,
    "Product",
    productId,
    locationId,
    async (url, init) => {
      calls++;
      assert.equal(String(url), `https://${config.domain}/admin/api/2026-10/graphql.json`);
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.ok(body.query.startsWith("query "));
      assert.ok(!body.query.includes("mutation"));
      assert.deepEqual(body.variables.ids, [productId]);
      assert.equal(body.variables.location, locationId);
      const node = structuredClone(full);
      node.variants.nodes =
        calls === 1 ? full.variants.nodes.slice(0, 3) : full.variants.nodes.slice(3);
      node.variants.pageInfo = { hasNextPage: calls === 1, endCursor: calls === 1 ? "next" : null };
      assert.equal(body.variables.after, calls === 1 ? null : "next");
      return reply(node);
    },
  );
  assert.equal(calls, 2);
  assertOracleSeedSource(productTask, actual, get);
});
test("truncated media/barcodes, cursor stalls, duplicate variants and changing product metadata are refused", async () => {
  for (const failure of ["media", "barcodes", "cursor", "duplicates", "changed"]) {
    let calls = 0;
    await assert.rejects(
      readOracleSeedSource(
        config,
        "authored-token",
        shopId,
        "Product",
        productId,
        locationId,
        async () => {
          calls++;
          const node = product();
          if (failure === "media") node.media.pageInfo.hasNextPage = true;
          if (failure === "barcodes") {
            const v = node.variants.nodes[0];
            assert.ok(v);
            v.barcodes.pageInfo.hasNextPage = true;
          }
          if (["cursor", "duplicates", "changed"].includes(failure)) {
            node.variants.nodes =
              failure === "duplicates"
                ? node.variants.nodes.slice(0, 1)
                : node.variants.nodes.slice(calls - 1, calls);
            node.variants.pageInfo = {
              hasNextPage: true,
              endCursor: failure === "cursor" ? "stuck" : String(calls),
            };
            if (failure === "changed" && calls > 1) node.title = "changed";
          }
          return reply(node);
        },
      ),
      code(failure === "changed" ? "source-changed" : "incomplete-source"),
    );
    assert.ok(calls <= 2);
  }
});
test("wrong store, version, ID, missing node and API errors are terminal and secret-free", async () => {
  for (const failure of ["store", "version", "id", "missing", "errors"]) {
    let calls = 0;
    await assert.rejects(
      readOracleSeedSource(
        config,
        "authored-token",
        shopId,
        "Product",
        productId,
        locationId,
        async () => {
          calls++;
          const node = product();
          if (failure === "id") node.id = "gid://shopify/Product/2";
          if (failure === "errors")
            return Response.json(
              { errors: [{ message: "private store content" }] },
              { headers: { "x-shopify-api-version": "2026-10" } },
            );
          return reply(
            failure === "missing" ? null : node,
            failure === "store" ? { ...shop, id: "gid://shopify/Shop/2" } : shop,
            failure === "version" ? "2026-07" : "2026-10",
          );
        },
      ),
      (error) =>
        code(failure === "store" ? "store-mismatch" : "read-failed")(error) &&
        !String(error).includes("private"),
    );
    assert.equal(calls, 1);
  }
});
test("page/blog/article/collection/menu source comparisons retain exact content, parents and nested links", async () => {
  for (const task of state.tasks) {
    let actual: SeedSourceNode;
    if (task.resource === "page") {
      const p = snapshotSchema.shape.pages.element.parse(task.source);
      actual = {
        __typename: "Page",
        id: "gid://shopify/Page/1",
        handle: p.handle,
        title: p.title,
        templateSuffix: p.templateSuffix,
        body: p.bodyHtml,
        isPublished: true,
        seo: { title: p.seo?.title ?? null, description: p.seo?.description ?? null },
      };
    } else if (task.resource === "blog") {
      const p = snapshotSchema.shape.blogs.element.omit({ articles: true }).parse(task.source);
      actual = {
        __typename: "Blog",
        id: "gid://shopify/Blog/1",
        handle: p.handle,
        title: p.title,
        templateSuffix: p.templateSuffix,
        commentPolicy: p.commentsEnabled ? "MODERATED" : "CLOSED",
        seo: { title: p.seo?.title ?? null, description: p.seo?.description ?? null },
      };
    } else if (task.resource === "article") {
      const p = snapshotSchema.shape.blogs.element.shape.articles.element.parse(task.source);
      actual = {
        __typename: "Article",
        id: "gid://shopify/Article/1",
        handle: p.handle,
        title: p.title,
        templateSuffix: p.templateSuffix,
        body: p.bodyHtml,
        summary: p.excerptHtml,
        author: { name: p.author },
        publishedAt: new Date(p.publishedAt).toISOString(),
        isPublished: true,
        tags: [...p.tags].reverse(),
        blog: { id: get(seedBindingKey("blog-id", task.identity[0] ?? "")) },
        image: image(p.image),
        seo: { title: p.seo?.title ?? null, description: p.seo?.description ?? null },
      };
    } else if (task.resource === "collection") {
      const p = snapshotSchema.shape.collections.element.parse(task.source);
      actual = {
        __typename: "Collection",
        id: "gid://shopify/Collection/1",
        handle: p.handle,
        title: p.title,
        templateSuffix: p.templateSuffix,
        descriptionHtml: p.descriptionHtml,
        sortOrder: "MANUAL",
        image: image(p.image),
        seo: { title: p.seo?.title ?? null, description: p.seo?.description ?? null },
      };
    } else if (task.resource === "menu") {
      const p = snapshotSchema.shape.menus.element.parse(task.source),
        types: Record<string, string> = {
          product_link: "PRODUCT",
          collection_link: "COLLECTION",
          page_link: "PAGE",
          blog_link: "BLOG",
          http_link: "HTTP",
        };
      type Item = {
        title: string;
        type: string;
        url: string | null;
        resourceId: string | null;
        items: Item[];
      };
      const items = (links: typeof p.links): Item[] =>
        links.map((l) => ({
          title: l.title,
          type: types[l.type] ?? "UNKNOWN",
          url:
            l.type === "http_link"
              ? l.url
              : "https://authored-demo.myshopify.com/generated-resource-path",
          resourceId:
            l.type === "http_link"
              ? null
              : get(seedBindingKey(`${l.type.replace(/_link$/, "")}-id`, l.resourceHandle ?? "")),
          items: items(l.links),
        }));
      actual = {
        __typename: "Menu",
        id: "gid://shopify/Menu/1",
        handle: p.handle,
        title: p.title,
        items: items(p.links),
      };
    } else continue;
    const parsed = await readOracleSeedSource(
      config,
      "authored-token",
      shopId,
      actual.__typename,
      actual.id,
      undefined,
      async () => {
        if (["Page", "Blog", "Article"].includes(actual.__typename) && "seo" in actual) {
          const { seo, ...record } = actual;
          return reply({
            ...record,
            seoTitle:
              seo?.title == null ? null : { value: seo.title, type: "single_line_text_field" },
            seoDescription:
              seo?.description == null
                ? null
                : { value: seo.description, type: "single_line_text_field" },
          });
        }
        return reply(actual);
      },
    );
    assertOracleSeedSource(task, parsed, get);
    const changed = structuredClone(parsed);
    changed.title = "changed";
    assert.throws(() => assertOracleSeedSource(task, changed, get), code("source-mismatch"));
    if (parsed.__typename === "Article") {
      parsed.blog.id = "gid://shopify/Blog/99";
      assert.throws(() => assertOracleSeedSource(task, parsed, get), code("source-mismatch"));
    }
    if (parsed.__typename === "Menu" && parsed.items.length) {
      const link = parsed.items[0];
      assert.ok(link);
      link.resourceId = "gid://shopify/Collection/99";
      assert.throws(() => assertOracleSeedSource(task, parsed, get), code("source-mismatch"));
    }
  }
});
test("mandatory executor postcondition verifies source before issuing an execution receipt", async () => {
  const contracts: unknown = JSON.parse(
      await readFile(
        new URL("./fixtures/oracle-seed-input-contracts.json", import.meta.url),
        "utf8",
      ),
    ),
    page = state.tasks.find((t) => t.resource === "page");
  assert.ok(page);
  const wanted = snapshotSchema.shape.pages.element.parse(page.source);
  let changed = true,
    writes = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      query = String(body.query);
    if (query.includes("OfflinePreviewSeedGuard"))
      return Response.json(
        {
          data: {
            shop: {
              ...shop,
              name: "Authored shop",
              currencyCode: "USD",
              ianaTimezone: "UTC",
              metafield: { value: "true" },
            },
            currentAppInstallation: { accessScopes: [{ handle: "write_content" }] },
          },
        },
        { headers: { "x-shopify-api-version": "2026-10" } },
      );
    if (query.startsWith("mutation")) {
      writes++;
      return Response.json(
        { data: { pageCreate: { page: { id: "gid://shopify/Page/1" }, userErrors: [] } } },
        { headers: { "x-shopify-api-version": "2026-10" } },
      );
    }
    return reply({
      __typename: "Page",
      id: "gid://shopify/Page/1",
      handle: wanted.handle,
      title: wanted.title,
      templateSuffix: wanted.templateSuffix,
      body: changed ? "changed" : wanted.bodyHtml,
      isPublished: true,
      seoTitle:
        wanted.seo?.title == null
          ? null
          : { value: wanted.seo.title, type: "single_line_text_field" },
      seoDescription:
        wanted.seo?.description == null
          ? null
          : { value: wanted.seo.description, type: "single_line_text_field" },
    });
  };
  const verifyResult = createOracleSeedSourceVerifier(
      config,
      snapshot,
      shopId,
      "authored-token",
      get,
      fetcher,
    ),
    executor = createOracleSeedExecutor(config, snapshot, shopId, "authored-token", contracts, {
      authorize: async () => {},
      verifyBindings: async () => {},
      verifyResult,
      fetcher,
    }),
    step = {
      stateHash: state.hash,
      taskKey: page.key,
      kind: "task" as const,
      options: { mode: "create" as const },
      bindings: {},
    };
  await assert.rejects(executor.executeVerified(step), (error) =>
    String(error).includes("postcondition-failed"),
  );
  assert.equal(writes, 1);
  // A separately authorized mocked execution is used here; the transport itself never replays the failed write.
  changed = false;
  await executor.executeVerified(step);
  assert.equal(writes, 2);
  const template = compileSeedTask(page, { mode: "create" })[0];
  assert.ok(template);
  const context: SeedExecutionContext = {
    domain: config.domain,
    apiVersion: "2026-10",
    kind: "task",
    options: { mode: "create" },
    fixtureHash: plan.fixtureHash,
    stateHash: state.hash,
    expectedShopId: shopId,
    task: page,
    template,
  };
  await assert.rejects(
    verifyResult({ ...context, fixtureHash: "wrong" }, { page: { id: "gid://shopify/Page/1" } }),
    code("invalid-input"),
  );
});
