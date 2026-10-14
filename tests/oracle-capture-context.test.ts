import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toLiquidHtmlAST } from "@shopify/liquid-html-parser";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { applyScenario } from "../packages/data/src/scenarios.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import {
  applyOracleCaptureContext,
  captureContextHash,
  captureContextKey,
  captureContextSnippet,
  captureContextSource,
  captureOracleContextPage,
  extractNativeCaptureContext,
  inspectVerifiedCaptureContext,
  type NativeCaptureContext,
} from "../tools/oracle/capture-context.js";
import { instrumentTheme } from "../tools/oracle/instrument-theme.js";
import { config, shopId } from "./helpers/seed-product.js";

// Authored Native/HTTP responses, never actual Shopify goldens or approval evidence.
function native(): NativeCaptureContext {
  return {
    shopId: "1",
    domain: config.domain,
    path: "/cart",
    locale: "en",
    epoch: String(Math.floor(Date.now() / 1000)),
    cart: {
      currency: "USD",
      note: null,
      taxesIncluded: null,
      dutiesIncluded: false,
      itemCount: 0,
      originalTotal: 0,
      subtotal: 0,
      total: 0,
      discount: 0,
      items: [],
    },
  };
}
function script(value: NativeCaptureContext) {
  return `<script id="${captureContextKey}" type="application/json">${JSON.stringify(Buffer.from(JSON.stringify(value)).toString("base64"))}</script>`;
}
function page(value: NativeCaptureContext) {
  return `<div id="shopify-section-main">Authored cart</div>${script(value)}`;
}
const input = {
  config,
  path: "/cart",
  previewThemeId: "7",
  cookie: "authored-private-cookie",
  summaryOptions: { sectionTypes: { main: "main" } },
};
function setup(payload = native(), failure = "") {
  let gets = 0,
    themes = 0,
    files = 0,
    sources = 0;
  const dependencies = {
    readCaptureContextSource: async () => {
      sources++;
      return failure === "snippet" || (failure === "late-snippet" && sources > 2)
        ? "Changed uploaded snippet"
        : captureContextSource;
    },
    readIdentity: async () => ({
      id: failure === "shop" ? "gid://shopify/Shop/2" : shopId,
      myshopifyDomain: config.domain,
      name: "Authored",
      currencyCode: "USD",
      ianaTimezone: "UTC",
      plan: { partnerDevelopment: true },
      metafield: failure === "marker" ? null : { value: "true" },
    }),
    readTheme: async () => {
      themes++;
      return {
        id: "gid://shopify/OnlineStoreTheme/7",
        role:
          failure === "live" || (failure === "late-live" && themes > 3)
            ? ("MAIN" as const)
            : ("UNPUBLISHED" as const),
        processing: false,
        processingFailed: false,
      };
    },
    verifyThemeFiles: async () => {
      files++;
      if (failure === "files" && files > 1) throw new Error("Changed private files");
    },
    verifyShopSettings: async () => {
      if (failure === "settings") throw new Error("Private shop values");
    },
    fetcher: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      gets++;
      const target = new URL(String(url)),
        headers = new Headers(init?.headers);
      assert.equal(target.hostname, config.domain);
      assert.equal(init?.redirect, "manual");
      assert.equal(headers.get("Cookie"), input.cookie);
      assert.equal(headers.has("Authorization"), false);
      assert.equal(headers.has("x-shopify-access-token"), false);
      const value = structuredClone(payload);
      if (gets === 2) {
        value.epoch = String(Number(value.epoch) + 1);
        if (failure === "unstable") value.cart.dutiesIncluded = true;
        if (failure === "backwards") value.epoch = String(Number(payload.epoch) - 1);
      }
      return new Response(failure === "oversize" ? "x".repeat(4 * 1024 * 1024 + 1) : page(value), {
        status: failure === "redirect" ? 302 : 200,
        headers: { "content-type": "text/html" },
      });
    },
  };
  return { dependencies, gets: () => gets };
}
test("capture-context source is authored Liquid, preserves Unicode/large IDs through base64, and rejects duplicate/malformed scripts", () => {
  toLiquidHtmlAST(captureContextSource, { mode: "tolerant", allowUnclosedDocumentNode: false });
  assert.match(captureContextSource, /'now' \| date: '%s'/);
  assert.match(captureContextHash, /^[a-f0-9]{64}$/);
  const value = native();
  value.cart.note = '한글 </script> & "';
  assert.deepEqual(extractNativeCaptureContext(script(value)), value);
  assert.throws(() => extractNativeCaptureContext(script(value) + script(value)), {
    code: "invalid-payload",
  });
  assert.throws(
    () =>
      extractNativeCaptureContext(
        script(value).replace('type="application/json"', 'type="text/plain"'),
      ),
    { code: "invalid-payload" },
  );
  assert.throws(
    () =>
      extractNativeCaptureContext(
        script(value).replace(/>[^<]*<\/script>/, '>"bad-base64"</script>'),
      ),
    { code: "invalid-payload" },
  );
});
test("same-response Native clock/cart context is scoped to an actual guarded HTML pair, and payload metadata never changes section summaries", async () => {
  const value = native(),
    s = setup(value),
    result = await captureOracleContextPage(input, shopId, s.dependencies);
  assert.equal(s.gets(), 2);
  assert.equal(result.capture.capturedAt, new Date(Number(value.epoch) * 1000).toISOString());
  const view = inspectVerifiedCaptureContext(result.context);
  assert.equal(view.contexts[1].epoch, String(Number(value.epoch) + 1));
  assert.equal(view.rawHashes.length, 2);
  assert.equal(result.capture.publicSummary.sections.length, 1);
  assert.throws(() => inspectVerifiedCaptureContext(JSON.parse(JSON.stringify(result.context))), {
    code: "unverified-context",
  });
  view.contexts[0].cart.dutiesIncluded = true;
  assert.equal(
    inspectVerifiedCaptureContext(result.context).contexts[0].cart.dutiesIncluded,
    false,
  );
});
test("store/marker/theme/settings/file guards and bound clock/path/domain mismatches cannot mint a context receipt", async () => {
  for (const failure of [
    "shop",
    "marker",
    "live",
    "late-live",
    "files",
    "settings",
    "unstable",
    "backwards",
    "redirect",
    "oversize",
    "snippet",
    "late-snippet",
  ]) {
    const s = setup(native(), failure);
    await assert.rejects(captureOracleContextPage(input, shopId, s.dependencies));
    if (["shop", "marker", "live", "settings"].includes(failure)) assert.equal(s.gets(), 0);
    if (["late-live", "late-snippet"].includes(failure)) assert.equal(s.gets(), 2);
  }
  for (const failure of ["payload-shop", "domain", "path", "stale"]) {
    const value = native();
    if (failure === "payload-shop") value.shopId = "2";
    if (failure === "domain") value.domain = "other.myshopify.com";
    if (failure === "path") value.path = "/products/wrong";
    if (failure === "stale") value.epoch = String(Number(value.epoch) - 600);
    const s = setup(value);
    await assert.rejects(captureOracleContextPage(input, shopId, s.dependencies), {
      code: "context-mismatch",
    });
  }
});
test("Native null flags/note and cart-line context remain explicit in calibrated input and Node/browser output", async () => {
  const snapshot = applyScenario(defaultFixture(), "with-items");
  snapshot.scenarios = {};
  snapshot.shop.currency = "USD";
  const value = native();
  value.cart.note = snapshot.cart.note;
  value.cart.items = snapshot.cart.lines.map((line, index) => {
    const product = snapshot.products.find((product) => product.handle === line.productHandle),
      variant = product?.variants.find((variant) => variant.id === line.variantId);
    assert.ok(product && variant);
    const actual = String(9007199254740993n + BigInt(index)),
      productId = String(8000000000000001n + BigInt(index));
    variant.id = actual;
    product.id = productId;
    line.variantId = actual;
    line.key = `${actual}:authored`;
    const price = Number(variant.price) * 100,
      linePrice = price * line.quantity;
    return {
      variantId: actual,
      productId,
      handle: product.handle,
      key: line.key,
      quantity: line.quantity,
      price,
      originalPrice: price,
      finalPrice: price,
      linePrice,
      originalLinePrice: linePrice,
      finalLinePrice: linePrice,
      instructions: null,
      parentRelationship: null,
      itemComponents: null,
    };
  });
  value.cart.itemCount = value.cart.items.reduce((n, line) => n + line.quantity, 0);
  value.cart.total =
    value.cart.subtotal =
    value.cart.originalTotal =
      value.cart.items.reduce((n, line) => n + line.linePrice, 0);
  const s = setup(value),
    result = await captureOracleContextPage(input, shopId, s.dependencies),
    projected = applyOracleCaptureContext(snapshot, result.context);
  assert.equal(projected.snapshot.cart.lines[0]?.instructions, null);
  assert.equal(projected.snapshot.cart.lines[0]?.itemComponents, null);
  assert.equal(projected.snapshot.cart.taxesIncluded, null);
  assert.equal(projected.captureReady, false);
  assert.equal(snapshot.cart.lines[0]?.instructions?.can_remove, true);
  const source =
      "{{shop.id}}|{{shop.permanent_domain}}|{{cart.taxes_included|json}}|{{cart.duties_included|json}}|{% for item in cart.items %}{{item.instructions|json}}/{{item.item_components|json}};{% endfor %}",
    files = {
      "layout/theme.liquid": "{{content_for_layout}}",
      "templates/cart.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      "sections/main.liquid": source,
    },
    options = { snapshot: projected.snapshot, inspect: true },
    node = await renderTheme(new MemoryThemeFileSystem(files), "/cart", options);
  assert.match(node.html, /1\|authored-demo.myshopify.com\|null\|false\|null\/null;null\/null;/);
  assert.deepEqual(node.diagnostics, []);
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(files), "/cart", options),
    node,
  );
  const changed = structuredClone(snapshot);
  assert.ok(changed.cart.lines[0]);
  changed.cart.lines[0].key = "wrong";
  assert.throws(() => applyOracleCaptureContext(changed, result.context), {
    code: "context-mismatch",
  });
});
test("instrumentation adds context only to opt-in temporary copies and the same snippet renders offline from supplied data", async () => {
  const root = await mkdtemp(join(tmpdir(), "sop-context-source-"));
  let output = "",
    plain = "";
  try {
    await mkdir(join(root, "layout"));
    await mkdir(join(root, "templates"));
    const original = "<!doctype html><html>{{content_for_layout}}</html>";
    await writeFile(join(root, "layout/theme.liquid"), original);
    await writeFile(join(root, "templates/cart.liquid"), "Cart");
    const copy = await instrumentTheme(root, { captureContext: true });
    output = copy.path;
    assert.equal(copy.contextSnippetHash, captureContextHash);
    assert.equal(
      await readFile(join(copy.path, captureContextSnippet), "utf8"),
      captureContextSource,
    );
    assert.equal(await readFile(join(root, "layout/theme.liquid"), "utf8"), original);
    assert.match(
      await readFile(join(copy.path, "layout/theme.liquid"), "utf8"),
      /render 'sop-capture-context-v1'/,
    );
    const normal = await instrumentTheme(root);
    plain = normal.path;
    assert.equal(await readFile(join(plain, "layout/theme.liquid"), "utf8"), original);
    const snapshot = defaultFixture();
    snapshot.shop.id = "1";
    snapshot.shop.permanentDomain = config.domain;
    snapshot.cart.note = null;
    snapshot.cart.taxesIncluded = null;
    const files = {
        "layout/theme.liquid": `${original}{% render '${captureContextKey}' %}`,
        "templates/cart.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
        "sections/main.liquid": "Cart",
        [captureContextSnippet]: captureContextSource,
      },
      rendered = await renderTheme(new MemoryThemeFileSystem(files), "/cart", { snapshot });
    const observed = extractNativeCaptureContext(rendered.html);
    assert.equal(observed.epoch, String(Date.parse(snapshot.meta.now) / 1000));
    assert.equal(observed.shopId, "1");
    assert.equal(observed.domain, config.domain);
    assert.equal(observed.cart.note, null);
    assert.equal(observed.cart.taxesIncluded, null);
    await mkdir(join(root, "snippets"));
    await writeFile(join(root, captureContextSnippet), "Existing user snippet");
    await assert.rejects(instrumentTheme(root, { captureContext: true }), /reserved snippet/);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (output) await rm(output, { recursive: true, force: true });
    if (plain) await rm(plain, { recursive: true, force: true });
  }
});

test("capture pins caller input before asynchronous guards and never follows later domain or preview changes", async () => {
  const request = structuredClone(input),
    s = setup(),
    identity = s.dependencies.readIdentity;
  s.dependencies.readIdentity = async () => {
    request.config.domain = "changed.invalid";
    request.previewThemeId = "9999";
    return identity();
  };
  const result = await captureOracleContextPage(request, shopId, s.dependencies);
  const record = inspectVerifiedCaptureContext(result.context);
  assert.equal(record.domain, config.domain);
  assert.equal(record.previewThemeId, "7");
  assert.equal(s.gets(), 2);
});
