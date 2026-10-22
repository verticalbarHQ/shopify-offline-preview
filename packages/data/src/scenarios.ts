import { focalPointPercent, snapshotImages } from "./images.js";
import {
  type CompleteSnapshot,
  completeSnapshotSchema,
  type Snapshot,
  snapshotSchema,
} from "./schema.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** RFC 7396: arrays replace wholesale, null removes keys, inputs are never mutated. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!record(patch)) return structuredClone(patch);
  const output: Record<string, unknown> = record(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete output[key];
    else
      Object.defineProperty(output, key, {
        value: mergePatch(Object.hasOwn(output, key) ? output[key] : undefined, value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return output;
}

export function applyScenario(snapshot: Snapshot, name: string = "default"): Snapshot {
  if (name === "default") return structuredClone(snapshot);
  if (!Object.hasOwn(snapshot.scenarios, name)) throw new Error(`Unknown scenario: ${name}`);
  return snapshotSchema.parse(mergePatch(snapshot, snapshot.scenarios[name]));
}

/** Local source integrity; missing theme setting resources remain renderer diagnostics. */
export function validateSnapshotReferences(snapshot: Snapshot): void {
  function unique(values: string[], kind: string): void {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${kind}`);
  }
  unique(
    snapshot.products.map((p) => p.handle),
    "product handle",
  );
  for (const [kind, resources] of [
    ["product", snapshot.products],
    ["collection", snapshot.collections],
    ["page", snapshot.pages],
    ["blog", snapshot.blogs],
    ["article", snapshot.blogs.flatMap((blog) => blog.articles)],
  ] as const)
    unique(
      resources.flatMap((resource) => (resource.id === undefined ? [] : [resource.id])),
      `${kind} id`,
    );
  unique(
    snapshot.collections.map((p) => p.handle),
    "collection handle",
  );
  unique(
    snapshot.pages.map((p) => p.handle),
    "page handle",
  );
  unique(
    snapshot.blogs.map((p) => p.handle),
    "blog handle",
  );
  unique(
    snapshot.menus.map((p) => p.handle),
    "menu handle",
  );
  unique(
    snapshot.products.flatMap((p) => p.variants.map((v) => v.id)),
    "variant id",
  );
  unique(
    (snapshot.images ?? []).map((image) => image.filename),
    "uploaded image filename",
  );
  const imageMetadata = new Map<string, Map<string, Set<unknown>>>();
  for (const source of snapshotImages(snapshot)) {
    const fields = imageMetadata.get(source.file) ?? new Map<string, Set<unknown>>();
    for (const [key, value] of Object.entries({
      alt: source.alt,
      width: source.width,
      height: source.height,
      focalX: source.focalPoint ? focalPointPercent(source.focalPoint.x) : null,
      focalY: source.focalPoint ? focalPointPercent(source.focalPoint.y) : null,
    })) {
      if (value === undefined) continue;
      const values = fields.get(key) ?? new Set<unknown>();
      values.add(value);
      fields.set(key, values);
    }
    imageMetadata.set(source.file, fields);
  }
  for (const source of snapshot.images ?? [])
    if ([...(imageMetadata.get(source.file)?.values() ?? [])].some((values) => values.size > 1))
      throw new Error("Conflicting image metadata for the same local file");
  const products = new Map(snapshot.products.map((p) => [p.handle, p]));
  for (const product of snapshot.products) {
    const files = new Set(product.images.map((i) => i.file));
    if (product.media) {
      // Every product image is image media exactly once; Shopify lists images among the media.
      const listed = product.media.flatMap((media) =>
        media.mediaType === "image" ? [media.file] : [],
      );
      if (
        new Set(listed).size !== listed.length ||
        listed.length !== files.size ||
        listed.some((file) => !files.has(file))
      )
        throw new Error(`Product media must list each image of ${product.handle} once`);
    }
    unique(
      product.options.map((option) => option.name),
      `option name on ${product.handle}`,
    );
    for (const variant of product.variants) {
      if (
        variant.quantityRule?.max !== undefined &&
        variant.quantityRule.max !== null &&
        variant.quantityRule.max < variant.quantityRule.min
      )
        throw new Error("Variant quantity rule maximum is below its minimum");
      if (variant.image !== undefined && variant.image !== null && !files.has(variant.image))
        throw new Error(`Missing variant image on ${product.handle}`);
      if (variant.optionValues.length !== product.options.length)
        throw new Error(`Option count mismatch on ${product.handle}`);
      for (const option of product.options) {
        const value = variant.optionValues.find((v) => v.name === option.name);
        if (!value || !option.values.includes(value.value))
          throw new Error(`Invalid option value on ${product.handle}`);
      }
    }
  }
  for (const collection of snapshot.collections)
    for (const handle of collection.products ?? [])
      if (!products.has(handle)) throw new Error(`Missing collection member: ${handle}`);
  for (const blog of snapshot.blogs)
    unique(
      blog.articles.map((a) => a.handle),
      `article handle in ${blog.handle}`,
    );
  for (const line of snapshot.cart.lines) {
    const product = products.get(line.productHandle);
    if (!product?.variants.some((v) => v.id === line.variantId))
      throw new Error(`Missing cart variant: ${line.productHandle}/${line.variantId}`);
  }
  unique(
    snapshot.cart.lines.flatMap((line) => (line.key === undefined ? [] : [line.key])),
    "cart line key",
  );
}

/** Oracle scenarios must still resolve to complete data before any store write is prepared. */
export function applyCompleteScenario(
  snapshot: CompleteSnapshot,
  name = "default",
): CompleteSnapshot {
  return completeSnapshotSchema.parse(applyScenario(snapshot, name));
}
