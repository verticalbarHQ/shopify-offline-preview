import { z } from "zod";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
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
import { buildOracleSeedPlan } from "./seed-plan.js";
import { type SeedValue, seedBindingKey } from "./seed-requests.js";
import { inspectVerifiedSeedUpload, type VerifiedSeedUpload } from "./seed-upload.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

interface Entry {
  value: string;
  expected: ExpectedSeedIdentity;
  originalImage?: { sha256: string; bytes: number };
  proof: VerifiedSeedExecution | null;
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
      | "concurrent-record",
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
      if (expected.kind !== "Location" && expected.kind !== "Publication")
        throw new SeedLedgerError("unsupported-step");
      const copy = structuredClone(expected),
        key =
          copy.kind === "Location"
            ? seedBindingKey("inventory-location")
            : seedBindingKey("online-store-publication");
      const entry: Entry = { value: copy.id, expected: copy, proof: null };
      try {
        await check(entry);
      } catch {
        throw new SeedLedgerError("read-back-failed");
      }
      entries.set(key, entry);
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
            const node = (
              await readOracleSeedIdentities(pinned, token, shopId, "MediaImage", [id], fetcher)
            )[0];
            if (node?.__typename !== "MediaImage" || !node.image || !asset)
              throw new SeedLedgerError("binding-mismatch");
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
      if (context.options.mode === "update" && task.resource === "collection") {
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
