import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import {
  createOracleSeedBindingLedger,
  inspectVerifiedSeedOwnership,
  SeedLedgerError,
} from "../tools/oracle/seed-binding-ledger.js";
import { createOracleSeedExecutor } from "../tools/oracle/seed-execution.js";
import {
  applyOracleSeedGenerated,
  createOracleSeedGeneratedRecorder,
  inspectVerifiedSeedGenerated,
  readOracleSeedGeneratedMetadata,
  SeedGeneratedError,
} from "../tools/oracle/seed-generated.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";

// Authored GraphQL responses only. Test authorization callbacks are not real owner approval.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1",
  locationId = "gid://shopify/Location/1",
  productLegacy = "9007199254740993",
  productId = `gid://shopify/Product/${productLegacy}`,
  createdAt = "2026-10-15T01:23:45Z",
  shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } },
  contracts: unknown = JSON.parse(
    await readFile(new URL("./fixtures/oracle-seed-input-contracts.json", import.meta.url), "utf8"),
  ),
  code = (name: string) => (error: unknown) =>
    error instanceof SeedGeneratedError && error.code === name,
  reply = (data: unknown, version = "2026-10") =>
    Response.json({ data }, { headers: { "x-shopify-api-version": version } });
function setup() {
  const snapshot = defaultFixture();
  for (const p of snapshot.products) {
    p.images = [];
    for (const v of p.variants) v.image = null;
  }
  const source = snapshot.products[0];
  assert.ok(source);
  const plan = buildOracleSeedPlan(config, snapshot),
    state = plan.states[0];
  assert.ok(state);
  const task = state.tasks.find((t) => t.resource === "product");
  assert.ok(task);
  const variants = source.variants.map((v, index) => ({
      id: `gid://shopify/ProductVariant/${BigInt(productLegacy) + BigInt(index + 1)}`,
      legacyResourceId: String(BigInt(productLegacy) + BigInt(index + 1)),
      selectedOptions: v.optionValues,
    })),
    parent = { id: productId, handle: source.handle, tags: source.tags };
  let reads = 0,
    writes = 0,
    change = false,
    foreign = false,
    badContent = false;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      query = String(body.query);
    if (query.includes("OfflinePreviewSeedGuard"))
      return reply({
        shop: {
          ...shop,
          name: "Authored shop",
          currencyCode: "USD",
          ianaTimezone: "UTC",
          metafield: { value: "true" },
        },
        currentAppInstallation: {
          accessScopes: ["write_products", "write_inventory", "read_locations"].map((handle) => ({
            handle,
          })),
        },
      });
    if (query.includes("OfflinePreviewSeedAbsence"))
      return reply({
        shop,
        products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      });
    if (query.includes("OfflinePreviewSeedIdentities"))
      return reply({
        shop,
        nodes: body.variables.ids.map((id: string) =>
          id === locationId
            ? { __typename: "Location", id, isActive: true }
            : id === productId
              ? { __typename: "Product", ...parent }
              : {
                  __typename: "ProductVariant",
                  ...variants.find((v) => v.id === id),
                  product: parent,
                },
        ),
      });
    if (query.includes("OfflinePreviewSeedVariants"))
      return reply({
        shop,
        product: {
          ...parent,
          variants: {
            nodes: variants.map((v) => ({ __typename: "ProductVariant", ...v })),
            pageInfo: { hasNextPage: false },
          },
        },
      });
    if (query.includes("OfflinePreviewSeedGenerated")) {
      reads++;
      return reply({
        shop,
        nodes: [
          {
            __typename: "Product",
            ...parent,
            legacyResourceId: productLegacy,
            createdAt: change && reads % 2 === 0 ? "2026-10-15T01:23:46Z" : createdAt,
            publishedAt: null,
            variants: {
              nodes: variants.map((v, i) =>
                foreign && i === 0
                  ? { ...v, id: "gid://shopify/ProductVariant/99", legacyResourceId: "99" }
                  : v,
              ),
              pageInfo: { hasNextPage: false },
            },
          },
        ],
      });
    }
    if (query.includes("OfflinePreviewSeedSource"))
      return reply({
        shop,
        nodes: [
          {
            __typename: "Product",
            ...parent,
            title: badContent ? "changed" : source.title,
            templateSuffix: source.templateSuffix,
            descriptionHtml: source.descriptionHtml,
            vendor: source.vendor,
            productType: source.productType,
            status: "ACTIVE",
            seo: source.seo,
            category: null,
            isGiftCard: false,
            requiresSellingPlan: false,
            options: source.options.map((o, index) => ({
              name: o.name,
              position: index + 1,
              optionValues: o.values.map((name) => ({ name })),
            })),
            media: { nodes: [], pageInfo: { hasNextPage: false } },
            variants: {
              nodes: source.variants.map((v, index) => ({
                id: variants[index]?.id,
                position: index + 1,
                selectedOptions: v.optionValues,
                price: v.price,
                compareAtPrice: v.compareAtPrice,
                sku: v.sku,
                taxable: v.taxable,
                inventoryPolicy: v.inventoryPolicy === "deny" ? "DENY" : "CONTINUE",
                inventoryQuantity: v.inventoryQuantity,
                barcodes: {
                  nodes: v.barcode ? [{ value: v.barcode, type: null }] : [],
                  pageInfo: { hasNextPage: false },
                },
                media: { nodes: [], pageInfo: { hasNextPage: false } },
                inventoryItem: {
                  id: `gid://shopify/InventoryItem/${index + 1}`,
                  sku: v.sku,
                  tracked: true,
                  requiresShipping: v.requiresShipping,
                  measurement: { weight: { value: v.weight, unit: "GRAMS" } },
                  inventoryLevel: {
                    isActive: true,
                    location: { id: locationId },
                    quantities: [{ name: "available", quantity: v.inventoryQuantity }],
                  },
                },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        ],
      });
    assert.ok(query.startsWith("mutation "));
    writes++;
    return reply({ productSet: { product: { id: productId }, userErrors: [] } });
  };
  const ledger = createOracleSeedBindingLedger(config, snapshot, shopId, "authored", [], fetcher),
    executor = createOracleSeedExecutor(config, snapshot, shopId, "authored", contracts, {
      authorize: async () => {},
      verifyResult: async () => {},
      verifyBindings: ledger.verifyBindings,
      fetcher,
    }),
    recorder = createOracleSeedGeneratedRecorder(
      config,
      snapshot,
      shopId,
      "authored",
      ledger,
      fetcher,
    );
  const step = {
    stateHash: state.hash,
    taskKey: task.key,
    kind: "task" as const,
    options: { mode: "create" as const },
    bindings: { '["inventory-location"]': locationId },
  };
  return {
    snapshot,
    source,
    plan,
    state,
    task,
    ledger,
    executor,
    recorder,
    variants,
    step,
    fetcher,
    reads: () => reads,
    writes: () => writes,
    set: (failure: "change" | "foreign" | "content") => {
      change = failure === "change";
      foreign = failure === "foreign";
      badContent = failure === "content";
    },
  };
}
test("generated reader is read-only, pins store/version/ID and preserves integer IDs above numeric precision", async () => {
  const { fetcher } = setup();
  const metadata = await readOracleSeedGeneratedMetadata(
    config,
    "authored",
    shopId,
    "Product",
    productId,
    async (url, init) => {
      assert.equal(String(url), `https://${config.domain}/admin/api/2026-10/graphql.json`);
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.ok(body.query.startsWith("query "));
      assert.ok(!body.query.includes("mutation"));
      assert.deepEqual(body.variables.ids, [productId]);
      return fetcher(url, init);
    },
  );
  assert.equal(metadata.__typename, "Product");
  if (metadata.__typename !== "Product") throw new Error();
  assert.equal(metadata.legacyResourceId, productLegacy);
  assert.equal(metadata.createdAt, createdAt);
});
test("genuine execution must be recorded in the ledger; fresh source and stable metadata precede a generated receipt", async () => {
  const s = setup();
  await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
  const execution = await s.executor.executeVerified(s.step);
  await assert.rejects(s.recorder.record(execution), code("unverified-execution"));
  await s.ledger.record(execution);
  const receipt = await s.recorder.record(execution),
    view = inspectVerifiedSeedGenerated(receipt);
  assert.equal(s.reads(), 2);
  assert.equal(s.writes(), 1);
  assert.equal(view.stateHash, s.state.hash);
  view.metadata.handle = "changed";
  assert.notEqual(inspectVerifiedSeedGenerated(receipt).metadata.handle, "changed");
  assert.throws(
    () => inspectVerifiedSeedGenerated(JSON.parse(JSON.stringify(receipt))),
    code("unverified-execution"),
  );
  await assert.rejects(
    s.recorder.record({ kind: "verified-seed-execution" }),
    code("unverified-execution"),
  );
});
test("current owned observation reuses unchanged source across fixture states without claiming another execution", async () => {
  const s = setup();
  await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
  const execution = await s.executor.executeVerified(s.step);
  await s.ledger.record(execution);
  const unchanged = s.plan.states.find(
      (state) =>
        state.hash !== s.state.hash &&
        state.tasks.some(
          (task) => task.key === s.task.key && task.sourceHash === s.task.sourceHash,
        ),
    ),
    changed = s.plan.states.find((state) =>
      state.tasks.some((task) => task.key === s.task.key && task.sourceHash !== s.task.sourceHash),
    );
  assert.ok(unchanged && changed);
  const observation = await s.ledger.observeOwnedTask(unchanged.hash, s.task.key),
    context = inspectVerifiedSeedOwnership(observation),
    generated = await s.recorder.recordOwned(observation);
  assert.equal(context.stateHash, unchanged.hash);
  assert.equal(inspectVerifiedSeedGenerated(generated).stateHash, unchanged.hash);
  assert.equal(s.writes(), 1);
  context.task.sourceHash = "altered clone";
  assert.equal(inspectVerifiedSeedOwnership(observation).task.sourceHash, s.task.sourceHash);
  await assert.rejects(s.ledger.observeOwnedTask(changed.hash, s.task.key), {
    code: "scope-mismatch",
  });
  await assert.rejects(
    s.recorder.recordOwned({ kind: "verified-seed-ownership" }),
    code("unverified-execution"),
  );
  await assert.rejects(
    s.recorder.recordOwned(JSON.parse(JSON.stringify(observation))),
    code("unverified-execution"),
  );
  const other = setup();
  await assert.rejects(other.recorder.recordOwned(observation), code("unverified-execution"));
  assert.equal(other.reads(), 0);
});
test("owned observations require the same full source and stable generated metadata as execution-based calibration", async () => {
  for (const failure of ["change", "foreign", "content"] as const) {
    const s = setup();
    await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
    await s.ledger.record(await s.executor.executeVerified(s.step));
    const observation = await s.ledger.observeOwnedTask(s.state.hash, s.task.key);
    s.set(failure);
    await assert.rejects(
      s.recorder.recordOwned(observation),
      (error) => error instanceof SeedGeneratedError,
    );
    assert.equal(s.writes(), 1);
  }
});
test("case patch remaps variant/cart references, preserves shop inputs and reports incomplete capture dependencies", async () => {
  const s = setup(),
    before = structuredClone(s.snapshot);
  await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
  const execution = await s.executor.executeVerified(s.step);
  await s.ledger.record(execution);
  const receipt = await s.recorder.record(execution),
    cart = benchmarkMatrix.find((p) => p.scenario === "with-items");
  assert.ok(cart);
  const calibrated = applyOracleSeedGenerated(config, s.snapshot, shopId, cart.id, [receipt]),
    product = calibrated.snapshot.products[0];
  assert.ok(product);
  assert.equal(product.id, productLegacy);
  assert.equal(product.createdAt, createdAt);
  assert.equal(product.publishedAt, null);
  assert.equal(product.variants[0]?.id, s.variants[0]?.legacyResourceId);
  assert.equal(calibrated.snapshot.cart.lines[0]?.variantId, s.variants[0]?.legacyResourceId);
  assert.deepEqual(calibrated.snapshot.shop, s.snapshot.shop);
  assert.deepEqual(s.snapshot, before);
  assert.deepEqual(calibrated.snapshot.scenarios, {});
  assert.ok(calibrated.missingTasks.length > 0);
  assert.ok(calibrated.omissions.includes("cart-session-keys"));
  assert.equal(calibrated.captureReady, false);
  const soldOut = benchmarkMatrix.find((p) => p.scenario === "sold-out");
  assert.ok(soldOut);
  assert.throws(
    () => applyOracleSeedGenerated(config, s.snapshot, shopId, soldOut.id, [receipt]),
    code("scope-mismatch"),
  );
  assert.throws(
    () => applyOracleSeedGenerated(config, s.snapshot, "gid://shopify/Shop/2", cart.id, [receipt]),
    code("scope-mismatch"),
  );
  assert.throws(
    () => applyOracleSeedGenerated(config, s.snapshot, shopId, cart.id, [receipt, receipt]),
    code("scope-mismatch"),
  );
});
test("changed metadata, a foreign variant or changed source produces no calibration receipt", async () => {
  for (const failure of ["change", "foreign", "content"] as const) {
    const s = setup();
    await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
    const execution = await s.executor.executeVerified(s.step);
    await s.ledger.record(execution);
    s.set(failure);
    await assert.rejects(
      s.recorder.record(execution),
      code(
        failure === "change"
          ? "metadata-changed"
          : failure === "foreign"
            ? "metadata-mismatch"
            : "read-failed",
      ),
    );
    assert.equal(s.writes(), 1);
  }
});
test("concurrent generation is rejected while the first read remains live; later readonly refresh is allowed", async () => {
  const s = setup();
  await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
  const execution = await s.executor.executeVerified(s.step);
  await s.ledger.record(execution);
  const results = await Promise.allSettled([
    s.recorder.record(execution),
    s.recorder.record(execution),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected");
  assert.ok(failed?.status === "rejected");
  assert.ok(code("concurrent-record")(failed.reason));
  await s.recorder.record(execution);
  assert.equal(s.writes(), 1);
});
test("old execution loses recorded ownership after a later update and cannot be calibrated", async () => {
  const s = setup();
  await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
  const old = await s.executor.executeVerified(s.step);
  await s.ledger.record(old);
  const observation = await s.ledger.observeOwnedTask(s.state.hash, s.task.key);
  const values = Object.fromEntries(
    s.source.variants.map((v, i) => [
      JSON.stringify(["variant-id", s.source.handle, v.id]),
      s.variants[i]?.id,
    ]),
  );
  const updated = await s.executor.executeVerified({
    ...s.step,
    options: { mode: "update" },
    bindings: {
      ...s.step.bindings,
      ...values,
      [JSON.stringify(["product-id", s.source.handle])]: productId,
    },
  });
  await s.ledger.record(updated);
  await assert.rejects(
    s.ledger.assertRecorded(old),
    (e) => e instanceof SeedLedgerError && e.code === "unverified-execution",
  );
  await assert.rejects(s.recorder.record(old), code("unverified-execution"));
  await assert.rejects(s.recorder.recordOwned(observation), code("unverified-execution"));
});
test("truncation, duplicate or inconsistent legacy IDs and approximate comments counts are rejected", async () => {
  const s = setup(),
    response = await s.fetcher("https://authored.invalid", {
      body: JSON.stringify({ query: "query OfflinePreviewSeedGenerated" }),
    }),
    document = await response.json();
  for (const failure of ["truncated", "duplicate", "legacy"]) {
    const data = structuredClone(document.data),
      node = data.nodes[0];
    if (failure === "truncated") node.variants.pageInfo.hasNextPage = true;
    if (failure === "duplicate") node.variants.nodes.push(node.variants.nodes[0]);
    if (failure === "legacy") node.legacyResourceId = "1";
    await assert.rejects(
      readOracleSeedGeneratedMetadata(config, "authored", shopId, "Product", productId, async () =>
        reply(data),
      ),
      code(failure === "legacy" ? "metadata-mismatch" : "incomplete-metadata"),
    );
  }
  const article = {
    __typename: "Article",
    id: "gid://shopify/Article/1",
    handle: "story",
    blog: { id: "gid://shopify/Blog/1" },
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
    commentsCount: { count: 10000, precision: "AT_LEAST" },
  };
  await assert.rejects(
    readOracleSeedGeneratedMetadata(config, "authored", shopId, "Article", article.id, async () =>
      reply({ shop, nodes: [article] }),
    ),
    code("incomplete-metadata"),
  );
  const exact = await readOracleSeedGeneratedMetadata(
    config,
    "authored",
    shopId,
    "Article",
    article.id,
    async () =>
      reply({ shop, nodes: [{ ...article, commentsCount: { count: 0, precision: "EXACT" } }] }),
  );
  assert.equal(exact.__typename, "Article");
});
test("wrong store, version, unknown IDs and API errors never reflect private response details", async () => {
  for (const failure of ["store", "version", "missing", "errors"]) {
    let calls = 0;
    await assert.rejects(
      readOracleSeedGeneratedMetadata(
        config,
        "authored",
        shopId,
        "Page",
        "gid://shopify/Page/1",
        async () => {
          calls++;
          const data = {
            shop: failure === "store" ? { ...shop, id: "gid://shopify/Shop/2" } : shop,
            nodes:
              failure === "missing"
                ? [null]
                : [{ __typename: "Page", id: "gid://shopify/Page/1", handle: "about" }],
          };
          return failure === "errors"
            ? Response.json(
                { data, errors: [{ message: "private response body" }] },
                { headers: { "x-shopify-api-version": "2026-10" } },
              )
            : reply(data, failure === "version" ? "2026-07" : "2026-10");
        },
      ),
      (e) =>
        code(failure === "store" ? "store-mismatch" : "read-failed")(e) &&
        !String(e).includes("private"),
    );
    assert.equal(calls, 1);
  }
});
