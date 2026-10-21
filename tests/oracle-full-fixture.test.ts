import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { applyCompleteScenario as applyScenario } from "../packages/data/src/scenarios.js";
import { backupDigest } from "../tools/oracle/backup-audit.js";
import { inspectVerifiedOracleCase } from "../tools/oracle/case-capture.js";
import { snapshotFingerprint } from "../tools/oracle/matrix.js";
import { inspectVerifiedSeedGenerated } from "../tools/oracle/seed-generated.js";
import { openOracleSeedStateDriver } from "../tools/oracle/seed-state-driver.js";
import { inspectVerifiedSeedState } from "../tools/oracle/seed-state-reader.js";
import {
  allContracts,
  config,
  fullFixtureStore,
  locationId,
  publication,
  shopId,
} from "./helpers/case-store.js";

// Unmodified release inputs, but authored HTTP only: no Shopify authorization, mutation or goldens.
test("unmodified forty-product fixture traverses all seven real driver states, restart, and eighteen complete case assemblies", async (t) => {
  const store = fullFixtureStore(),
    directory = await realpath(await mkdtemp(join(tmpdir(), "sop-full-fixture-")));
  assert.deepEqual(store.snapshot, defaultFixture());
  assert.equal(store.snapshot.products.length, 40);
  assert.equal(store.plan.states.length, 7);
  assert.equal(store.assets.length, 16);
  assert.equal(new Set(store.assets.map((asset) => asset.sha256)).size, 16);
  const uploads = new Set<string>();
  const open = () =>
    openOracleSeedStateDriver(
      config,
      store.snapshot,
      shopId,
      "authored",
      allContracts,
      store.assets,
      directory,
      {
        authorize: async () => {},
        fetcher: store.fetcher,
        readImage: store.readImage,
        uploadFetcher: async (_url, init) => {
          assert.ok(init?.body instanceof FormData);
          const file = init.body.get("file");
          assert.ok(file instanceof File);
          const asset = store.assets.find((asset) => asset.file === file.name);
          assert.ok(asset);
          assert.equal(file.size, asset.bytes);
          assert.equal(backupDigest(new Uint8Array(await file.arrayBuffer())), asset.sha256);
          assert.equal(uploads.has(file.name), false);
          uploads.add(file.name);
          return new Response(null, { status: 204 });
        },
        location: { kind: "Location", id: locationId },
        publication,
      },
    );
  type Driver = Awaited<ReturnType<typeof openOracleSeedStateDriver>>;
  let driver: Driver | undefined;
  try {
    driver = await open();
    const originalIds = store.variantIds(),
      singleState = store.plan.requests.find(
        (request) => request.scenario === "single-variant",
      )?.stateHash;
    assert.ok(singleState);
    let restored = false;
    let created = 0,
      updated = 0,
      reordered = 0;
    for (const state of store.plan.states) {
      store.selectState(state.hash);
      const result: Awaited<ReturnType<Driver["runState"]>> = await driver.runState(state.hash);
      const record = inspectVerifiedSeedState(result.resourceState);
      assert.equal(record.stateHash, state.hash);
      assert.equal(record.fixtureHash, store.plan.fixtureHash);
      assert.equal(record.taskKeys.length, 65);
      assert.equal(result.generated.length, 46);
      for (const receipt of result.generated)
        assert.equal(inspectVerifiedSeedGenerated(receipt).stateHash, state.hash);
      created += result.counts.created;
      updated += result.counts.updated;
      reordered += result.counts.reordered;
      const writes = store.counts().writes;
      assert.equal(store.variantIds().get("sop-main-1"), originalIds.get("sop-main-1"));
      if (state.hash === singleState) {
        assert.equal(store.variantIds().has("sop-main-2"), false);
        await driver.close();
        driver = await open();
        restored = true;
        assert.equal(store.counts().writes, writes);
      } else if (restored) {
        assert.ok(store.variantIds().has("sop-main-2"));
        assert.notEqual(store.variantIds().get("sop-main-2"), originalIds.get("sop-main-2"));
      }
      const repeated: Awaited<ReturnType<Driver["runState"]>> = await driver.runState(state.hash);
      assert.deepEqual(repeated.counts, {
        created: 0,
        updated: 0,
        reused: 65,
        reordered: 0,
        published: 0,
      });
      assert.equal(store.counts().writes, writes);
    }
    assert.equal(restored, true);
    assert.equal(store.mutationCounts().get("stagedUploadsCreate"), 16);
    assert.equal(store.mutationCounts().get("fileCreate"), 16);
    assert.equal(uploads.size, 16);
    assert.equal(store.mutationCounts().get("publishablePublish"), 41);
    assert.equal(store.mutationCounts().get("collectionCreate"), 1);
    assert.equal(store.mutationCounts().get("collectionUpdate"), 2);
    assert.equal(store.mutationCounts().get("articleCreate"), 3);
    assert.equal(store.mutationCounts().get("articleUpdate"), 1);
    assert.equal(created, 65);
    assert.ok(updated > 0);
    assert.ok(reordered > 0);
    for (const request of store.plan.requests) {
      store.selectState(request.stateHash);
      await driver.runState(request.stateHash);
      const cart = store.cartTransport(),
        before = store.counts().writes;
      const receipt = await driver.captureSeededCase(
        request.caseId,
        {
          previewThemeId: "7",
          summaryOptions: { sectionTypes: { main: "main" } },
        },
        {
          cart: {
            passwordCookie: "_shopify_essential=authored",
            fetcher: cart.transport,
            authorize: async () => {},
          },
          capture: store.captureAdapters,
          shop: store.shop,
          imageProbes: {
            product: {
              themeId: "8",
              cookie: "authored-cookie",
              dependencies: store.imageDependencies,
            },
            collection: {
              themeId: "9",
              cookie: "authored-cookie",
              dependencies: store.imageDependencies,
            },
            article: {
              themeId: "10",
              cookie: "authored-cookie",
              dependencies: store.imageDependencies,
            },
          },
        },
      );
      const record = inspectVerifiedOracleCase(receipt),
        expected = applyScenario(store.snapshot, request.scenario);
      assert.equal(record.caseId, request.caseId);
      assert.equal(record.stateHash, request.stateHash);
      assert.equal(record.baseFixtureHash, store.plan.fixtureHash);
      assert.equal(record.snapshotHash, snapshotFingerprint(record.snapshot));
      assert.equal(record.snapshot.meta.now, record.capture.capturedAt);
      assert.deepEqual(record.snapshot.scenarios, {});
      assert.equal(record.snapshot.products.length, 40);
      const product = record.snapshot.products[0],
        wanted = expected.products[0];
      assert.ok(product && wanted);
      assert.equal(product.variants.length, wanted.variants.length);
      assert.equal(product.images.length, wanted.images.length);
      assert.equal(product.title, wanted.title);
      assert.deepEqual(
        product.variants.map((variant) => variant.available),
        wanted.variants.map((variant) => variant.available),
      );
      assert.equal(
        record.snapshot.collections[0]?.products.length,
        expected.collections[0]?.products.length,
      );
      assert.equal(
        record.snapshot.blogs[0]?.articles[0]?.image === null,
        expected.blogs[0]?.articles[0]?.image === null,
      );
      assert.equal(record.snapshot.cart.lines.length, request.scenario === "with-items" ? 2 : 0);
      assert.equal(cart.posts(), request.scenario === "with-items" ? 2 : 0);
      assert.equal(store.counts().writes, before);
      t.diagnostic(`${request.caseId}: complete calibrated case, no catalog writes`);
    }
    assert.equal(store.mutationCounts().get("fileCreate"), 16);
  } finally {
    if (driver) await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
});
