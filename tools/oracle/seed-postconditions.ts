import { basename } from "node:path";
import { z } from "zod";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import type { createOracleSeedBindingLedger } from "./seed-binding-ledger.js";
import {
  type SeedCompletionDependencies,
  waitOracleSeedCollectionOrder,
  waitOracleSeedImage,
} from "./seed-completion.js";
import type { SeedExecutionDependencies } from "./seed-execution.js";
import {
  assertOracleSeedIdentity,
  type ExpectedSeedIdentity,
  readOracleSeedIdentities,
} from "./seed-identities.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import { createOracleSeedPublicationVerifier } from "./seed-publication.js";
import { seedBindingKey } from "./seed-requests.js";
import { createOracleSeedSourceVerifier } from "./seed-source.js";
import { validateOracleSeedUploadTarget } from "./seed-upload.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class SeedPostconditionError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "scope-mismatch"
      | "unsupported-step"
      | "result-mismatch"
      | "verification-failed",
  ) {
    super(`Oracle seed postcondition failed: ${code}`);
    this.name = "SeedPostconditionError";
  }
}

/** Complete dispatcher for the currently compiled steps. No default success, authorization, setup mutations or live CLI. */
export function createOracleSeedPostconditions(
  config: OracleConfig,
  snapshot: Snapshot,
  shopId: string,
  token: string,
  ledger: ReturnType<typeof createOracleSeedBindingLedger>,
  images: readonly { file: string; bytes: number; sha256: string }[],
  dependencies: SeedCompletionDependencies = {},
): SeedExecutionDependencies["verifyResult"] {
  const pinned = oracleConfigSchema.parse(config),
    plan = buildOracleSeedPlan(pinned, snapshot),
    assets = structuredClone(images),
    fetcher = dependencies.fetcher ?? fetch;
  if (
    plan.issues.length ||
    !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId) ||
    !token.trim() ||
    new Set(assets.map((a) => a.file)).size !== assets.length
  )
    throw new SeedPostconditionError("invalid-input");
  const sourceVerifier = createOracleSeedSourceVerifier(
      pinned,
      snapshot,
      shopId,
      token,
      ledger.get,
      fetcher,
    ),
    publicationVerifier = createOracleSeedPublicationVerifier(
      pinned,
      snapshot,
      shopId,
      token,
      ledger,
      dependencies,
    );
  return async (context, payload, variables) => {
    const task = plan.states
      .find((s) => s.hash === context.stateHash)
      ?.tasks.find((t) => t.key === context.task.key);
    if (
      !task ||
      context.domain !== pinned.domain ||
      context.apiVersion !== pinned.apiVersion ||
      context.expectedShopId !== shopId ||
      context.fixtureHash !== plan.fixtureHash ||
      task.sourceHash !== context.task.sourceHash
    )
      throw new SeedPostconditionError("scope-mismatch");
    try {
      if (context.kind === "publication") {
        await publicationVerifier(context, payload, variables);
        return;
      }
      if (context.kind === "collection-order") {
        if (
          task.resource !== "collection" ||
          context.template.operation !== "collectionReorderProducts"
        )
          throw new SeedPostconditionError("unsupported-step");
        const source = snapshotSchema.shape.collections.element.parse(task.source),
          before = await ledger.verifyExpected(
            seedBindingKey("collection-id", source.handle),
            true,
          );
        if (
          before.kind !== "Collection" ||
          variables.id !== before.id ||
          source.sortOrder !== "manual" ||
          before.members.length !== source.products.length
        )
          throw new SeedPostconditionError("result-mismatch");
        const expected = structuredClone(before),
          members = new Map(before.members.map((m) => [m.handle, m]));
        expected.members = source.products.map((handle) => {
          const member = members.get(handle);
          if (!member) throw new SeedPostconditionError("result-mismatch");
          return member;
        });
        expected.ordered = true;
        const job = z.object({ id: z.string() }).parse(payload.job);
        await waitOracleSeedCollectionOrder(pinned, token, shopId, job.id, expected, dependencies);
        return;
      }
      if (context.kind !== "task") throw new SeedPostconditionError("unsupported-step");
      if (task.resource === "image") {
        const source = snapshotSchema.shape.products.element.shape.images.element.parse(
            task.source,
          ),
          asset = assets.find((a) => a.file === source.file);
        if (!asset) throw new SeedPostconditionError("invalid-input");
        if (context.template.operation === "stagedUploadsCreate") {
          validateOracleSeedUploadTarget(context, payload, variables, asset);
          return;
        }
        if (context.template.operation !== "fileCreate" || context.options.mode !== "create")
          throw new SeedPostconditionError("unsupported-step");
        const sent = z
            .object({
              files: z
                .array(
                  z.object({
                    filename: z.literal(basename(source.file)),
                    contentType: z.literal("IMAGE"),
                    alt: z.literal(source.alt),
                    duplicateResolutionMode: z.literal("RAISE_ERROR"),
                    originalSource: z.literal(
                      ledger.get(seedBindingKey("staged-image-url", source.file)),
                    ),
                  }),
                )
                .length(1),
            })
            .parse(variables),
          files = z
            .array(z.object({ id: z.string().regex(/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/) }))
            .length(sent.files.length)
            .parse(payload.files),
          file = files[0];
        if (!file) throw new SeedPostconditionError("result-mismatch");
        const node = await waitOracleSeedImage(
          pinned,
          token,
          shopId,
          file.id,
          { width: source.width, height: source.height, bytes: asset.bytes, sha256: asset.sha256 },
          dependencies,
        );
        if (node.alt !== source.alt) throw new SeedPostconditionError("result-mismatch");
        return;
      }
      await sourceVerifier(context, payload);
      const result = z.object({ id: z.string() }).parse(payload[task.resource]);
      // Update postconditions bind to the actual sent ID, not merely a resource with the same handle.
      if (context.options.mode === "update") {
        const sent =
          task.resource === "product"
            ? z.object({ identifier: z.object({ id: z.string() }) }).parse(variables).identifier.id
            : task.resource === "collection"
              ? z.object({ collection: z.object({ id: z.string() }) }).parse(variables).collection
                  .id
              : z.object({ id: z.string() }).parse(variables).id;
        if (sent !== result.id) throw new SeedPostconditionError("result-mismatch");
      }
      if (task.resource === "collection") {
        const source = snapshotSchema.shape.collections.element.parse(task.source),
          node = (
            await readOracleSeedIdentities(
              pinned,
              token,
              shopId,
              "Collection",
              [result.id],
              fetcher,
            )
          )[0];
        if (node?.__typename !== "Collection" || node.sources.length !== 1 || !node.sources[0])
          throw new SeedPostconditionError("result-mismatch");
        const actual = node.sources[0],
          expected: ExpectedSeedIdentity = {
            kind: "Collection",
            id: result.id,
            handle: source.handle,
            sourceId: actual.id,
            sourceAppId: actual.app?.id ?? null,
            members: source.products.map((handle) => ({
              id: ledger.get(seedBindingKey("product-id", handle)),
              handle,
            })),
            ordered: false,
          };
        if (
          context.options.mode === "update" &&
          actual.id !== ledger.get(seedBindingKey("collection-source-id", source.handle))
        )
          throw new SeedPostconditionError("result-mismatch");
        assertOracleSeedIdentity(expected, node);
      }
    } catch (error) {
      if (error instanceof SeedPostconditionError) throw error;
      throw new SeedPostconditionError("verification-failed");
    }
  };
}
