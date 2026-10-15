import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import { createOracleCartSessions } from "./cart-session.js";
import { createOracleNativeImageRecorder, type NativeImageDependencies } from "./image-native.js";
import { createOracleSeedBindingLedger } from "./seed-binding-ledger.js";
import type { SeedCompletionDependencies } from "./seed-completion.js";
import {
  createOracleSeedExecutor,
  inspectVerifiedSeedExecution,
  type SeedExecutionContext,
  SeedExecutionError,
  type SeedExecutionStep,
  type VerifiedSeedExecution,
} from "./seed-execution.js";
import { createOracleSeedGeneratedRecorder } from "./seed-generated.js";
import type { ExpectedSeedIdentity } from "./seed-identities.js";
import type { StoredSeedCheckpoint } from "./seed-journal.js";
import { createOracleSeedPostconditions } from "./seed-postconditions.js";
import { createOracleSeedStateReader } from "./seed-state-reader.js";
import { createOracleSeedUploader, SeedUploadError } from "./seed-upload.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class SeedRuntimeError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "concurrent-operation"
      | "recovery-required"
      | "recording-failed",
  ) {
    super(`Oracle seed runtime failed: ${code}`);
    this.name = "SeedRuntimeError";
  }
}
export interface SeedRuntimeDependencies {
  /** Must validate actual backup/restoration and owner-confirmed manual first wipe. No boolean flag or default approval exists. */
  authorize(context: SeedExecutionContext): Promise<void>;
  fetcher?: typeof fetch;
  /** Separate unauthenticated storage transport; no Admin token/header is attached. */
  uploadFetcher?: typeof fetch;
  completion?: Omit<SeedCompletionDependencies, "fetcher">;
}

/** One in-process execution lane with mandatory composed postconditions and atomic binding registration.
 * No batch seeder, durable recovery, wipe, marker, credentials or live entry point is supplied here. */
export function createOracleSeedRuntime(
  inputConfig: OracleConfig,
  inputSnapshot: Snapshot,
  shopId: string,
  token: string,
  schema: unknown,
  images: readonly { file: string; bytes: number; sha256: string }[],
  dependencies: SeedRuntimeDependencies,
) {
  if (typeof dependencies.authorize !== "function") throw new SeedRuntimeError("invalid-input");
  const config = oracleConfigSchema.parse(inputConfig),
    snapshot = snapshotSchema.parse(inputSnapshot),
    fetcher = dependencies.fetcher ?? fetch,
    ledger = createOracleSeedBindingLedger(config, snapshot, shopId, token, images, fetcher),
    carts = createOracleCartSessions(config, snapshot, shopId, token, ledger, fetcher),
    generated = createOracleSeedGeneratedRecorder(config, snapshot, shopId, token, ledger, fetcher),
    stateReader = createOracleSeedStateReader(config, snapshot, shopId, token, ledger, {
      ...dependencies.completion,
      fetcher,
    }),
    verifyResult = createOracleSeedPostconditions(config, snapshot, shopId, token, ledger, images, {
      ...dependencies.completion,
      fetcher,
    }),
    executor = createOracleSeedExecutor(config, snapshot, shopId, token, schema, {
      authorize: dependencies.authorize,
      verifyBindings: ledger.verifyBindings,
      verifyResult,
      fetcher,
    }),
    uploader = createOracleSeedUploader(config, snapshot, shopId, images, {
      authorize: dependencies.authorize,
      ...(dependencies.uploadFetcher ? { fetcher: dependencies.uploadFetcher } : {}),
    });
  let busy = false,
    recovery = false;
  async function operation<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) throw new SeedRuntimeError("concurrent-operation");
    if (recovery) throw new SeedRuntimeError("recovery-required");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }
  return {
    status: () => (recovery ? ("recovery-required" as const) : ("accepting-steps" as const)),
    getBinding: ledger.get,
    prepareCart: (...args: Parameters<typeof carts.prepare>) =>
      operation(() => carts.prepare(...args)),
    captureCart: (...args: Parameters<typeof carts.capture>) =>
      operation(() => carts.capture(...args)),
    captureCartContext: (...args: Parameters<typeof carts.captureContext>) =>
      operation(() => carts.captureContext(...args)),
    captureCartCorpusContext: (...args: Parameters<typeof carts.captureCorpusContext>) =>
      operation(() => carts.captureCorpusContext(...args)),
    verifyStore: () => operation(() => stateReader.guard()),
    describeTask: (stateHash: string, taskKey: string) =>
      operation(() => stateReader.describe(stateHash, taskKey)),
    verifyTask: (stateHash: string, taskKey: string) =>
      operation(() => stateReader.verifyTask(stateHash, taskKey)),
    publicationState: (stateHash: string, taskKey: string) =>
      operation(() => stateReader.publication(stateHash, taskKey)),
    verifyState: (stateHash: string) => operation(() => stateReader.verifyState(stateHash)),
    recordGenerated: (receipt: VerifiedSeedExecution) => operation(() => generated.record(receipt)),
    observeGenerated: (stateHash: string, taskKey: string) =>
      operation(async () => {
        const ownership = await ledger.observeOwnedTask(stateHash, taskKey);
        return generated.recordOwned(ownership);
      }),
    observeNativeImages: (
      stateHash: string,
      taskKey: string,
      themeId: string,
      cookie: string,
      native: NativeImageDependencies,
    ) =>
      operation(() =>
        createOracleNativeImageRecorder(
          config,
          snapshot,
          shopId,
          token,
          ledger,
          native,
          fetcher,
        ).observe(stateHash, taskKey, themeId, cookie),
      ),
    checkpoint: () => {
      if (busy) throw new SeedRuntimeError("concurrent-operation");
      if (recovery) throw new SeedRuntimeError("recovery-required");
      return ledger.checkpoint();
    },
    restoreCheckpoint: (receipt: StoredSeedCheckpoint) =>
      operation(async () => {
        try {
          await ledger.restoreCheckpoint(receipt);
        } catch {
          recovery = true;
          throw new SeedRuntimeError("recording-failed");
        }
      }),
    registerEnvironment: (
      expected: Extract<ExpectedSeedIdentity, { kind: "Location" | "Publication" }>,
    ) => operation(() => ledger.registerEnvironment(expected)),
    execute: (step: SeedExecutionStep) =>
      operation(async () => {
        let receipt: VerifiedSeedExecution;
        try {
          receipt = await executor.executeVerified(step);
        } catch (error) {
          if (
            error instanceof SeedExecutionError &&
            ["mutation-outcome-unknown", "postcondition-failed", "user-errors"].includes(error.code)
          )
            recovery = true;
          throw error;
        }
        const record = inspectVerifiedSeedExecution(receipt);
        if (
          record.context.kind === "publication" ||
          record.context.template.operation === "stagedUploadsCreate"
        )
          return receipt;
        try {
          await ledger.record(receipt);
        } catch {
          recovery = true;
          throw new SeedRuntimeError("recording-failed");
        }
        return receipt;
      }),
    upload: (receipt: VerifiedSeedExecution, bytes: Uint8Array) =>
      operation(async () => {
        let uploaded: Awaited<ReturnType<typeof uploader.upload>>;
        try {
          uploaded = await uploader.upload(receipt, bytes);
        } catch (error) {
          if (
            error instanceof SeedUploadError &&
            ["upload-outcome-unknown", "upload-rejected"].includes(error.code)
          )
            recovery = true;
          throw error;
        }
        try {
          ledger.recordUpload(uploaded);
        } catch {
          recovery = true;
          throw new SeedRuntimeError("recording-failed");
        }
        return uploaded;
      }),
  };
}
