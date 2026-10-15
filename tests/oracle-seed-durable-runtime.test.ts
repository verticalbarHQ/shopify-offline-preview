import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import { backupDigest } from "../tools/oracle/backup-audit.js";
import { createOracleSeedBindingLedger } from "../tools/oracle/seed-binding-ledger.js";
import { openOracleSeedDurableRuntime } from "../tools/oracle/seed-durable-runtime.js";
import {
  applyOracleSeedGenerated,
  inspectVerifiedSeedGenerated,
} from "../tools/oracle/seed-generated.js";
import { openOracleSeedJournal } from "../tools/oracle/seed-journal.js";
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
    denied = false,
    drift = "",
    sourceReads = 0,
    generatedReads = 0,
    updateLost = false,
    driftAt = Infinity;
  const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      const { query } = JSON.parse(String(init?.body)),
        shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } },
        reply = (data: unknown) =>
          Response.json({ data }, { headers: { "x-shopify-api-version": "2026-10" } });
      if (query.startsWith("mutation "))
        assert.match(
          JSON.parse(await readFile(join(directory, "seed-run.json"), "utf8")).pending,
          /^[a-f0-9]{64}$/,
        );
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
            metafield: drift === "guard" ? null : { value: "true" },
          },
          currentAppInstallation: { accessScopes: [{ handle: "write_content" }] },
        });
      if (query.includes("OfflinePreviewSeedAbsence"))
        return reply({
          shop,
          pages: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        });
      if (query.includes("OfflinePreviewSeedSource")) {
        sourceReads++;
        return reply({
          shop,
          nodes: [
            {
              __typename: "Page",
              id,
              handle: source.handle,
              title: source.title,
              body:
                drift === "source" || sourceReads >= driftAt
                  ? "authored changed body"
                  : source.bodyHtml,
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
      if (query.includes("OfflinePreviewSeedGenerated")) {
        generatedReads++;
        return reply({
          shop,
          nodes: [
            {
              __typename: "Page",
              id,
              handle:
                drift === "generated" && generatedReads % 2 === 0
                  ? "authored changed handle"
                  : source.handle,
            },
          ],
        });
      }
      if (query.includes("OfflinePreviewSeedIdentities")) {
        if (failure === "settle")
          await writeFile(join(directory, "seed-run.json"), "authored disk substitution");
        return reply({
          shop,
          nodes: [
            { __typename: "Page", id, handle: drift === "identity" ? "changed" : source.handle },
          ],
        });
      }
      assert.ok(query.startsWith("mutation "));
      writes++;
      if (failure === "lost" || (updateLost && query.includes("pageUpdate")))
        throw new Error("authored lost acknowledgement");
      return reply({
        pageCreate: { page: { id }, userErrors: [] },
        pageUpdate: { page: { id }, userErrors: [] },
      });
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
    loseUpdate: () => {
      updateLost = true;
    },
    drift: (value: string) => {
      drift = value;
      driftAt = value === "source-after" ? sourceReads + 2 : Infinity;
    },
    fetcher,
  };
}

test("verified checkpoint restores owned binding only after fresh reads and permits a guarded update without replaying create", async () => {
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
    assert.equal(runtime.getBinding(seedBindingKey("page-id", source.handle)), id);
    await runtime.execute({
      ...step,
      options: { mode: "update" },
      bindings: { [seedBindingKey("page-id", source.handle)]: id },
    });
    assert.equal(s.writes(), 2);
    await runtime.close();
  } finally {
    await rm(s.directory, { recursive: true, force: true });
  }
});

test("causal updates permit returning to a known state after another verified update while suppressing immediate or reopened replay", async () => {
  const s = await setup();
  try {
    let runtime = await s.open();
    await runtime.execute(step);
    const update = {
        ...step,
        options: { mode: "update" as const },
        bindings: { [seedBindingKey("page-id", source.handle)]: id },
      },
      other = plan.states.find(
        (state) =>
          state.hash !== step.stateHash &&
          state.tasks.some(
            (candidate) =>
              candidate.key === step.taskKey && candidate.sourceHash === task.sourceHash,
          ),
      );
    assert.ok(other);
    await runtime.execute(update);
    const before = s.calls();
    await assert.rejects(runtime.execute(update), { code: "duplicate-operation" });
    assert.equal(s.calls(), before);
    await runtime.execute({ ...update, stateHash: other.hash });
    await runtime.execute(update);
    assert.equal(s.writes(), 4);
    await runtime.close();
    runtime = await s.open();
    const reopenedCalls = s.calls();
    await assert.rejects(runtime.execute(update), { code: "duplicate-operation" });
    assert.equal(s.calls(), reopenedCalls);
    assert.equal(s.writes(), 4);
    await runtime.close();
  } finally {
    await rm(s.directory, { recursive: true, force: true });
  }
});
test("a lost causal update never allows a later state transition to bypass the pending barrier", async () => {
  const s = await setup();
  try {
    let runtime = await s.open();
    await runtime.execute(step);
    s.loseUpdate();
    await assert.rejects(
      runtime.execute({
        ...step,
        options: { mode: "update" },
        bindings: { [seedBindingKey("page-id", source.handle)]: id },
      }),
      { code: "mutation-outcome-unknown" },
    );
    await runtime.close();
    runtime = await s.open();
    const before = s.calls();
    await assert.rejects(runtime.describeTask(step.stateHash, step.taskKey), {
      code: "recovery-required",
    });
    await assert.rejects(runtime.execute(step), { code: "recovery-required" });
    assert.equal(s.calls(), before);
    assert.equal(s.writes(), 2);
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
test("real state reader distinguishes absent and verified owned tasks, rejects drift, and cannot certify a partially seeded fixture", async () => {
  const s = await setup();
  try {
    const runtime = await s.open();
    await runtime.verifyStore();
    assert.deepEqual(await runtime.describeTask(step.stateHash, step.taskKey), {
      status: "absent",
    });
    await assert.rejects(runtime.verifyTask(step.stateHash, step.taskKey), {
      code: "unverified-task",
    });
    await runtime.execute(step);
    const description = await runtime.describeTask(step.stateHash, step.taskKey);
    assert.equal(description.status, "owned");
    if (description.status !== "owned") throw new Error();
    assert.equal(description.sourceHash, task.sourceHash);
    await runtime.verifyTask(step.stateHash, step.taskKey);
    await assert.rejects(runtime.verifyState(step.stateHash), { code: "unverified-task" });
    s.drift("source");
    await assert.rejects(runtime.describeTask(step.stateHash, step.taskKey), {
      code: "source-mismatch",
    });
    assert.equal(s.writes(), 1);
    await runtime.close();
  } finally {
    await rm(s.directory, { recursive: true, force: true });
  }
});

test("restored ownership produces fresh generated evidence without another write or journal mutation", async () => {
  const s = await setup();
  try {
    let runtime = await s.open();
    const execution = await runtime.execute(step),
      live = await runtime.recordGenerated(execution);
    assert.equal(inspectVerifiedSeedGenerated(live).metadata.id, id);
    await runtime.close();
    runtime = await s.open();
    const before = await readFile(join(s.directory, "seed-run.json"), "utf8"),
      generated = await runtime.observeGenerated(step.stateHash, step.taskKey),
      view = inspectVerifiedSeedGenerated(generated),
      request = plan.requests.find((request) => request.stateHash === step.stateHash);
    assert.ok(request);
    const calibrated = applyOracleSeedGenerated(config, snapshot, shopId, request.caseId, [
      generated,
    ]);
    assert.equal(view.metadata.id, id);
    assert.equal(calibrated.snapshot.pages.find((page) => page.handle === source.handle)?.id, "1");
    assert.equal(calibrated.captureReady, false);
    assert.equal(s.writes(), 1);
    assert.equal(await readFile(join(s.directory, "seed-run.json"), "utf8"), before);
    for (const drift of ["source", "identity", "generated"]) {
      s.drift(drift);
      await assert.rejects(runtime.observeGenerated(step.stateHash, step.taskKey));
      assert.equal(s.writes(), 1);
    }
    s.drift("");
    await runtime.observeGenerated(step.stateHash, step.taskKey);
    await runtime.close();
  } finally {
    await rm(s.directory, { recursive: true, force: true });
  }
});

test("checkpoint restoration rejects source, identity, marker and late source drift without adopting any binding or replaying writes", async () => {
  for (const drift of ["source", "identity", "guard", "source-after"]) {
    const s = await setup();
    try {
      let runtime = await s.open();
      await runtime.execute(step);
      await runtime.close();
      const original = await readFile(join(s.directory, "seed-run.json"), "utf8"),
        document = JSON.parse(original);
      s.drift(drift);
      const journal = await openOracleSeedJournal(s.directory, document.scope),
        stored = journal.checkpoint();
      assert.ok(stored);
      const ledger = createOracleSeedBindingLedger(
        config,
        snapshot,
        shopId,
        "authored",
        [],
        s.fetcher,
      );
      await assert.rejects(ledger.restoreCheckpoint(stored), { code: "restoration-failed" });
      assert.throws(() => ledger.get(seedBindingKey("page-id", source.handle)), {
        code: "binding-missing",
      });
      await journal.close();
      assert.equal(await readFile(join(s.directory, "seed-run.json"), "utf8"), original);
      assert.equal(s.writes(), 1);
      s.drift("");
      runtime = await s.open();
      assert.equal(runtime.getBinding(seedBindingKey("page-id", source.handle)), id);
      await runtime.close();
    } finally {
      await rm(s.directory, { recursive: true, force: true });
    }
  }
});

test("plain and serialized checkpoint flags cannot claim restored ownership", async () => {
  const s = await setup();
  try {
    const ledger = createOracleSeedBindingLedger(
      config,
      snapshot,
      shopId,
      "authored",
      [],
      s.fetcher,
    );
    await assert.rejects(ledger.restoreCheckpoint({ kind: "stored-seed-checkpoint" }), {
      code: "restoration-failed",
    });
    assert.equal(s.calls(), 0);
    const runtime = await s.open();
    await runtime.execute(step);
    await runtime.close();
    const document = JSON.parse(await readFile(join(s.directory, "seed-run.json"), "utf8")),
      journal = await openOracleSeedJournal(s.directory, document.scope),
      stored = journal.checkpoint();
    assert.ok(stored);
    await assert.rejects(ledger.restoreCheckpoint(JSON.parse(JSON.stringify(stored))), {
      code: "restoration-failed",
    });
    const restoring = ledger.restoreCheckpoint(stored);
    await assert.rejects(
      ledger.registerEnvironment({ kind: "Location", id: "gid://shopify/Location/1" }),
      { code: "concurrent-record" },
    );
    assert.throws(() => ledger.checkpoint(), { code: "concurrent-record" });
    await restoring;
    assert.equal(ledger.get(seedBindingKey("page-id", source.handle)), id);
    assert.equal(s.writes(), 1);
    await journal.close();
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
