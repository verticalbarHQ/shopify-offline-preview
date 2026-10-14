import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import {
  createOracleSeedBindingLedger,
  SeedLedgerError,
} from "../tools/oracle/seed-binding-ledger.js";
import {
  createOracleSeedExecutor,
  inspectVerifiedSeedExecution,
  type SeedExecutionStep,
} from "../tools/oracle/seed-execution.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";
import { seedBindingKey } from "../tools/oracle/seed-requests.js";
import {
  createOracleSeedUploader,
  inspectVerifiedSeedUpload,
  SeedUploadError,
} from "../tools/oracle/seed-upload.js";

// Authored mocks only. No live Shopify operations or owner approval evidence.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  snapshot = defaultFixture(),
  shopId = "gid://shopify/Shop/1",
  plan = buildOracleSeedPlan(config, snapshot),
  state = plan.states[0];
assert.ok(state);
const image = state.tasks.find((t) => t.resource === "image");
assert.ok(image);
const imageSource = snapshotSchema.shape.products.element.shape.images.element.parse(image.source);
const file = image.identity[0];
assert.ok(file);
const bytes = new Uint8Array([1, 2, 3]),
  asset = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
  assets = [asset],
  step: SeedExecutionStep = {
    stateHash: state.hash,
    taskKey: image.key,
    kind: "task",
    options: { mode: "create", imageBytes: bytes.length },
    bindings: {},
  },
  named = (name: string, kind = "SCALAR") => ({ kind, name }),
  required = (type: object) => ({ kind: "NON_NULL", name: null, ofType: type }),
  list = (name: string) =>
    required({ kind: "LIST", name: null, ofType: required(named(name, "INPUT_OBJECT")) }),
  schema = {
    apiVersion: "2026-10",
    operations: [
      { name: "stagedUploadsCreate", args: [{ name: "input", type: list("StagedUploadInput") }] },
      { name: "fileCreate", args: [{ name: "files", type: list("FileCreateInput") }] },
    ],
    types: [
      {
        name: "StagedUploadInput",
        kind: "INPUT_OBJECT",
        enumValues: null,
        inputFields: ["resource", "filename", "mimeType", "httpMethod", "fileSize"].map((name) => ({
          name,
          type: named("String"),
        })),
      },
      {
        name: "FileCreateInput",
        kind: "INPUT_OBJECT",
        enumValues: null,
        inputFields: [
          "filename",
          "contentType",
          "alt",
          "originalSource",
          "duplicateResolutionMode",
        ].map((name) => ({ name, type: named("String") })),
      },
      { name: "String", kind: "SCALAR", enumValues: null, inputFields: null },
    ],
  },
  target = () => ({
    url: "https://shopify-staged-uploads.storage.googleapis.com/",
    resourceUrl: "https://shopify-staged-uploads.storage.googleapis.com/tmp/authored/image.png",
    parameters: [
      { name: "key", value: "tmp/authored/image.png" },
      { name: "policy", value: "authored-signed-value" },
    ],
  }),
  ok = async () => {},
  matches = (code: string) => (error: unknown) =>
    error instanceof SeedUploadError && error.code === code;

function setup(customTarget = target()) {
  let fileWrites = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === "GET") {
      assert.equal(init.headers, undefined);
      return new Response(bytes);
    }
    const body = JSON.parse(String(init?.body)),
      query = String(body.query);
    if (query.includes("OfflinePreviewSeedIdentities")) {
      const source = imageSource;
      return Response.json(
        {
          data: {
            shop: {
              id: shopId,
              myshopifyDomain: config.domain,
              plan: { partnerDevelopment: true },
            },
            nodes: [
              {
                __typename: "MediaImage",
                id: "gid://shopify/MediaImage/1",
                fileStatus: "READY",
                image: {
                  url: "https://cdn.shopify.com/image.png",
                  width: source.width,
                  height: source.height,
                },
                originalSource: {
                  url: "https://cdn.shopify.com/original.png",
                  fileSize: bytes.length,
                },
              },
            ],
          },
        },
        { headers: { "x-shopify-api-version": "2026-10" } },
      );
    }
    const data = query.includes("OfflinePreviewSeedGuard")
      ? {
          shop: {
            id: shopId,
            myshopifyDomain: config.domain,
            name: "Authored shop",
            currencyCode: "USD",
            ianaTimezone: "UTC",
            plan: { partnerDevelopment: true },
            metafield: { value: "true" },
          },
          currentAppInstallation: { accessScopes: [{ handle: "write_files" }] },
        }
      : query.includes("stagedUploadsCreate")
        ? { stagedUploadsCreate: { stagedTargets: [customTarget], userErrors: [] } }
        : { fileCreate: { files: [{ id: "gid://shopify/MediaImage/1" }], userErrors: [] } };
    if (query.includes("fileCreate")) fileWrites++;
    return Response.json({ data }, { headers: { "x-shopify-api-version": "2026-10" } });
  };
  const ledger = createOracleSeedBindingLedger(
      config,
      snapshot,
      shopId,
      "authored-token",
      assets,
      fetcher,
    ),
    executor = createOracleSeedExecutor(config, snapshot, shopId, "authored-token", schema, {
      authorize: ok,
      verifyBindings: ledger.verifyBindings,
      verifyResult: ok,
      fetcher,
    });
  return { ledger, executor, fileWrites: () => fileWrites };
}
test("multipart POST uses all returned fields, last file part and no Admin credentials; receipt requires actual 2xx", async () => {
  const { executor } = setup();
  let posts = 0,
    approvals = 0;
  const uploader = createOracleSeedUploader(config, snapshot, shopId, assets, {
    authorize: async () => {
      approvals++;
    },
    fetcher: async (url, init) => {
      posts++;
      assert.equal(url, target().url);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.headers, undefined);
      assert.ok(init?.body instanceof FormData);
      const keys: string[] = [];
      init.body.forEach((_value, key) => {
        keys.push(key);
      });
      assert.deepEqual(keys, ["key", "policy", "file"]);
      assert.equal(init.body.get("policy"), "authored-signed-value");
      const blob = init.body.get("file");
      assert.ok(blob instanceof Blob);
      assert.equal(blob.type, "image/png");
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
      return new Response(null, { status: 201 });
    },
  });
  const source = await executor.executeVerified(step),
    receipt = await uploader.upload(source, bytes);
  assert.equal(posts, 1);
  assert.equal(approvals, 1);
  const view = inspectVerifiedSeedUpload(receipt);
  assert.equal(view.resourceUrl, target().resourceUrl);
  view.resourceUrl = "tampered";
  assert.equal(inspectVerifiedSeedUpload(receipt).resourceUrl, target().resourceUrl);
  assert.throws(
    () => inspectVerifiedSeedUpload(JSON.parse(JSON.stringify(receipt))),
    matches("unverified-upload"),
  );
  await assert.rejects(uploader.upload(source, bytes), matches("target-used"));
});
test("forged, wrong store, altered source bytes and mismatched declared size are refused before POST", async () => {
  const { executor } = setup(),
    source = await executor.executeVerified(step);
  let posts = 0;
  const deps = {
    authorize: ok,
    fetcher: async () => {
      posts++;
      return new Response(null, { status: 204 });
    },
  };
  const uploader = createOracleSeedUploader(config, snapshot, shopId, assets, deps);
  await assert.rejects(
    uploader.upload({ kind: "verified-seed-execution" }, bytes),
    matches("invalid-target"),
  );
  await assert.rejects(
    createOracleSeedUploader(config, snapshot, "gid://shopify/Shop/2", assets, deps).upload(
      source,
      bytes,
    ),
    matches("scope-mismatch"),
  );
  await assert.rejects(
    uploader.upload(source, new Uint8Array([1, 2, 4])),
    matches("asset-mismatch"),
  );
  await assert.rejects(
    createOracleSeedUploader(config, snapshot, shopId, [{ ...asset, bytes: 4 }], deps).upload(
      source,
      bytes,
    ),
    matches("asset-mismatch"),
  );
  assert.equal(posts, 0);
});
test("unsafe upload/resource URLs and ambiguous form parameters are rejected without leaking signed values", async () => {
  let posts = 0;
  for (const bad of [
    { ...target(), url: "https://evil.example/upload" },
    { ...target(), resourceUrl: "https://evil.example/image" },
    { ...target(), url: "https://shopify.s3.amazonaws.com:8443/" },
    { ...target(), url: "https://secret@shopify.s3.amazonaws.com/" },
    { ...target(), resourceUrl: `${target().resourceUrl}#secret` },
    { ...target(), parameters: [{ name: "file", value: "secret" }] },
    {
      ...target(),
      parameters: [
        { name: "key", value: "secret" },
        { name: "Key", value: "secret" },
      ],
    },
  ]) {
    const { executor } = setup(bad),
      source = await executor.executeVerified(step),
      uploader = createOracleSeedUploader(config, snapshot, shopId, assets, {
        authorize: ok,
        fetcher: async () => {
          posts++;
          return new Response();
        },
      });
    await assert.rejects(
      uploader.upload(source, bytes),
      (error) => matches("invalid-target")(error) && !String(error).includes("secret"),
    );
  }
  assert.equal(posts, 0);
});
test("network failure, rejection and redirects issue no receipt and cannot replay a target", async () => {
  for (const outcome of ["lost", "500", "302", "redirected"]) {
    const { executor } = setup(),
      source = await executor.executeVerified(step);
    let posts = 0;
    const uploader = createOracleSeedUploader(config, snapshot, shopId, assets, {
      authorize: ok,
      fetcher: async () => {
        posts++;
        if (outcome === "lost") throw new Error("authored-signed-value");
        const response = new Response(null, {
          status: outcome === "redirected" ? 200 : Number(outcome),
        });
        if (outcome === "redirected")
          Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    });
    await assert.rejects(
      uploader.upload(source, bytes),
      matches(outcome === "lost" ? "upload-outcome-unknown" : "upload-rejected"),
    );
    await assert.rejects(uploader.upload(source, bytes), matches("target-used"));
    assert.equal(posts, 1);
  }
});
test("fresh authorization denial stops POST, and concurrent callers can send a target only once", async () => {
  const { executor } = setup(),
    source = await executor.executeVerified(step);
  let posts = 0;
  const denied = createOracleSeedUploader(config, snapshot, shopId, assets, {
    authorize: async () => {
      throw new Error("private approval context");
    },
    fetcher: async () => {
      posts++;
      return new Response();
    },
  });
  await assert.rejects(denied.upload(source, bytes), matches("authorization-denied"));
  assert.equal(posts, 0);
  const uploader = createOracleSeedUploader(config, snapshot, shopId, assets, {
    authorize: ok,
    fetcher: async () => {
      posts++;
      return new Response(null, { status: 204 });
    },
  });
  const results = await Promise.allSettled([
    uploader.upload(source, bytes),
    uploader.upload(source, bytes),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(posts, 1);
});
test("ledger accepts a scoped upload receipt for fileCreate but never treats it as processed image ownership", async () => {
  const { executor, ledger, fileWrites } = setup(),
    source = await executor.executeVerified(step),
    uploader = createOracleSeedUploader(config, snapshot, shopId, assets, {
      authorize: ok,
      fetcher: async () => new Response(null, { status: 204 }),
    }),
    receipt = await uploader.upload(source, bytes),
    key = seedBindingKey("staged-image-url", file);
  assert.throws(
    () => ledger.recordUpload({ kind: "verified-seed-upload" }),
    (e) => e instanceof SeedLedgerError && e.code === "unverified-execution",
  );
  ledger.recordUpload(receipt);
  assert.equal(ledger.get(key), target().resourceUrl);
  assert.throws(() => ledger.get(seedBindingKey("image-id", file)));
  assert.throws(() => ledger.recordUpload(receipt));
  const wrong = createOracleSeedBindingLedger(
    config,
    snapshot,
    "gid://shopify/Shop/2",
    "authored-token",
    assets,
  );
  assert.throws(() => wrong.recordUpload(receipt));
  const mismatch = createOracleSeedBindingLedger(config, snapshot, shopId, "authored-token", [
    { ...asset, sha256: "0".repeat(64) },
  ]);
  assert.throws(() => mismatch.recordUpload(receipt));
  const context = inspectVerifiedSeedExecution(source).context;
  context.template.variables = { originalSource: { $seedBinding: key, $seedType: "STAGED_URL" } };
  await assert.rejects(ledger.verifyBindings(context, { [key]: target().resourceUrl }));
  await assert.rejects(
    executor.executeVerified({
      ...step,
      requestIndex: 1,
      bindings: { [key]: "https://shopify.s3.amazonaws.com/other" },
    }),
  );
  assert.equal(fileWrites(), 0);
  const created = await executor.executeVerified({
    ...step,
    requestIndex: 1,
    bindings: { [key]: ledger.get(key) },
  });
  await ledger.record(created);
  assert.equal(ledger.get(seedBindingKey("image-id", file)), "gid://shopify/MediaImage/1");
  assert.equal(fileWrites(), 1);
});
