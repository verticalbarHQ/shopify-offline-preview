import { z } from "zod";
import {
  type OracleConfig,
  type OracleIdentity,
  oracleConfigSchema,
  oracleIdentityQuery,
  oracleIdentitySchema,
} from "./store-guard.js";

const responseSchema = z.object({
  data: z.object({ shop: oracleIdentitySchema }).optional(),
  errors: z.array(z.unknown()).optional(),
});
export const oracleThemeSchema = z.object({
  id: z.string(),
  role: z.string(),
  processing: z.boolean(),
  processingFailed: z.boolean(),
});
export type OracleTheme = z.infer<typeof oracleThemeSchema>;
const themeResponseSchema = z.object({
  data: z.object({ theme: oracleThemeSchema.nullable() }).optional(),
  errors: z.array(z.unknown()).optional(),
});

export async function readOracleTheme(
  config: OracleConfig,
  accessToken: string,
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<OracleTheme> {
  oracleConfigSchema.parse(config);
  if (!accessToken.trim()) throw new Error("Existing Admin API access token required");
  if (!/^[1-9]\d*$/.test(id)) throw new Error("Invalid preview theme id");
  const response = await fetcher(
    `https://${config.domain}/admin/api/${config.apiVersion}/graphql.json`,
    {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({
        query:
          "query OfflinePreviewTheme($id: ID!) { theme(id: $id) { id role processing processingFailed } }",
        variables: { id: `gid://shopify/OnlineStoreTheme/${id}` },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`Oracle theme request failed (HTTP ${response.status})`);
  const result = themeResponseSchema.safeParse(await response.json());
  if (!result.success || result.data.errors?.length || !result.data.data?.theme)
    throw new Error("Oracle theme metadata unavailable; capture refused");
  return result.data.data.theme;
}

/** Existing credentials only. This module cannot create apps/tokens or make mutations. */
export async function readOracleIdentity(
  config: OracleConfig,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<OracleIdentity> {
  oracleConfigSchema.parse(config);
  if (!accessToken.trim())
    throw new Error("Existing Admin API access token required; no token is created automatically");
  const response = await fetcher(
    `https://${config.domain}/admin/api/${config.apiVersion}/graphql.json`,
    {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: oracleIdentityQuery }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`Oracle identity request failed (HTTP ${response.status})`);
  const document = responseSchema.parse(await response.json());
  if (document.errors?.length || !document.data)
    throw new Error("Oracle identity query failed; response details are withheld from logs");
  return document.data.shop;
}
