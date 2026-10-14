import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkMatrix } from "../packages/data/src/fixture.js";
import {
  inspectVerifiedSeedOwnership,
  SeedLedgerError,
} from "../tools/oracle/seed-binding-ledger.js";
import {
  applyOracleSeedGenerated,
  inspectVerifiedSeedGenerated,
  readOracleSeedGeneratedMetadata,
  SeedGeneratedError,
} from "../tools/oracle/seed-generated.js";
import { createOracleSeedStateReader } from "../tools/oracle/seed-state-reader.js";

import {
  code,
  config,
  createdAt,
  locationId,
  productId,
  productLegacy,
  reply,
  setup,
  shop,
  shopId,
} from "./helpers/seed-product.js";

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
test("state description verifies the previous complete owned product before declaring variant additions for another state", async () => {
  const s = setup();
  await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
  await s.ledger.record(await s.executor.executeVerified(s.step));
  const reader = createOracleSeedStateReader(config, s.snapshot, shopId, "authored", s.ledger, {
      fetcher: s.fetcher,
    }),
    changed = s.plan.states.find((state) =>
      state.tasks.some((task) => task.key === s.task.key && task.sourceHash !== s.task.sourceHash),
    );
  assert.ok(changed);
  const previous = await reader.describe(changed.hash, s.task.key);
  assert.equal(previous.status, "owned");
  if (previous.status !== "owned") throw new Error();
  assert.equal(previous.sourceHash, s.task.sourceHash);
  assert.deepEqual(
    previous.variantIds,
    s.source.variants.map((variant) => variant.id),
  );
  await reader.verifyTask(s.state.hash, s.task.key);
  await assert.rejects(reader.verifyTask(changed.hash, s.task.key), { code: "unverified-task" });
  s.set("content");
  await assert.rejects(reader.describe(changed.hash, s.task.key), { code: "source-mismatch" });
  assert.equal(s.writes(), 1);
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
