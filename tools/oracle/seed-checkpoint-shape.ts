import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { snapshotSchema } from "../../packages/data/src/schema.js";
import type { ExpectedSeedIdentity } from "./seed-identities.js";
import type { buildOracleSeedPlan, SeedTask } from "./seed-plan.js";
import { seedBindingKey } from "./seed-requests.js";

const id = z.string().regex(/^gid:\/\/shopify\/[A-Za-z]+\/[1-9]\d*$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  handle = z.string().min(1).max(1024),
  imageUrl = z
    .string()
    .max(16384)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.port &&
          !url.hash &&
          ["cdn.shopify.com", "shopify-shop-assets.storage.googleapis.com"].includes(
            url.hostname,
          ) &&
          [...url.searchParams].every(
            ([key, value]) =>
              ["v", "width", "height", "dpr"].includes(key) && /^\d+(?:\.\d+)?$/.test(value),
          )
        );
      } catch {
        return false;
      }
    }),
  expected = z.union([
    z.strictObject({
      kind: z.literal("Product"),
      id,
      handle,
      requiredTag: z.literal("sop-fixture"),
    }),
    z.strictObject({
      kind: z.literal("ProductVariant"),
      id,
      productId: id,
      productHandle: handle,
      requiredTag: z.literal("sop-fixture"),
      selectedOptions: z
        .array(z.strictObject({ name: handle, value: z.string().max(1024) }))
        .max(3)
        .transform((values) =>
          values.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        ),
    }),
    z.strictObject({
      kind: z.literal("Collection"),
      id,
      handle,
      sourceId: id,
      sourceAppId: id.nullable(),
      members: z.array(z.strictObject({ id, handle })).max(250),
      ordered: z.boolean(),
    }),
    z.strictObject({ kind: z.enum(["Page", "Blog", "Menu"]), id, handle }),
    z.strictObject({ kind: z.literal("Article"), id, handle, blogId: id, blogHandle: handle }),
    z.strictObject({
      kind: z.literal("MediaImage"),
      id,
      url: imageUrl,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    z.strictObject({ kind: z.literal("Location"), id }),
    z.strictObject({ kind: z.literal("Publication"), id, catalogId: id, appId: id }),
  ]),
  provenance = z.strictObject({
    stateHash: digest,
    taskKey: z.string().min(1).max(2048),
    sourceHash: digest,
  });
export const seedCheckpointSchema = z.strictObject({
  version: z.literal(1),
  domain: z.string(),
  apiVersion: z.literal("2026-10"),
  shopId: id,
  fixtureHash: digest,
  entries: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(4096),
        value: z.union([id, imageUrl]),
        expected,
        originalImage: z
          .strictObject({
            bytes: z
              .number()
              .int()
              .positive()
              .max(32 * 1024 * 1024),
            sha256: digest,
          })
          .optional(),
        provenance: provenance.nullable(),
      }),
    )
    .max(20000),
});
export type SeedCheckpointData = z.infer<typeof seedCheckpointSchema>;
export type SeedCheckpointEntry = SeedCheckpointData["entries"][number];

/** Reconstruct every permitted alias from the pinned fixture, rather than accepting arbitrary serialized keys. */
export function assertSeedCheckpointBindings(
  plan: ReturnType<typeof buildOracleSeedPlan>,
  data: SeedCheckpointData,
  assets: readonly { file: string; bytes: number; sha256: string }[],
): { task: SeedTask; stateHash: string; id: string }[] {
  const entries = new Map(data.entries.map((entry) => [entry.key, entry]));
  if (entries.size !== data.entries.length) throw new Error();
  const allowed = new Map<string, SeedCheckpointEntry>(),
    roots: { task: SeedTask; stateHash: string; id: string }[] = [],
    get = (key: string) => {
      const entry = entries.get(key);
      if (!entry) throw new Error();
      return entry.value;
    };
  for (const entry of data.entries) {
    if (!entry.provenance) {
      const key =
        entry.expected.kind === "Location"
          ? seedBindingKey("inventory-location")
          : entry.expected.kind === "Publication"
            ? seedBindingKey("online-store-publication")
            : "";
      if (!key || key !== entry.key || entry.value !== entry.expected.id || entry.originalImage)
        throw new Error();
      allowed.set(key, entry);
      continue;
    }
    const task = plan.states
      .find((state) => state.hash === entry.provenance?.stateHash)
      ?.tasks.find((task) => task.key === entry.provenance?.taskKey);
    if (!task || task.sourceHash !== entry.provenance.sourceHash) throw new Error();
    const rootKey =
      task.resource === "article"
        ? seedBindingKey("article-id", ...task.identity)
        : seedBindingKey(`${task.resource}-id`, task.identity[0] ?? "");
    if (entry.key !== rootKey) continue;
    roots.push({ task, stateHash: entry.provenance.stateHash, id: entry.value });
    const add = (
        key: string,
        value: string,
        expected: SeedCheckpointEntry["expected"],
        originalImage?: { bytes: number; sha256: string },
      ) => {
        if (allowed.has(key)) throw new Error();
        allowed.set(key, {
          key,
          value,
          expected,
          provenance: entry.provenance,
          ...(originalImage ? { originalImage } : {}),
        });
      },
      handle = task.identity[0] ?? "",
      rootId = entry.value;
    if (task.resource === "product") {
      const source = snapshotSchema.shape.products.element.parse(task.source);
      if (!source.tags.includes("sop-fixture")) throw new Error();
      add(rootKey, rootId, {
        kind: "Product",
        id: rootId,
        handle: source.handle,
        requiredTag: "sop-fixture",
      });
      for (const variant of source.variants) {
        const key = seedBindingKey("variant-id", source.handle, variant.id),
          variantId = get(key);
        add(key, variantId, {
          kind: "ProductVariant",
          id: variantId,
          productId: rootId,
          productHandle: source.handle,
          requiredTag: "sop-fixture",
          selectedOptions: variant.optionValues
            .map((value) => ({ ...value }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        });
      }
    } else if (task.resource === "collection") {
      const source = snapshotSchema.shape.collections.element.parse(task.source),
        prior = entry.expected;
      if (prior.kind !== "Collection" || (prior.ordered && source.sortOrder !== "manual"))
        throw new Error();
      const sourceKey = seedBindingKey("collection-source-id", handle),
        expected: ExpectedSeedIdentity = {
          kind: "Collection",
          id: rootId,
          handle,
          sourceId: get(sourceKey),
          sourceAppId: prior.sourceAppId,
          members: source.products.map((handle) => ({
            id: get(seedBindingKey("product-id", handle)),
            handle,
          })),
          ordered: prior.ordered,
        };
      add(rootKey, rootId, expected);
      add(sourceKey, expected.sourceId, expected);
    } else if (task.resource === "image") {
      const source = snapshotSchema.shape.products.element.shape.images.element.parse(task.source),
        asset = assets.find((asset) => asset.file === source.file);
      if (!asset || entry.expected.kind !== "MediaImage") throw new Error();
      const expected: ExpectedSeedIdentity = {
          kind: "MediaImage",
          id: rootId,
          url: get(seedBindingKey("image-url", source.file)),
          width: source.width,
          height: source.height,
        },
        original = { bytes: asset.bytes, sha256: asset.sha256 };
      add(rootKey, rootId, expected, original);
      add(seedBindingKey("image-url", source.file), expected.url, expected, original);
    } else if (task.resource === "article") {
      const source = snapshotSchema.shape.blogs.element.shape.articles.element.parse(task.source);
      add(rootKey, rootId, {
        kind: "Article",
        id: rootId,
        handle: source.handle,
        blogId: get(seedBindingKey("blog-id", handle)),
        blogHandle: handle,
      });
    } else if (task.resource === "page" || task.resource === "blog" || task.resource === "menu") {
      const kind = task.resource === "page" ? "Page" : task.resource === "blog" ? "Blog" : "Menu";
      add(rootKey, rootId, { kind, id: rootId, handle });
    } else throw new Error();
  }
  if (allowed.size !== entries.size) throw new Error();
  for (const [key, entry] of entries) {
    if (!isDeepStrictEqual(entry, allowed.get(key))) throw new Error();
  }
  return roots;
}
