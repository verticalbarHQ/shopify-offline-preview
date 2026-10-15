import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createOracleCaseCapturer,
  inspectVerifiedOracleCase,
  type OracleCasePort,
} from "../tools/oracle/case-capture.js";
import { snapshotFingerprint } from "../tools/oracle/matrix.js";
import { inspectVerifiedSeedGenerated } from "../tools/oracle/seed-generated.js";
import { openOracleSeedStateDriver } from "../tools/oracle/seed-state-driver.js";
import { createOracleShopSettingsVerifier } from "../tools/oracle/shop-settings.js";
import {
  allContracts,
  compactCaseStore,
  config,
  locationId,
  publication,
  shopId,
} from "./helpers/case-store.js";

// Entirely authored API/storefront responses. Real opaque runtime receipts, but NO live Shopify writes, approvals or goldens.
async function harness() {
  const store = compactCaseStore(),
    directory = await realpath(await mkdtemp(join(tmpdir(), "sop-case-journal-")));
  try {
    const driver = await openOracleSeedStateDriver(
      config,
      store.snapshot,
      shopId,
      "authored",
      allContracts,
      [],
      directory,
      {
        authorize: async () => {},
        fetcher: store.fetcher,
        readImage: async () => {
          throw new Error("No authored images");
        },
        location: { kind: "Location", id: locationId },
        publication,
      },
    );
    const seed = await driver.runState(store.state.hash);
    const images = {
      product: { themeId: "8", cookie: "authored-cookie", dependencies: store.imageDependencies },
      collection: {
        themeId: "9",
        cookie: "authored-cookie",
        dependencies: store.imageDependencies,
      },
      article: { themeId: "10", cookie: "authored-cookie", dependencies: store.imageDependencies },
    };
    return {
      store,
      driver,
      seed,
      images,
      close: async () => {
        await driver.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
const captureInput = { previewThemeId: "7", summaryOptions: { sectionTypes: { main: "main" } } };
test("production driver composes real owned state, generated/image/shop/cart/clock receipts for every request of a compact contract fixture", async () => {
  const h = await harness();
  try {
    const before = h.store.counts().writes;
    for (const request of h.store.plan.requests) {
      const cart = h.store.cartTransport(),
        receipt = await h.driver.captureSeededCase(request.caseId, captureInput, {
          cart: {
            passwordCookie: "_shopify_essential=authored",
            fetcher: cart.transport,
            authorize: async () => {},
          },
          capture: h.store.captureAdapters,
          shop: h.store.shop,
          imageProbes: h.images,
        }),
        record = inspectVerifiedOracleCase(receipt);
      assert.equal(record.caseId, request.caseId);
      assert.equal(record.path, request.path);
      assert.equal(record.baseFixtureHash, h.store.plan.fixtureHash);
      assert.equal(record.stateHash, request.stateHash);
      assert.equal(record.snapshotHash, snapshotFingerprint(record.snapshot));
      assert.equal(record.snapshot.meta.now, record.capture.capturedAt);
      assert.equal(record.snapshot.shop.id, "1");
      assert.equal(record.rawHashes.length, 2);
      assert.deepEqual(record.snapshot.scenarios, {});
      assert.equal(cart.posts(), request.scenario === "with-items" ? 2 : 0);
      assert.throws(() => inspectVerifiedOracleCase(JSON.parse(JSON.stringify(receipt))), {
        code: "unverified-case",
      });
      record.snapshot.shop.name = "Tampered clone";
      assert.notEqual(inspectVerifiedOracleCase(receipt).snapshot.shop.name, "Tampered clone");
    }
    assert.equal(h.store.counts().writes, before); // Only isolated session writes; no catalogue mutation during capture.
  } finally {
    await h.close();
  }
});
test("generated metadata changing during the HTML pair fails final assembly despite unchanged writable source", async () => {
  const h = await harness();
  try {
    const request = h.store.plan.requests[0];
    assert.ok(request);
    const cart = h.store.cartTransport();
    let html = 0;
    const fetcher: typeof fetch = async (url, init) => {
      const response = await cart.transport(url, init);
      if (init?.method === "GET" && new URL(String(url)).pathname !== "/cart.js" && ++html === 2)
        h.store.changeGenerated();
      return response;
    };
    await assert.rejects(
      h.driver.captureSeededCase(request.caseId, captureInput, {
        cart: { passwordCookie: "_shopify_essential=authored", fetcher, authorize: async () => {} },
        capture: h.store.captureAdapters,
        shop: h.store.shop,
        imageProbes: h.images,
      }),
      { code: "changed-evidence" },
    );
  } finally {
    await h.close();
  }
});

test("complete genuine evidence cannot be combined with replaced summary/text/raw HTML or a different cart case", async () => {
  const h = await harness();
  try {
    for (const failure of ["summary", "text", "html", "cart-case"]) {
      const server = h.store.cartTransport(),
        port: OracleCasePort = {
          verifyState: async (hash) => (await h.driver.runState(hash)).resourceState,
          observeGenerated: async (_hash, key) => {
            const found = h.seed.generated.find(
              (receipt) => inspectVerifiedSeedGenerated(receipt).taskKey === key,
            );
            assert.ok(found);
            return found;
          },
          observeImages: (hash, key) => {
            const task = h.store.state.tasks.find((task) => task.key === key);
            assert.ok(task);
            if (
              task.resource !== "product" &&
              task.resource !== "collection" &&
              task.resource !== "article"
            )
              throw new Error();
            const probe = h.images[task.resource];
            return h.driver.observeNativeImages(
              hash,
              key,
              probe.themeId,
              probe.cookie,
              probe.dependencies,
            );
          },
          verifyShop: (expected) =>
            createOracleShopSettingsVerifier(config, expected, shopId, "authored", {
              fetcher: h.store.fetcher,
              ...h.store.shop,
            })(),
          prepareCart: (id, dependencies) =>
            h.driver.prepareCart(failure === "cart-case" ? "13-cart-default" : id, dependencies),
          captureCartContext: async (...args) => {
            const result = await h.driver.captureCartContext(...args);
            if (failure === "summary") result.capture.publicSummary.sections = [];
            if (failure === "text") result.capture.privateSectionText.main = "Changed private text";
            if (failure === "html")
              result.capture.privateRawHtml = [
                result.capture.privateRawHtml[0] + "changed",
                result.capture.privateRawHtml[1],
              ];
            return result;
          },
        },
        capturer = createOracleCaseCapturer(config, h.store.snapshot, shopId, port);
      await assert.rejects(
        capturer.capture(
          "01-home-default",
          captureInput,
          {
            passwordCookie: "_shopify_essential=authored",
            fetcher: server.transport,
            authorize: async () => {},
          },
          h.store.captureAdapters,
        ),
      );
      assert.equal(server.posts(), 0);
    }
  } finally {
    await h.close();
  }
});
test("one case owns the production driver until all post-capture reads finish; a later clean attempt succeeds after drift", async () => {
  const h = await harness();
  try {
    let entered: () => void = () => {},
      release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve;
      }),
      server = h.store.cartTransport(),
      capture = h.driver.captureSeededCase("01-home-default", captureInput, {
        cart: {
          passwordCookie: "_shopify_essential=authored",
          fetcher: server.transport,
          authorize: async () => {},
        },
        capture: h.store.captureAdapters,
        shop: {
          readNativeSettings: async (context) => {
            entered();
            await hold;
            return h.store.shop.readNativeSettings();
          },
        },
        imageProbes: h.images,
      });
    await ready;
    await assert.rejects(h.driver.runState(h.store.state.hash), { code: "concurrent-run" });
    await assert.rejects(h.driver.close(), { code: "concurrent-run" });
    release();
    await capture;
    h.store.changeSource();
    const broken = h.store.cartTransport();
    await assert.rejects(
      h.driver.captureSeededCase("01-home-default", captureInput, {
        cart: {
          passwordCookie: "_shopify_essential=authored",
          fetcher: broken.transport,
          authorize: async () => {},
        },
        capture: h.store.captureAdapters,
        shop: h.store.shop,
        imageProbes: h.images,
      }),
    );
    assert.equal(broken.posts(), 0);
    h.store.reset();
    const fresh = h.store.cartTransport();
    const restored = await h.driver.captureSeededCase("01-home-default", captureInput, {
      cart: {
        passwordCookie: "_shopify_essential=authored",
        fetcher: fresh.transport,
        authorize: async () => {},
      },
      capture: h.store.captureAdapters,
      shop: h.store.shop,
      imageProbes: h.images,
    });
    assert.equal(inspectVerifiedOracleCase(restored).caseId, "01-home-default");
  } finally {
    await h.close();
  }
});

test("serialized state flags and a genuine state from another domain fail before session or capture work", async () => {
  const h = await harness();
  try {
    let further = 0;
    const unavailable = async () => {
        further++;
        throw new Error("Must not reach later work");
      },
      port: OracleCasePort = {
        verifyState: async () => JSON.parse(JSON.stringify(h.seed.resourceState)),
        observeGenerated: unavailable,
        observeImages: unavailable,
        verifyShop: unavailable,
        prepareCart: unavailable,
        captureCartContext: unavailable,
      },
      cart = {
        passwordCookie: "_shopify_essential=authored",
        authorize: async () => {
          throw new Error("No session write authorized");
        },
      };
    await assert.rejects(
      createOracleCaseCapturer(config, h.store.snapshot, shopId, port).capture(
        "01-home-default",
        captureInput,
        cart,
        h.store.captureAdapters,
      ),
      { code: "unverified-task" },
    );
    assert.equal(further, 0);
    port.verifyState = async () => h.seed.resourceState;
    await assert.rejects(
      createOracleCaseCapturer(
        { ...config, domain: "other.myshopify.com" },
        h.store.snapshot,
        shopId,
        port,
      ).capture("01-home-default", captureInput, cart, h.store.captureAdapters),
      { code: "invalid-scope" },
    );
    assert.equal(further, 0);
  } finally {
    await h.close();
  }
});
