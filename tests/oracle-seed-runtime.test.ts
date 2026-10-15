import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import { inspectPreparedSeedCheckpoint } from "../tools/oracle/seed-binding-ledger.js";
import { inspectVerifiedSeedExecution } from "../tools/oracle/seed-execution.js";
import { openOracleSeedJournal, seedJournalFingerprint } from "../tools/oracle/seed-journal.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";
import { seedBindingKey } from "../tools/oracle/seed-requests.js";
import { createOracleSeedRuntime, SeedRuntimeError } from "../tools/oracle/seed-runtime.js";

// Authored API fixtures only. There is no real backup/wipe authorization or Shopify mutation here.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1",
  snapshot = defaultFixture(),
  plan = buildOracleSeedPlan(config, snapshot),
  state = plan.states[0];
assert.ok(state);
const page = state.tasks.find((t) => t.resource === "page");
assert.ok(page);
const source = snapshotSchema.shape.pages.element.parse(page.source),
  pageId = "gid://shopify/Page/1",
  schema: unknown = JSON.parse(
    await readFile(new URL("./fixtures/oracle-seed-input-contracts.json", import.meta.url), "utf8"),
  ),
  step = {
    stateHash: state.hash,
    taskKey: page.key,
    kind: "task" as const,
    options: { mode: "create" as const },
    bindings: {},
  },
  code = (value: string) => (error: unknown) =>
    error instanceof SeedRuntimeError && error.code === value;
function setup(failure = "", authorize: () => Promise<void> = async () => {}) {
  const events: string[] = [];
  let writes = 0,
    created = false;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      query = String(body.query),
      shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } };
    const reply = (data: unknown) =>
      Response.json({ data }, { headers: { "x-shopify-api-version": "2026-10" } });
    if (query.includes("OfflinePreviewSeedGuard")) {
      events.push("guard");
      return reply({
        shop: {
          ...shop,
          name: "Authored",
          currencyCode: "USD",
          ianaTimezone: "UTC",
          metafield: failure === "guard" ? null : { value: "true" },
        },
        currentAppInstallation: { accessScopes: [{ handle: "write_content" }] },
      });
    }
    if (query.includes("OfflinePreviewSeedAbsence")) {
      events.push("absence");
      return reply({
        shop,
        pages: {
          nodes: created ? [{ id: pageId, handle: source.handle }] : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    }
    if (query.includes("OfflinePreviewSeedSource")) {
      events.push("source");
      return reply({
        shop,
        nodes: [
          {
            __typename: "Page",
            id: failure === "update-id" && writes > 1 ? "gid://shopify/Page/2" : pageId,
            handle: source.handle,
            title: source.title,
            body: failure === "source" ? "changed" : source.bodyHtml,
            templateSuffix: source.templateSuffix,
            isPublished: true,
            seoTitle:
              source.seo?.title == null
                ? null
                : { value: source.seo.title, type: "single_line_text_field" },
            seoDescription:
              source.seo?.description == null
                ? null
                : { value: source.seo.description, type: "single_line_text_field" },
          },
        ],
      });
    }
    if (query.includes("OfflinePreviewSeedIdentities")) {
      events.push("identity");
      return reply({
        shop,
        nodes: [
          {
            __typename: "Page",
            id: pageId,
            handle: failure === "record" ? "other" : source.handle,
          },
        ],
      });
    }
    assert.ok(query.startsWith("mutation "));
    events.push("write");
    writes++;
    created = true;
    if (failure === "lost") throw new Error("private transport detail");
    return reply({
      pageCreate: { page: { id: pageId }, userErrors: [] },
      pageUpdate: {
        page: { id: failure === "update-id" ? "gid://shopify/Page/2" : pageId },
        userErrors: [],
      },
    });
  };
  const runtime = createOracleSeedRuntime(config, snapshot, shopId, "authored", schema, [], {
    authorize: async () => {
      events.push("authorize");
      await authorize();
    },
    fetcher,
  });
  return { runtime, events, writes: () => writes };
}
test("default runtime performs mandatory source readback and records the binding before returning execution", async () => {
  const s = setup(),
    proof = await s.runtime.execute(step);
  assert.equal(inspectVerifiedSeedExecution(proof).payload.page !== undefined, true);
  assert.equal(s.runtime.getBinding(seedBindingKey("page-id", source.handle)), pageId);
  assert.deepEqual(s.events, ["authorize", "guard", "absence", "write", "source", "identity"]);
  await s.runtime.execute({
    ...step,
    options: { mode: "update" },
    bindings: { [seedBindingKey("page-id", source.handle)]: pageId },
  });
  assert.equal(s.writes(), 2);
  assert.equal(s.runtime.status(), "accepting-steps");
});
test("lost result, failed source equality or failed ledger registration blocks further writes in this runtime", async () => {
  for (const failure of ["lost", "source", "record"]) {
    const s = setup(failure);
    await assert.rejects(s.runtime.execute(step));
    assert.equal(s.writes(), 1);
    assert.equal(s.runtime.status(), "recovery-required");
    await assert.rejects(s.runtime.execute(step), code("recovery-required"));
    assert.equal(s.writes(), 1);
    assert.throws(() => s.runtime.getBinding(seedBindingKey("page-id", source.handle)));
  }
});
test("prewrite approval/guard denial creates no write and does not pretend an uncertain mutation occurred", async () => {
  const rejected = setup("", async () => {
    throw new Error("No actual owner approval");
  });
  await assert.rejects(rejected.runtime.execute(step));
  assert.equal(rejected.writes(), 0);
  assert.equal(rejected.runtime.status(), "accepting-steps");
  const guarded = setup("guard");
  await assert.rejects(guarded.runtime.execute(step));
  assert.equal(guarded.writes(), 0);
  assert.equal(guarded.runtime.status(), "accepting-steps");
});
test("runtime owns the full execute-through-record lane, including awaits in authorization", async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    s = setup("", () => blocked),
    pending = s.runtime.execute(step);
  await assert.rejects(s.runtime.execute(step), code("concurrent-operation"));
  assert.equal(s.writes(), 0);
  release();
  await pending;
  assert.equal(s.writes(), 1);
});

test("an update response with identical source on a different ID cannot replace the sent target binding", async () => {
  const s = setup("update-id");
  await s.runtime.execute(step);
  await assert.rejects(
    s.runtime.execute({
      ...step,
      options: { mode: "update" },
      bindings: { [seedBindingKey("page-id", source.handle)]: pageId },
    }),
  );
  assert.equal(s.runtime.status(), "recovery-required");
  assert.equal(s.runtime.getBinding(seedBindingKey("page-id", source.handle)), pageId);
});

function imageSetup(failure = "") {
  const task = state?.tasks.find((t) => t.resource === "image");
  assert.ok(task);
  const image = snapshotSchema.shape.products.element.shape.images.element.parse(task.source),
    bytes = new Uint8Array([1, 2, 3]),
    asset = {
      file: image.file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    target = {
      url:
        failure === "target"
          ? "https://example.invalid/"
          : "https://shopify-staged-uploads.storage.googleapis.com/",
      resourceUrl: "https://shopify-staged-uploads.storage.googleapis.com/tmp/authored/image.png",
      parameters: [{ name: "key", value: "tmp/authored/image.png" }],
    },
    named = (name: string, kind = "SCALAR") => ({ kind, name }),
    list = (name: string) => ({
      kind: "NON_NULL",
      name: null,
      ofType: {
        kind: "LIST",
        name: null,
        ofType: { kind: "NON_NULL", name: null, ofType: named(name, "INPUT_OBJECT") },
      },
    }),
    contracts = {
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
          inputFields: ["resource", "filename", "mimeType", "httpMethod", "fileSize"].map(
            (name) => ({ name, type: named("String") }),
          ),
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
    events: string[] = [],
    shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } },
    fetcher: typeof fetch = async (_url, init) => {
      if (init?.method === "GET") {
        assert.equal(init.headers, undefined);
        events.push("original-bytes");
        return new Response(failure === "hash" ? new Uint8Array([4, 5, 6]) : bytes);
      }
      const { query, variables } = JSON.parse(String(init?.body)),
        reply = (data: unknown) =>
          Response.json({ data }, { headers: { "x-shopify-api-version": "2026-10" } });
      if (
        query.includes("OfflinePreviewSeedGuard") ||
        query.includes("OfflinePreviewOracleIdentity")
      )
        return reply({
          shop: {
            ...shop,
            name: "Authored",
            currencyCode: "USD",
            ianaTimezone: "UTC",
            metafield: { value: "true" },
          },
          currentAppInstallation: { accessScopes: [{ handle: "write_files" }] },
        });
      if (query.includes("OfflinePreviewSeedIdentities"))
        return reply({
          shop,
          nodes: [
            {
              __typename: "MediaImage",
              id: "gid://shopify/MediaImage/1",
              alt: failure === "alt" ? "wrong" : image.alt,
              fileStatus: "READY",
              image: {
                url: "https://cdn.shopify.com/image.png",
                width: image.width,
                height: image.height,
              },
              originalSource: {
                url: "https://cdn.shopify.com/original.png",
                fileSize: bytes.length,
              },
            },
          ],
        });
      if (query.includes("stagedUploadsCreate")) {
        events.push("stage");
        return reply({ stagedUploadsCreate: { stagedTargets: [target], userErrors: [] } });
      }
      assert.ok(query.includes("fileCreate"));
      assert.equal(variables.files[0].originalSource, target.resourceUrl);
      events.push("create");
      return reply({
        fileCreate: { files: [{ id: "gid://shopify/MediaImage/1" }], userErrors: [] },
      });
    },
    create = () =>
      createOracleSeedRuntime(config, snapshot, shopId, "authored", contracts, [asset], {
        authorize: async () => {},
        fetcher,
        uploadFetcher: async (_url, init) => {
          assert.equal(init?.headers, undefined);
          assert.equal(init?.credentials, "omit");
          events.push("upload");
          if (failure === "upload") throw new Error("unknown acknowledgement");
          return new Response(null, { status: 204 });
        },
      }),
    imageStep = {
      ...step,
      taskKey: task.key,
      options: { mode: "create" as const, imageBytes: bytes.length },
    };
  return { runtime: create(), create, bytes, imageStep, image, events, target };
}
test("runtime registers staged bytes only after upload acknowledgement, then verifies original bytes, alt and processed image before binding", async () => {
  const s = imageSetup(),
    stagedKey = seedBindingKey("staged-image-url", s.image.file),
    proof = await s.runtime.execute(s.imageStep);
  assert.throws(() => s.runtime.getBinding(stagedKey));
  await assert.rejects(
    s.runtime.execute({
      ...s.imageStep,
      requestIndex: 1,
      bindings: { [stagedKey]: s.target.resourceUrl },
    }),
  );
  assert.deepEqual(s.events, ["stage"]);
  await s.runtime.upload(proof, s.bytes);
  assert.equal(s.runtime.getBinding(stagedKey), s.target.resourceUrl);
  assert.throws(() => s.runtime.getBinding(seedBindingKey("image-id", s.image.file)));
  await s.runtime.execute({
    ...s.imageStep,
    requestIndex: 1,
    bindings: { [stagedKey]: s.target.resourceUrl },
  });
  assert.equal(
    s.runtime.getBinding(seedBindingKey("image-id", s.image.file)),
    "gid://shopify/MediaImage/1",
  );
  assert.deepEqual(s.events.slice(0, 3), ["stage", "upload", "create"]);
  assert.ok(s.events.filter((e) => e === "original-bytes").length >= 2);
});
test("processed image bindings restore only after fresh original-byte and alt verification, without persisting staged upload credentials", async () => {
  const s = imageSetup(),
    directory = await realpath(await mkdtemp(join(tmpdir(), "sop-image-checkpoint-")));
  try {
    const staged = await s.runtime.execute(s.imageStep);
    await s.runtime.upload(staged, s.bytes);
    await s.runtime.execute({
      ...s.imageStep,
      requestIndex: 1,
      bindings: { [seedBindingKey("staged-image-url", s.image.file)]: s.target.resourceUrl },
    });
    const prepared = s.runtime.checkpoint(),
      data = inspectPreparedSeedCheckpoint(prepared);
    assert.equal(data.entries.length, 2);
    assert.equal(JSON.stringify(data).includes(s.target.resourceUrl), false);
    const journal = await openOracleSeedJournal(
        directory,
        seedJournalFingerprint("authored image scope"),
      ),
      intent = seedJournalFingerprint("authored image completion");
    await journal.begin(intent);
    await journal.settle(intent, "verified", prepared);
    const stored = journal.checkpoint();
    assert.ok(stored);
    const restored = s.create(),
      before = s.events.filter((event) => event === "original-bytes").length;
    await restored.restoreCheckpoint(stored);
    assert.equal(
      restored.getBinding(seedBindingKey("image-id", s.image.file)),
      "gid://shopify/MediaImage/1",
    );
    assert.equal(
      restored.getBinding(seedBindingKey("image-url", s.image.file)),
      "https://cdn.shopify.com/image.png",
    );
    assert.throws(() => restored.getBinding(seedBindingKey("staged-image-url", s.image.file)));
    assert.ok(s.events.filter((event) => event === "original-bytes").length > before);
    assert.equal(s.events.filter((event) => event === "create").length, 1);
    assert.deepEqual(inspectPreparedSeedCheckpoint(restored.checkpoint()), data);
    await journal.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("invalid staged target, lost upload acknowledgement and mismatched actual image never permit further runtime writes", async () => {
  for (const failure of ["target", "upload", "hash", "alt"]) {
    const s = imageSetup(failure);
    if (failure === "target") await assert.rejects(s.runtime.execute(s.imageStep));
    else {
      const proof = await s.runtime.execute(s.imageStep);
      if (failure === "upload") await assert.rejects(s.runtime.upload(proof, s.bytes));
      else {
        await s.runtime.upload(proof, s.bytes);
        await assert.rejects(
          s.runtime.execute({
            ...s.imageStep,
            requestIndex: 1,
            bindings: { [seedBindingKey("staged-image-url", s.image.file)]: s.target.resourceUrl },
          }),
        );
      }
    }
    assert.equal(s.runtime.status(), "recovery-required");
    const before = s.events.length;
    await assert.rejects(s.runtime.execute(s.imageStep), code("recovery-required"));
    assert.equal(s.events.length, before);
    assert.throws(() => s.runtime.getBinding(seedBindingKey("image-id", s.image.file)));
  }
});
