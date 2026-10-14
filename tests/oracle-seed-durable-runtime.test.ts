import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import { backupDigest } from "../tools/oracle/backup-audit.js";
import { openOracleSeedDurableRuntime } from "../tools/oracle/seed-durable-runtime.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";
import { seedBindingKey } from "../tools/oracle/seed-requests.js";

// Authored responses only. No actual Shopify authorization, backup, restoration or mutation evidence.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  snapshot = defaultFixture(),
  shopId = "gid://shopify/Shop/1",
  plan = buildOracleSeedPlan(config, snapshot),
  state = plan.states[0];
assert.ok(state);
const task = state.tasks.find((t) => t.resource === "page");
assert.ok(task);
const source = snapshotSchema.shape.pages.element.parse(task.source),
  id = "gid://shopify/Page/1",
  schema: unknown = JSON.parse(
    await readFile(new URL("./fixtures/oracle-seed-input-contracts.json", import.meta.url), "utf8"),
  ),
  step = {
    stateHash: state.hash,
    taskKey: task.key,
    kind: "task" as const,
    options: { mode: "create" as const },
    bindings: {},
  };
async function setup(failure = "", authorize: () => Promise<void> = async () => {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sop-durable-runtime-")));
  let calls = 0,
    writes = 0,
    denied = false;
  const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      // No API or storage request can happen before the journal reservation reaches disk.
      assert.match(
        JSON.parse(await readFile(join(directory, "seed-run.json"), "utf8")).pending,
        /^[a-f0-9]{64}$/,
      );
      const { query } = JSON.parse(String(init?.body)),
        shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } },
        reply = (data: unknown) =>
          Response.json({ data }, { headers: { "x-shopify-api-version": "2026-10" } });
      if (query.includes("OfflinePreviewSeedGuard"))
        return reply({
          shop: {
            ...shop,
            name: "Authored",
            currencyCode: "USD",
            ianaTimezone: "UTC",
            metafield: { value: "true" },
          },
          currentAppInstallation: { accessScopes: [{ handle: "write_content" }] },
        });
      if (query.includes("OfflinePreviewSeedAbsence"))
        return reply({
          shop,
          pages: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        });
      if (query.includes("OfflinePreviewSeedSource"))
        return reply({
          shop,
          nodes: [
            {
              __typename: "Page",
              id,
              handle: source.handle,
              title: source.title,
              body: source.bodyHtml,
              templateSuffix: source.templateSuffix,
              isPublished: true,
              seo: source.seo,
            },
          ],
        });
      if (query.includes("OfflinePreviewSeedIdentities")) {
        if (failure === "settle")
          await writeFile(join(directory, "seed-run.json"), "authored disk substitution");
        return reply({ shop, nodes: [{ __typename: "Page", id, handle: source.handle }] });
      }
      assert.ok(query.startsWith("mutation "));
      writes++;
      if (failure === "lost") throw new Error("authored lost acknowledgement");
      return reply({ pageCreate: { page: { id }, userErrors: [] } });
    },
    open = () =>
      openOracleSeedDurableRuntime(
        config,
        snapshot,
        shopId,
        "authored-token-never-persist",
        schema,
        [],
        directory,
        {
          authorize: async () => {
            await authorize();
            if (denied) throw new Error("authored denial");
          },
          fetcher,
        },
      );
  return {
    directory,
    open,
    deny: (value: boolean) => {
      denied = value;
    },
    calls: () => calls,
    writes: () => writes,
  };
}

test("verified execution commits only after source and binding checks; reopening suppresses the exact call without inventing restored ownership", async () => {
  const s = await setup();
  try {
    let runtime = await s.open();
    await runtime.execute(step);
    assert.equal(runtime.getBinding(seedBindingKey("page-id", source.handle)), id);
    const saved = await readFile(join(s.directory, "seed-run.json"), "utf8");
    assert.equal(JSON.parse(saved).pending, null);
    assert.equal(JSON.parse(saved).completed.length, 1);
    assert.equal(
      saved.includes("authored-token-never-persist") || saved.includes(source.bodyHtml),
      false,
    );
    await runtime.close();
    runtime = await s.open();
    const before = s.calls();
    await assert.rejects(runtime.execute(step), { code: "duplicate-operation" });
    // Defaults and unused bindings cannot turn the same compiled request into a new intent.
    await assert.rejects(
      runtime.execute({ ...step, requestIndex: 0, bindings: { ignored: "authored extra input" } }),
      { code: "duplicate-operation" },
    );
    assert.equal(s.calls(), before);
    assert.equal(s.writes(), 1);
    assert.throws(() => runtime.getBinding(seedBindingKey("page-id", source.handle)));
    await runtime.close();
  } finally {
    await rm(s.directory, { recursive: true, force: true });
  }
});

test("lost acknowledgement remains pending after restart and prevents every later network operation", async () => {
  const s = await setup("lost");
  try {
    let runtime = await s.open();
    await assert.rejects(runtime.execute(step), { code: "mutation-outcome-unknown" });
    await runtime.close();
    runtime = await s.open();
    assert.equal(runtime.status(), "recovery-required");
    const before = s.calls();
    await assert.rejects(runtime.execute(step), { code: "recovery-required" });
    await assert.rejects(
      runtime.registerEnvironment({ kind: "Location", id: "gid://shopify/Location/1" }),
      { code: "recovery-required" },
    );
    assert.equal(s.calls(), before);
    assert.equal(s.writes(), 1);
    await runtime.close();
  } finally {
    await rm(s.directory, { recursive: true, force: true });
  }
});

test("proven prewrite denial clears the reservation and permits a later authorized attempt", async () => {
  const s = await setup();
  try {
    const runtime = await s.open();
    s.deny(true);
    await assert.rejects(runtime.execute(step), { code: "authorization-denied" });
    assert.equal(s.calls(), 0);
    assert.equal(
      JSON.parse(await readFile(join(s.directory, "seed-run.json"), "utf8")).pending,
      null,
    );
    s.deny(false);
    await runtime.execute(step);
    assert.equal(s.writes(), 1);
    await runtime.close();
  } finally {
    await rm(s.directory, { recursive: true, force: true });
  }
});

test("journal replacement after an actual write prevents claiming durable completion and blocks further work", async () => {
  const s = await setup("settle");
  try {
    const runtime = await s.open();
    await assert.rejects(runtime.execute(step), { code: "journal-unavailable" });
    assert.equal(s.writes(), 1);
    assert.equal(runtime.status(), "recovery-required");
    await assert.rejects(runtime.execute(step), { code: "recovery-required" });
    assert.equal(s.writes(), 1);
    await runtime.close();
  } finally {
    await rm(s.directory, { recursive: true, force: true });
  }
});

test("close and a second operation cannot interrupt a reserved write while authorization awaits", async () => {
  let release: () => void = () => {},
    entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    s = await setup("", async () => {
      entered();
      await gate;
    });
  try {
    const runtime = await s.open(),
      pending = runtime.execute(step);
    await started;
    await assert.rejects(runtime.close(), { code: "concurrent-operation" });
    await assert.rejects(runtime.execute(step), { code: "concurrent-operation" });
    assert.equal(s.calls(), 0);
    release();
    await pending;
    await runtime.close();
    await assert.rejects(runtime.execute(step), { code: "closed" });
    assert.equal(s.writes(), 1);
  } finally {
    release();
    await rm(s.directory, { recursive: true, force: true });
  }
});

test("staged upload keeps signed values private and retains an uncertain POST across reopen", async () => {
  const imageTask = state?.tasks.find((t) => t.resource === "image");
  assert.ok(imageTask);
  const image = snapshotSchema.shape.products.element.shape.images.element.parse(imageTask.source),
    bytes = new Uint8Array([1, 2, 3]),
    assets = [{ file: image.file, bytes: bytes.length, sha256: backupDigest(bytes) }],
    contracts = {
      apiVersion: "2026-10",
      operations: [
        {
          name: "stagedUploadsCreate",
          args: [
            {
              name: "input",
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: {
                  kind: "LIST",
                  name: null,
                  ofType: {
                    kind: "NON_NULL",
                    name: null,
                    ofType: { kind: "INPUT_OBJECT", name: "StagedUploadInput" },
                  },
                },
              },
            },
          ],
        },
      ],
      types: [
        {
          name: "StagedUploadInput",
          kind: "INPUT_OBJECT",
          enumValues: null,
          inputFields: ["resource", "filename", "mimeType", "httpMethod", "fileSize"].map(
            (name) => ({ name, type: { kind: "SCALAR", name: "String" } }),
          ),
        },
        { name: "String", kind: "SCALAR", enumValues: null, inputFields: null },
      ],
    },
    target = {
      url: "https://shopify-staged-uploads.storage.googleapis.com/",
      resourceUrl:
        "https://shopify-staged-uploads.storage.googleapis.com/tmp/private-signed-resource.png",
      parameters: [{ name: "policy", value: "private-signed-policy" }],
    };
  for (const lost of [false, true]) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "sop-durable-upload-")));
    let posts = 0;
    const fetcher: typeof fetch = async (_url, init) => {
        const { query } = JSON.parse(String(init?.body)),
          data = query.includes("OfflinePreviewSeedGuard")
            ? {
                shop: {
                  id: shopId,
                  myshopifyDomain: config.domain,
                  plan: { partnerDevelopment: true },
                  name: "Authored",
                  currencyCode: "USD",
                  ianaTimezone: "UTC",
                  metafield: { value: "true" },
                },
                currentAppInstallation: { accessScopes: [{ handle: "write_files" }] },
              }
            : { stagedUploadsCreate: { stagedTargets: [target], userErrors: [] } };
        return Response.json({ data }, { headers: { "x-shopify-api-version": "2026-10" } });
      },
      open = () =>
        openOracleSeedDurableRuntime(
          config,
          snapshot,
          shopId,
          "never-save-token",
          contracts,
          assets,
          directory,
          {
            authorize: async () => {},
            fetcher,
            uploadFetcher: async (_url, init) => {
              posts++;
              assert.equal(init?.headers, undefined);
              const saved = JSON.parse(await readFile(join(directory, "seed-run.json"), "utf8"));
              assert.match(saved.pending, /^[a-f0-9]{64}$/);
              if (lost) throw new Error("lost upload acknowledgement");
              return new Response(null, { status: 204 });
            },
          },
        );
    try {
      let runtime = await open();
      const proof = await runtime.execute({
        ...step,
        taskKey: imageTask.key,
        options: { mode: "create", imageBytes: bytes.length },
      });
      if (lost)
        await assert.rejects(runtime.upload(proof, bytes), { code: "upload-outcome-unknown" });
      else {
        await runtime.upload(proof, bytes);
        assert.equal(
          runtime.getBinding(seedBindingKey("staged-image-url", image.file)),
          target.resourceUrl,
        );
        await assert.rejects(runtime.upload(proof, bytes), { code: "duplicate-operation" });
      }
      const raw = await readFile(join(directory, "seed-run.json"), "utf8");
      assert.equal(/private-signed|never-save-token|storage.googleapis.com/.test(raw), false);
      assert.equal(posts, 1);
      await runtime.close();
      runtime = await open();
      if (lost) {
        assert.equal(runtime.status(), "recovery-required");
        await assert.rejects(runtime.upload(proof, bytes), { code: "recovery-required" });
      }
      assert.throws(() => runtime.getBinding(seedBindingKey("staged-image-url", image.file)));
      await runtime.close();
      assert.equal(posts, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
