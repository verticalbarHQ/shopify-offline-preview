import type { Snapshot } from "../../packages/data/src/schema.js";
import { backupDigest } from "./backup-audit.js";
import {
  inspectVerifiedSeedExecution,
  SeedExecutionError,
  type SeedExecutionStep,
  type VerifiedSeedExecution,
} from "./seed-execution.js";
import type { ExpectedSeedIdentity } from "./seed-identities.js";
import { openOracleSeedJournal, SeedJournalError, seedJournalFingerprint } from "./seed-journal.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import {
  compileSeedStepTemplates,
  resolveSeedRequest,
  type SeedRequestTemplate,
} from "./seed-requests.js";
import {
  createOracleSeedRuntime,
  type SeedRuntimeDependencies,
  SeedRuntimeError,
} from "./seed-runtime.js";
import { SeedUploadError } from "./seed-upload.js";
import type { OracleConfig } from "./store-guard.js";

/** These outcomes prove this call dispatched no mutation (or only definitive preexecution throttles). */
function notDispatched(error: unknown): boolean {
  if (error instanceof SeedExecutionError)
    return [
      "invalid-step",
      "schema-mismatch",
      "binding-invalid",
      "authorization-denied",
      "binding-verification-failed",
      "guard-unavailable",
      "guard-denied",
      "scope-missing",
      "concurrent-execution",
      "throttle-limit",
    ].includes(error.code);
  if (error instanceof SeedUploadError)
    return [
      "invalid-target",
      "scope-mismatch",
      "asset-mismatch",
      "target-used",
      "authorization-denied",
      "unverified-upload",
    ].includes(error.code);
  return false;
}

/** Restart-safe replay suppression around the in-process runtime. A private journal is mandatory here.
 * Hashes are not ownership proofs: reopening does not restore bindings or permit automatic reconciliation.
 * Pending operations and stale process locks require separate operator recovery; no erase/reset API exists. */
export async function openOracleSeedDurableRuntime(
  config: OracleConfig,
  snapshot: Snapshot,
  shopId: string,
  token: string,
  schema: unknown,
  images: readonly { file: string; bytes: number; sha256: string }[],
  directory: string,
  dependencies: SeedRuntimeDependencies,
) {
  const runtime = createOracleSeedRuntime(
      config,
      snapshot,
      shopId,
      token,
      schema,
      images,
      dependencies,
    ),
    plan = buildOracleSeedPlan(config, snapshot),
    scope = seedJournalFingerprint({
      version: 1,
      config,
      shopId,
      fixtureHash: plan.fixtureHash,
      schema,
      images,
    }),
    journal = await openOracleSeedJournal(directory, scope);
  let busy = false,
    closed = false;
  async function operation<T>(fn: () => Promise<T>): Promise<T> {
    if (closed) throw new SeedJournalError("closed");
    if (busy) throw new SeedRuntimeError("concurrent-operation");
    if (journal.status() !== "accepting-intents" || runtime.status() === "recovery-required")
      throw new SeedJournalError("recovery-required");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }
  async function write<T>(intent: string, fn: () => Promise<T>): Promise<T> {
    // Durable reservation precedes all authorization/guard/network work. A crash cannot forget it.
    await journal.begin(intent);
    let value: T;
    try {
      value = await fn();
    } catch (error) {
      if (notDispatched(error)) await journal.settle(intent, "not-dispatched");
      throw error;
    }
    // The runtime has already completed actual readback and binding registration.
    await journal.settle(intent, "verified");
    return value;
  }
  return {
    status: () =>
      closed
        ? ("closed" as const)
        : journal.status() === "accepting-intents" && runtime.status() === "accepting-steps"
          ? ("accepting-steps" as const)
          : ("recovery-required" as const),
    getBinding: runtime.getBinding,
    registerEnvironment: (
      expected: Extract<ExpectedSeedIdentity, { kind: "Location" | "Publication" }>,
    ) => operation(() => runtime.registerEnvironment(structuredClone(expected))),
    execute: (step: SeedExecutionStep) =>
      operation(async () => {
        const copy = structuredClone(step),
          task = plan.states
            .find((state) => state.hash === copy.stateHash)
            ?.tasks.find((task) => task.key === copy.taskKey);
        if (!task) throw new SeedExecutionError("invalid-step");
        let template: SeedRequestTemplate;
        try {
          const selected = compileSeedStepTemplates(
            task,
            copy.kind,
            copy.options,
            copy.observedOrder,
          )[copy.requestIndex ?? 0];
          if (!selected || !Number.isInteger(copy.requestIndex ?? 0)) throw new Error();
          template = selected;
        } catch {
          throw new SeedExecutionError("invalid-step");
        }
        let request: ReturnType<typeof resolveSeedRequest>;
        try {
          request = resolveSeedRequest(template, copy.bindings);
        } catch {
          throw new SeedExecutionError("binding-invalid");
        }
        const intent = seedJournalFingerprint({
          kind: "execute",
          stateHash: copy.stateHash,
          taskKey: task.key,
          sourceHash: task.sourceHash,
          request,
        });
        return write(intent, () => runtime.execute(copy));
      }),
    upload: (receipt: VerifiedSeedExecution, bytes: Uint8Array) =>
      operation(async () => {
        const record = inspectVerifiedSeedExecution(receipt),
          copy = new Uint8Array(bytes),
          intent = seedJournalFingerprint({
            kind: "upload",
            record,
            bytes: backupDigest(copy),
          });
        return write(intent, () => runtime.upload(receipt, copy));
      }),
    close: async () => {
      if (closed) return;
      if (busy) throw new SeedRuntimeError("concurrent-operation");
      closed = true;
      await journal.close();
    },
  };
}
