import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import { readOracleIdentity } from "./admin-read.js";
import {
  assertSeedCheckpointBindings,
  type SeedCheckpointData,
  seedCheckpointSchema,
} from "./seed-checkpoint-shape.js";
import { waitOracleSeedCollectionOrder, waitOracleSeedImage } from "./seed-completion.js";
import {
  inspectVerifiedSeedExecution,
  type SeedExecutionContext,
  type VerifiedSeedExecution,
} from "./seed-execution.js";
import {
  assertOracleSeedHandleAbsent,
  assertOracleSeedIdentity,
  type ExpectedSeedIdentity,
  readOracleSeedIdentities,
  readOracleSeedVariants,
  verifyOracleSeedImageBytes,
} from "./seed-identities.js";
import { inspectStoredSeedCheckpoint, type StoredSeedCheckpoint } from "./seed-journal.js";
import { buildOracleSeedPlan, type SeedTask } from "./seed-plan.js";
import { type SeedValue, seedBindingKey } from "./seed-requests.js";
import {
  assertOracleSeedSource,
  readOracleSeedSource,
  type SeedSourceKind,
} from "./seed-source.js";
import { inspectVerifiedSeedUpload, type VerifiedSeedUpload } from "./seed-upload.js";
import { assertOracleStore, type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export interface PreparedSeedCheckpoint {
  readonly kind: "prepared-seed-checkpoint";
}
export interface VerifiedSeedOwnership {
  readonly kind: "verified-seed-ownership";
}
export interface SeedOwnershipContext {
  domain: string;
  apiVersion: "2026-10";
  expectedShopId: string;
  fixtureHash: string;
  stateHash: string;
  task: { key: string; sourceHash: string };
  kind: "task";
}
const ownershipObservations = new WeakMap<
  VerifiedSeedOwnership,
  { owner: object; entry: Entry; key: string; context: SeedOwnershipContext }
>();
export function inspectVerifiedSeedOwnership(receipt: VerifiedSeedOwnership): SeedOwnershipContext {
  const observation = ownershipObservations.get(receipt);
  if (!observation) throw new SeedLedgerError("unverified-execution");
  return structuredClone(observation.context);
}
interface RestoredSeedOwnership {
  readonly kind: "restored-seed-ownership";
}
type Provenance = NonNullable<SeedCheckpointData["entries"][number]["provenance"]>;
const preparedCheckpoints = new WeakMap<PreparedSeedCheckpoint, SeedCheckpointData>(),
  restoredOwnership = new WeakMap<RestoredSeedOwnership, Provenance>();
export function inspectPreparedSeedCheckpoint(receipt: PreparedSeedCheckpoint): SeedCheckpointData {
  const data = preparedCheckpoints.get(receipt);
  if (!data) throw new SeedLedgerError("unverified-execution");
  return structuredClone(data);
}

interface Entry {
  value: string;
  expected: ExpectedSeedIdentity;
  originalImage?: { sha256: string; bytes: number };
  proof: VerifiedSeedExecution | RestoredSeedOwnership | null;
}
const ownershipRevisions = new WeakMap<NonNullable<Entry["proof"]>, string>();
function ownershipRevision(proof: NonNullable<Entry["proof"]>): string {
  let revision = ownershipRevisions.get(proof);
  if (!revision) {
    revision = randomUUID();
    ownershipRevisions.set(proof, revision);
  }
  return revision;
}
export class SeedLedgerError extends Error {
  constructor(
    readonly code:
      | "scope-mismatch"
      | "unverified-execution"
      | "binding-missing"
      | "binding-mismatch"
      | "unsupported-step"
      | "read-back-failed"
      | "concurrent-record"
      | "restoration-failed",
  ) {
    super(`Oracle seed binding ledger failed: ${code}`);
    this.name = "SeedLedgerError";
  }
}
export function createOracleSeedBindingLedger(
  config: OracleConfig,
  snapshot: Snapshot,
  shopId: string,
  token: string,
  images: readonly { file: string; bytes: number; sha256: string }[],
  fetcher: typeof fetch = fetch,
) {
  const pinned = oracleConfigSchema.parse(config),
    plan = buildOracleSeedPlan(pinned, snapshot),
    assets = structuredClone(images);
  if (!/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId) || !token.trim() || plan.issues.length)
    throw new SeedLedgerError("scope-mismatch");
  const entries = new Map<string, Entry>(),
    owner = {},
    staged = new Map<string, VerifiedSeedUpload>(),
    usedUploads = new WeakSet<VerifiedSeedUpload>(),
    used = new WeakSet<VerifiedSeedExecution>();
  let recording = false;
  function scope(context: SeedExecutionContext) {
    const task = plan.states
      .find((s) => s.hash === context.stateHash)
      ?.tasks.find((t) => t.key === context.task.key);
    if (
      context.domain !== pinned.domain ||
      context.apiVersion !== pinned.apiVersion ||
      context.expectedShopId !== shopId ||
      context.fixtureHash !== plan.fixtureHash ||
      !task ||
      task.sourceHash !== context.task.sourceHash
    )
      throw new SeedLedgerError("scope-mismatch");
    return task;
  }
  async function check(entry: Entry) {
    const rows = await readOracleSeedIdentities(
        pinned,
        token,
        shopId,
        entry.expected.kind,
        [entry.expected.id],
        fetcher,
      ),
      row = rows[0];
    if (!row) throw new SeedLedgerError("read-back-failed");
    assertOracleSeedIdentity(entry.expected, row);
    if (entry.originalImage) {
      if (row.__typename !== "MediaImage") throw new SeedLedgerError("binding-mismatch");
      await verifyOracleSeedImageBytes(row, entry.originalImage, fetcher);
    }
  }
  function current(key: string): Entry {
    const entry = entries.get(key);
    if (!entry) throw new SeedLedgerError("binding-missing");
    return entry;
  }
  function identityId(value: unknown, kind: string): string {
    const parsed = z
      .object({ id: z.string().regex(new RegExp(`^gid://shopify/${kind}/[1-9]\\d*$`)) })
      .parse(value);
    return parsed.id;
  }
  const tuple = (values: { name: string; value: string }[]) =>
    JSON.stringify([...values].sort((a, b) => a.name.localeCompare(b.name)));
  return {
    /** Ownership of a recorded source, including restored roots; writable fields still require fresh source comparison. */
    async observeOwnedTask(stateHash: string, taskKey: string): Promise<VerifiedSeedOwnership> {
      if (recording) throw new SeedLedgerError("concurrent-record");
      const task = plan.states
        .find((state) => state.hash === stateHash)
        ?.tasks.find((task) => task.key === taskKey);
      if (!task) throw new SeedLedgerError("scope-mismatch");
      const key =
          task.resource === "article"
            ? seedBindingKey("article-id", ...task.identity)
            : seedBindingKey(`${task.resource}-id`, task.identity[0] ?? ""),
        entry = current(key);
      if (!entry.proof) throw new SeedLedgerError("unverified-execution");
      const provenance =
        entry.proof.kind === "restored-seed-ownership"
          ? restoredOwnership.get(entry.proof)
          : (() => {
              const { context } = inspectVerifiedSeedExecution(entry.proof);
              return {
                stateHash: context.stateHash,
                taskKey: context.task.key,
                sourceHash: context.task.sourceHash,
              };
            })();
      // An unchanged task may be reused in another fixture state; changed source requires a real update first.
      if (
        !provenance ||
        provenance.taskKey !== taskKey ||
        provenance.sourceHash !== task.sourceHash
      )
        throw new SeedLedgerError("scope-mismatch");
      try {
        await check(entry);
      } catch {
        throw new SeedLedgerError("read-back-failed");
      }
      if (entries.get(key) !== entry) throw new SeedLedgerError("unverified-execution");
      const receipt: VerifiedSeedOwnership = Object.freeze({ kind: "verified-seed-ownership" });
      ownershipObservations.set(receipt, {
        owner,
        entry,
        key,
        context: {
          domain: pinned.domain,
          apiVersion: pinned.apiVersion,
          expectedShopId: shopId,
          fixtureHash: plan.fixtureHash,
          stateHash,
          task: { key: taskKey, sourceHash: task.sourceHash },
          kind: "task",
        },
      });
      return receipt;
    },
    async assertOwned(receipt: VerifiedSeedOwnership): Promise<ExpectedSeedIdentity> {
      if (recording) throw new SeedLedgerError("concurrent-record");
      const observation = ownershipObservations.get(receipt);
      if (
        !observation ||
        observation.owner !== owner ||
        entries.get(observation.key) !== observation.entry
      )
        throw new SeedLedgerError("unverified-execution");
      try {
        await check(observation.entry);
      } catch {
        throw new SeedLedgerError("read-back-failed");
      }
      if (recording || entries.get(observation.key) !== observation.entry)
        throw new SeedLedgerError("unverified-execution");
      return structuredClone(observation.entry.expected);
    },
    /** Only recorded opaque proofs can prepare a persistable ownership checkpoint. No staged URLs are retained. */
    checkpoint(): PreparedSeedCheckpoint {
      if (recording) throw new SeedLedgerError("concurrent-record");
      try {
        const data = seedCheckpointSchema.parse({
          version: 1,
          domain: pinned.domain,
          apiVersion: pinned.apiVersion,
          shopId,
          fixtureHash: plan.fixtureHash,
          entries: [...entries].map(([key, entry]) => {
            let provenance: Provenance | null = null;
            if (entry.proof) {
              if (entry.proof.kind === "restored-seed-ownership") {
                const restored = restoredOwnership.get(entry.proof);
                if (!restored) throw new SeedLedgerError("unverified-execution");
                provenance = restored;
              } else {
                const { context } = inspectVerifiedSeedExecution(entry.proof);
                provenance = {
                  stateHash: context.stateHash,
                  taskKey: context.task.key,
                  sourceHash: context.task.sourceHash,
                };
              }
            }
            return {
              key,
              value: entry.value,
              expected: entry.expected,
              provenance,
              revision: entry.proof ? ownershipRevision(entry.proof) : null,
              ...(entry.originalImage ? { originalImage: entry.originalImage } : {}),
            };
          }),
        });
        assertSeedCheckpointBindings(plan, data, assets);
        const receipt: PreparedSeedCheckpoint = Object.freeze({ kind: "prepared-seed-checkpoint" });
        preparedCheckpoints.set(receipt, data);
        return receipt;
      } catch (error) {
        if (error instanceof SeedLedgerError) throw error;
        throw new SeedLedgerError("binding-mismatch");
      }
    },
    /** Trusted private journal provenance plus fresh API reads restore bindings, never a historical execution receipt. */
    async restoreCheckpoint(receipt: StoredSeedCheckpoint): Promise<void> {
      if (recording) throw new SeedLedgerError("concurrent-record");
      if (entries.size || staged.size) throw new SeedLedgerError("binding-mismatch");
      recording = true;
      try {
        const data = seedCheckpointSchema.parse(inspectStoredSeedCheckpoint(receipt));
        if (
          data.domain !== pinned.domain ||
          data.apiVersion !== pinned.apiVersion ||
          data.shopId !== shopId ||
          data.fixtureHash !== plan.fixtureHash
        )
          throw new Error();
        const roots = assertSeedCheckpointBindings(plan, data, assets),
          additions = new Map<string, Entry>(),
          legacyRevisions = new Map<string, string>();
        for (const entry of data.entries) {
          let proof: RestoredSeedOwnership | null = null;
          if (entry.provenance) {
            proof = Object.freeze({ kind: "restored-seed-ownership" });
            restoredOwnership.set(proof, entry.provenance);
            const key = JSON.stringify(entry.provenance),
              revision = entry.revision ?? legacyRevisions.get(key) ?? randomUUID();
            legacyRevisions.set(key, revision);
            ownershipRevisions.set(proof, revision);
          }
          additions.set(entry.key, {
            value: entry.value,
            expected: entry.expected,
            proof,
            ...(entry.originalImage ? { originalImage: entry.originalImage } : {}),
          });
        }
        const get = (key: string) => {
            const value = additions.get(key)?.value;
            if (!value) throw new Error();
            return value;
          },
          guard = async () => {
            const identity = await readOracleIdentity(pinned, token, async (url, init) => {
              const response = await fetcher(url, init);
              if (response.headers.get("x-shopify-api-version") !== pinned.apiVersion)
                throw new Error();
              const bytes = await response.arrayBuffer();
              if (bytes.byteLength > 65536) throw new Error();
              return new Response(bytes, { status: response.status, headers: response.headers });
            });
            assertOracleStore(pinned, identity);
            if (identity.id !== shopId) throw new Error();
          },
          sources = async () => {
            const kinds: Partial<Record<SeedTask["resource"], SeedSourceKind>> = {
              product: "Product",
              collection: "Collection",
              page: "Page",
              blog: "Blog",
              article: "Article",
              menu: "Menu",
            };
            for (const root of roots) {
              if (root.task.resource === "image") {
                const source = snapshotSchema.shape.products.element.shape.images.element.parse(
                    root.task.source,
                  ),
                  node = (
                    await readOracleSeedIdentities(
                      pinned,
                      token,
                      shopId,
                      "MediaImage",
                      [root.id],
                      fetcher,
                    )
                  )[0];
                if (node?.__typename !== "MediaImage" || node.alt !== source.alt) throw new Error();
              } else {
                const kind = kinds[root.task.resource];
                if (!kind) throw new Error();
                const actual = await readOracleSeedSource(
                  pinned,
                  token,
                  shopId,
                  kind,
                  root.id,
                  kind === "Product" ? get(seedBindingKey("inventory-location")) : undefined,
                  fetcher,
                );
                assertOracleSeedSource(root.task, actual, get);
                if (root.task.resource === "product" && actual.__typename === "Product") {
                  const source = snapshotSchema.shape.products.element.parse(root.task.source),
                    byTuple = new Map(
                      actual.variants.nodes.map((variant) => [
                        tuple(variant.selectedOptions),
                        variant.id,
                      ]),
                    );
                  if (byTuple.size !== source.variants.length) throw new Error();
                  for (const variant of source.variants) {
                    if (
                      byTuple.get(tuple(variant.optionValues)) !==
                      get(seedBindingKey("variant-id", source.handle, variant.id))
                    )
                      throw new Error();
                  }
                }
              }
            }
          };
        await guard();
        await sources();
        const checked = new Set<string>();
        for (const entry of additions.values()) {
          const key = JSON.stringify([entry.expected, entry.originalImage]);
          if (!checked.has(key)) {
            await check(entry);
            checked.add(key);
          }
        }
        await sources();
        await guard();
        // Atomic adoption: any earlier failure leaves this new ledger entirely empty.
        for (const [key, entry] of additions) entries.set(key, entry);
      } catch {
        throw new SeedLedgerError("restoration-failed");
      } finally {
        recording = false;
      }
    },
    /** Fresh expectation for a recorded fixture resource or an explicitly selected environment binding. */
    async verifyExpected(key: string, requireOwnership = false): Promise<ExpectedSeedIdentity> {
      const entry = current(key);
      if (requireOwnership && !entry.proof) throw new SeedLedgerError("unverified-execution");
      try {
        await check(entry);
      } catch {
        throw new SeedLedgerError("read-back-failed");
      }
      if (entries.get(key) !== entry) throw new SeedLedgerError("unverified-execution");
      return structuredClone(entry.expected);
    },
    /** Requires this exact execution to be the current recorded owner of its resource, then rereads identity. */
    async assertRecorded(receipt: VerifiedSeedExecution): Promise<ExpectedSeedIdentity> {
      let record: ReturnType<typeof inspectVerifiedSeedExecution>;
      try {
        record = inspectVerifiedSeedExecution(receipt);
      } catch {
        throw new SeedLedgerError("unverified-execution");
      }
      const task = scope(record.context);
      if (record.context.kind !== "task") throw new SeedLedgerError("unsupported-step");
      const key =
        task.resource === "article"
          ? seedBindingKey("article-id", task.identity[0] ?? "", task.identity[1] ?? "")
          : task.resource === "image"
            ? seedBindingKey("image-id", task.identity[0] ?? "")
            : seedBindingKey(`${task.resource}-id`, task.identity[0] ?? "");
      const entry = current(key);
      if (entry.proof !== receipt) throw new SeedLedgerError("unverified-execution");
      try {
        await check(entry);
      } catch {
        throw new SeedLedgerError("read-back-failed");
      }
      if (entries.get(key) !== entry) throw new SeedLedgerError("unverified-execution");
      return structuredClone(entry.expected);
    },
    get(key: string): string {
      const upload = staged.get(key);
      if (upload) return inspectVerifiedSeedUpload(upload).resourceUrl;
      return current(key).value;
    },
    /** A transport acknowledgement is a staged source, never processed-image ownership. */
    recordUpload(receipt: VerifiedSeedUpload): void {
      if (recording) throw new SeedLedgerError("concurrent-record");
      let record: ReturnType<typeof inspectVerifiedSeedUpload>;
      try {
        record = inspectVerifiedSeedUpload(receipt);
      } catch {
        throw new SeedLedgerError("unverified-execution");
      }
      const task = scope(record.context),
        asset = assets.find((a) => a.file === record.file),
        key = seedBindingKey("staged-image-url", record.file);
      if (
        task.resource !== "image" ||
        task.identity[0] !== record.file ||
        !asset ||
        asset.bytes !== record.bytes ||
        asset.sha256 !== record.sha256 ||
        usedUploads.has(receipt) ||
        staged.has(key)
      )
        throw new SeedLedgerError("binding-mismatch");
      staged.set(key, receipt);
      usedUploads.add(receipt);
    },
    /** Explicit read-only environment choices are not fixture ownership or mutation authorization. */
    async registerEnvironment(
      expected: Extract<ExpectedSeedIdentity, { kind: "Location" | "Publication" }>,
    ) {
      if (recording) throw new SeedLedgerError("concurrent-record");
      if (expected.kind !== "Location" && expected.kind !== "Publication")
        throw new SeedLedgerError("unsupported-step");
      const copy = structuredClone(expected),
        key =
          copy.kind === "Location"
            ? seedBindingKey("inventory-location")
            : seedBindingKey("online-store-publication");
      const entry: Entry = { value: copy.id, expected: copy, proof: null };
      recording = true;
      try {
        await check(entry);
        entries.set(key, entry);
      } catch {
        throw new SeedLedgerError("read-back-failed");
      } finally {
        recording = false;
      }
    },
    /** Only a live-process guarded execution receipt followed by actual read-back can add owned bindings. */
    async record(receipt: VerifiedSeedExecution): Promise<void> {
      if (recording) throw new SeedLedgerError("concurrent-record");
      recording = true;
      try {
        let record: ReturnType<typeof inspectVerifiedSeedExecution>;
        try {
          record = inspectVerifiedSeedExecution(receipt);
        } catch {
          throw new SeedLedgerError("unverified-execution");
        }
        if (used.has(receipt)) throw new SeedLedgerError("unverified-execution");
        const task = scope(record.context),
          additions = new Map<string, Entry>(),
          deletions: string[] = [];
        if (record.context.kind === "collection-order" && task.resource === "collection") {
          const source = snapshotSchema.shape.collections.element.parse(task.source),
            key = seedBindingKey("collection-id", source.handle),
            before = current(key);
          if (
            before.expected.kind !== "Collection" ||
            !before.proof ||
            record.context.template.operation !== "collectionReorderProducts" ||
            record.variables.id !== before.value
          )
            throw new SeedLedgerError("binding-mismatch");
          const expected = structuredClone(before.expected),
            byHandle = new Map(expected.members.map((m) => [m.handle, m]));
          if (source.sortOrder !== "manual" || source.products.length !== expected.members.length)
            throw new SeedLedgerError("binding-mismatch");
          expected.members = source.products.map((handle) => {
            const member = byHandle.get(handle);
            if (!member) throw new SeedLedgerError("binding-mismatch");
            return member;
          });
          expected.ordered = true;
          const job = z.object({ id: z.string() }).safeParse(record.payload.job);
          if (!job.success) throw new SeedLedgerError("binding-mismatch");
          try {
            await waitOracleSeedCollectionOrder(pinned, token, shopId, job.data.id, expected, {
              fetcher,
            });
          } catch {
            throw new SeedLedgerError("read-back-failed");
          }
          const sourceKey = seedBindingKey("collection-source-id", source.handle),
            priorSource = current(sourceKey);
          if (!priorSource.proof || priorSource.value !== expected.sourceId)
            throw new SeedLedgerError("binding-mismatch");
          entries.set(key, { ...before, expected, proof: receipt });
          entries.set(sourceKey, { ...priorSource, expected, proof: receipt });
          used.add(receipt);
          return;
        }
        if (record.context.kind !== "task") throw new SeedLedgerError("unsupported-step");
        async function add(
          key: string,
          value: string,
          expected: ExpectedSeedIdentity,
          originalImage?: { sha256: string; bytes: number },
        ) {
          const before = entries.get(key);
          if (
            record.context.options.mode === "update" &&
            (!before?.proof || before.value !== value)
          )
            throw new SeedLedgerError("binding-mismatch");
          if (record.context.options.mode === "create" && before)
            throw new SeedLedgerError("binding-mismatch");
          const entry: Entry = {
            value,
            expected,
            proof: receipt,
            ...(originalImage ? { originalImage } : {}),
          };
          await check(entry);
          additions.set(key, entry);
        }
        try {
          if (task.resource === "product") {
            const source = snapshotSchema.shape.products.element.parse(task.source),
              id = identityId(record.payload.product, "Product");
            if (!source.tags.includes("sop-fixture")) throw new SeedLedgerError("binding-mismatch");
            await add(seedBindingKey("product-id", source.handle), id, {
              kind: "Product",
              id,
              handle: source.handle,
              requiredTag: "sop-fixture",
            });
            const actual = await readOracleSeedVariants(pinned, token, shopId, id, fetcher),
              byTuple = new Map(actual.map((v) => [tuple(v.selectedOptions), v]));
            if (actual.length !== source.variants.length || byTuple.size !== actual.length)
              throw new SeedLedgerError("binding-mismatch");
            for (const variant of source.variants) {
              const found = byTuple.get(
                tuple(variant.optionValues.map((o) => ({ name: o.name, value: o.value }))),
              );
              if (!found) throw new SeedLedgerError("binding-mismatch");
              const expected: ExpectedSeedIdentity = {
                kind: "ProductVariant",
                id: found.id,
                productId: id,
                productHandle: source.handle,
                requiredTag: "sop-fixture",
                selectedOptions: found.selectedOptions,
              };
              assertOracleSeedIdentity(expected, found);
              additions.set(seedBindingKey("variant-id", source.handle, variant.id), {
                value: found.id,
                expected,
                proof: receipt,
              });
            }
            for (const key of entries.keys()) {
              const parts: unknown = JSON.parse(key);
              if (
                Array.isArray(parts) &&
                parts[0] === "variant-id" &&
                parts[1] === source.handle &&
                !additions.has(key)
              )
                deletions.push(key);
            }
          } else if (task.resource === "collection") {
            const source = snapshotSchema.shape.collections.element.parse(task.source),
              id = identityId(record.payload.collection, "Collection");
            const node = (
              await readOracleSeedIdentities(pinned, token, shopId, "Collection", [id], fetcher)
            )[0];
            if (node?.__typename !== "Collection" || node.sources.length !== 1 || !node.sources[0])
              throw new SeedLedgerError("binding-mismatch");
            const owned = node.sources[0],
              expected: ExpectedSeedIdentity = {
                kind: "Collection",
                id,
                handle: source.handle,
                sourceId: owned.id,
                sourceAppId: owned.app?.id ?? null,
                members: source.products.map((handle) => ({
                  id: current(seedBindingKey("product-id", handle)).value,
                  handle,
                })),
                ordered: false,
              };
            await add(seedBindingKey("collection-id", source.handle), id, expected);
            const key = seedBindingKey("collection-source-id", source.handle),
              prior = entries.get(key);
            if (
              record.context.options.mode === "update" &&
              (!prior?.proof || prior.value !== owned.id)
            )
              throw new SeedLedgerError("binding-mismatch");
            additions.set(key, { value: owned.id, expected, proof: receipt });
          } else if (task.resource === "image") {
            if (
              record.context.template.operation !== "fileCreate" ||
              record.context.options.mode !== "create"
            )
              throw new SeedLedgerError("unsupported-step");
            const source = snapshotSchema.shape.products.element.shape.images.element.parse(
                task.source,
              ),
              asset = assets.find((a) => a.file === source.file),
              files = z
                .array(z.object({ id: z.string() }))
                .length(1)
                .parse(record.payload.files),
              id = identityId(files[0], "MediaImage");
            if (!asset) throw new SeedLedgerError("binding-mismatch");
            const node = await waitOracleSeedImage(
              pinned,
              token,
              shopId,
              id,
              {
                width: source.width,
                height: source.height,
                bytes: asset.bytes,
                sha256: asset.sha256,
              },
              { fetcher },
            );
            if (!node.image) throw new SeedLedgerError("binding-mismatch");
            const expected: ExpectedSeedIdentity = {
                kind: "MediaImage",
                id,
                url: node.image.url,
                width: source.width,
                height: source.height,
              },
              original = { bytes: asset.bytes, sha256: asset.sha256 };
            await add(seedBindingKey("image-id", source.file), id, expected, original);
            additions.set(seedBindingKey("image-url", source.file), {
              value: node.image.url,
              expected,
              originalImage: original,
              proof: receipt,
            });
          } else if (task.resource === "article") {
            const source = snapshotSchema.shape.blogs.element.shape.articles.element.parse(
                task.source,
              ),
              blog = task.identity[0];
            if (!blog) throw new SeedLedgerError("binding-mismatch");
            const id = identityId(record.payload.article, "Article"),
              blogId = current(seedBindingKey("blog-id", blog)).value;
            await add(seedBindingKey("article-id", blog, source.handle), id, {
              kind: "Article",
              id,
              handle: source.handle,
              blogId,
              blogHandle: blog,
            });
          } else if (
            task.resource === "page" ||
            task.resource === "blog" ||
            task.resource === "menu"
          ) {
            const kind =
                task.resource === "page" ? "Page" : task.resource === "blog" ? "Blog" : "Menu",
              handle = task.identity[0];
            if (!handle) throw new SeedLedgerError("binding-mismatch");
            const id = identityId(record.payload[task.resource], kind);
            await add(seedBindingKey(`${task.resource}-id`, handle), id, { kind, id, handle });
          } else throw new SeedLedgerError("unsupported-step");
        } catch (error) {
          if (error instanceof SeedLedgerError) throw error;
          throw new SeedLedgerError("read-back-failed");
        }
        for (const key of deletions) entries.delete(key);
        for (const [key, entry] of additions) entries.set(key, entry);
        used.add(receipt);
      } finally {
        recording = false;
      }
    },
    async verifyBindings(
      context: SeedExecutionContext,
      values: Readonly<Record<string, string>>,
    ): Promise<void> {
      const task = scope(context),
        required = new Set<string>();
      if (
        context.kind === "task" &&
        context.options.mode === "create" &&
        task.resource !== "image" &&
        task.resource !== "metaobject"
      ) {
        const kind =
          task.resource === "product"
            ? "Product"
            : task.resource === "collection"
              ? "Collection"
              : task.resource === "page"
                ? "Page"
                : task.resource === "blog"
                  ? "Blog"
                  : task.resource === "menu"
                    ? "Menu"
                    : "Article";
        const handle = task.identity[task.resource === "article" ? 1 : 0];
        if (!handle) throw new SeedLedgerError("binding-mismatch");
        const parent =
          task.resource === "article"
            ? current(seedBindingKey("blog-id", task.identity[0] ?? "")).value
            : undefined;
        try {
          await assertOracleSeedHandleAbsent(pinned, token, shopId, kind, handle, fetcher, parent);
        } catch {
          throw new SeedLedgerError("read-back-failed");
        }
      }
      function references(value: SeedValue) {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(references);
          return;
        }
        if (typeof value.$seedBinding === "string") required.add(value.$seedBinding);
        else Object.values(value).forEach(references);
      }
      Object.values(context.template.variables).forEach(references);
      const checked = new Set<Entry>();
      for (const key of required) {
        const upload = staged.get(key);
        if (upload) {
          const record = inspectVerifiedSeedUpload(upload);
          scope(record.context);
          if (
            task.resource !== "image" ||
            task.sourceHash !== record.context.task.sourceHash ||
            task.identity[0] !== record.file ||
            context.template.operation !== "fileCreate" ||
            !Object.hasOwn(values, key) ||
            values[key] !== record.resourceUrl
          )
            throw new SeedLedgerError("binding-mismatch");
          continue;
        }
        const entry = current(key);
        if (!Object.hasOwn(values, key) || values[key] !== entry.value)
          throw new SeedLedgerError("binding-mismatch");
        if (!checked.has(entry)) {
          try {
            await check(entry);
          } catch {
            throw new SeedLedgerError("read-back-failed");
          }
          checked.add(entry);
        }
      }
      if (
        context.kind === "task" &&
        context.options.mode === "update" &&
        task.resource === "collection"
      ) {
        const expected = current(seedBindingKey("collection-id", task.identity[0] ?? "")).expected;
        if (
          expected.kind !== "Collection" ||
          !context.options.collectionMembers ||
          JSON.stringify([...context.options.collectionMembers].sort()) !==
            JSON.stringify(expected.members.map((m) => m.handle).sort())
        )
          throw new SeedLedgerError("binding-mismatch");
      }
      if (context.kind === "collection-order") {
        const expected = current(seedBindingKey("collection-id", task.identity[0] ?? "")).expected;
        if (expected.kind !== "Collection") throw new SeedLedgerError("binding-mismatch");
        try {
          const node = (
            await readOracleSeedIdentities(
              pinned,
              token,
              shopId,
              "Collection",
              [expected.id],
              fetcher,
            )
          )[0];
          if (
            node?.__typename !== "Collection" ||
            node.sortOrder !== "MANUAL" ||
            !context.observedOrder ||
            JSON.stringify(node.products.nodes.map((p) => p.handle)) !==
              JSON.stringify(context.observedOrder)
          )
            throw new Error("Stale order");
        } catch {
          throw new SeedLedgerError("read-back-failed");
        }
      }
    },
  };
}
