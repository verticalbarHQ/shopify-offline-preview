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

/** Full, unchanged unpublished-theme inventory plus exact file bytes. Sequential cursor reads; no mutations or credentials on CDN GETs. */
export async function readOracleAllThemeFiles(
  input: OracleConfig,
  token: string,
  themeId: string,
  fetcher: typeof fetch = fetch,
): Promise<CorpusFiles> {
  const config = oracleConfigSchema.parse(input),
    endpoint = `https://${config.domain}/admin/api/${config.apiVersion}/graphql.json`;
  if (!token.trim() || !/^[1-9]\d*$/.test(themeId))
    throw new Error("Existing token and unpublished preview theme required");
  let total = 0;
  const bounded: typeof fetch = async (url, init) => {
    const response = await fetcher(url, init);
    if (
      !response.ok ||
      response.redirected ||
      (response.url && response.url !== String(url)) ||
      (String(url) === endpoint &&
        response.headers.get("x-shopify-api-version") !== config.apiVersion)
    )
      throw new Error("Oracle complete file read refused");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Oracle complete file read refused");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        total += part.value.byteLength;
        if (size > 32 * 1024 * 1024 || total > 128 * 1024 * 1024)
          throw new Error("Oracle complete file read bound exceeded");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      headers: response.headers,
    });
  };
  const schema = z.object({
    data: z.object({
      theme: oracleThemeSchema
        .extend({
          files: z.object({
            nodes: z.array(z.object({ filename: z.string() })).max(50),
            userErrors: z.array(z.unknown()),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          }),
        })
        .nullable(),
    }),
    errors: z.array(z.unknown()).optional(),
  });
  async function inventory() {
    const files = new Set<string>(),
      cursors = new Set<string>();
    let after: string | null = null;
    const deadline = Date.now() + 120000;
    for (let page = 0; page < 100; page++) {
      if (Date.now() >= deadline) throw new Error();
      const response = await bounded(endpoint, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
          body: JSON.stringify({
            query: `query OfflinePreviewFileInventory($id:ID!,$after:String){ theme(id:$id){id role processing processingFailed files(first:50,after:$after){nodes{filename} userErrors{code filename} pageInfo{hasNextPage endCursor}}}}`,
            variables: { id: `gid://shopify/OnlineStoreTheme/${themeId}`, after },
          }),
          signal: AbortSignal.timeout(Math.min(30000, deadline - Date.now())),
        }),
        document = schema.parse(await response.json()),
        theme = document.data.theme;
      if (
        document.errors?.length ||
        !theme ||
        theme.id !== `gid://shopify/OnlineStoreTheme/${themeId}` ||
        theme.role !== "UNPUBLISHED" ||
        theme.processing ||
        theme.processingFailed ||
        theme.files.userErrors.length
      )
        throw new Error();
      for (const node of theme.files.nodes) {
        themePath(node.filename);
        if (files.has(node.filename)) throw new Error();
        files.add(node.filename);
        if (files.size > 1000) throw new Error();
      }
      if (!theme.files.pageInfo.hasNextPage) return [...files].sort();
      const cursor = theme.files.pageInfo.endCursor;
      if (!theme.files.nodes.length || !cursor || cursors.has(cursor)) throw new Error();
      cursors.add(cursor);
      after = cursor;
    }
    throw new Error();
  }
  try {
    const before = await inventory();
    if (!before.length) throw new Error();
    const files = await readOracleThemeFiles(config, token, themeId, before, bounded),
      after = await inventory();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error();
    return files;
  } catch {
    throw new Error("Oracle complete theme file verification failed; details withheld");
  }
}
