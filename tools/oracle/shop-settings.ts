import { z } from "zod";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class ShopSettingsError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "read-failed"
      | "store-mismatch"
      | "settings-mismatch"
      | "native-observation-required"
      | "native-observation-failed"
      | "settings-changed"
      | "concurrent-verification",
  ) {
    super(`Oracle shop settings verification failed: ${code}`);
    this.name = "ShopSettingsError";
  }
}
const adminShop = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Shop\/[1-9]\d*$/),
  myshopifyDomain: z.string(),
  plan: z.object({ partnerDevelopment: z.boolean() }),
  name: z.string(),
  primaryDomain: z.object({ host: z.string() }),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  ianaTimezone: z.string(),
  description: z.string().nullable(),
  currencyFormats: z.object({ moneyFormat: z.string(), moneyWithCurrencyFormat: z.string() }),
});
export type OracleAdminShopSettings = z.infer<typeof adminShop>;
export const oracleShopSettingsQuery = `query OfflinePreviewShopSettings {
  shop { id myshopifyDomain plan { partnerDevelopment } name primaryDomain { host }
    currencyCode ianaTimezone description currencyFormats { moneyFormat moneyWithCurrencyFormat } }
}`;

/** Existing credentials, readonly settings. Does not rewrite the prepared fixture or infer request-dependent flags. */
export async function readOracleShopSettings(
  config: OracleConfig,
  token: string,
  shopId: string,
  fetcher: typeof fetch = fetch,
): Promise<OracleAdminShopSettings> {
  let pinned: OracleConfig;
  try {
    pinned = oracleConfigSchema.parse(config);
    if (!token.trim() || !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId)) throw new Error();
  } catch {
    throw new ShopSettingsError("invalid-input");
  }
  let shop: OracleAdminShopSettings;
  try {
    const response = await fetcher(
      `https://${pinned.domain}/admin/api/${pinned.apiVersion}/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query: oracleShopSettingsQuery }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok || response.headers.get("x-shopify-api-version") !== pinned.apiVersion)
      throw new Error();
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 1024 * 1024) throw new Error();
    const document = z
      .object({ data: z.object({ shop: adminShop }), errors: z.array(z.unknown()).optional() })
      .parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
    if (document.errors?.length) throw new Error();
    shop = document.data.shop;
  } catch {
    throw new ShopSettingsError("read-failed");
  }
  if (shop.id !== shopId || shop.myshopifyDomain !== pinned.domain || !shop.plan.partnerDevelopment)
    throw new ShopSettingsError("store-mismatch");
  return shop;
}

/** Only field names leave this comparison. Unmodeled API/Liquid relationships require fresh Native observations. */
export function compareOracleShopSettings(
  expected: Snapshot["shop"],
  actual: OracleAdminShopSettings,
) {
  const wanted = snapshotSchema.shape.shop.parse(expected),
    observed = adminShop.parse(actual),
    mapped = {
      name: observed.name,
      domain: observed.primaryDomain.host,
      currency: observed.currencyCode,
      timezone: observed.ianaTimezone,
      money_format: observed.currencyFormats.moneyFormat,
      money_with_currency_format: observed.currencyFormats.moneyWithCurrencyFormat,
      description: observed.description,
    },
    mismatchedFields = Object.entries(mapped)
      .filter(([key, value]) => Object.hasOwn(wanted, key) && Reflect.get(wanted, key) !== value)
      .map(([key]) => key),
    nativeFields = Object.keys(wanted).filter((key) => !Object.hasOwn(mapped, key));
  return { mismatchedFields, nativeFields };
}
export interface NativeShopSettingsContext {
  domain: string;
  shopId: string;
  apiVersion: "2026-10";
  locale: string;
}
const nativeObservation = z.object({
  domain: z.string(),
  shopId: z.string(),
  apiVersion: z.literal("2026-10"),
  locale: z.string(),
  shop: snapshotSchema.shape.shop,
});
export interface ShopSettingsDependencies {
  fetcher?: typeof fetch;
  /** Trusted adapter must observe the authenticated Native storefront in the intended request context. Never echo the expected fixture. */
  readNativeSettings?(context: NativeShopSettingsContext): Promise<unknown>;
}
export interface VerifiedOracleShopSettings {
  readonly kind: "verified-oracle-shop-settings";
}
interface VerifiedSettingsRecord {
  domain: string;
  shopId: string;
  apiVersion: "2026-10";
  shop: Snapshot["shop"];
}
const verified = new WeakMap<VerifiedOracleShopSettings, VerifiedSettingsRecord>();
function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}
export function inspectVerifiedOracleShopSettings(
  receipt: VerifiedOracleShopSettings,
): VerifiedSettingsRecord {
  const record = verified.get(receipt);
  if (!record) throw new ShopSettingsError("native-observation-required");
  return structuredClone(record);
}

/** Fresh API comparison + mandatory Native request context, bracketed by a second unchanged settings read. No mutation or approval is granted. */
export function createOracleShopSettingsVerifier(
  config: OracleConfig,
  expected: Snapshot["shop"],
  shopId: string,
  token: string,
  dependencies: ShopSettingsDependencies = {},
) {
  let pinned: OracleConfig, wanted: Snapshot["shop"];
  try {
    pinned = oracleConfigSchema.parse(config);
    wanted = snapshotSchema.shape.shop.parse(expected);
    if (!token.trim() || !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId)) throw new Error();
  } catch {
    throw new ShopSettingsError("invalid-input");
  }
  let busy = false;
  return async (): Promise<VerifiedOracleShopSettings> => {
    if (busy) throw new ShopSettingsError("concurrent-verification");
    busy = true;
    try {
      const before = await readOracleShopSettings(pinned, token, shopId, dependencies.fetcher),
        comparison = compareOracleShopSettings(wanted, before);
      if (comparison.mismatchedFields.length) throw new ShopSettingsError("settings-mismatch");
      if (!dependencies.readNativeSettings)
        throw new ShopSettingsError("native-observation-required");
      let native: z.infer<typeof nativeObservation>;
      try {
        native = nativeObservation.parse(
          await dependencies.readNativeSettings({
            domain: pinned.domain,
            shopId,
            apiVersion: pinned.apiVersion,
            locale: wanted.locale,
          }),
        );
      } catch {
        throw new ShopSettingsError("native-observation-failed");
      }
      if (
        native.domain !== pinned.domain ||
        native.shopId !== shopId ||
        native.apiVersion !== pinned.apiVersion
      )
        throw new ShopSettingsError("store-mismatch");
      if (native.locale !== wanted.locale || native.shop.locale !== wanted.locale)
        throw new ShopSettingsError("settings-mismatch");
      for (const key of Object.keys(wanted)) {
        // Schema validation rejects arbitrary keys. Exact JSON values preserve flags, policy order and currency-format bytes.
        if (
          !Object.hasOwn(native.shop, key) ||
          canonical(Reflect.get(native.shop, key)) !== canonical(Reflect.get(wanted, key))
        )
          throw new ShopSettingsError("settings-mismatch");
      }
      const after = await readOracleShopSettings(pinned, token, shopId, dependencies.fetcher);
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new ShopSettingsError("settings-changed");
      const receipt: VerifiedOracleShopSettings = Object.freeze({
        kind: "verified-oracle-shop-settings",
      });
      verified.set(receipt, {
        domain: pinned.domain,
        shopId,
        apiVersion: pinned.apiVersion,
        shop: structuredClone(wanted),
      });
      return receipt;
    } finally {
      busy = false;
    }
  };
}
