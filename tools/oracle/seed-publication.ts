import { z } from "zod";
import type { Snapshot } from "../../packages/data/src/schema.js";
import type { createOracleSeedBindingLedger } from "./seed-binding-ledger.js";
import { type SeedCompletionDependencies, waitOracleSeedPublication } from "./seed-completion.js";
import type { SeedExecutionDependencies } from "./seed-execution.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import { seedBindingKey } from "./seed-requests.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class SeedPublicationError extends Error {
  constructor(readonly code: "scope-mismatch" | "binding-mismatch" | "publication-unverified") {
    super(`Oracle publication verification failed: ${code}`);
    this.name = "SeedPublicationError";
  }
}

/** Mandatory postcondition for an already authorized publishablePublish. Explicit environment choice is not mutation approval. */
export function createOracleSeedPublicationVerifier(
  config: OracleConfig,
  snapshot: Snapshot,
  shopId: string,
  token: string,
  ledger: ReturnType<typeof createOracleSeedBindingLedger>,
  dependencies: SeedCompletionDependencies = {},
): SeedExecutionDependencies["verifyResult"] {
  const pinned = oracleConfigSchema.parse(config),
    plan = buildOracleSeedPlan(pinned, snapshot);
  if (plan.issues.length) throw new SeedPublicationError("scope-mismatch");
  return async (context, _payload, variables) => {
    const task = plan.states
      .find((s) => s.hash === context.stateHash)
      ?.tasks.find((t) => t.key === context.task.key);
    if (
      !task ||
      context.fixtureHash !== plan.fixtureHash ||
      context.domain !== pinned.domain ||
      context.apiVersion !== pinned.apiVersion ||
      context.expectedShopId !== shopId ||
      task.sourceHash !== context.task.sourceHash ||
      context.kind !== "publication" ||
      context.template.operation !== "publishablePublish" ||
      !["product", "collection"].includes(task.resource)
    )
      throw new SeedPublicationError("scope-mismatch");
    const sent = z
      .strictObject({
        id: z.string(),
        input: z.array(z.strictObject({ publicationId: z.string() })).length(1),
      })
      .safeParse(variables);
    if (!sent.success) throw new SeedPublicationError("binding-mismatch");
    try {
      const resourceKey = seedBindingKey(`${task.resource}-id`, task.identity[0] ?? ""),
        publicationKey = seedBindingKey("online-store-publication"),
        resource = await ledger.verifyExpected(resourceKey, true),
        publication = await ledger.verifyExpected(publicationKey);
      if (
        (resource.kind !== "Product" && resource.kind !== "Collection") ||
        publication.kind !== "Publication" ||
        sent.data.id !== resource.id ||
        sent.data.input[0]?.publicationId !== publication.id
      )
        throw new SeedPublicationError("binding-mismatch");
      await waitOracleSeedPublication(pinned, token, shopId, resource, publication, dependencies);
      const currentResource = await ledger.verifyExpected(resourceKey, true),
        currentPublication = await ledger.verifyExpected(publicationKey);
      if (
        JSON.stringify(currentResource) !== JSON.stringify(resource) ||
        JSON.stringify(currentPublication) !== JSON.stringify(publication)
      )
        throw new SeedPublicationError("binding-mismatch");
    } catch (error) {
      if (error instanceof SeedPublicationError) throw error;
      throw new SeedPublicationError("publication-unverified");
    }
  };
}
