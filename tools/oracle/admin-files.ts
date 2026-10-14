import { z } from "zod";
import { themePath } from "../../packages/theme/src/index.js";
import { oracleThemeSchema } from "./admin-read.js";
import type { CorpusFiles } from "./corpus-environment.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

const bodySchema = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("OnlineStoreThemeFileBodyText"), content: z.string() }),
  z.object({ __typename: z.literal("OnlineStoreThemeFileBodyBase64"), contentBase64: z.string() }),
  z.object({ __typename: z.literal("OnlineStoreThemeFileBodyUrl"), url: z.string() }),
]);
const responseSchema = z.object({
  data: z
    .object({
      theme: oracleThemeSchema
        .extend({
          files: z.object({
            nodes: z.array(z.object({ filename: z.string(), body: bodySchema })),
            userErrors: z.array(z.unknown()),
            pageInfo: z.object({ hasNextPage: z.boolean() }),
          }),
        })
        .nullable(),
    })
    .optional(),
  errors: z.array(z.unknown()).optional(),
});
const query = `query OfflinePreviewFiles($id: ID!, $filenames: [String!]!) {
  theme(id: $id) { id role processing processingFailed
    files(first: 50, filenames: $filenames) { nodes { filename body { __typename
      ... on OnlineStoreThemeFileBodyText { content }
      ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
      ... on OnlineStoreThemeFileBodyUrl { url }
    } } userErrors { code filename } pageInfo { hasNextPage } }
  }
}`;
/** Existing credentials, read-only queries, exact requested files, sequential batches of 50. */
export async function readOracleThemeFiles(
  config: OracleConfig,
  token: string,
  themeId: string,
  paths: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<CorpusFiles> {
  oracleConfigSchema.parse(config);
  if (!token.trim() || !/^[1-9]\d*$/.test(themeId))
    throw new Error("Existing token and valid preview theme required");
  if (!paths.length || paths.length > 1000 || new Set(paths).size !== paths.length)
    throw new Error("Unique bounded corpus file list required");
  for (const path of paths) {
    themePath(path);
    if (/[\r\n]/.test(path)) throw new Error("Invalid oracle file path");
  }
  const files: CorpusFiles = {};
  for (let start = 0; start < paths.length; start += 50) {
    const requested = paths.slice(start, start + 50);
    const response = await fetcher(
      `https://${config.domain}/admin/api/${config.apiVersion}/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({
          query,
          variables: { id: `gid://shopify/OnlineStoreTheme/${themeId}`, filenames: requested },
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`Oracle file query failed (HTTP ${response.status})`);
    let document: unknown;
    try {
      document = await response.json();
    } catch {
      throw new Error("Oracle file response is not valid JSON; details withheld");
    }
    const parsed = responseSchema.safeParse(document);
    if (!parsed.success || parsed.data.errors?.length || !parsed.data.data?.theme)
      throw new Error("Oracle theme files unavailable; response details withheld");
    const theme = parsed.data.data.theme;
    if (
      theme.id !== `gid://shopify/OnlineStoreTheme/${themeId}` ||
      theme.role !== "UNPUBLISHED" ||
      theme.processing ||
      theme.processingFailed
    )
      throw new Error("Requested unpublished processed theme required for file verification");
    if (
      theme.files.userErrors.length ||
      theme.files.pageInfo.hasNextPage ||
      theme.files.nodes.length !== requested.length
    )
      throw new Error("Incomplete oracle theme file batch");
    for (const file of theme.files.nodes) {
      if (!requested.includes(file.filename) || Object.hasOwn(files, file.filename))
        throw new Error("Unexpected or duplicate oracle theme file");
      const body = file.body;
      if (body.__typename === "OnlineStoreThemeFileBodyText") files[file.filename] = body.content;
      else if (body.__typename === "OnlineStoreThemeFileBodyBase64") {
        const bytes = Buffer.from(body.contentBase64, "base64");
        if (bytes.toString("base64") !== body.contentBase64)
          throw new Error("Invalid oracle file encoding");
        files[file.filename] = bytes;
      } else {
        let url: URL;
        try {
          url = new URL(body.url);
        } catch {
          throw new Error("Invalid oracle asset URL");
        }
        if (
          url.protocol !== "https:" ||
          url.hostname !== "cdn.shopify.com" ||
          url.port ||
          url.username ||
          url.password
        )
          throw new Error("Oracle asset URL must use the Shopify CDN");
        const asset = await fetcher(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
        });
        if (!asset.ok) throw new Error(`Oracle asset read failed (HTTP ${asset.status})`);
        files[file.filename] = new Uint8Array(await asset.arrayBuffer());
      }
    }
  }
  return files;
}
