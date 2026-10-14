import assert from "node:assert/strict";
import { test } from "node:test";
import { liquidPrice } from "../packages/data/src/objects.js";
import {
  applyOracleCart,
  createOracleCartSessions,
  inspectVerifiedOracleCart,
} from "../tools/oracle/cart-session.js";
import { applyOracleSeedGenerated } from "../tools/oracle/seed-generated.js";
import { createOracleSeedRuntime } from "../tools/oracle/seed-runtime.js";
import { config, locationId, productLegacy, setup, shopId } from "./helpers/seed-product.js";

// Authored API and storefront responses only, never real cart/capture/owner authorization evidence.
const publication = {
  kind: "Publication" as const,
  id: "gid://shopify/Publication/1",
  catalogId: "gid://shopify/AppCatalog/1",
  appId: "gid://shopify/App/1",
};
async function fixture(empty = false) {
  const s = setup(false, (snapshot) => {
    const product = snapshot.products[0];
    assert.ok(product);
    const variants = product.variants.filter((variant) => variant.available).slice(0, 2);
    assert.equal(variants.length, 2);
    snapshot.scenarios["with-items"] = {
      cart: {
        lines: variants.map((variant, index) => ({
          productHandle: product.handle,
          variantId: variant.id,
          quantity: index + 1,
        })),
        note: "Authored cart note",
      },
    };
  });
  await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
  await s.ledger.registerEnvironment(publication);
  const execution = await s.executor.executeVerified(s.step);
  await s.ledger.record(execution);
  const request = s.plan.requests.find(
    (request) => request.caseId === (empty ? "13-cart-default" : "14-cart-with-items"),
  );
  assert.ok(request?.cart);
  const generated = await s.recorder.record(execution),
    derived = applyOracleSeedGenerated(config, s.snapshot, shopId, request.caseId, [generated]);
  const controller = createOracleCartSessions(
    config,
    s.snapshot,
    shopId,
    "authored",
    s.ledger,
    s.fetcher,
  );
  return { s, execution, request, derived, controller };
}
function storefront(f: Awaited<ReturnType<typeof fixture>>, failure = "") {
  let note: string | null = null,
    items: Record<string, unknown>[] = [],
    calls = 0,
    posts = 0,
    htmlGets = 0,
    reads = 0;
  const desired = f.request.cart;
  assert.ok(desired);
  function cart() {
    const total = items.reduce((sum, line) => sum + Number(line.line_price), 0);
    return {
      token:
        failure === "token" && reads > 1 ? "changed-private-token" : "authored-private-cart-token",
      note,
      currency: f.s.snapshot.shop.currency,
      attributes: {},
      item_count: items.reduce((sum, line) => sum + Number(line.quantity), 0),
      items,
      original_total_price: total,
      items_subtotal_price: total,
      total_price: total,
      total_discount: 0,
      cart_level_discount_applications: [],
      discount_codes: [],
    };
  }
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    const target = new URL(String(url)),
      headers = new Headers(init?.headers);
    assert.equal(target.origin, `https://${config.domain}`);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.has("x-shopify-access-token"), false);
    assert.match(headers.get("cookie") ?? "", /^(storefront_digest|_shopify_essential)=authored/);
    if (calls > 1) assert.match(headers.get("cookie") ?? "", /cart=authored-private-cookie/);
    if (target.pathname === "/cart.js") {
      reads++;
      const value = cart();
      if (failure === "existing" && reads === 1) value.note = "Existing user cart";
      if (failure === "currency" && reads > 1) value.currency = "EUR";
      if (failure === "quantity" && reads > 1 && value.items[0]) value.items[0].quantity = 99;
      if (failure === "price" && reads > 1 && value.items[0]) value.items[0].price = 99;
      if (failure === "discount" && reads > 1) value.total_discount = 1;
      if (failure === "key-drift" && htmlGets > 0 && value.items[0]) value.items[0].key = "changed";
      // IDs are actual JSON number tokens above 2^53, not pre-rounded JavaScript numbers.
      let text = JSON.stringify(value).replace(
        /"(id|variant_id|product_id)":"([0-9]+)"/g,
        '"$1":$2',
      );
      if (failure === "duplicate-json" && reads > 1)
        text = text.replace('"item_count":', '"item_count":0,"item_count":');
      if (failure === "oversize") text = "x".repeat(2 * 1024 * 1024 + 1);
      return new Response(text, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "set-cookie":
            failure === "cookie-domain"
              ? "cart=authored; Domain=evil.invalid; Path=/"
              : "cart=authored-private-cookie; Path=/; Secure; HttpOnly",
        },
      });
    }
    if (target.pathname === "/cart") {
      htmlGets++;
      assert.equal(init?.method, "GET");
      assert.equal(target.searchParams.get("preview_theme_id"), "7");
      return new Response('<div id="shopify-section-main">Authored cart</div>', {
        headers: { "content-type": "text/html" },
      });
    }
    assert.equal(init?.method, "POST");
    posts++;
    const payload = JSON.parse(String(init.body));
    if (target.pathname === "/cart/update.js") {
      note = payload.note;
    } else {
      assert.equal(target.pathname, "/cart/add.js");
      if (failure === "lost") throw new Error("private cookie/token transport detail");
      items = payload.items
        .map((item: { id: string; quantity: number }, index: number) => {
          const variantIndex = f.s.variants.findIndex(
              (variant) => variant.legacyResourceId === item.id,
            ),
            variant = f.s.source.variants[variantIndex];
          assert.ok(variant);
          const price = liquidPrice(variant.price);
          return {
            id: item.id,
            variant_id: item.id,
            product_id: productLegacy,
            handle: f.s.source.handle,
            key: `${item.id}:authored-${index}`,
            quantity: item.quantity,
            price,
            original_price: price,
            final_price: price,
            line_price: price * item.quantity,
            original_line_price: price * item.quantity,
            final_line_price: price * item.quantity,
            total_discount: 0,
            properties: {},
            selling_plan_allocation: null,
            discounts: [],
            line_level_discount_allocations: [],
          };
        })
        .reverse(); // Native response order is authoritative.
    }
    return Response.json(cart());
  };
  return {
    fetcher,
    calls: () => calls,
    posts: () => posts,
    htmlGets: () => htmlGets,
    change: () => {
      note = "Changed elsewhere";
    },
  };
}
function captureDependencies(f: Awaited<ReturnType<typeof fixture>>, failure = "") {
  let themes = 0,
    files = 0,
    settings = 0;
  return {
    readIdentity: async () => ({
      id: failure === "shop" ? "gid://shopify/Shop/2" : shopId,
      myshopifyDomain: config.domain,
      name: "Authored",
      currencyCode: "USD",
      ianaTimezone: "UTC",
      plan: { partnerDevelopment: true },
      metafield: { value: "true" },
    }),
    readTheme: async () => {
      themes++;
      return {
        id: "gid://shopify/OnlineStoreTheme/7",
        role:
          failure === "live" || (failure === "late-live" && themes > 2)
            ? ("MAIN" as const)
            : ("UNPUBLISHED" as const),
        processing: false,
        processingFailed: false,
      };
    },
    verifyThemeFiles: async () => {
      files++;
      if (failure === "files" && files > 1) throw new Error("changed files");
    },
    verifyShopSettings: async () => {
      settings++;
      if (failure === "settings") throw new Error("private settings");
    },
    counts: () => ({ themes, files, settings }),
  };
}
const captureInput = { previewThemeId: "7", summaryOptions: { sectionTypes: { main: "main" } } };
test("isolated cart setup verifies owned source and publication, retains cookies privately and applies exact large IDs, native keys and order", async () => {
  const f = await fixture(),
    server = storefront(f),
    stages: string[] = [];
  const receipt = await f.controller.prepare(f.request.caseId, {
    passwordCookie: "storefront_digest=authored",
    fetcher: server.fetcher,
    authorize: async (context) => {
      stages.push(context.stage);
      assert.equal(context.stateHash, f.request.stateHash);
    },
  });
  assert.deepEqual(stages, ["note", "add"]);
  assert.equal(server.posts(), 2);
  const observed = inspectVerifiedOracleCart(receipt);
  assert.equal(observed.lines.length, 2);
  assert.ok(BigInt(observed.lines[0]?.variantId ?? 0) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(JSON.stringify(receipt).includes("private"), false);
  assert.equal(JSON.stringify(observed).includes("private"), false);
  const projected = applyOracleCart(
    config,
    f.s.snapshot,
    shopId,
    f.request.caseId,
    f.derived.snapshot,
    receipt,
  );
  assert.deepEqual(
    projected.snapshot.cart.lines.map((line) => line.key),
    observed.lines.map((line) => line.key),
  );
  assert.equal(projected.captureReady, false);
  assert.equal(f.derived.snapshot.cart.lines[0]?.key, undefined);
  const deps = captureDependencies(f),
    captured = await f.controller.capture(receipt, captureInput, deps);
  assert.equal(server.htmlGets(), 2);
  assert.match(captured.privateRawHtml[0], /Authored cart/);
  assert.equal(server.posts(), 2);
  assert.ok(deps.counts().files >= 3);
  assert.throws(() => inspectVerifiedOracleCart(JSON.parse(JSON.stringify(receipt))), {
    code: "session-invalid",
  });
  assert.throws(
    () =>
      applyOracleCart(config, f.s.snapshot, shopId, "13-cart-default", f.derived.snapshot, receipt),
    { code: "scope-mismatch" },
  );
});
test("empty cart capture performs no mutations and still uses an isolated verified cookie session", async () => {
  const f = await fixture(true),
    server = storefront(f),
    receipt = await f.controller.prepare(f.request.caseId, {
      passwordCookie: "storefront_digest=authored",
      fetcher: server.fetcher,
      authorize: async () => {
        throw new Error("must not mutate");
      },
    });
  assert.equal(server.posts(), 0);
  assert.deepEqual(inspectVerifiedOracleCart(receipt).lines, []);
  await f.controller.capture(receipt, captureInput, captureDependencies(f));
  assert.equal(server.htmlGets(), 2);
});
test("existing carts, foreign cookies, missing approval and failed ownership never clear or add to a cart", async () => {
  for (const failure of ["existing", "cookie-domain", "cookie-input", "approval", "source"]) {
    const f = await fixture(),
      server = storefront(f, failure);
    if (failure === "source") f.s.set("content");
    await assert.rejects(
      f.controller.prepare(f.request.caseId, {
        passwordCookie:
          failure === "cookie-input"
            ? "storefront_digest=authored; cart=someone-else"
            : "storefront_digest=authored",
        fetcher: server.fetcher,
        authorize: async () => {
          if (failure === "approval") throw new Error("denied");
        },
      }),
      {
        code:
          failure === "existing"
            ? "session-not-empty"
            : failure === "cookie-input"
              ? "invalid-input"
              : failure === "approval"
                ? "authorization-denied"
                : "request-failed",
      },
    );
    assert.equal(server.posts(), 0);
  }
});
test("lost POST outcome is never retried; malformed, oversized, wrong-price/quantity/currency/token and discounted readbacks issue no receipt", async () => {
  for (const failure of [
    "lost",
    "quantity",
    "price",
    "currency",
    "token",
    "discount",
    "duplicate-json",
    "oversize",
  ]) {
    const f = await fixture(),
      server = storefront(f, failure);
    await assert.rejects(
      f.controller.prepare(f.request.caseId, {
        passwordCookie: "_shopify_essential=authored",
        fetcher: server.fetcher,
        authorize: async () => {},
      }),
      { code: ["lost", "oversize"].includes(failure) ? "request-failed" : "cart-mismatch" },
    );
    assert.ok(server.posts() <= 2);
  }
});
test("cart drift, settings, store/theme identity and late uploaded-file changes invalidate the session and prevent successful capture", async () => {
  for (const failure of ["key-drift", "settings", "shop", "live", "late-live", "files"]) {
    const f = await fixture(),
      server = storefront(f, failure),
      receipt = await f.controller.prepare(f.request.caseId, {
        passwordCookie: "storefront_digest=authored",
        fetcher: server.fetcher,
        authorize: async () => {},
      });
    await assert.rejects(
      f.controller.capture(receipt, captureInput, captureDependencies(f, failure)),
    );
    assert.throws(() => inspectVerifiedOracleCart(receipt), { code: "session-invalid" });
    const calls = server.calls();
    await assert.rejects(f.controller.capture(receipt, captureInput, captureDependencies(f)), {
      code: "session-invalid",
    });
    assert.equal(server.calls(), calls);
  }
});

test("the composed runtime owns the cart session, excludes simultaneous seed operations and refuses sessions from another runtime", async () => {
  const f = await fixture(),
    s = f.s,
    server = storefront(f),
    runtime = createOracleSeedRuntime(config, s.snapshot, shopId, "authored", s.retained, [], {
      authorize: async () => {},
      fetcher: s.fetcher,
    });
  await runtime.registerEnvironment({ kind: "Location", id: locationId });
  await runtime.registerEnvironment(publication);
  await runtime.execute(s.step);
  let entered: () => void = () => {},
    release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const preparing = runtime.prepareCart(f.request.caseId, {
    passwordCookie: "storefront_digest=authored",
    fetcher: server.fetcher,
    authorize: async () => {
      entered();
      await hold;
    },
  });
  await ready;
  await assert.rejects(runtime.verifyStore(), { code: "concurrent-operation" });
  release();
  const receipt = await preparing;
  await assert.rejects(f.controller.capture(receipt, captureInput, captureDependencies(f)), {
    code: "session-invalid",
  });
  await runtime.captureCart(receipt, captureInput, captureDependencies(f));
  assert.equal(server.htmlGets(), 2);
  assert.equal(server.posts(), 2);
  const changed = structuredClone(f.derived.snapshot);
  assert.ok(changed.products[0]);
  changed.products[0].id = "9999";
  assert.throws(
    () => applyOracleCart(config, s.snapshot, shopId, f.request.caseId, changed, receipt),
    { code: "cart-mismatch" },
  );
});
