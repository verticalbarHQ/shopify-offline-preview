import { createHash } from "node:crypto";
import { benchmarkMatrix } from "../../packages/data/src/fixture.js";
import { snapshotImages } from "../../packages/data/src/images.js";
import { applyScenario, validateSnapshotReferences } from "../../packages/data/src/scenarios.js";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import { backupDigest, backupDirectory, backupFile } from "./backup-audit.js";
import { snapshotFingerprint } from "./matrix.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export type SeedResource =
  | "image"
  | "product"
  | "collection"
  | "page"
  | "blog"
  | "article"
  | "menu"
  | "metaobject";
export interface SeedTask {
  key: string;
  resource: SeedResource;
  identity: readonly string[];
  dependencies: string[];
  /** Source-shaped desired state, not an executable Admin API request. */
  source: unknown;
  sourceHash: string;
}
export interface SeedState {
  hash: string;
  scenario: string;
  tasks: SeedTask[];
  shopToVerify: Snapshot["shop"];
}
export interface SeedIssue {
  code: string;
  resource: string;
}
const key = (kind: string, ...parts: string[]) => JSON.stringify([kind, ...parts]);
const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, entry: unknown) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? Object.fromEntries(
              Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : entry,
      ),
    )
    .digest("hex");

/** Full matrix preparation only. No credentials, requests, mutations or fabricated remote IDs. */
export function buildOracleSeedPlan(config: OracleConfig, input: Snapshot) {
  oracleConfigSchema.parse(config);
  const snapshot = snapshotSchema.parse(input);
  validateSnapshotReferences(snapshot);
  const states: SeedState[] = [],
    requests: {
      caseId: string;
      path: string;
      scenario: string;
      stateHash: string;
      snapshotHash: string;
      cart: Snapshot["cart"] | null;
    }[] = [];
  const knownStates = new Set<string>();
  const issues = new Map<string, SeedIssue>();
  function issue(code: string, resource: string) {
    issues.set(key(code, resource), { code, resource });
  }
  for (const page of benchmarkMatrix) {
    const desired = applyScenario(snapshot, page.scenario);
    validateSnapshotReferences(desired);
    const path = new URL(page.path, "https://fixture.invalid").pathname.split("/");
    const required =
      page.page === "product"
        ? desired.products.some((p) => p.handle === path[2])
        : page.page === "collection"
          ? desired.collections.some((p) => p.handle === path[2])
          : page.page === "page"
            ? desired.pages.some((p) => p.handle === path[2])
            : page.page === "blog"
              ? desired.blogs.some((p) => p.handle === path[2])
              : page.page === "article"
                ? desired.blogs.some(
                    (p) => p.handle === path[2] && p.articles.some((a) => a.handle === path[3]),
                  )
                : true;
    if (!required) issue("matrix-path-resource-missing", page.id);
    // Cart is storefront-session state; scenario definitions are not store resources.
    const stateHash = hash({
      shop: desired.shop,
      images: desired.images ?? [],
      products: desired.products,
      collections: desired.collections,
      pages: desired.pages,
      blogs: desired.blogs,
      menus: desired.menus,
      metaobjects: desired.metaobjects,
      filters: desired.filters,
    });
    requests.push({
      caseId: page.id,
      path: page.path,
      scenario: page.scenario,
      stateHash,
      snapshotHash: snapshotFingerprint(desired),
      cart: page.page === "cart" ? structuredClone(desired.cart) : null,
    });
    if (knownStates.has(stateHash)) continue;
    knownStates.add(stateHash);
    const tasks: SeedTask[] = [];
    function add(
      resource: SeedResource,
      identity: string[],
      source: unknown,
      dependencies: string[] = [],
    ) {
      const taskKey = key(resource, ...identity);
      if (tasks.some((task) => task.key === taskKey)) throw new Error("Duplicate seed identity");
      tasks.push({
        key: taskKey,
        resource,
        identity,
        source: structuredClone(source),
        sourceHash: hash(source),
        dependencies: [...new Set(dependencies)],
      });
    }
    const images = new Map<string, ReturnType<typeof snapshotImages>[number]>();
    for (const image of snapshotImages(desired)) {
      // File ownership is independent of per-association readonly image/media identifiers and view alt text.
      const upload = { ...image };
      delete upload.id;
      delete upload.mediaId;
      delete upload.mediaAlt;
      delete upload.previewAlt;
      const previous = images.get(image.file);
      if (previous && hash(previous) !== hash(upload))
        issue("conflicting-image-metadata", key("image", image.file));
      else images.set(image.file, upload);
    }
    for (const [file, image] of images) add("image", [file], image);
    for (const product of desired.products) {
      add(
        "product",
        [product.handle],
        product,
        product.images.map((image) => key("image", image.file)),
      );
      if (product.options.length > 3 || product.options.length === 0)
        issue("invalid-product-option-count", key("product", product.handle));
      const combinations = product.variants.map((v) =>
        JSON.stringify(
          product.options.map((o) => v.optionValues.find((x) => x.name === o.name)?.value),
        ),
      );
      if (new Set(combinations).size !== combinations.length)
        issue("duplicate-variant-options", key("product", product.handle));
      for (const variant of product.variants) {
        if (
          variant.inventoryQuantity !== undefined &&
          (variant.inventoryQuantity < -2147483648 || variant.inventoryQuantity > 2147483647)
        )
          issue("inventory-quantity-out-of-api-range", key("variant", product.handle, variant.id));
        if (
          variant.inventoryQuantity === undefined ||
          variant.inventoryPolicy === undefined ||
          variant.inventoryManagement === undefined
        )
          issue("inventory-source-required", key("variant", product.handle, variant.id));
        else if (variant.inventoryManagement !== "shopify")
          issue(
            "inventory-management-adapter-required",
            key("variant", product.handle, variant.id),
          );
        else if (
          variant.available !==
          (variant.inventoryQuantity > 0 || variant.inventoryPolicy === "continue")
        )
          issue("inventory-availability-conflict", key("variant", product.handle, variant.id));
      }
      if (Object.keys(product.metafields).length)
        issue("metafield-definitions-required", key("product", product.handle));
    }
    for (const collection of desired.collections) {
      add("collection", [collection.handle], collection, [
        ...collection.products.map((handle) => key("product", handle)),
        ...(collection.image ? [key("image", collection.image.file)] : []),
      ]);
      if (new Set(collection.products).size !== collection.products.length)
        issue("duplicate-collection-member", key("collection", collection.handle));
    }
    for (const source of desired.pages) {
      add("page", [source.handle], source);
      if (Object.keys(source.metafields).length)
        issue("metafield-definitions-required", key("page", source.handle));
    }
    for (const blog of desired.blogs) {
      const { articles, ...source } = blog;
      add("blog", [blog.handle], source);
      if (Object.keys(blog.metafields).length)
        issue("metafield-definitions-required", key("blog", blog.handle));
      for (const article of articles) {
        add("article", [blog.handle, article.handle], article, [
          key("blog", blog.handle),
          ...(article.image ? [key("image", article.image.file)] : []),
        ]);
        if (Object.keys(article.metafields).length)
          issue("metafield-definitions-required", key("article", blog.handle, article.handle));
      }
    }
    for (const metaobject of desired.metaobjects) {
      add("metaobject", [metaobject.type, metaobject.handle], metaobject);
      issue(
        "metaobject-definitions-required",
        key("metaobject", metaobject.type, metaobject.handle),
      );
    }
    for (const menu of desired.menus) {
      const dependencies: string[] = [];
      function links(rows: typeof menu.links, depth: number) {
        if (rows.length && depth > 3) issue("menu-depth-exceeds-shopify", key("menu", menu.handle));
        for (const link of rows) {
          const resource = {
            product_link: "product",
            collection_link: "collection",
            page_link: "page",
            blog_link: "blog",
          }[link.type];
          if (resource && link.resourceHandle)
            dependencies.push(key(resource, link.resourceHandle));
          else if (link.type !== "http_link")
            issue("menu-reference-adapter-required", key("menu", menu.handle));
          links(link.links, depth + 1);
        }
      }
      links(menu.links, 1);
      add("menu", [menu.handle], menu, dependencies);
    }
    const emitted = new Set<string>();
    for (const task of tasks) {
      for (const dependency of task.dependencies)
        if (!emitted.has(dependency)) issue("missing-or-unordered-resource-reference", task.key);
      emitted.add(task.key);
    }
    if (desired.filters.length) issue("collection-filter-configuration-required", "shop");
    states.push({
      hash: stateHash,
      scenario: page.scenario,
      tasks,
      shopToVerify: structuredClone(desired.shop),
    });
  }
  return {
    schemaVersion: "1.0",
    source: "oracle-seed-dry-run",
    domain: config.domain,
    apiVersion: config.apiVersion,
    fixtureHash: snapshotFingerprint(snapshot),
    states,
    requests,
    requiredScopes: [
      "write_products",
      "write_publications",
      "write_inventory",
      "read_locations",
      "write_content",
      "write_online_store_navigation",
      "write_files",
      "write_metaobjects",
      "write_themes",
    ],
    externalBindings: [
      "processed-image-ids",
      "inventory-location-id",
      "online-store-publication-id",
    ],
    calibrationRequired: [
      "resource-ids",
      "variant-ids-by-options",
      "platform-generated-timestamps",
      "shop-settings",
      "image-processing",
    ],
    issues: [...issues.values()].sort(
      (a, b) => a.code.localeCompare(b.code) || a.resource.localeCompare(b.resource),
    ),
    executionReady: false,
    blockers: [
      "admin-wire-adapters-not-verified",
      "fresh-dev-store-identity-and-marker-required",
      "complete-backup-and-restoration-required",
      "action-time-wipe-approval-required",
      "shop-settings-and-resource-calibration-required",
    ],
    mutationsExecuted: 0,
  };
}

/** Deterministic fixture PNGs are inspected locally before upload preparation. */
export async function readOracleSeedImages(
  plan: ReturnType<typeof buildOracleSeedPlan>,
  imageDirectory: string,
) {
  const root = await backupDirectory(imageDirectory);
  const records = new Map<
    string,
    { file: string; bytes: number; sha256: string; width: number; height: number }
  >();
  for (const state of plan.states) {
    for (const task of state.tasks) {
      if (task.resource !== "image") continue;
      const source = snapshotSchema.shape.products.element.shape.images.element.parse(task.source);
      if (records.has(source.file)) continue;
      const bytes = await backupFile(root, source.file);
      if (
        bytes.length < 33 ||
        !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        Buffer.from(bytes.subarray(12, 16)).toString("ascii") !== "IHDR"
      )
        throw new Error("Fixture PNG required");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (
        view.getUint32(8) !== 13 ||
        view.getUint32(16) !== source.width ||
        view.getUint32(20) !== source.height
      )
        throw new Error("Fixture image dimensions differ from source");
      records.set(source.file, {
        file: source.file,
        bytes: bytes.length,
        sha256: backupDigest(bytes),
        width: source.width,
        height: source.height,
      });
    }
  }
  return [...records.values()].sort((a, b) => a.file.localeCompare(b.file));
}
