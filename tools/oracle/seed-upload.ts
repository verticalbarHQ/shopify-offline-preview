import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import {
  inspectVerifiedSeedExecution,
  type SeedExecutionContext,
  type VerifiedSeedExecution,
} from "./seed-execution.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class SeedUploadError extends Error {
  constructor(
    readonly code:
      | "invalid-target"
      | "scope-mismatch"
      | "asset-mismatch"
      | "target-used"
      | "authorization-denied"
      | "upload-outcome-unknown"
      | "upload-rejected"
      | "unverified-upload",
  ) {
    super(`Oracle staged upload failed: ${code}`);
    this.name = "SeedUploadError";
  }
}
export interface VerifiedSeedUpload {
  readonly kind: "verified-seed-upload";
}
interface UploadRecord {
  context: SeedExecutionContext;
  file: string;
  bytes: number;
  sha256: string;
  resourceUrl: string;
}
const uploads = new WeakMap<VerifiedSeedUpload, UploadRecord>();
// Reserve before POST: a lost acknowledgement must never trigger an automatic replay.
const attempted = new WeakSet<VerifiedSeedExecution>();
export function inspectVerifiedSeedUpload(receipt: VerifiedSeedUpload): UploadRecord {
  const record = uploads.get(receipt);
  if (!record) throw new SeedUploadError("unverified-upload");
  return structuredClone(record);
}
function stagedUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !["shopify-staged-uploads.storage.googleapis.com", "shopify.s3.amazonaws.com"].includes(
        url.hostname,
      )
    )
      throw new Error();
    return url.href;
  } catch {
    throw new SeedUploadError("invalid-target");
  }
}
const targets = z.object({
  stagedTargets: z
    .array(
      z.object({
        url: z.string().max(16384),
        resourceUrl: z.string().max(16384),
        parameters: z
          .array(
            z.object({
              name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
              value: z.string().max(65536),
            }),
          )
          .min(1)
          .max(32),
      }),
    )
    .length(1),
});

/** Shared by the pre-receipt postcondition and the later byte-upload transport. No upload completion is claimed here. */
export function validateOracleSeedUploadTarget(
  context: SeedExecutionContext,
  payload: unknown,
  variables: unknown,
  asset: { file: string; bytes: number },
) {
  try {
    if (
      context.kind !== "task" ||
      context.task.resource !== "image" ||
      context.options.mode !== "create" ||
      context.template.operation !== "stagedUploadsCreate"
    )
      throw new Error();
    const source = snapshotSchema.shape.products.element.shape.images.element.parse(
      context.task.source,
    );
    if (
      source.file !== asset.file ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      asset.bytes > 32 * 1024 * 1024
    )
      throw new Error();
    z.object({
      input: z
        .array(
          z.object({
            resource: z.literal("IMAGE"),
            filename: z.literal(basename(source.file)),
            mimeType: z.literal("image/png"),
            httpMethod: z.literal("POST"),
            fileSize: z.literal(String(asset.bytes)),
          }),
        )
        .length(1),
    }).parse(variables);
    const target = targets.parse(payload).stagedTargets[0];
    if (
      !target ||
      target.parameters.some((p) => p.name.toLowerCase() === "file") ||
      new Set(target.parameters.map((p) => p.name.toLowerCase())).size !== target.parameters.length
    )
      throw new Error();
    stagedUrl(target.url);
    stagedUrl(target.resourceUrl);
    return target;
  } catch {
    throw new SeedUploadError("invalid-target");
  }
}

/** Operator-only upload transport; no credentials, retries, CLI or SDK import path. */
export function createOracleSeedUploader(
  config: OracleConfig,
  snapshot: Snapshot,
  shopId: string,
  images: readonly { file: string; bytes: number; sha256: string }[],
  dependencies: { authorize(context: SeedExecutionContext): Promise<void>; fetcher?: typeof fetch },
) {
  const pinned = oracleConfigSchema.parse(config),
    plan = buildOracleSeedPlan(pinned, snapshot),
    assets = structuredClone(images);
  if (
    plan.issues.length ||
    !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId) ||
    typeof dependencies.authorize !== "function" ||
    new Set(assets.map((a) => a.file)).size !== assets.length
  )
    throw new SeedUploadError("scope-mismatch");
  return {
    async upload(receipt: VerifiedSeedExecution, bytes: Uint8Array): Promise<VerifiedSeedUpload> {
      let record: ReturnType<typeof inspectVerifiedSeedExecution>;
      try {
        record = inspectVerifiedSeedExecution(receipt);
      } catch {
        throw new SeedUploadError("invalid-target");
      }
      const context = record.context,
        task = plan.states
          .find((s) => s.hash === context.stateHash)
          ?.tasks.find((t) => t.key === context.task.key);
      if (
        context.domain !== pinned.domain ||
        context.apiVersion !== pinned.apiVersion ||
        context.fixtureHash !== plan.fixtureHash ||
        context.expectedShopId !== shopId ||
        !task ||
        task.sourceHash !== context.task.sourceHash ||
        task.resource !== "image" ||
        context.kind !== "task" ||
        context.options.mode !== "create" ||
        context.template.operation !== "stagedUploadsCreate"
      )
        throw new SeedUploadError("scope-mismatch");
      const source = snapshotSchema.shape.products.element.shape.images.element.parse(task.source),
        asset = assets.find((a) => a.file === source.file),
        copy = new Uint8Array(bytes),
        sha256 = createHash("sha256").update(copy).digest("hex");
      if (
        !asset ||
        asset.bytes < 1 ||
        asset.bytes > 32 * 1024 * 1024 ||
        copy.length !== asset.bytes ||
        sha256 !== asset.sha256
      )
        throw new SeedUploadError("asset-mismatch");
      const target = validateOracleSeedUploadTarget(
        context,
        record.payload,
        record.variables,
        asset,
      );
      if (attempted.has(receipt)) throw new SeedUploadError("target-used");
      const form = new FormData();
      for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
      form.append("file", new Blob([copy], { type: "image/png" }), basename(source.file));
      try {
        await dependencies.authorize(structuredClone(context));
      } catch {
        throw new SeedUploadError("authorization-denied");
      }
      // Another concurrent caller may have reserved the receipt while authorization awaited.
      if (attempted.has(receipt)) throw new SeedUploadError("target-used");
      attempted.add(receipt);
      let response: Response;
      try {
        response = await (dependencies.fetcher ?? fetch)(target.url, {
          method: "POST",
          body: form,
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        throw new SeedUploadError("upload-outcome-unknown");
      }
      // Response text may contain signed parameters. Never parse, retain or reflect it.
      try {
        await response.body?.cancel();
      } catch {
        /* Status headers already received. */
      }
      if (response.redirected || response.status < 200 || response.status >= 300)
        throw new SeedUploadError("upload-rejected");
      const result: VerifiedSeedUpload = Object.freeze({ kind: "verified-seed-upload" });
      uploads.set(result, {
        context,
        file: source.file,
        bytes: asset.bytes,
        sha256,
        resourceUrl: target.resourceUrl,
      });
      return result;
    },
  };
}
