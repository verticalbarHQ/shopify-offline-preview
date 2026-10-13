import { z } from "zod";

export const oracleIdentityQuery = `query OfflinePreviewOracleIdentity {
  shop {
    id myshopifyDomain name currencyCode ianaTimezone
    plan { partnerDevelopment }
    metafield(namespace: "sop", key: "oracle_store") { value }
  }
}`;
const domain = z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);
export const oracleConfigSchema = z.strictObject({ domain, apiVersion: z.literal("2026-10") });
export const oracleIdentitySchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Shop\/\d+$/),
  myshopifyDomain: domain,
  name: z.string(),
  currencyCode: z.string(),
  ianaTimezone: z.string(),
  plan: z.object({ partnerDevelopment: z.boolean() }),
  metafield: z.object({ value: z.string() }).nullable(),
});
export type OracleConfig = z.infer<typeof oracleConfigSchema>;
export type OracleIdentity = z.infer<typeof oracleIdentitySchema>;

/** This guard does not grant mutation approval and performs no network calls. */
export function assertOracleStore(config: OracleConfig, observed: OracleIdentity): void {
  oracleConfigSchema.parse(config);
  oracleIdentitySchema.parse(observed);
  if (observed.myshopifyDomain !== config.domain) throw new Error("Oracle store domain mismatch");
  if (!observed.plan.partnerDevelopment)
    throw new Error("Oracle requires a verified partner development store");
  if (observed.metafield?.value !== "true")
    throw new Error("Oracle marker sop.oracle_store is missing or not true");
}
