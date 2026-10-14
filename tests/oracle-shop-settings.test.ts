import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { captureOracleHtmlPair } from "../tools/oracle/capture.js";
import {
  compareOracleShopSettings,
  createOracleShopSettingsVerifier,
  inspectVerifiedOracleShopSettings,
  readOracleShopSettings,
  ShopSettingsError,
} from "../tools/oracle/shop-settings.js";

// Authored API and Native observations; no real storefront settings proof is manufactured.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1",
  expected = defaultFixture().shop,
  code = (value: string) => (error: unknown) =>
    error instanceof ShopSettingsError && error.code === value;
function admin() {
  return {
    id: shopId,
    myshopifyDomain: config.domain,
    plan: { partnerDevelopment: true },
    name: expected.name,
    primaryDomain: { host: expected.domain },
    currencyCode: expected.currency,
    ianaTimezone: expected.timezone,
    description: expected.description ?? null,
    currencyFormats: {
      moneyFormat: expected.money_format,
      moneyWithCurrencyFormat: expected.money_with_currency_format,
    },
  };
}
function response(shop = admin(), version = "2026-10") {
  return Response.json({ data: { shop } }, { headers: { "x-shopify-api-version": version } });
}
const native = () => ({
  domain: config.domain,
  shopId,
  apiVersion: config.apiVersion,
  locale: expected.locale,
  shop: structuredClone(expected),
});

test("shop API reads pin store/version and retain exact currency-format bytes without rewriting inputs", async () => {
  const before = structuredClone(expected);
  const actual = await readOracleShopSettings(config, "authored", shopId, async (url, init) => {
    assert.equal(String(url), `https://${config.domain}/admin/api/2026-10/graphql.json`);
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    assert.ok(body.query.startsWith("query "));
    assert.ok(!body.query.includes("mutation"));
    assert.ok(body.query.includes("moneyWithCurrencyFormat"));
    return response();
  });
  const comparison = compareOracleShopSettings(expected, actual);
  assert.deepEqual(comparison.mismatchedFields, []);
  assert.ok(comparison.nativeFields.includes("locale"));
  assert.ok(comparison.nativeFields.includes("enabled_payment_types"));
  assert.ok(comparison.nativeFields.includes("features"));
  assert.equal(actual.currencyFormats.moneyFormat, expected.money_format);
  assert.deepEqual(expected, before);
});
test("known mismatches fail before Native work; a missing Native adapter never means verified settings", async () => {
  for (const change of ["name", "domain", "currency", "timezone", "format"]) {
    let natives = 0;
    const verify = createOracleShopSettingsVerifier(config, expected, shopId, "authored", {
      fetcher: async () => {
        const shop = admin();
        if (change === "name") shop.name = "private store name";
        if (change === "domain") shop.primaryDomain.host = "other.test";
        if (change === "currency") shop.currencyCode = "CAD";
        if (change === "timezone") shop.ianaTimezone = "Asia/Seoul";
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Shopify money-format syntax is intentionally literal.
        if (change === "format") shop.currencyFormats.moneyFormat = "${{amount}}";
        return response(shop);
      },
      readNativeSettings: async () => {
        natives++;
        return native();
      },
    });
    await assert.rejects(
      verify(),
      (e) => code("settings-mismatch")(e) && !String(e).includes("private"),
    );
    assert.equal(natives, 0);
  }
  await assert.rejects(
    createOracleShopSettingsVerifier(config, expected, shopId, "authored", {
      fetcher: async () => response(),
    })(),
    code("native-observation-required"),
  );
});
test("Native context verifies locale, accounts, payment types, feature flags, SEO and ordered policies", async () => {
  for (const failure of [
    "locale",
    "accounts",
    "payments",
    "features",
    "seo",
    "policies",
    "domain",
    "missing",
  ]) {
    const verify = createOracleShopSettingsVerifier(config, expected, shopId, "authored", {
      fetcher: async () => response(),
      readNativeSettings: async (context) => {
        assert.equal(context.locale, expected.locale);
        assert.equal(context.shopId, shopId);
        const observed = native();
        if (failure === "locale") observed.locale = "fr";
        if (failure === "accounts") observed.shop.customer_accounts_enabled = true;
        if (failure === "payments") observed.shop.enabled_payment_types = ["visa"];
        if (failure === "features") observed.shop.features = { "follow_on_shop?": true };
        if (failure === "seo")
          observed.shop.seo = { title: "changed", description: expected.description };
        if (failure === "policies")
          observed.shop.policies = [
            { title: "Refund", body: "Authored policy", url: "/policies/refund-policy" },
          ];
        if (failure === "domain") observed.domain = "other.myshopify.com";
        if (failure === "missing") delete observed.shop.features;
        return observed;
      },
    });
    await assert.rejects(
      verify(),
      code(failure === "domain" ? "store-mismatch" : "settings-mismatch"),
    );
  }
});
test("API/Native/API sequence mints an in-memory proof, preserves inputs and refuses changed settings", async () => {
  const events: string[] = [],
    input = structuredClone(expected),
    verify = createOracleShopSettingsVerifier(config, input, shopId, "authored", {
      fetcher: async () => {
        events.push("API");
        return response();
      },
      readNativeSettings: async () => {
        events.push("Native");
        return native();
      },
    });
  const proof = await verify();
  assert.deepEqual(events, ["API", "Native", "API"]);
  const view = inspectVerifiedOracleShopSettings(proof);
  assert.deepEqual(view.shop, input);
  view.shop.name = "tampered";
  assert.equal(inspectVerifiedOracleShopSettings(proof).shop.name, input.name);
  assert.throws(
    () => inspectVerifiedOracleShopSettings(JSON.parse(JSON.stringify(proof))),
    code("native-observation-required"),
  );
  assert.deepEqual(input, expected);
  let reads = 0;
  await assert.rejects(
    createOracleShopSettingsVerifier(config, expected, shopId, "authored", {
      fetcher: async () => {
        const shop = admin();
        if (++reads === 2) shop.description = "changed";
        return response(shop);
      },
      readNativeSettings: async () => native(),
    })(),
    code("settings-changed"),
  );
});
test("dictionary order is immaterial but policy order and context values remain exact", async () => {
  const wanted = structuredClone(expected);
  wanted.features = { first: false, second: true };
  wanted.policies = [
    { title: "Refund", body: "Authored refund", url: "/policies/refund-policy" },
    { title: "Privacy", body: "Authored privacy", url: "/policies/privacy-policy" },
  ];
  const observed = { ...native(), shop: structuredClone(wanted) };
  observed.shop.features = { second: true, first: false };
  const verify = createOracleShopSettingsVerifier(config, wanted, shopId, "authored", {
    fetcher: async () => response(),
    readNativeSettings: async () => observed,
  });
  await verify();
  observed.shop.policies?.reverse();
  await assert.rejects(verify(), code("settings-mismatch"));
});
test("wrong scope/version/errors and failed Native callbacks do not leak private data", async () => {
  for (const failure of ["store", "version", "errors"]) {
    await assert.rejects(
      readOracleShopSettings(config, "authored", shopId, async () => {
        const shop = admin();
        if (failure === "store") shop.id = "gid://shopify/Shop/2";
        return failure === "errors"
          ? Response.json(
              { data: { shop }, errors: [{ message: "private settings body" }] },
              { headers: { "x-shopify-api-version": "2026-10" } },
            )
          : response(shop, failure === "version" ? "2026-07" : "2026-10");
      }),
      (e) =>
        code(failure === "store" ? "store-mismatch" : "read-failed")(e) &&
        !String(e).includes("private"),
    );
  }
  await assert.rejects(
    createOracleShopSettingsVerifier(config, expected, shopId, "authored", {
      fetcher: async () => response(),
      readNativeSettings: async () => {
        throw new Error("private callback detail");
      },
    })(),
    code("native-observation-failed"),
  );
});
test("concurrent verification cannot reuse an in-flight settings observation", async () => {
  const verify = createOracleShopSettingsVerifier(config, expected, shopId, "authored", {
      fetcher: async () => response(),
      readNativeSettings: async () => native(),
    }),
    results = await Promise.allSettled([verify(), verify()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected");
  assert.ok(failed?.status === "rejected");
  assert.ok(code("concurrent-verification")(failed.reason));
});
test("HTML capture requires shop verification before GET and refuses post-capture settings drift", async () => {
  const input = { config, path: "/", previewThemeId: "2", cookie: "authored-cookie" },
    identity = {
      id: shopId,
      myshopifyDomain: config.domain,
      name: "Authored",
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
    };
  let gets = 0,
    checks = 0;
  const dependencies = {
    readIdentity: async () => identity,
    readTheme: async () => theme,
    verifyShopSettings: async () => {
      checks++;
    },
    fetcher: async () => {
      gets++;
      return new Response("Authored HTML", { headers: { "content-type": "text/html" } });
    },
  };
  const missing = { ...dependencies };
  Reflect.deleteProperty(missing, "verifyShopSettings");
  await assert.rejects(
    captureOracleHtmlPair(input, missing),
    /shop settings verification required/,
  );
  assert.equal(gets, 0);
  await assert.rejects(
    captureOracleHtmlPair(input, {
      ...dependencies,
      verifyShopSettings: async () => {
        throw new Error("Settings mismatch");
      },
    }),
  );
  assert.equal(gets, 0);
  await assert.rejects(
    captureOracleHtmlPair(input, {
      ...dependencies,
      verifyShopSettings: async () => {
        if (++checks === 2) throw new Error("Settings changed");
      },
    }),
  );
  assert.equal(gets, 2);
  gets = 0;
  checks = 0;
  await captureOracleHtmlPair(input, dependencies);
  assert.equal(gets, 2);
  assert.equal(checks, 2);
});
