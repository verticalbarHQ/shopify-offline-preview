import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import {
  captureCorpusCase,
  extractCorpusOutput,
  prepareCorpus,
  savePrivateCorpusCapture,
} from "../tools/oracle/corpus.js";

const original = {
  id: "filters/escape/0",
  kind: "filters",
  name: "escape",
  path: "/products/source-handle",
  liquid: '{{ "&lt;/script&gt;&amp;" | escape }}',
};
const mapping = { "/products/source-handle": "/products/sop-matrix-needle?variant=sop-variant-1" };
function fixture() {
  const result = prepareCorpus([original], mapping);
  const item = result.cases[0];
  assert.ok(item);
  return { ...result, item };
}
function payload(id: string, value: unknown) {
  const encoded = typeof value === "string" ? Buffer.from(value).toString("base64") : value;
  return `<script id="${id}" type="application/json">${JSON.stringify(encoded)}</script>`;
}

test("corpus preparation preserves original inputs and records decoded source and explicit context mapping", async () => {
  const { item, files } = fixture();
  assert.equal(item.liquid, original.liquid);
  assert.equal(item.liquidSource, '{{ "</script>&" | escape }}');
  assert.notEqual(item.originalInputHash, item.preparedInputHash);
  assert.equal(
    new URL(item.requestPath, "https://fixture.invalid").searchParams.get("variant"),
    "sop-variant-1",
  );
  assert.equal(
    new URL(item.requestPath, "https://fixture.invalid").searchParams.get("view"),
    item.payloadId,
  );
  const result = await renderTheme(new MemoryThemeFileSystem(files), item.requestPath);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.file]),
    [["shopify-server-only", "layout/sop-corpus.liquid"]],
  );
  assert.equal(extractCorpusOutput(result.html, item), "&lt;/script&gt;&amp;");
  assert.deepEqual(prepareCorpus([original], mapping), { cases: [item], files });
});

test("corpus preparation rejects missing mappings, changed context kinds, unsafe paths and duplicates", () => {
  assert.throws(() => prepareCorpus([original], {}), /mapping required/);
  for (const path of [
    "https://external.invalid/",
    "//external.invalid/",
    "/products/x#fragment",
    "/products/x?view=other",
    "/products/x?preview_theme_id=1",
    "/cart",
    "/products/\\external",
  ])
    assert.throws(() => prepareCorpus([original], { [original.path]: path }));
  assert.throws(() => prepareCorpus([original, original], mapping), /Duplicate/);
  assert.throws(() => prepareCorpus([{ ...original, liquid: " " }], mapping), /no executable/);
});

test("corpus extraction requires the exact unique string payload and withholds malformed output", () => {
  const { item } = fixture();
  assert.equal(
    extractCorpusOutput(payload(item.payloadId, "<b>Native output</b>"), item),
    "<b>Native output</b>",
  );
  assert.equal(
    extractCorpusOutput(payload(item.payloadId, "</script>한글 😀"), item),
    "</script>한글 😀",
  );
  assert.equal(
    extractCorpusOutput(payload(item.payloadId, "\uFEFFleading BOM"), item),
    "\uFEFFleading BOM",
  );
  for (const encoded of ["%%", "/w=="])
    assert.throws(
      () =>
        extractCorpusOutput(
          `<script id="${item.payloadId}" type="application/json">${JSON.stringify(encoded)}</script>`,
          item,
        ),
      /canonical UTF-8 Base64/,
    );
  assert.throws(() => extractCorpusOutput("<p>Password gate</p>", item), /Exactly one/);
  assert.throws(
    () => extractCorpusOutput(payload(item.payloadId, "a") + payload(item.payloadId, "a"), item),
    /Exactly one/,
  );
  assert.throws(
    () => extractCorpusOutput(payload(item.payloadId, { secret: "do not publish" }), item),
    /output string/,
  );
  assert.throws(
    () =>
      extractCorpusOutput(
        `<script id="${item.payloadId}" type="application/json">private-invalid-json</script>`,
        item,
      ),
    (error) => error instanceof Error && !error.message.includes("private-invalid-json"),
  );
});

const config = { domain: "example-test.myshopify.com", apiVersion: "2026-10" as const };
const identity = {
  id: "gid://shopify/Shop/1",
  myshopifyDomain: config.domain,
  name: "Synthetic test",
  currencyCode: "USD",
  ianaTimezone: "UTC",
  plan: { partnerDevelopment: true },
  metafield: { value: "true" },
};
const preview = {
  id: "gid://shopify/OnlineStoreTheme/2",
  role: "UNPUBLISHED",
  processing: false,
  processingFailed: false,
};
const metadata = { specCommit: "a".repeat(40), fixtureHash: "b".repeat(64) };

test("guarded read-only corpus capture requires stable native payloads and public observations contain hashes only", async () => {
  const { item } = fixture();
  let gets = 0;
  const fetcher: typeof fetch = async (url, init) => {
    gets++;
    const target = new URL(String(url));
    assert.equal(target.hostname, config.domain);
    assert.equal(target.searchParams.get("view"), item.payloadId);
    assert.equal(target.searchParams.get("preview_theme_id"), "2");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    return new Response(payload(item.payloadId, "synthetic private native-like output"), {
      headers: { "Content-Type": "text/html" },
    });
  };
  const result = await captureCorpusCase(
    { config, previewThemeId: "2", cookie: "synthetic-test-cookie" },
    item,
    metadata,
    {
      readIdentity: async () => identity,
      verifyShopSettings: async () => {},
      readTheme: async () => preview,
      readThemeFiles: async () => fixture().files,
      fetcher,
    },
  );
  assert.equal(gets, 2);
  assert.equal(result.observation.doubleCaptureStable, true);
  assert.ok(!JSON.stringify(result.observation).includes("private native-like"));
  assert.ok(!JSON.stringify(result.observation).includes("synthetic-test-cookie"));
  assert.equal(result.privateOutputs[0], "synthetic private native-like output");
  let attempt = 0;
  await assert.rejects(
    captureCorpusCase(
      { config, previewThemeId: "2", cookie: "synthetic-test-cookie" },
      item,
      metadata,
      {
        readIdentity: async () => identity,
        verifyShopSettings: async () => {},
        readTheme: async () => preview,
        readThemeFiles: async () => fixture().files,
        fetcher: async () =>
          new Response(payload(item.payloadId, String(++attempt)), {
            headers: { "Content-Type": "text/html" },
          }),
      },
    ),
    /Unstable/,
  );
  await assert.rejects(
    captureCorpusCase(
      { config, previewThemeId: "2", cookie: "synthetic-test-cookie" },
      item,
      metadata,
      {
        readIdentity: async () => ({ ...identity, metafield: null }),
        verifyShopSettings: async () => {},
        readTheme: async () => preview,
        readThemeFiles: async () => fixture().files,
        fetcher,
      },
    ),
    /marker/,
  );
  assert.equal(gets, 2);
});

test("all nonempty pinned filter examples prepare without fabricating the ten missing inputs", async () => {
  const generated = JSON.parse(await readFile("packages/spec/src/generated/corpus.json", "utf8"));
  const inputs = generated.filter((input: { kind: string }) => input.kind === "filters");
  const paths = Object.fromEntries(
    inputs.map((input: { path: string }) => [input.path, input.path]),
  );
  const prepared = prepareCorpus(inputs, paths);
  assert.equal(prepared.cases.length, 235);
  assert.equal(new Set(prepared.cases.map((item) => item.payloadId)).size, 235);
  assert.equal(Object.keys(prepared.files).length, 4 + 235 * 3);
});

test("changed prepared requests or source hashes cannot acquire capture provenance", async () => {
  const { item } = fixture();
  let gets = 0;
  const fetcher: typeof fetch = async () => {
    gets++;
    throw new Error("Must not fetch");
  };
  for (const changed of [
    { ...item, requestPath: "/other" },
    { ...item, originalInputHash: "c".repeat(64) },
    { ...item, liquidSource: "changed" },
  ]) {
    await assert.rejects(
      captureCorpusCase(
        { config, previewThemeId: "2", cookie: "synthetic-test-cookie" },
        changed,
        metadata,
        {
          readIdentity: async () => identity,
          verifyShopSettings: async () => {},
          readTheme: async () => preview,
          readThemeFiles: async () => fixture().files,
          fetcher,
        },
      ),
      /provenance/,
    );
  }
  assert.equal(gets, 0);
});

test("private corpus files retain readable outputs with owner-only permissions while public metadata stays hash-only", async () => {
  const { item } = fixture();
  const result = await captureCorpusCase(
    { config, previewThemeId: "2", cookie: "synthetic-test-cookie" },
    item,
    metadata,
    {
      readIdentity: async () => identity,
      verifyShopSettings: async () => {},
      readTheme: async () => preview,
      readThemeFiles: async () => fixture().files,
      fetcher: async () =>
        new Response(payload(item.payloadId, "synthetic private output"), {
          headers: { "Content-Type": "text/html" },
        }),
    },
  );
  const directory = await savePrivateCorpusCapture(result);
  try {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const file of ["1.html", "2.html", "outputs.json", "observation.json"])
      assert.equal((await stat(`${directory}/${file}`)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(`${directory}/outputs.json`, "utf8")), [
      "synthetic private output",
      "synthetic private output",
    ]);
    assert.ok(
      !(await readFile(`${directory}/observation.json`, "utf8")).includes(
        "synthetic private output",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
