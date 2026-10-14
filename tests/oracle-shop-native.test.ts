import assert from "node:assert/strict";
import { test } from "node:test";
import { toLiquidHtmlAST } from "@shopify/liquid-html-parser";
import {
  createNativeShopSettingsReader,
  extractNativeShopPayload,
  NativeShopError,
  observeNativeShopSettings,
  prepareNativeShopProbe,
} from "../tools/oracle/shop-native.js";
import { createOracleShopSettingsVerifier } from "../tools/oracle/shop-settings.js";

// Authored responses only. Native-looking fixtures are not owner-store observations or goldens.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1",
  themeId = "2",
  probe = prepareNativeShopProbe(["follow_on_shop?"]),
  identity = {
    id: shopId,
    myshopifyDomain: config.domain,
    name: "Authored shop",
    currencyCode: "USD",
    ianaTimezone: "UTC",
    plan: { partnerDevelopment: true },
    metafield: { value: "true" },
  },
  theme = {
    id: "gid://shopify/OnlineStoreTheme/2",
    role: "UNPUBLISHED",
    processing: false,
    processingFailed: false,
  },
  code = (name: string) => (error: unknown) =>
    error instanceof NativeShopError && error.code === name;
function raw() {
  return {
    shopId: "1",
    permanentDomain: config.domain,
    locale: "en",
    name: "Authored shop",
    domain: "authored.test",
    currency: "USD",
    money_format: "USD {{amount}}",
    money_with_currency_format: "USD {{amount}}",
    description: "Observed description",
    customer_accounts_enabled: true,
    customer_accounts_optional: false,
    enabled_payment_types: ["visa"],
    features: { "follow_on_shop?": false },
    policies: [
      {
        id: "10",
        title: "Authored policy",
        body: "<p>Unicode 한글 </script><script>untrusted()</script> &amp;</p>",
        url: "/policies/refund-policy",
      },
    ],
    pageTitle: "Observed homepage title",
    pageDescription: "Observed homepage description",
  };
}
function html(value = raw()) {
  return `<script id="${probe.key}" type="application/json">${JSON.stringify(Buffer.from(JSON.stringify(value)).toString("base64"))}</script>`;
}
function admin() {
  const r = raw();
  return {
    id: shopId,
    myshopifyDomain: config.domain,
    plan: { partnerDevelopment: true },
    name: r.name,
    primaryDomain: { host: r.domain },
    currencyCode: r.currency,
    ianaTimezone: "America/New_York",
    description: r.description,
    currencyFormats: {
      moneyFormat: r.money_format,
      moneyWithCurrencyFormat: r.money_with_currency_format,
    },
  };
}
function setup() {
  const events: string[] = [];
  const dependencies = {
    readIdentity: async () => {
      events.push("identity");
      return identity;
    },
    readTheme: async (id: string) => {
      events.push("theme");
      assert.equal(id, themeId);
      return theme;
    },
    readThemeFiles: async (id: string, paths: readonly string[]) => {
      events.push("files");
      assert.equal(id, themeId);
      assert.deepEqual(paths, Object.keys(probe.files).sort());
      return probe.files;
    },
    readAdminSettings: async () => {
      events.push("API");
      return admin();
    },
    fetcher: async (url: string | URL | Request, init?: RequestInit) => {
      events.push("GET");
      const target = new URL(String(url));
      assert.equal(target.hostname, config.domain);
      assert.equal(target.searchParams.get("view"), probe.key);
      assert.equal(target.searchParams.get("preview_theme_id"), themeId);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "manual");
      assert.deepEqual(init?.headers, {
        Cookie: "authored-cookie",
        Accept: "text/html",
        "Accept-Language": "en",
      });
      return new Response(html(), { headers: { "content-type": "text/html" } });
    },
  };
  return { events, dependencies };
}
test("probe contains observed Liquid expressions and feature names only; routing/files/hash are deterministic", () => {
  const second = prepareNativeShopProbe(["follow_on_shop?"]);
  assert.deepEqual(second, probe);
  assert.equal(Object.keys(probe.files).length, 3);
  const text = Object.values(probe.files).join("");
  assert.ok(text.includes("request.locale.iso_code"));
  assert.ok(text.includes("shop.enabled_payment_types"));
  assert.ok(text.includes("shop.customer_accounts_optional"));
  assert.ok(text.includes("base64_encode"));
  assert.ok(text.includes("shop.features['follow_on_shop?']"));
  const section = probe.files[`sections/${probe.key}.liquid`];
  assert.equal(typeof section, "string");
  if (typeof section !== "string") throw new Error();
  assert.doesNotThrow(() => toLiquidHtmlAST(section));
  assert.ok(!text.includes(raw().name));
  assert.ok(!text.includes(raw().pageTitle));
  assert.throws(() => prepareNativeShopProbe(["unsafe' | json"]), code("invalid-input"));
  assert.throws(() => prepareNativeShopProbe(["duplicate", "duplicate"]), code("invalid-input"));
});
test("Base64 payload preserves Unicode, policy HTML, entities and closing script text without executing markup", () => {
  assert.deepEqual(extractNativeShopPayload(html(), probe), raw());
  assert.ok(!html().includes("untrusted()"));
  for (const invalid of [
    "<p>no payload</p>",
    html() + html(),
    html().replace('type="application/json"', 'type="text/javascript"'),
    `<script id="${probe.key}" type="application/json">"not base64"</script>`,
  ])
    assert.throws(() => extractNativeShopPayload(invalid, probe), code("payload-invalid"));
  const changed = raw();
  Reflect.deleteProperty(changed.features, "follow_on_shop?");
  assert.throws(() => extractNativeShopPayload(html(changed), probe), code("payload-invalid"));
});
test("unpublished theme and exact uploaded files bracket the GET pair; Native fields and API timezone remain separate", async () => {
  const s = setup(),
    result = await observeNativeShopSettings(
      config,
      shopId,
      themeId,
      "authored-cookie",
      "en",
      probe,
      s.dependencies,
    );
  assert.deepEqual(s.events, [
    "identity",
    "theme",
    "files",
    "API",
    "GET",
    "GET",
    "files",
    "identity",
    "theme",
    "API",
  ]);
  assert.equal(result.shop.name, raw().name);
  assert.equal(result.shop.timezone, admin().ianaTimezone);
  assert.equal(result.shop.locale, raw().locale);
  assert.equal(result.shop.seo?.title, raw().pageTitle);
  assert.equal(result.shop.seo?.description, raw().pageDescription);
  assert.deepEqual(result.shop.features, raw().features);
});
test("missing marker, wrong shop or live/unprocessed theme refuses all storefront requests", async () => {
  for (const failure of ["marker", "store", "role", "processing"]) {
    const s = setup();
    await assert.rejects(
      observeNativeShopSettings(config, shopId, themeId, "authored-cookie", "en", probe, {
        ...s.dependencies,
        readIdentity: async () =>
          failure === "marker"
            ? { ...identity, metafield: null }
            : failure === "store"
              ? { ...identity, id: "gid://shopify/Shop/2" }
              : identity,
        readTheme: async () => ({
          ...theme,
          ...(failure === "role"
            ? { role: "MAIN" }
            : failure === "processing"
              ? { processing: true }
              : {}),
        }),
      }),
      code("guard-denied"),
    );
    assert.ok(!s.events.includes("GET"));
  }
});
test("modified prepared or uploaded harness files cannot emit a settings observation", async () => {
  const s = setup(),
    changed = { ...probe, files: { ...probe.files, "layout/extra.liquid": "changed" } };
  await assert.rejects(
    observeNativeShopSettings(
      config,
      shopId,
      themeId,
      "authored-cookie",
      "en",
      changed,
      s.dependencies,
    ),
    code("files-mismatch"),
  );
  assert.equal(s.events.length, 0);
  await assert.rejects(
    observeNativeShopSettings(config, shopId, themeId, "authored-cookie", "en", probe, {
      ...s.dependencies,
      readThemeFiles: async () => ({ ...probe.files, [`sections/${probe.key}.liquid`]: "changed" }),
    }),
    code("files-mismatch"),
  );
  assert.ok(!s.events.includes("GET"));
});
test("changed Native/API values, wrong locale and redirected password gates do not create verified observations", async () => {
  for (const failure of ["native", "api", "locale", "redirect", "error"]) {
    const s = setup();
    let gets = 0,
      apis = 0;
    await assert.rejects(
      observeNativeShopSettings(config, shopId, themeId, "authored-cookie", "en", probe, {
        ...s.dependencies,
        readAdminSettings: async () => {
          const value = admin();
          if (failure === "api" && ++apis === 2) value.name = "changed";
          return value;
        },
        fetcher: async () => {
          gets++;
          if (failure === "redirect") return new Response(null, { status: 302 });
          if (failure === "error") throw new Error("private cookie detail");
          const value = raw();
          if (failure === "native" && gets === 2) value.enabled_payment_types = ["master"];
          if (failure === "locale") value.locale = "fr";
          return new Response(html(value), { headers: { "content-type": "text/html" } });
        },
      }),
      (e) =>
        code(
          failure === "native" || failure === "api"
            ? "unstable-observation"
            : failure === "locale"
              ? "scope-mismatch"
              : "read-failed",
        )(e) && !String(e).includes("private"),
    );
  }
});
test("bound reader rejects another scope and supplies real transport observations to the mandatory verifier", async () => {
  const s = setup(),
    reader = createNativeShopSettingsReader(
      config,
      shopId,
      themeId,
      "authored-cookie",
      probe,
      s.dependencies,
    ),
    context = { ...config, shopId, locale: "en" };
  await assert.rejects(
    reader({ ...context, shopId: "gid://shopify/Shop/2" }),
    code("scope-mismatch"),
  );
  assert.equal(s.events.length, 0);
  const observed = await reader(context),
    verify = createOracleShopSettingsVerifier(config, observed.shop, shopId, "authored-token", {
      fetcher: async () =>
        Response.json(
          { data: { shop: admin() } },
          { headers: { "x-shopify-api-version": "2026-10" } },
        ),
      readNativeSettings: reader,
    });
  const proof = await verify();
  assert.equal(proof.kind, "verified-oracle-shop-settings");
  // This is authored HTTP test data; no live Native receipt or golden registration occurs.
});
