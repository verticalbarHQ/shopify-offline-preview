import { z } from "zod";
import { applyScenario, validateSnapshotReferences } from "../../packages/data/src/scenarios.js";
import type { Snapshot } from "../../packages/data/src/schema.js";
import { snapshotSchema } from "../../packages/data/src/schema.js";
import { snapshotFingerprint } from "./matrix.js";
import {
  type createOracleSeedBindingLedger,
  inspectVerifiedSeedOwnership,
  type SeedOwnershipContext,
  type VerifiedSeedOwnership,
} from "./seed-binding-ledger.js";
import {
  inspectVerifiedSeedExecution,
  type SeedExecutionContext,
  type VerifiedSeedExecution,
} from "./seed-execution.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import { seedBindingKey } from "./seed-requests.js";
import { assertOracleSeedSource, readOracleSeedSource } from "./seed-source.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class SeedGeneratedError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "unverified-execution"
      | "scope-mismatch"
      | "read-failed"
      | "store-mismatch"
      | "incomplete-metadata"
      | "metadata-mismatch"
      | "metadata-changed"
      | "concurrent-record",
  ) {
    super(`Oracle generated metadata failed: ${code}`);
    this.name = "SeedGeneratedError";
  }
}
const id = z.string().regex(/^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]*\/[1-9]\d*$/),
  legacy = z.string().regex(/^[1-9]\d*$/),
  date = z.iso.datetime({ offset: true }),
  common = { id, handle: z.string() },
  metadataSchemas = {
    Product: z.object({
      ...common,
      __typename: z.literal("Product"),
      legacyResourceId: legacy,
      createdAt: date,
      publishedAt: date.nullable(),
      variants: z.object({
        nodes: z
          .array(
            z.object({
              id,
              legacyResourceId: legacy,
              selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
            }),
          )
          .max(250),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    }),
    Collection: z.object({
      ...common,
      __typename: z.literal("Collection"),
      legacyResourceId: legacy,
    }),
    Page: z.object({ ...common, __typename: z.literal("Page") }),
    Blog: z.object({ ...common, __typename: z.literal("Blog") }),
    Article: z.object({
      ...common,
      __typename: z.literal("Article"),
      blog: z.object({ id }),
      createdAt: date,
      updatedAt: date.nullable(),
      publishedAt: date.nullable(),
      commentsCount: z
        .object({ count: z.number().int().nonnegative(), precision: z.string() })
        .nullable(),
    }),
  } as const;
export type SeedGeneratedKind = keyof typeof metadataSchemas;
export type SeedGeneratedMetadata = z.infer<(typeof metadataSchemas)[SeedGeneratedKind]>;
export const seedGeneratedSelections: Record<SeedGeneratedKind, string> = {
  Product:
    "id handle legacyResourceId createdAt publishedAt variants(first:250) { nodes { id legacyResourceId selectedOptions { name value } } pageInfo { hasNextPage } }",
  Collection: "id handle legacyResourceId",
  Page: "id handle",
  Blog: "id handle",
  Article:
    "id handle blog { id } createdAt updatedAt publishedAt commentsCount { count precision }",
};
function numericId(gid: string, kind: string) {
  const prefix = `gid://shopify/${kind}/`;
  if (!gid.startsWith(prefix) || !legacy.safeParse(gid.slice(prefix.length)).success)
    throw new SeedGeneratedError("metadata-mismatch");
  return gid.slice(prefix.length);
}

/** Reads generated fields only. Coincidental matches never register existing resources as fixture-owned. */
export async function readOracleSeedGeneratedMetadata(
  config: OracleConfig,
  token: string,
  shopId: string,
  kind: SeedGeneratedKind,
  resourceId: string,
  fetcher: typeof fetch = fetch,
): Promise<SeedGeneratedMetadata> {
  let pinned: OracleConfig;
  try {
    pinned = oracleConfigSchema.parse(config);
    if (
      !token.trim() ||
      !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId) ||
      !Object.hasOwn(metadataSchemas, kind)
    )
      throw new Error();
    numericId(resourceId, kind);
  } catch {
    throw new SeedGeneratedError("invalid-input");
  }
  let node: SeedGeneratedMetadata;
  try {
    const response = await fetcher(
      `https://${pinned.domain}/admin/api/${pinned.apiVersion}/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({
          query: `query OfflinePreviewSeedGenerated($ids:[ID!]!) { shop { id myshopifyDomain plan { partnerDevelopment } } nodes(ids:$ids) { __typename ... on ${kind} { ${seedGeneratedSelections[kind]} } } }`,
          variables: { ids: [resourceId] },
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok || response.headers.get("x-shopify-api-version") !== pinned.apiVersion)
      throw new Error();
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error();
    const parsed = z
      .object({
        data: z.object({
          shop: z.object({
            id: z.string(),
            myshopifyDomain: z.string(),
            plan: z.object({ partnerDevelopment: z.boolean() }),
          }),
          nodes: z.array(z.unknown()).length(1),
        }),
        errors: z.array(z.unknown()).optional(),
      })
      .parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
    if (parsed.errors?.length) throw new Error();
    if (
      parsed.data.shop.id !== shopId ||
      parsed.data.shop.myshopifyDomain !== pinned.domain ||
      !parsed.data.shop.plan.partnerDevelopment
    )
      throw new SeedGeneratedError("store-mismatch");
    node = metadataSchemas[kind].parse(parsed.data.nodes[0]);
    if (node.id !== resourceId) throw new Error();
  } catch (error) {
    if (error instanceof SeedGeneratedError) throw error;
    throw new SeedGeneratedError("read-failed");
  }
  if (node.__typename === "Product" || node.__typename === "Collection")
    if (numericId(node.id, node.__typename) !== node.legacyResourceId)
      throw new SeedGeneratedError("metadata-mismatch");
  if (node.__typename === "Product") {
    if (
      node.variants.pageInfo.hasNextPage ||
      new Set(node.variants.nodes.map((v) => v.id)).size !== node.variants.nodes.length
    )
      throw new SeedGeneratedError("incomplete-metadata");
    for (const variant of node.variants.nodes)
      if (numericId(variant.id, "ProductVariant") !== variant.legacyResourceId)
        throw new SeedGeneratedError("metadata-mismatch");
  }
  if (node.__typename === "Article" && node.commentsCount?.precision !== "EXACT")
    throw new SeedGeneratedError("incomplete-metadata");
  return node;
}

export interface VerifiedSeedGenerated {
  readonly kind: "verified-seed-generated";
}
interface GeneratedRecord {
  domain: string;
  shopId: string;
  fixtureHash: string;
  stateHash: string;
  taskKey: string;
  sourceHash: string;
  metadata: SeedGeneratedMetadata;
}
const records = new WeakMap<VerifiedSeedGenerated, GeneratedRecord>();
export function inspectVerifiedSeedGenerated(receipt: VerifiedSeedGenerated): GeneratedRecord {
  const record = records.get(receipt);
  if (!record) throw new SeedGeneratedError("unverified-execution");
  return structuredClone(record);
}

/** Supplemental generated-field evidence; this does not verify shop settings, cart keys or a complete capture input. */
export function createOracleSeedGeneratedRecorder(
  config: OracleConfig,
  snapshot: Snapshot,
  shopId: string,
  token: string,
  ledger: ReturnType<typeof createOracleSeedBindingLedger>,
  fetcher: typeof fetch = fetch,
) {
  const pinned = oracleConfigSchema.parse(config),
    plan = buildOracleSeedPlan(pinned, snapshot);
  if (plan.issues.length) throw new SeedGeneratedError("invalid-input");
  let busy = false;
  async function recordObservation(
    context: SeedOwnershipContext | SeedExecutionContext,
    assertOwnership: () => ReturnType<typeof ledger.assertOwned>,
  ): Promise<VerifiedSeedGenerated> {
    if (busy) throw new SeedGeneratedError("concurrent-record");
    busy = true;
    try {
      const task = plan.states
        .find((s) => s.hash === context.stateHash)
        ?.tasks.find((t) => t.key === context.task.key);
      if (
        !task ||
        context.fixtureHash !== plan.fixtureHash ||
        context.expectedShopId !== shopId ||
        context.domain !== pinned.domain ||
        context.apiVersion !== pinned.apiVersion ||
        task.sourceHash !== context.task.sourceHash ||
        context.kind !== "task"
      )
        throw new SeedGeneratedError("scope-mismatch");
      const kinds: Partial<Record<typeof task.resource, SeedGeneratedKind>> = {
          product: "Product",
          collection: "Collection",
          page: "Page",
          blog: "Blog",
          article: "Article",
        },
        kind = kinds[task.resource];
      if (!kind) throw new SeedGeneratedError("invalid-input");
      let expected: Awaited<ReturnType<typeof ledger.assertRecorded>>;
      try {
        expected = await assertOwnership();
      } catch {
        throw new SeedGeneratedError("unverified-execution");
      }
      if (expected.kind !== kind) throw new SeedGeneratedError("metadata-mismatch");
      let before: SeedGeneratedMetadata, after: SeedGeneratedMetadata;
      try {
        before = await readOracleSeedGeneratedMetadata(
          pinned,
          token,
          shopId,
          kind,
          expected.id,
          fetcher,
        );
        const source = await readOracleSeedSource(
          pinned,
          token,
          shopId,
          kind,
          expected.id,
          kind === "Product" ? ledger.get(seedBindingKey("inventory-location")) : undefined,
          fetcher,
        );
        assertOracleSeedSource(task, source, ledger.get);
        after = await readOracleSeedGeneratedMetadata(
          pinned,
          token,
          shopId,
          kind,
          expected.id,
          fetcher,
        );
      } catch (error) {
        if (error instanceof SeedGeneratedError) throw error;
        throw new SeedGeneratedError("read-failed");
      }
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new SeedGeneratedError("metadata-changed");
      if (after.handle !== task.identity[task.resource === "article" ? 1 : 0])
        throw new SeedGeneratedError("metadata-mismatch");
      if (after.__typename === "Product") {
        // Use the actual state's source, including overlays; default snapshot variants are not authoritative here.
        const taskVariants = z
          .object({
            variants: z.array(
              z.object({
                id: z.string(),
                optionValues: z.array(z.object({ name: z.string(), value: z.string() })),
              }),
            ),
          })
          .parse(task.source).variants;
        if (after.variants.nodes.length !== taskVariants.length)
          throw new SeedGeneratedError("metadata-mismatch");
        const tuple = (values: { name: string; value: string }[]) =>
            JSON.stringify([...values].sort((a, b) => a.name.localeCompare(b.name))),
          observed = new Map(after.variants.nodes.map((v) => [tuple(v.selectedOptions), v]));
        if (observed.size !== taskVariants.length)
          throw new SeedGeneratedError("metadata-mismatch");
        for (const variant of taskVariants)
          if (
            observed.get(tuple(variant.optionValues))?.id !==
            ledger.get(seedBindingKey("variant-id", after.handle, variant.id))
          )
            throw new SeedGeneratedError("metadata-mismatch");
      }
      if (
        after.__typename === "Article" &&
        after.blog.id !== ledger.get(seedBindingKey("blog-id", task.identity[0] ?? ""))
      )
        throw new SeedGeneratedError("metadata-mismatch");
      try {
        await assertOwnership();
      } catch {
        throw new SeedGeneratedError("unverified-execution");
      }
      const output: VerifiedSeedGenerated = Object.freeze({ kind: "verified-seed-generated" });
      records.set(output, {
        domain: pinned.domain,
        shopId,
        fixtureHash: plan.fixtureHash,
        stateHash: context.stateHash,
        taskKey: task.key,
        sourceHash: task.sourceHash,
        metadata: after,
      });
      return output;
    } finally {
      busy = false;
    }
  }
  return {
    async record(receipt: VerifiedSeedExecution): Promise<VerifiedSeedGenerated> {
      let context: SeedExecutionContext;
      try {
        context = inspectVerifiedSeedExecution(receipt).context;
      } catch {
        throw new SeedGeneratedError("unverified-execution");
      }
      return recordObservation(context, () => ledger.assertRecorded(receipt));
    },
    async recordOwned(receipt: VerifiedSeedOwnership): Promise<VerifiedSeedGenerated> {
      let context: SeedOwnershipContext;
      try {
        context = inspectVerifiedSeedOwnership(receipt);
      } catch {
        throw new SeedGeneratedError("unverified-execution");
      }
      return recordObservation(context, () => ledger.assertOwned(receipt));
    },
  };
}

/** Applies only observed generated fields to a prepared fixture case. It is never a store importer or capture-ready assertion. */
export function applyOracleSeedGenerated(
  config: OracleConfig,
  input: Snapshot,
  shopId: string,
  caseId: string,
  receipts: readonly VerifiedSeedGenerated[],
) {
  const original = snapshotSchema.parse(input),
    plan = buildOracleSeedPlan(config, original),
    request = plan.requests.find((r) => r.caseId === caseId),
    state = plan.states.find((s) => s.hash === request?.stateHash);
  if (plan.issues.length || !request || !state || !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId))
    throw new SeedGeneratedError("invalid-input");
  const snapshot = applyScenario(original, request.scenario),
    seen = new Set<string>(),
    variantIds = new Map<string, string>(),
    omissions: string[] = [];
  // A case snapshot must not silently reapply uncalibrated overlays after generated IDs are replaced.
  snapshot.scenarios = {};
  for (const receipt of receipts) {
    const record = inspectVerifiedSeedGenerated(receipt),
      task = state.tasks.find((t) => t.key === record.taskKey),
      metadata = record.metadata;
    if (
      record.domain !== config.domain ||
      record.shopId !== shopId ||
      record.fixtureHash !== plan.fixtureHash ||
      record.stateHash !== state.hash ||
      !task ||
      task.sourceHash !== record.sourceHash ||
      seen.has(task.key)
    )
      throw new SeedGeneratedError("scope-mismatch");
    seen.add(task.key);
    if (metadata.__typename === "Product") {
      const product = snapshot.products.find((p) => p.handle === metadata.handle);
      if (!product) throw new SeedGeneratedError("metadata-mismatch");
      product.id = metadata.legacyResourceId;
      product.createdAt = metadata.createdAt;
      product.publishedAt = metadata.publishedAt;
      const tuple = (values: { name: string; value: string }[]) =>
          JSON.stringify([...values].sort((a, b) => a.name.localeCompare(b.name))),
        byTuple = new Map(metadata.variants.nodes.map((v) => [tuple(v.selectedOptions), v]));
      for (const variant of product.variants) {
        const observed = byTuple.get(tuple(variant.optionValues));
        if (!observed) throw new SeedGeneratedError("metadata-mismatch");
        variantIds.set(variant.id, observed.legacyResourceId);
        variant.id = observed.legacyResourceId;
      }
    } else if (metadata.__typename === "Page") {
      const page = snapshot.pages.find((p) => p.handle === metadata.handle);
      if (!page) throw new SeedGeneratedError("metadata-mismatch");
      page.id = numericId(metadata.id, "Page");
    } else if (metadata.__typename === "Blog") {
      const blog = snapshot.blogs.find((p) => p.handle === metadata.handle);
      if (!blog) throw new SeedGeneratedError("metadata-mismatch");
      blog.id = numericId(metadata.id, "Blog");
    } else if (metadata.__typename === "Collection") {
      const collection = snapshot.collections.find((p) => p.handle === metadata.handle);
      if (!collection) throw new SeedGeneratedError("metadata-mismatch");
      collection.id = metadata.legacyResourceId;
    } else {
      const blog = snapshot.blogs.find((b) => b.handle === task.identity[0]),
        article = blog?.articles.find((a) => a.handle === metadata.handle);
      if (!article || !metadata.publishedAt || !metadata.commentsCount)
        throw new SeedGeneratedError("incomplete-metadata");
      article.id = numericId(metadata.id, "Article");
      article.createdAt = metadata.createdAt;
      article.publishedAt = metadata.publishedAt;
      article.commentsCount = metadata.commentsCount.count;
      if (metadata.updatedAt) article.updatedAt = metadata.updatedAt;
      else {
        delete article.updatedAt;
        omissions.push("article-updated-at-unavailable");
      }
    }
  }
  for (const line of snapshot.cart.lines) {
    const actual = variantIds.get(line.variantId);
    if (actual) line.variantId = actual;
  }
  try {
    validateSnapshotReferences(snapshot);
  } catch {
    throw new SeedGeneratedError("metadata-mismatch");
  }
  const resources = new Set(["product", "collection", "page", "blog", "article"]),
    missingTasks = state.tasks
      .filter((t) => resources.has(t.resource) && !seen.has(t.key))
      .map((t) => t.key);
  return {
    snapshot,
    sourceScenario: request.scenario,
    stateHash: state.hash,
    baseFixtureHash: plan.fixtureHash,
    snapshotHash: snapshotFingerprint(snapshot),
    missingTasks,
    omissions: [
      ...new Set([
        ...omissions,
        "shop-settings-verification",
        "publication-postconditions",
        "image-and-storefront-metadata",
        "cart-session-keys",
        "capture-clock",
        "all-state-fixture-assembly",
      ]),
    ],
    captureReady: false as const,
  };
}
