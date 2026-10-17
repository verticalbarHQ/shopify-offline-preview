import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import { backupDigest } from "../tools/oracle/backup-audit.js";
import type { SeedExecutionStep, VerifiedSeedExecution } from "../tools/oracle/seed-execution.js";
import { inspectVerifiedSeedGenerated } from "../tools/oracle/seed-generated.js";
import { buildOracleSeedPlan, type SeedTask } from "../tools/oracle/seed-plan.js";
import {
  compileSeedStepTemplates,
  resolveSeedRequest,
  seedBindingKey,
} from "../tools/oracle/seed-requests.js";
import {
  createOracleSeedStateDriver,
  type SeedDriverPort,
} from "../tools/oracle/seed-state-driver.js";
import {
  inspectVerifiedSeedState,
  type SeedTaskStatus,
} from "../tools/oracle/seed-state-reader.js";

// Authored protocol model only. Stub receipts deliberately fail real inspectors; none are Shopify evidence.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  snapshot = defaultFixture(),
  plan = buildOracleSeedPlan(config, snapshot),
  schema: unknown = JSON.parse(
    await readFile(
      new URL("./fixtures/oracle-seed-all-input-contracts.json", import.meta.url),
      "utf8",
    ),
  ),
  bytes = new Uint8Array([1, 2, 3]),
  images = [
    ...new Set(
      plan.states.flatMap((state) =>
        state.tasks.filter((task) => task.resource === "image").map((task) => task.identity[0]),
      ),
    ),
  ].map((file) => {
    assert.ok(file);
    return { file, bytes: bytes.length, sha256: backupDigest(bytes) };
  });

function model() {
  const values = new Map<string, string>([
      [seedBindingKey("inventory-location"), "gid://shopify/Location/1"],
      [seedBindingKey("online-store-publication"), "gid://shopify/Publication/1"],
    ]),
    records = new Map<string, { task: SeedTask; order: string[] }>(),
    published = new Set<string>(),
    receipts = new WeakMap<VerifiedSeedExecution, SeedExecutionStep>(),
    calls: SeedExecutionStep[] = [],
    creations = new Map<string, number>();
  let nextId = 10,
    guards = 0,
    uploads = 0,
    failBefore = "",
    closed = false;
  const getTask = (stateHash: string, taskKey: string) => {
      const task = plan.states
        .find((state) => state.hash === stateHash)
        ?.tasks.find((task) => task.key === taskKey);
      assert.ok(task);
      return task;
    },
    rootKey = (task: SeedTask) =>
      task.resource === "article"
        ? seedBindingKey("article-id", ...task.identity)
        : seedBindingKey(`${task.resource}-id`, task.identity[0] ?? ""),
    get = (key: string) => {
      const value = values.get(key);
      assert.ok(value, `Missing authored binding ${key}`);
      return value;
    },
    describe = async (_stateHash: string, taskKey: string): Promise<SeedTaskStatus> => {
      const record = records.get(taskKey);
      if (!record) return { status: "absent" };
      return {
        status: "owned",
        sourceHash: record.task.sourceHash,
        variantIds:
          record.task.resource === "product"
            ? snapshotSchema.shape.products.element
                .parse(record.task.source)
                .variants.map((variant) => variant.id)
            : [],
        collectionMembers:
          record.task.resource === "collection"
            ? snapshotSchema.shape.collections.element.parse(record.task.source).products
            : [],
        collectionOrder: [...record.order],
      };
    },
    verify = async (stateHash: string, taskKey: string) => {
      const task = getTask(stateHash, taskKey),
        record = records.get(taskKey);
      assert.equal(record?.task.sourceHash, task.sourceHash);
      if (task.resource === "collection")
        assert.deepEqual(
          record?.order,
          snapshotSchema.shape.collections.element.parse(task.source).products,
        );
    },
    port: SeedDriverPort = {
      getBinding: get,
      verifyStore: async () => {
        assert.equal(closed, false);
        guards++;
      },
      describeTask: describe,
      verifyTask: verify,
      publicationState: async (_state, key) => published.has(key),
      verifyState: async (stateHash) => {
        const state = plan.states.find((state) => state.hash === stateHash);
        assert.ok(state);
        for (const task of state.tasks) {
          await verify(stateHash, task.key);
          if (["product", "collection"].includes(task.resource))
            assert.equal(published.has(task.key), true);
        }
        return Object.freeze({ kind: "verified-seed-state" });
      },
      observeGenerated: async (stateHash, key) => {
        await verify(stateHash, key);
        return Object.freeze({ kind: "verified-seed-generated" });
      },
      execute: async (step) => {
        assert.equal(closed, false);
        const task = getTask(step.stateHash, step.taskKey),
          template = compileSeedStepTemplates(task, step.kind, step.options, step.observedOrder)[
            step.requestIndex ?? 0
          ];
        assert.ok(template);
        resolveSeedRequest(template, step.bindings);
        calls.push(structuredClone(step));
        if (failBefore === step.taskKey) throw new Error("authored prewrite denial");
        const receipt: VerifiedSeedExecution = Object.freeze({ kind: "verified-seed-execution" });
        receipts.set(receipt, step);
        if (step.kind === "publication") {
          published.add(task.key);
          return receipt;
        }
        if (step.kind === "collection-order") {
          const current = records.get(task.key);
          assert.ok(current);
          current.order = [...snapshotSchema.shape.collections.element.parse(task.source).products];
          return receipt;
        }
        if (template.operation === "stagedUploadsCreate") return receipt;
        const before = records.get(task.key);
        if (step.options.mode === "create") {
          assert.equal(before, undefined);
          creations.set(task.key, (creations.get(task.key) ?? 0) + 1);
          const kinds: Record<string, string> = {
            image: "MediaImage",
            product: "Product",
            collection: "Collection",
            page: "Page",
            blog: "Blog",
            article: "Article",
            menu: "Menu",
          };
          values.set(rootKey(task), `gid://shopify/${kinds[task.resource]}/${nextId++}`);
        } else assert.ok(before);
        if (task.resource === "product") {
          const source = snapshotSchema.shape.products.element.parse(task.source),
            previous = before
              ? snapshotSchema.shape.products.element
                  .parse(before.task.source)
                  .variants.map((variant) => variant.id)
              : [],
            expectedNew = source.variants
              .filter((variant) => !previous.includes(variant.id))
              .map((variant) => variant.id);
          if (before) assert.deepEqual(step.options.newVariantIds, expectedNew);
          for (const old of previous.filter(
            (id) => !source.variants.some((variant) => variant.id === id),
          ))
            values.delete(seedBindingKey("variant-id", source.handle, old));
          for (const variant of source.variants) {
            const key = seedBindingKey("variant-id", source.handle, variant.id);
            if (!values.has(key)) values.set(key, `gid://shopify/ProductVariant/${nextId++}`);
          }
        }
        if (task.resource === "collection") {
          if (before)
            assert.deepEqual(
              step.options.collectionMembers,
              snapshotSchema.shape.collections.element.parse(before.task.source).products,
            );
          values.set(
            seedBindingKey("collection-source-id", task.identity[0] ?? ""),
            `gid://shopify/CollectionConditionsSource/1`,
          );
        }
        if (task.resource === "image") {
          assert.ok(values.has(seedBindingKey("staged-image-url", task.identity[0] ?? "")));
          values.set(
            seedBindingKey("image-url", task.identity[0] ?? ""),
            `https://cdn.shopify.com/authored-${nextId}.png`,
          );
        }
        records.set(task.key, {
          task,
          order:
            task.resource === "collection"
              ? [...snapshotSchema.shape.collections.element.parse(task.source).products].reverse()
              : [],
        });
        return receipt;
      },
      upload: async (receipt, content) => {
        const step = receipts.get(receipt);
        assert.ok(step);
        assert.deepEqual(content, bytes);
        uploads++;
        const task = getTask(step.stateHash, step.taskKey);
        values.set(
          seedBindingKey("staged-image-url", task.identity[0] ?? ""),
          "https://shopify-staged-uploads.storage.googleapis.com/tmp/authored.png",
        );
        return Object.freeze({ kind: "verified-seed-upload" });
      },
      close: async () => {
        closed = true;
      },
    };
  return {
    port,
    calls,
    creations,
    records,
    guards: () => guards,
    uploads: () => uploads,
    deny: (key: string) => {
      failBefore = key;
    },
  };
}

test("full seven-state protocol creates once, applies explicit variant/member changes, orders, publishes, and reuses verified state", async () => {
  const m = model(),
    driver = createOracleSeedStateDriver(
      config,
      snapshot,
      schema,
      images,
      m.port,
      async () => bytes,
    );
  let updates = 0;
  for (const state of plan.states) {
    const result = await driver.runState(state.hash),
      repeated = await driver.runState(state.hash);
    updates += result.counts.updated;
    assert.equal(result.generated.length, 46);
    assert.equal(result.captureReady, false);
    assert.deepEqual(repeated.counts, {
      created: 0,
      updated: 0,
      reused: 65,
      reordered: 0,
      published: 0,
    });
    assert.throws(() => inspectVerifiedSeedState(result.resourceState));
    const generated = result.generated[0];
    assert.ok(generated);
    assert.throws(() => inspectVerifiedSeedGenerated(generated));
  }
  assert.ok(updates > 0);
  assert.equal(m.creations.size, 65);
  assert.equal(
    [...m.creations.values()].every((count) => count === 1),
    true,
  );
  assert.equal(m.uploads(), 16);
  assert.ok(m.calls.some((call) => call.kind === "collection-order"));
  assert.equal(m.calls.filter((call) => call.kind === "publication").length, 41);
  const first = plan.states[0];
  assert.ok(first);
  await driver.runState(first.hash); // Returning to an earlier state updates owned resources instead of recreating them.
  assert.equal(
    [...m.creations.values()].every((count) => count === 1),
    true,
  );
  await driver.close();
  await assert.rejects(driver.runState(first.hash), { code: "closed" });
});

test("known prewrite failure resumes a partially applied state without repeating completed resource creates", async () => {
  const m = model(),
    state = plan.states[0];
  assert.ok(state);
  const page = state.tasks.find((task) => task.resource === "page");
  assert.ok(page);
  const driver = createOracleSeedStateDriver(
    config,
    snapshot,
    schema,
    images,
    m.port,
    async () => bytes,
  );
  m.deny(page.key);
  await assert.rejects(driver.runState(state.hash));
  assert.equal(m.records.has(page.key), false);
  m.deny("");
  const result = await driver.runState(state.hash);
  assert.ok(result.counts.reused > 0);
  assert.equal(
    [...m.creations.values()].every((count) => count === 1),
    true,
  );
  await driver.close();
});

test("all local image hashes and retained write contracts are checked before any port operation", async () => {
  const m = model(),
    state = plan.states[0];
  assert.ok(state);
  const driver = createOracleSeedStateDriver(
    config,
    snapshot,
    schema,
    images,
    m.port,
    async () => new Uint8Array([9]),
  );
  await assert.rejects(driver.runState(state.hash), { code: "local-image-mismatch" });
  assert.equal(m.guards(), 0);
  assert.equal(m.calls.length, 0);
  await driver.close();
  const contract = JSON.parse(
    await readFile(
      new URL("./fixtures/oracle-seed-all-input-contracts.json", import.meta.url),
      "utf8",
    ),
  );
  contract.operations = contract.operations.filter(
    (operation: { name: string }) => operation.name !== "fileCreate",
  );
  assert.throws(
    () =>
      createOracleSeedStateDriver(
        config,
        snapshot,
        contract,
        images,
        model().port,
        async () => bytes,
      ),
    { code: "schema-mismatch" },
  );
});

test("one state run owns the driver lane through asynchronous local reads and rejects close or another run", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    m = model(),
    state = plan.states[0];
  assert.ok(state);
  const driver = createOracleSeedStateDriver(config, snapshot, schema, images, m.port, async () => {
      await gate;
      return bytes;
    }),
    pending = driver.runState(state.hash);
  await assert.rejects(driver.runState(state.hash), { code: "concurrent-run" });
  await assert.rejects(driver.close(), { code: "concurrent-run" });
  assert.equal(m.calls.length, 0);
  release();
  await pending;
  await driver.close();
});
