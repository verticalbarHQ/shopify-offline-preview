import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { captureCorpusCase, extractCorpusOutput, prepareCorpus } from "../tools/oracle/corpus.js";
import {
  type CorpusEnvironment,
  corpusDependencyFiles,
  corpusFilesFingerprint,
} from "../tools/oracle/corpus-environment.js";
import { snapshotFingerprint } from "../tools/oracle/matrix.js";
import { verifyCorpusObservation } from "../tools/oracle/verify-corpus.js";

const input = {
  id: "filters/inline_asset_content/0",
  kind: "filters",
  name: "inline_asset_content",
  path: "/",
  liquid: "{{ 'icon.svg' | inline_asset_content }}",
};
const svg = '<svg viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';
const environment: CorpusEnvironment = {
  files: [
    { path: "assets/icon.svg", encoding: "utf8", content: svg, provenance: "authored-fixture" },
    {
      path: "config/settings_schema.json",
      encoding: "utf8",
      content: '[{"settings":[{"type":"text","id":"owned_label","default":"Own label"}]}]',
      provenance: "authored-fixture",
    },
    {
      path: "locales/en.default.json",
      encoding: "utf8",
      content: '{"owned":{"label":"Own translation"}}',
      provenance: "authored-fixture",
    },
  ],
};
function prepared(env = environment) {
  const result = prepareCorpus([input], { "/": "/" }, env);
  const item = result.cases[0];
  assert.ok(item);
  return { ...result, item };
}
const config = { domain: "example-test.myshopify.com", apiVersion: "2026-10" as const };
const identity = {
  id: "gid://shopify/Shop/1",
  myshopifyDomain: config.domain,
  name: "Synthetic",
  currencyCode: "USD",
  ianaTimezone: "UTC",
  plan: { partnerDevelopment: true },
  metafield: { value: "true" },
};
const theme = {
  id: "gid://shopify/OnlineStoreTheme/2",
  role: "UNPUBLISHED",
  processing: false,
  processingFailed: false,
};
const metadata = { specCommit: "a".repeat(40), fixtureHash: snapshotFingerprint(defaultFixture()) };
function payload(id: string) {
  return `<script id="${id}" type="application/json">${JSON.stringify(svg).replaceAll("<", "\\u003c")}</script>`;
}

test("corpus dependencies preserve original input and bind assets, settings, locales and binary bytes", async () => {
  const { item, files } = prepared();
  assert.equal(item.liquid, input.liquid);
  assert.equal(item.harnessHash, corpusFilesFingerprint(files));
  const result = await renderTheme(new MemoryThemeFileSystem(files), item.requestPath);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(extractCorpusOutput(result.html, item, environment), svg);
  const reversed = { files: [...environment.files].reverse() };
  assert.equal(prepared(reversed).item.harnessHash, item.harnessHash);
  const encoded = {
    files: environment.files.map((file) => ({
      ...file,
      encoding: "base64" as const,
      content: Buffer.from(file.content).toString("base64"),
    })),
  };
  assert.equal(prepared(encoded).item.harnessHash, item.harnessHash);
  assert.notEqual(
    prepared({
      files: environment.files.map((file) =>
        file.path === "assets/icon.svg" ? { ...file, content: `${svg} ` } : file,
      ),
    }).item.harnessHash,
    item.harnessHash,
  );
});

test("dependency paths cannot replace generated harness code and malformed data stays out of error messages", () => {
  const first = environment.files[0];
  assert.ok(first);
  for (const path of [
    "../outside",
    "/absolute",
    "sections/main.liquid",
    "snippets/main.liquid",
    "templates/index.json",
    "layout/theme.liquid",
    "config/other.json",
    "assets/bad\npath",
  ])
    assert.throws(() => corpusDependencyFiles({ files: [{ ...first, path }] }));
  assert.throws(() => corpusDependencyFiles({ files: [first, first] }), /Duplicate/);
  assert.throws(
    () =>
      corpusDependencyFiles({
        files: [{ ...first, encoding: "base64", content: "not base64" }],
      }),
    /canonical base64/,
  );
  assert.throws(
    () =>
      corpusDependencyFiles({
        files: [{ ...first, path: "locales/en.json", content: "private invalid data" }],
      }),
    (error) => error instanceof Error && !error.message.includes("private invalid data"),
  );
});

test("uploaded file audit runs after guards and on both sides of the HTML capture pair", async () => {
  const { item, files } = prepared();
  const events: string[] = [];
  const capture = await captureCorpusCase(
    { config, previewThemeId: "2", cookie: "synthetic-cookie" },
    item,
    metadata,
    {
      readIdentity: async () => {
        events.push("identity");
        return identity;
      },
      verifyShopSettings: async () => {},
      readTheme: async () => {
        events.push("theme");
        return theme;
      },
      readThemeFiles: async (id, paths) => {
        events.push("files");
        assert.equal(id, "2");
        assert.deepEqual(paths, Object.keys(files).sort());
        return files;
      },
      fetcher: async () => {
        events.push("GET");
        return new Response(payload(item.payloadId), { headers: { "Content-Type": "text/html" } });
      },
    },
    environment,
  );
  assert.deepEqual(events, ["identity", "theme", "files", "GET", "GET", "files"]);
  assert.equal(capture.observation.harnessHash, item.harnessHash);
  assert.ok(!JSON.stringify(capture.observation).includes(svg));
});

test("changed or missing uploaded files and post-capture edits cannot produce a corpus observation", async () => {
  const { item, files } = prepared();
  for (const mutation of ["before", "after"]) {
    let reads = 0,
      gets = 0;
    await assert.rejects(
      captureCorpusCase(
        { config, previewThemeId: "2", cookie: "synthetic-cookie" },
        item,
        metadata,
        {
          readIdentity: async () => identity,
          verifyShopSettings: async () => {},
          readTheme: async () => theme,
          readThemeFiles: async () => {
            reads++;
            return mutation === "before" || reads === 2
              ? { ...files, "assets/icon.svg": "changed" }
              : files;
          },
          fetcher: async () => {
            gets++;
            return new Response(payload(item.payloadId), {
              headers: { "Content-Type": "text/html" },
            });
          },
        },
        environment,
      ),
      /Uploaded corpus harness files differ/,
    );
    assert.equal(gets, mutation === "before" ? 0 : 2);
  }
  let audits = 0;
  await assert.rejects(
    captureCorpusCase(
      { config, previewThemeId: "2", cookie: "synthetic-cookie" },
      item,
      metadata,
      {
        readIdentity: async () => ({ ...identity, metafield: null }),
        verifyShopSettings: async () => {},
        readTheme: async () => theme,
        readThemeFiles: async () => {
          audits++;
          return files;
        },
      },
      environment,
    ),
    /marker/,
  );
  assert.equal(audits, 0);
});

test("offline replay requires the exact environment and harness hash even when input and fixture are unchanged", async () => {
  const { item, files } = prepared();
  const snapshot = defaultFixture();
  const rendered = await renderTheme(new MemoryThemeFileSystem(files), item.requestPath, {
    snapshot,
  });
  const output = extractCorpusOutput(rendered.html, item, environment);
  const observation = {
    ...metadata,
    schemaVersion: "1.0",
    source: "shopify-storefront",
    caseId: item.id,
    name: item.name,
    harnessHash: item.harnessHash,
    originalInputHash: item.originalInputHash,
    preparedInputHash: item.preparedInputHash,
    requestPath: item.requestPath,
    capturedAt: "2026-10-14T00:00:00.000Z",
    doubleCaptureStable: true,
    outputHash: createHash("sha256").update(output).digest("hex"),
    outputBytes: Buffer.byteLength(output),
  };
  assert.equal(
    (
      await verifyCorpusObservation(item, observation, {
        snapshot,
        specCommit: metadata.specCommit,
        environment,
      })
    ).pass,
    true,
  );
  await assert.rejects(
    verifyCorpusObservation(item, observation, { snapshot, specCommit: metadata.specCommit }),
    /provenance/,
  );
  await assert.rejects(
    verifyCorpusObservation(
      item,
      { ...observation, harnessHash: "b".repeat(64) },
      { snapshot, specCommit: metadata.specCommit, environment },
    ),
    /does not match/,
  );
});

test("settings and locale dependencies actually supply the case execution context", async () => {
  const original = {
    ...input,
    id: "filters/escape/1",
    name: "escape",
    liquid: "{{settings.owned_label | escape}}|{{'owned.label' | t}}",
  };
  const result = prepareCorpus([original], { "/": "/" }, environment);
  const item = result.cases[0];
  assert.ok(item);
  const rendered = await renderTheme(new MemoryThemeFileSystem(result.files), item.requestPath);
  assert.deepEqual(rendered.diagnostics, []);
  assert.equal(extractCorpusOutput(rendered.html, item, environment), "Own label|Own translation");
});
