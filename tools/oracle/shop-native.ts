import { createHash } from "node:crypto";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { z } from "zod";
import { completeSnapshotSchema as snapshotSchema } from "../../packages/data/src/schema.js";
import { type OracleTheme, oracleThemeSchema } from "./admin-read.js";
import { type CorpusFiles, corpusFilesFingerprint } from "./corpus-environment.js";
import type { NativeShopSettingsContext, OracleAdminShopSettings } from "./shop-settings.js";
import {
  assertOracleStore,
  type OracleConfig,
  type OracleIdentity,
  oracleConfigSchema,
  oracleIdentitySchema,
} from "./store-guard.js";

export class NativeShopError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "guard-denied"
      | "files-mismatch"
      | "read-failed"
      | "payload-invalid"
      | "scope-mismatch"
      | "unstable-observation",
  ) {
    super(`Native shop observation failed: ${code}`);
    this.name = "NativeShopError";
  }
}
export function prepareNativeShopProbe(featureKeys: readonly string[]) {
  if (
    featureKeys.length > 16 ||
    new Set(featureKeys).size !== featureKeys.length ||
    featureKeys.some((k) => !/^[a-z][a-z0-9_]{0,63}\??$/.test(k))
  )
    throw new NativeShopError("invalid-input");
  const features = [...featureKeys].sort(),
    key = `sop-shop-${createHash("sha256").update(JSON.stringify(features)).digest("hex").slice(0, 16)}`,
    properties = [
      "name",
      "domain",
      "currency",
      "money_format",
      "money_with_currency_format",
      "description",
      "customer_accounts_enabled",
      "customer_accounts_optional",
      "enabled_payment_types",
    ],
    liquid = `{% capture sop_shop_observation %}{
      "shopId":{{shop.id | append: '' | json}},"permanentDomain":{{shop.permanent_domain | json}},"locale":{{request.locale.iso_code | json}},
      ${properties.map((p) => `${JSON.stringify(p)}:{{shop.${p} | json}}`).join(",")},
      "features":{${features.map((p) => `${JSON.stringify(p)}:{{shop.features['${p}'] | json}}`).join(",")}},
      "policies":[{% for policy in shop.policies %}{"id":{{policy.id | append: '' | json}},"title":{{policy.title | json}},"body":{{policy.body | json}},"url":{{policy.url | json}}}{% unless forloop.last %},{% endunless %}{% endfor %}],
      "pageTitle":{{page_title | json}},"pageDescription":{{page_description | json}}
    }{% endcapture %}<script id="${key}" type="application/json">{{sop_shop_observation | base64_encode | json}}</script>`;
  const files: CorpusFiles = {
    [`layout/${key}.liquid`]:
      "<!doctype html><html><head></head><body>{{content_for_layout}}</body></html>",
    [`sections/${key}.liquid`]: liquid,
    [`templates/index.${key}.json`]: JSON.stringify({
      layout: key,
      sections: { main: { type: key } },
      order: ["main"],
    }),
  };
  return {
    featureKeys: features,
    key,
    requestPath: `/?view=${key}`,
    files,
    harnessHash: corpusFilesFingerprint(files),
  };
}
export type PreparedNativeShopProbe = ReturnType<typeof prepareNativeShopProbe>;
function validateProbe(probe: PreparedNativeShopProbe) {
  const expected = prepareNativeShopProbe(probe.featureKeys);
  if (
    expected.key !== probe.key ||
    expected.requestPath !== probe.requestPath ||
    expected.harnessHash !== probe.harnessHash ||
    corpusFilesFingerprint(probe.files) !== expected.harnessHash
  )
    throw new NativeShopError("files-mismatch");
  return expected;
}
const rawSettings = z.strictObject({
  shopId: z.string().regex(/^[1-9]\d*$/),
  permanentDomain: z.string(),
  locale: z.string(),
  name: z.string(),
  domain: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  money_format: z.string(),
  money_with_currency_format: z.string(),
  description: z.string().nullable(),
  customer_accounts_enabled: z.boolean(),
  customer_accounts_optional: z.boolean(),
  enabled_payment_types: z.array(z.string().min(1)),
  features: z.record(z.string(), z.boolean()),
  policies: snapshotSchema.shape.shop.shape.policies.unwrap(),
  pageTitle: z.string(),
  pageDescription: z.string().nullable(),
});
export type NativeShopPayload = z.infer<typeof rawSettings>;

/** Base64 protects JSON/HTML strings from closing the payload script. No returned markup is executed. */
export function extractNativeShopPayload(
  html: string,
  probe: PreparedNativeShopProbe,
): NativeShopPayload {
  validateProbe(probe);
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new NativeShopError("payload-invalid");
  const payloads: string[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if (
      "tagName" in node &&
      node.tagName === "script" &&
      node.attrs.some((a) => a.name === "id" && a.value === probe.key)
    ) {
      if (!node.attrs.some((a) => a.name === "type" && a.value === "application/json"))
        throw new NativeShopError("payload-invalid");
      payloads.push(
        node.childNodes
          .map((c) => (c.nodeName === "#text" && "value" in c ? c.value : ""))
          .join(""),
      );
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  }
  try {
    visit(parse(html));
    if (payloads.length !== 1) throw new Error();
    const encoded = z.string().parse(JSON.parse(payloads[0] ?? "")),
      bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.byteLength > 1024 * 1024) throw new Error();
    const payload = rawSettings.parse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
    );
    if (JSON.stringify(Object.keys(payload.features).sort()) !== JSON.stringify(probe.featureKeys))
      throw new Error();
    return payload;
  } catch {
    throw new NativeShopError("payload-invalid");
  }
}
export interface NativeShopDependencies {
  readIdentity(): Promise<OracleIdentity>;
  readTheme(id: string): Promise<OracleTheme>;
  readThemeFiles(id: string, paths: readonly string[]): Promise<CorpusFiles>;
  readAdminSettings(): Promise<OracleAdminShopSettings>;
  /** Storefront fetch only. Admin credentials must never be forwarded to this transport. */
  fetcher?: typeof fetch;
}

/** Observational prerequisite for the settings verifier. No recursive settings verification, upload, marker or seeding. */
export async function observeNativeShopSettings(
  config: OracleConfig,
  shopId: string,
  themeId: string,
  cookie: string,
  locale: string,
  probe: PreparedNativeShopProbe,
  dependencies: NativeShopDependencies,
) {
  let pinned: OracleConfig;
  try {
    pinned = oracleConfigSchema.parse(config);
    if (
      !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId) ||
      !/^[1-9]\d*$/.test(themeId) ||
      !cookie.trim() ||
      /[\r\n]/.test(cookie) ||
      !locale.trim()
    )
      throw new Error();
  } catch {
    throw new NativeShopError("invalid-input");
  }
  const prepared = validateProbe(probe),
    paths = Object.keys(prepared.files).sort();
  async function guard() {
    try {
      const identity = oracleIdentitySchema.parse(await dependencies.readIdentity());
      assertOracleStore(pinned, identity);
      if (identity.id !== shopId) throw new Error();
      const theme = oracleThemeSchema.parse(await dependencies.readTheme(themeId));
      if (
        theme.id !== `gid://shopify/OnlineStoreTheme/${themeId}` ||
        theme.role !== "UNPUBLISHED" ||
        theme.processing ||
        theme.processingFailed
      )
        throw new Error();
    } catch {
      throw new NativeShopError("guard-denied");
    }
  }
  async function checkFiles() {
    try {
      if (
        corpusFilesFingerprint(await dependencies.readThemeFiles(themeId, paths)) !==
        prepared.harnessHash
      )
        throw new Error();
    } catch {
      throw new NativeShopError("files-mismatch");
    }
  }
  async function admin() {
    try {
      const settings = await dependencies.readAdminSettings();
      if (
        settings.id !== shopId ||
        settings.myshopifyDomain !== pinned.domain ||
        !settings.plan.partnerDevelopment
      )
        throw new Error();
      return settings;
    } catch {
      throw new NativeShopError("guard-denied");
    }
  }
  await guard();
  await checkFiles();
  const before = await admin(),
    url = new URL(prepared.requestPath, `https://${pinned.domain}`);
  url.searchParams.set("preview_theme_id", themeId);
  const fetcher = dependencies.fetcher ?? fetch;
  async function read() {
    try {
      const response = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        headers: { Cookie: cookie, Accept: "text/html", "Accept-Language": locale },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html"))
        throw new Error();
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 2 * 1024 * 1024) throw new Error();
      return extractNativeShopPayload(
        new TextDecoder("utf8", { fatal: true }).decode(bytes),
        prepared,
      );
    } catch (error) {
      if (error instanceof NativeShopError) throw error;
      throw new NativeShopError("read-failed");
    }
  }
  const first = await read(),
    second = await read();
  await checkFiles();
  await guard();
  const after = await admin();
  if (
    JSON.stringify(first) !== JSON.stringify(second) ||
    JSON.stringify(before) !== JSON.stringify(after)
  )
    throw new NativeShopError("unstable-observation");
  if (
    first.shopId !== shopId.split("/").at(-1) ||
    first.permanentDomain !== pinned.domain ||
    first.locale !== locale
  )
    throw new NativeShopError("scope-mismatch");
  let shop: z.infer<typeof snapshotSchema.shape.shop>;
  try {
    shop = snapshotSchema.shape.shop.parse({
      id: first.shopId,
      permanentDomain: first.permanentDomain,
      name: first.name,
      domain: first.domain,
      currency: first.currency,
      locale: first.locale,
      money_format: first.money_format,
      money_with_currency_format: first.money_with_currency_format,
      timezone: after.ianaTimezone,
      ...(first.description === null ? {} : { description: first.description }),
      customer_accounts_enabled: first.customer_accounts_enabled,
      customer_accounts_optional: first.customer_accounts_optional,
      enabled_payment_types: first.enabled_payment_types,
      features: first.features,
      policies: first.policies,
      seo: { title: first.pageTitle, description: first.pageDescription },
    });
  } catch {
    throw new NativeShopError("payload-invalid");
  }
  return {
    domain: pinned.domain,
    shopId,
    apiVersion: pinned.apiVersion,
    locale: first.locale,
    shop,
  };
}

/** Binds the prepared probe, cookie and unpublished theme once; each verification still performs fresh reads. */
export function createNativeShopSettingsReader(
  config: OracleConfig,
  shopId: string,
  themeId: string,
  cookie: string,
  probe: PreparedNativeShopProbe,
  dependencies: NativeShopDependencies,
) {
  const pinned = oracleConfigSchema.parse(config),
    prepared = validateProbe(probe);
  return async (context: NativeShopSettingsContext) => {
    if (
      context.domain !== pinned.domain ||
      context.shopId !== shopId ||
      context.apiVersion !== pinned.apiVersion
    )
      throw new NativeShopError("scope-mismatch");
    return observeNativeShopSettings(
      pinned,
      shopId,
      themeId,
      cookie,
      context.locale,
      prepared,
      dependencies,
    );
  };
}
