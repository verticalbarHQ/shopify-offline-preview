import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import {
  applyScenario,
  mergePatch,
  validateSnapshotReferences,
} from "../packages/data/src/scenarios.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { readOracleIdentity, readOracleTheme } from "../tools/oracle/admin-read.js";
import { assertGoldenFreshness, makeGoldenArtifact } from "../tools/oracle/artifacts.js";
import { captureOraclePage } from "../tools/oracle/capture.js";
import { instrumentLiquid } from "../tools/oracle/instrument.js";
import { sectionTypeMap } from "../tools/oracle/section-types.js";
import { assertOracleStore, type OracleIdentity } from "../tools/oracle/store-guard.js";
import { assertStableCapture, compareSummaries, summarizeHtml } from "../tools/oracle/summary.js";
import { theme } from "./fixtures.js";

test("synthetic fixture covers all 18 matrix cases and scenarios without dangling references", async () => {
  const fixture = defaultFixture();
  assert.deepEqual(fixture, JSON.parse(await readFile("fixtures/default/snapshot.json", "utf8")));
  assert.equal(benchmarkMatrix.length, 18);
  assert.equal(new Set(benchmarkMatrix.map((item) => item.id)).size, 18);
  for (const item of benchmarkMatrix)
    validateSnapshotReferences(applyScenario(fixture, item.scenario));
  const first = fixture.products[0];
  assert.ok(first);
  assert.equal(first.options.length, 3);
  assert.equal(first.variants.length, 8);
  assert.ok(fixture.products.length > 24);
  assert.equal(
    applyScenario(fixture, "sold-out").products[0]?.variants.some((v) => v.available),
    false,
  );
  assert.equal(applyScenario(fixture, "single-variant").products[0]?.variants.length, 1);
  assert.equal(applyScenario(fixture, "no-images").products[0]?.images.length, 0);
  assert.ok((applyScenario(fixture, "long-content").products[0]?.images.length ?? 0) > 10);
  assert.equal(applyScenario(fixture, "with-items").cart.lines.length, 2);
  assert.equal(applyScenario(fixture, "empty").collections[0]?.products.length, 0);
});

test("merge patch preserves inputs, replaces arrays, removes null keys, and cannot pollute prototypes", () => {
  const input = { a: { x: 1, y: 2 }, list: [1, 2] };
  assert.deepEqual(mergePatch(input, { a: { x: null }, list: [3] }), { a: { y: 2 }, list: [3] });
  assert.deepEqual(input, { a: { x: 1, y: 2 }, list: [1, 2] });
  const output = mergePatch({}, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  assert.throws(() => applyScenario(defaultFixture(), "missing"));
});

test("source integrity rejects duplicate ids, invalid variant options, and dangling cart/collection refs", () => {
  for (const breakFixture of [
    (f: ReturnType<typeof defaultFixture>) => {
      const product = f.products[0];
      assert.ok(product);
      f.products.push(structuredClone(product));
    },
    (f: ReturnType<typeof defaultFixture>) => {
      f.cart.lines.push({ productHandle: "missing", variantId: "missing", quantity: 1 });
    },
    (f: ReturnType<typeof defaultFixture>) => {
      f.collections[0]?.products.push("missing");
    },
    (f: ReturnType<typeof defaultFixture>) => {
      const v = f.products[0]?.variants[0];
      if (v) v.optionValues = [];
    },
  ]) {
    const fixture = defaultFixture();
    breakFixture(fixture);
    assert.throws(() => validateSnapshotReferences(fixture));
  }
});

test("oracle store guard refuses wrong domain, production stores, and missing/false markers", () => {
  const config = { domain: "example-test.myshopify.com", apiVersion: "2026-10" as const };
  const store: OracleIdentity = {
    id: "gid://shopify/Shop/123",
    myshopifyDomain: config.domain,
    name: "Example",
    currencyCode: "USD",
    ianaTimezone: "UTC",
    plan: { partnerDevelopment: true },
    metafield: { value: "true" },
  };
  assert.doesNotThrow(() => assertOracleStore(config, store));
  for (const changed of [
    { ...store, myshopifyDomain: "different.myshopify.com" },
    { ...store, plan: { partnerDevelopment: false } },
    { ...store, metafield: null },
    { ...store, metafield: { value: "false" } },
  ])
    assert.throws(() => assertOracleStore(config, changed));
});

test("instrumentation changes real attributes, ignores quoted strings/comments, and wraps theme blocks", () => {
  const source =
    '<div {{- block.shopify_attributes -}}>{{ "block.shopify_attributes" }}</div>{% comment %}{{ block.shopify_attributes }}{% endcomment %}';
  const classic = instrumentLiquid(source, "sections/example.liquid");
  assert.equal(classic.classicMarkers, 1);
  assert.equal(classic.themeBlockMarkers, 0);
  assert.ok(classic.source.includes('data-sop-block-id="{{ block.id }}"'));
  assert.ok(classic.source.includes('{{ "block.shopify_attributes" }}'));
  const block = instrumentLiquid(source, "blocks/example.liquid");
  assert.equal(block.themeBlockMarkers, 1);
  assert.ok(block.source.startsWith("<!--sop:block {{ block.id }} {{ block.type }}-->"));
});

const sectionTypes = { "template--N__main": "main-product" };
function html(text: string, numericId: number = 123): string {
  return `<div id="shopify-section-template--${numericId}__main"><!--sop:block b1 text--><span data-sop-block-id="b1" data-sop-block-type="text">${text}</span><!--sop:block b2 button--><button>Buy</button><!--/sop:block--><!--/sop:block--><script>secret script</script><style>secret style</style><noscript>ignored</noscript><template>ignored</template></div>`;
}
test("public summaries contain hashes only, normalize ids/text, and retain block nesting", () => {
  const first = summarizeHtml(html("Cafe\u0301   &amp; tea"), { sectionTypes });
  const second = summarizeHtml(html("Café &amp; tea", 456), { sectionTypes });
  assert.equal(first.sectionText["template--N__main"], "Café & teaBuy");
  assert.ok(!JSON.stringify(first.summary).includes("Café"));
  assert.equal(first.summary.markedBlockCount, 2);
  assert.equal(first.summary.tree[0]?.children[0]?.children[0]?.type, "button");
  assert.equal(compareSummaries(first.summary, second.summary).equal, true);
  assertStableCapture(first.summary, second.summary);
  assert.throws(
    () =>
      assertStableCapture(first.summary, summarizeHtml(html("Changed"), { sectionTypes }).summary),
    /Unstable/,
  );
});

test("capture summaries reject absent type maps, empty pages, and broken/duplicate markers", () => {
  assert.throws(() => summarizeHtml(html("Text"), { sectionTypes: {} }), /Missing source type/);
  assert.throws(() => summarizeHtml("<p>empty</p>", { sectionTypes }), /No Shopify/);
  assert.throws(
    () => summarizeHtml(html("Text").replace("<!--/sop:block-->", ""), { sectionTypes }),
    /Unclosed/,
  );
  assert.throws(
    () =>
      summarizeHtml(
        html("Text")
          .replace("<!--sop:block b2 button-->", "<!--/sop:block--><!--sop:block b1 button-->")
          .replace("</button><!--/sop:block--><!--/sop:block-->", "</button><!--/sop:block-->"),
        { sectionTypes },
      ),
    /Duplicate/,
  );
});

const testConfig = { domain: "example-test.myshopify.com", apiVersion: "2026-10" as const };
const testIdentity: OracleIdentity = {
  id: "gid://shopify/Shop/123",
  myshopifyDomain: testConfig.domain,
  name: "Example",
  currencyCode: "USD",
  ianaTimezone: "UTC",
  plan: { partnerDevelopment: true },
  metafield: { value: "true" },
};
test("read-only Admin inspection sends only the fixed query and withholds API error details", async () => {
  const success: typeof fetch = async (url, init) => {
    assert.equal(String(url), `https://${testConfig.domain}/admin/api/2026-10/graphql.json`);
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    assert.ok(body.query.startsWith("query "));
    assert.ok(!body.query.includes("mutation"));
    return new Response(JSON.stringify({ data: { shop: testIdentity } }), {
      headers: { "content-type": "application/json" },
    });
  };
  assert.deepEqual(
    await readOracleIdentity(testConfig, "synthetic-test-placeholder", success),
    testIdentity,
  );
  await assert.rejects(readOracleIdentity(testConfig, "", success), /Existing Admin/);
  const failure: typeof fetch = async () =>
    new Response(
      JSON.stringify({ errors: [{ message: "private API response must not appear in errors" }] }),
    );
  await assert.rejects(
    readOracleIdentity(testConfig, "synthetic-test-placeholder", failure),
    (error: unknown) => error instanceof Error && !error.message.includes("private API response"),
  );
});

test("capture guards run before GETs, require preview ids, and publish only stable hashes", async () => {
  const readTheme = async () => ({
    id: "gid://shopify/OnlineStoreTheme/456",
    role: "UNPUBLISHED",
    processing: false,
    processingFailed: false,
  });
  let requests = 0;
  const fetcher: typeof fetch = async (url, init) => {
    requests++;
    assert.equal(new URL(String(url)).searchParams.get("preview_theme_id"), "456");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    return new Response(html("Example"), { headers: { "content-type": "text/html" } });
  };
  const input = {
    config: testConfig,
    path: "/products/sample",
    previewThemeId: "456",
    cookie: "synthetic-test-session=value",
    summaryOptions: { sectionTypes },
  };
  await assert.rejects(
    captureOraclePage(input, {
      readTheme,
      verifyShopSettings: async () => {},
      readIdentity: async () => ({ ...testIdentity, plan: { partnerDevelopment: false } }),
      fetcher,
    }),
    /development store/,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    captureOraclePage(
      { ...input, previewThemeId: "" },
      {
        readTheme,
        readIdentity: async () => testIdentity,
        verifyShopSettings: async () => {},
        fetcher,
      },
    ),
    /preview theme id/,
  );
  assert.equal(requests, 0);
  for (const override of [
    { role: "MAIN" },
    { processing: true },
    { processingFailed: true },
    { id: "gid://shopify/OnlineStoreTheme/999" },
  ]) {
    await assert.rejects(
      captureOraclePage(input, {
        readIdentity: async () => testIdentity,
        verifyShopSettings: async () => {},
        readTheme: async () => ({ ...(await readTheme()), ...override }),
        fetcher,
      }),
      /unpublished/,
    );
    assert.equal(requests, 0);
  }
  const captured = await captureOraclePage(input, {
    readTheme,
    verifyShopSettings: async () => {},
    readIdentity: async () => testIdentity,
    fetcher,
  });
  assert.equal(requests, 2);
  assert.equal(captured.privateRawHtml.length, 2);
  assert.ok(!JSON.stringify(captured.publicSummary).includes("Example"));
  let index = 0;
  const unstable: typeof fetch = async () =>
    new Response(html(`Different ${index++}`), { headers: { "content-type": "text/html" } });
  await assert.rejects(
    captureOraclePage(input, {
      readTheme,
      verifyShopSettings: async () => {},
      readIdentity: async () => testIdentity,
      fetcher: unstable,
    }),
    /Unstable/,
  );
  const redirect: typeof fetch = async () =>
    new Response(null, { status: 302, headers: { location: "https://example.test" } });
  await assert.rejects(
    captureOraclePage(input, {
      readTheme,
      verifyShopSettings: async () => {},
      readIdentity: async () => testIdentity,
      fetcher: redirect,
    }),
    /HTTP 302/,
  );
  await assert.rejects(
    captureOraclePage(
      { ...input, path: "//example.test" },
      {
        readTheme,
        readIdentity: async () => testIdentity,
        verifyShopSettings: async () => {},
        fetcher,
      },
    ),
    /relative/,
  );
});

test("theme metadata inspection binds the numeric preview id to its GraphQL gid", async () => {
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.variables.id, "gid://shopify/OnlineStoreTheme/456");
    assert.ok(request.query.startsWith("query "));
    return new Response(
      JSON.stringify({
        data: {
          theme: {
            id: request.variables.id,
            role: "UNPUBLISHED",
            processing: false,
            processingFailed: false,
          },
        },
      }),
    );
  };
  assert.equal(
    (await readOracleTheme(testConfig, "synthetic-test-placeholder", "456", fetcher)).role,
    "UNPUBLISHED",
  );
  await assert.rejects(
    readOracleTheme(testConfig, "synthetic-test-placeholder", "abc", fetcher),
    /Invalid/,
  );
  const missing: typeof fetch = async () => new Response(JSON.stringify({ data: { theme: null } }));
  await assert.rejects(
    readOracleTheme(testConfig, "synthetic-test-placeholder", "456", missing),
    /unavailable/,
  );
});

test("source mapping uses active template/group configuration and refuses ambiguous or unknown templates", async () => {
  const mapping = await sectionTypeMap(
    new MemoryThemeFileSystem(theme()),
    "templates/product.json",
  );
  assert.equal(mapping["template--N__main"], "product");
  assert.equal(mapping["sections--N__header"], "header");
  assert.ok(!Object.hasOwn(mapping, "template--N__disabled"));
  await assert.rejects(
    sectionTypeMap(new MemoryThemeFileSystem(theme()), "templates/missing.json"),
    /Unsupported/,
  );
});

test("release freshness rejects future and stale captures and golden artifacts cannot contain raw fields", () => {
  const a = summarizeHtml(html("Example"), { sectionTypes });
  const capture = {
    publicSummary: a.summary,
    capturedAt: "2026-10-13T00:00:00.000Z",
    privateRawHtml: [html("Example"), html("Example")] as const,
    privateSectionText: a.sectionText,
  };
  const golden = makeGoldenArtifact(capture, {
    theme: "dawn",
    themeCommit: "a".repeat(40),
    caseId: "test-synthetic",
    path: "/",
    scenario: "default",
    fixtureHash: "b".repeat(64),
  });
  assert.ok(!JSON.stringify(golden).includes("privateRawHtml"));
  assert.doesNotThrow(() => assertGoldenFreshness(golden, new Date("2026-10-20T00:00:00Z")));
  assert.throws(() => assertGoldenFreshness(golden, new Date("2026-10-20T00:00:01Z")), /freshness/);
  assert.throws(() => assertGoldenFreshness(golden, new Date("2026-10-12T23:59:59Z")), /freshness/);
});

test("capture tree preserves repeated static executions and identifiers scoped to immediate parents", () => {
  const html = `<div id="shopify-section-template--123__main"><!--sop:block card card--><!--sop:block label text--><p>A</p><!--/sop:block--><!--/sop:block--><!--sop:block card card--><!--sop:block label text--><p>B</p><!--/sop:block--><!--/sop:block--></div>`;
  const result = summarizeHtml(html, { sectionTypes: { "template--N__main": "main" } }).summary;
  assert.equal(result.markedBlockCount, 4);
  assert.deepEqual(
    result.tree[0]?.children.map((node) => node.type),
    ["card", "card"],
  );
  assert.equal(result.tree[0]?.children[1]?.children[0]?.type, "text");
  assert.throws(
    () =>
      summarizeHtml(
        html.replace(
          "sop:block card card--><!--sop:block label text--><p>B",
          "sop:block card different--><!--sop:block label text--><p>B",
        ),
        { sectionTypes: { "template--N__main": "main" } },
      ),
    /Duplicate/,
  );
});

test("classic sibling markers retain all visible text under one logical block", () => {
  const result = summarizeHtml(
    '<div id="shopify-section-template--1__main"><p data-sop-block-id="same" data-sop-block-type="text">One</p><p data-sop-block-id="same" data-sop-block-type="text">Two</p></div>',
    { sectionTypes },
  );
  assert.equal(result.summary.markedBlockCount, 1);
  assert.equal(result.summary.tree[0]?.children.length, 1);
  assert.equal(result.sectionText["template--N__main"], "OneTwo");
});

test("classic multi-root markers describe one logical block and conflicting types still fail", () => {
  const source = `<div id="shopify-section-template--123__main"><p data-sop-block-id="price" data-sop-block-type="price">Price <span data-sop-block-id="price" data-sop-block-type="price">12.50</span></p><p data-sop-block-id="price" data-sop-block-type="price">Tax included</p><button data-sop-block-id="buy" data-sop-block-type="button">Buy</button></div>`;
  const result = summarizeHtml(source, { sectionTypes });
  assert.equal(result.summary.markedBlockCount, 2);
  assert.deepEqual(result.summary.tree[0]?.children, [
    { kind: "block", type: "price", children: [] },
    { kind: "block", type: "button", children: [] },
  ]);
  assert.equal(result.sectionText["template--N__main"], "Price 12.50Tax includedBuy");
  assert.throws(
    () =>
      summarizeHtml(source.replace('type="price">Tax', 'type="different">Tax'), { sectionTypes }),
    /Duplicate/,
  );
  const repeated = summarizeHtml(
    `<div id="shopify-section-template--123__main"><!--sop:block label text--><p>A</p><!--/sop:block--><!--sop:block label text--><p>B</p><!--/sop:block--></div>`,
    { sectionTypes },
  );
  assert.equal(repeated.summary.markedBlockCount, 2);
});

test("instrumentation outside a block preserves absent attributes instead of emitting empty markers", async () => {
  const source = instrumentLiquid(
    "<span {{block.shopify_attributes}}>Outside a block</span>",
    "sections/main.liquid",
  ).source;
  const fs = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  });
  const result = await renderTheme(fs, "/");
  assert.deepEqual(result.diagnostics, []);
  assert.ok(!result.html.includes("data-sop-block-id"));
  const summary = summarizeHtml(result.html, { sectionTypes: { "template--N__main": "main" } });
  assert.equal(summary.summary.markedBlockCount, 0);
  assert.equal(summary.sectionText["template--N__main"], "Outside a block");
});

test("source mapping binds snippet-owned literal wrappers only to exact real section files", async () => {
  const fs = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}{% render 'drawer' %}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": "Main",
    "sections/drawer-api.liquid": "Drawer API section",
    "snippets/drawer.liquid":
      '<div id="shopify-section-drawer-api" class="shopify-section">Drawer</div><div id="shopify-section-unknown">Unknown</div>',
  });
  const mapping = await sectionTypeMap(fs, "templates/index.json");
  assert.equal(mapping["drawer-api"], "drawer-api");
  assert.ok(!("unknown" in mapping));
  assert.ok(!("drawer" in mapping));
});
