import assert from "node:assert/strict";
import { test } from "node:test";
import { readOracleThemeFiles } from "../tools/oracle/admin-files.js";

const config = { domain: "example-test.myshopify.com", apiVersion: "2026-10" as const };
function response(nodes: unknown[], extra: Record<string, unknown> = {}) {
  return Response.json({
    data: {
      theme: {
        id: "gid://shopify/OnlineStoreTheme/2",
        role: "UNPUBLISHED",
        processing: false,
        processingFailed: false,
        files: { nodes, userErrors: [], pageInfo: { hasNextPage: false } },
        ...extra,
      },
    },
  });
}
test("theme file reads batch exact filenames and preserve text and binary bytes without mutations", async () => {
  const paths = Array.from({ length: 51 }, (_, i) => `assets/file-${i}`);
  let calls = 0;
  const files = await readOracleThemeFiles(
    config,
    "synthetic-token",
    "2",
    paths,
    async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).hostname, config.domain);
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.ok(body.query.startsWith("query "));
      assert.ok(body.variables.filenames.length <= 50);
      return response(
        body.variables.filenames.map((filename: string) => ({
          filename,
          body: { __typename: "OnlineStoreThemeFileBodyBase64", contentBase64: "AAH/" },
        })),
      );
    },
  );
  assert.equal(calls, 2);
  assert.equal(Object.keys(files).length, 51);
  assert.deepEqual(files[paths[0] ?? ""], Buffer.from([0, 1, 255]));
});
test("theme file reads reject live, incomplete, duplicate or unexpected records", async () => {
  const node = {
    filename: "assets/own.txt",
    body: { __typename: "OnlineStoreThemeFileBodyText", content: "private fixture" },
  };
  for (const result of [
    () => response([node], { role: "MAIN" }),
    () => response([]),
    () => response([{ ...node, filename: "assets/other.txt" }]),
    () => response([node, node]),
  ])
    await assert.rejects(
      readOracleThemeFiles(config, "synthetic-token", "2", ["assets/own.txt"], async () =>
        result(),
      ),
    );
  let calls = 0;
  await assert.rejects(
    readOracleThemeFiles(config, "synthetic-token", "2", ["../outside"], async () => {
      calls++;
      throw new Error();
    }),
  );
  assert.equal(calls, 0);
});
test("binary URL bodies use credential-free Shopify CDN reads and refuse redirects or other hosts", async () => {
  const node = (url: string) => ({
    filename: "assets/own.png",
    body: { __typename: "OnlineStoreThemeFileBodyUrl", url },
  });
  let calls = 0;
  const files = await readOracleThemeFiles(
    config,
    "synthetic-token",
    "2",
    ["assets/own.png"],
    async (url, init) => {
      calls++;
      if (calls === 1) return response([node("https://cdn.shopify.com/own.png")]);
      assert.equal(new URL(String(url)).hostname, "cdn.shopify.com");
      assert.equal(init?.method, "GET");
      assert.equal(init?.headers, undefined);
      assert.equal(init?.redirect, "manual");
      return new Response(new Uint8Array([0, 1, 255]));
    },
  );
  assert.deepEqual(files["assets/own.png"], new Uint8Array([0, 1, 255]));
  calls = 0;
  await assert.rejects(
    readOracleThemeFiles(config, "synthetic-token", "2", ["assets/own.png"], async () => {
      calls++;
      return response([node("https://other.invalid/private")]);
    }),
    /Shopify CDN/,
  );
  assert.equal(calls, 1);
});

test("malformed API documents, pagination and CDN redirects fail without exposing response content", async () => {
  const paths = ["assets/own.png"];
  await assert.rejects(
    readOracleThemeFiles(
      config,
      "synthetic-token",
      "2",
      paths,
      async () => new Response("private invalid response"),
    ),
    (error) => error instanceof Error && !error.message.includes("private invalid response"),
  );
  let calls = 0;
  await assert.rejects(
    readOracleThemeFiles(config, "synthetic-token", "2", paths, async () => {
      calls++;
      if (calls === 1)
        return response([
          {
            filename: paths[0],
            body: {
              __typename: "OnlineStoreThemeFileBodyUrl",
              url: "https://cdn.shopify.com/own.png",
            },
          },
        ]);
      return new Response(null, { status: 302, headers: { Location: "https://other.invalid/" } });
    }),
    /HTTP 302/,
  );
  assert.equal(calls, 2);
});
