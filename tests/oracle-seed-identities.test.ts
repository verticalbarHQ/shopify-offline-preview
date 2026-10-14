import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  assertOracleSeedIdentity,
  type ExpectedSeedIdentity,
  readOracleSeedIdentities,
  SeedIdentityError,
  type SeedIdentityNode,
  verifyOracleSeedImageBytes,
} from "../tools/oracle/seed-identities.js";

const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1";
const pid = (n: number) => `gid://shopify/Product/${n}`;
function product(n = 1) {
  return { __typename: "Product" as const, id: pid(n), handle: `p-${n}`, tags: ["sop-fixture"] };
}
function reply(nodes: unknown[], store: Record<string, unknown> = {}) {
  return Response.json(
    {
      data: {
        shop: {
          id: shopId,
          myshopifyDomain: config.domain,
          plan: { partnerDevelopment: true },
          ...store,
        },
        nodes,
      },
    },
    { headers: { "x-shopify-api-version": "2026-10" } },
  );
}
const code = (name: string) => (error: unknown) =>
  error instanceof SeedIdentityError && error.code === name;
function collection(): Extract<SeedIdentityNode, { __typename: "Collection" }> {
  const member = { id: pid(1), handle: "p-1" },
    selection = { product: member, variantIds: [] };
  return {
    __typename: "Collection",
    id: "gid://shopify/Collection/1",
    handle: "catalog",
    sortOrder: "MANUAL",
    products: { nodes: [member], pageInfo: { hasNextPage: false } },
    sources: [
      {
        __typename: "CollectionConditionsSource",
        id: "gid://shopify/CollectionConditionsSource/1",
        title: "SOP fixture membership",
        targetType: "PRODUCTS",
        shareable: false,
        app: { id: "gid://shopify/App/1" },
        inclusion: {
          conditions: [],
          selections: { nodes: [selection], pageInfo: { hasNextPage: false } },
        },
        exclusion: null,
      },
    ],
  };
}
const expectedCollection: ExpectedSeedIdentity = {
  kind: "Collection",
  id: "gid://shopify/Collection/1",
  handle: "catalog",
  sourceId: "gid://shopify/CollectionConditionsSource/1",
  sourceAppId: "gid://shopify/App/1",
  members: [{ id: pid(1), handle: "p-1" }],
  ordered: true,
};

test("identity reads are exact read-only batches, preserve request order and verify shop every time", async () => {
  const ids = Array.from({ length: 51 }, (_, i) => pid(i + 1));
  let calls = 0;
  const nodes = await readOracleSeedIdentities(
    config,
    "authored-token",
    shopId,
    "Product",
    ids,
    async (url, init) => {
      calls++;
      assert.equal(String(url), `https://${config.domain}/admin/api/2026-10/graphql.json`);
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.ok(body.query.startsWith("query "));
      assert.ok(!body.query.includes("mutation"));
      const requested: string[] = body.variables.ids;
      assert.ok(requested.length <= 50);
      return reply(
        [...requested].reverse().map((value) => product(Number(value.split("/").at(-1)))),
      );
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    nodes.map((n) => n.id),
    ids,
  );
});
test("wrong domain/shop/production and incomplete or wrong-type nodes fail closed", async () => {
  for (const store of [
    { id: "gid://shopify/Shop/2" },
    { myshopifyDomain: "other.myshopify.com" },
    { plan: { partnerDevelopment: false } },
  ])
    await assert.rejects(
      readOracleSeedIdentities(config, "authored", shopId, "Product", [pid(1)], async () =>
        reply([product()], store),
      ),
      code("store-mismatch"),
    );
  for (const nodes of [
    [],
    [null],
    [product(2)],
    [product(), product()],
    [{ __typename: "Page", id: pid(1), handle: "p-1" }],
  ])
    await assert.rejects(
      readOracleSeedIdentities(config, "authored", shopId, "Product", [pid(1)], async () =>
        reply(nodes),
      ),
      code("resource-unavailable"),
    );
});
test("malformed responses and invalid IDs expose fixed errors without response or credential values", async () => {
  await assert.rejects(
    readOracleSeedIdentities(
      config,
      "authored",
      shopId,
      "Product",
      [pid(1)],
      async () => new Response("private customer response"),
    ),
    code("resource-unavailable"),
  );
  let calls = 0;
  await assert.rejects(
    readOracleSeedIdentities(
      config,
      "authored",
      shopId,
      "Product",
      ["gid://shopify/Customer/1"],
      async () => {
        calls++;
        return reply([]);
      },
    ),
    code("invalid-input"),
  );
  assert.equal(calls, 0);
});
test("product identity requires its explicit ID, handle and fixture tag", () => {
  const expected: ExpectedSeedIdentity = {
    kind: "Product",
    id: pid(1),
    handle: "p-1",
    requiredTag: "sop-fixture",
  };
  assert.doesNotThrow(() => assertOracleSeedIdentity(expected, product()));
  for (const node of [{ ...product(), handle: "another" }, { ...product(), tags: [] }, product(2)])
    assert.throws(() => assertOracleSeedIdentity(expected, node), code("binding-mismatch"));
});
test("variant parent and previously verified option tuple must match independent of option order", () => {
  const expected: ExpectedSeedIdentity = {
    kind: "ProductVariant",
    id: "gid://shopify/ProductVariant/1",
    productId: pid(1),
    productHandle: "p-1",
    requiredTag: "sop-fixture",
    selectedOptions: [
      { name: "Color", value: "Red" },
      { name: "Size", value: "Small" },
    ],
  };
  const node: Extract<SeedIdentityNode, { __typename: "ProductVariant" }> = {
    __typename: "ProductVariant",
    id: expected.id,
    product: product(),
    selectedOptions: [...expected.selectedOptions].reverse(),
  };
  assert.doesNotThrow(() => assertOracleSeedIdentity(expected, node));
  assert.throws(
    () => assertOracleSeedIdentity(expected, { ...node, product: product(2) }),
    code("binding-mismatch"),
  );
  assert.throws(
    () =>
      assertOracleSeedIdentity(expected, {
        ...node,
        selectedOptions: [{ name: "Color", value: "Blue" }],
      }),
    code("binding-mismatch"),
  );
});
test("collection membership and owned single conditions source are checked instead of trusting a title", () => {
  const node = collection();
  assert.doesNotThrow(() => assertOracleSeedIdentity(expectedCollection, node));
  const source = node.sources[0];
  assert.ok(source);
  source.app = { id: "gid://shopify/App/2" };
  assert.throws(() => assertOracleSeedIdentity(expectedCollection, node), code("binding-mismatch"));
  source.app = { id: "gid://shopify/App/1" };
  source.inclusion.conditions.push({ __typename: "CollectionSourceInclusionConditionProductTag" });
  assert.throws(() => assertOracleSeedIdentity(expectedCollection, node), code("binding-mismatch"));
});
test("collection truncation, exclusions and changed order cannot pass as equal membership", () => {
  const node = collection();
  node.products.pageInfo.hasNextPage = true;
  assert.throws(
    () => assertOracleSeedIdentity(expectedCollection, node),
    code("incomplete-membership"),
  );
  node.products.pageInfo.hasNextPage = false;
  const source = node.sources[0];
  assert.ok(source);
  source.exclusion = {
    conditions: [{ __typename: "ExcludedCondition" }],
    selections: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  assert.throws(() => assertOracleSeedIdentity(expectedCollection, node), code("binding-mismatch"));
  source.exclusion = null;
  node.products.nodes.push({ id: pid(2), handle: "p-2" });
  assert.throws(() => assertOracleSeedIdentity(expectedCollection, node), code("binding-mismatch"));
});
test("ordered membership is distinct from a set and variant-only selections cannot stand in for products", () => {
  const node = collection(),
    source = node.sources[0];
  assert.ok(source);
  const second = { id: pid(2), handle: "p-2" };
  node.products.nodes.push(second);
  source.inclusion.selections.nodes.push({ product: second, variantIds: [] });
  const expected: ExpectedSeedIdentity = {
    ...expectedCollection,
    members: [...node.products.nodes],
  };
  node.products.nodes.reverse();
  assert.throws(() => assertOracleSeedIdentity(expected, node), code("binding-mismatch"));
  assert.doesNotThrow(() => assertOracleSeedIdentity({ ...expected, ordered: false }, node));
  const first = source.inclusion.selections.nodes[0];
  assert.ok(first);
  first.variantIds = ["gid://shopify/ProductVariant/1"];
  assert.throws(
    () => assertOracleSeedIdentity({ ...expected, ordered: false }, node),
    code("binding-mismatch"),
  );
});
test("article parents, active locations and explicit publication catalog/app relations are required", () => {
  assert.throws(
    () =>
      assertOracleSeedIdentity(
        {
          kind: "Article",
          id: "gid://shopify/Article/1",
          handle: "story",
          blogId: "gid://shopify/Blog/1",
          blogHandle: "news",
        },
        {
          __typename: "Article",
          id: "gid://shopify/Article/1",
          handle: "story",
          blog: { id: "gid://shopify/Blog/2", handle: "news" },
        },
      ),
    code("binding-mismatch"),
  );
  assert.throws(
    () =>
      assertOracleSeedIdentity(
        { kind: "Location", id: "gid://shopify/Location/1" },
        { __typename: "Location", id: "gid://shopify/Location/1", isActive: false },
      ),
    code("binding-mismatch"),
  );
  const expected: ExpectedSeedIdentity = {
    kind: "Publication",
    id: "gid://shopify/Publication/1",
    catalogId: "gid://shopify/AppCatalog/1",
    appId: "gid://shopify/App/1",
  };
  const pub: Extract<SeedIdentityNode, { __typename: "Publication" }> = {
    __typename: "Publication",
    id: expected.id,
    catalog: {
      __typename: "AppCatalog",
      id: expected.catalogId,
      apps: { nodes: [{ id: expected.appId }], pageInfo: { hasNextPage: false } },
    },
  };
  assert.doesNotThrow(() => assertOracleSeedIdentity(expected, pub));
  pub.catalog?.apps.nodes.push({ id: "gid://shopify/App/2" });
  assert.throws(() => assertOracleSeedIdentity(expected, pub), code("binding-mismatch"));
});
test("processed image dimensions/URL and original byte hash are verified with credential-free downloads", async () => {
  const bytes = new Uint8Array([1, 2, 3]),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const node: Extract<SeedIdentityNode, { __typename: "MediaImage" }> = {
    __typename: "MediaImage",
    id: "gid://shopify/MediaImage/1",
    fileStatus: "READY",
    image: { url: "https://cdn.shopify.com/authored.png", width: 64, height: 64 },
    originalSource: {
      url: "https://shopify-shop-assets.storage.googleapis.com/authored.png",
      fileSize: 3,
    },
  };
  assert.doesNotThrow(() =>
    assertOracleSeedIdentity(
      {
        kind: "MediaImage",
        id: node.id,
        url: "https://cdn.shopify.com/authored.png",
        width: 64,
        height: 64,
      },
      node,
    ),
  );
  await verifyOracleSeedImageBytes(node, { sha256, bytes: 3 }, async (_url, init) => {
    assert.equal(init?.method, "GET");
    assert.equal(init?.headers, undefined);
    assert.equal(init?.redirect, "error");
    return new Response(bytes);
  });
  await assert.rejects(
    verifyOracleSeedImageBytes(
      node,
      { sha256, bytes: 3 },
      async () => new Response(new Uint8Array([3, 2, 1])),
    ),
    code("binding-mismatch"),
  );
  const bad = {
    ...node,
    originalSource: { url: "https://private.example/credential", fileSize: 3 },
  };
  let calls = 0;
  await assert.rejects(
    verifyOracleSeedImageBytes(bad, { sha256, bytes: 3 }, async () => {
      calls++;
      return new Response(bytes);
    }),
    code("resource-unavailable"),
  );
  assert.equal(calls, 0);
});
