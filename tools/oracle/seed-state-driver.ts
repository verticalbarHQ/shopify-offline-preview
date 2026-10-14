import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import { backupDigest } from "./backup-audit.js";
import type { NativeImageDependencies } from "./image-native.js";
import { openOracleSeedDurableRuntime } from "./seed-durable-runtime.js";
import type { SeedExecutionStep, VerifiedSeedExecution } from "./seed-execution.js";
import { inspectVerifiedSeedGenerated, type VerifiedSeedGenerated } from "./seed-generated.js";
import type { ExpectedSeedIdentity } from "./seed-identities.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import {
  compileSeedCollectionOrder,
  compileSeedPublication,
  compileSeedTask,
  type SeedRequestOptions,
  type SeedRequestTemplate,
  type SeedValue,
} from "./seed-requests.js";
import type { SeedRuntimeDependencies } from "./seed-runtime.js";
import { seedAdminSchema, validateSeedRequestTemplate } from "./seed-schema.js";
import {
  inspectVerifiedSeedState,
  type SeedTaskStatus,
  type VerifiedSeedState,
} from "./seed-state-reader.js";
import type { VerifiedSeedUpload } from "./seed-upload.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class SeedDriverError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "invalid-state"
      | "schema-mismatch"
      | "local-image-mismatch"
      | "concurrent-run"
      | "closed"
      | "verification-failed",
  ) {
    super(`Oracle seed driver failed: ${code}`);
    this.name = "SeedDriverError";
  }
}
export interface SeedDriverPort {
  getBinding(key: string): string;
  verifyStore(): Promise<void>;
  describeTask(stateHash: string, taskKey: string): Promise<SeedTaskStatus>;
  verifyTask(stateHash: string, taskKey: string): Promise<void>;
  publicationState(stateHash: string, taskKey: string): Promise<boolean>;
  verifyState(stateHash: string): Promise<VerifiedSeedState>;
  execute(step: SeedExecutionStep): Promise<VerifiedSeedExecution>;
  upload(receipt: VerifiedSeedExecution, bytes: Uint8Array): Promise<VerifiedSeedUpload>;
  observeGenerated(stateHash: string, taskKey: string): Promise<VerifiedSeedGenerated>;
  close(): Promise<void>;
}
type Asset = { file: string; bytes: number; sha256: string };

function bindings(template: SeedRequestTemplate, port: Pick<SeedDriverPort, "getBinding">) {
  const values: Record<string, string> = {};
  function visit(value: SeedValue) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value.$seedBinding === "string")
      values[value.$seedBinding] = port.getBinding(value.$seedBinding);
    else Object.values(value).forEach(visit);
  }
  Object.values(template.variables).forEach(visit);
  return values;
}

/** Dependency-ordered orchestration over a trusted port. Port mocks are never real state or metadata evidence.
 * The production factory below owns the actual durable runtime and validates its opaque result receipts. */
export function createOracleSeedStateDriver(
  inputConfig: OracleConfig,
  input: Snapshot,
  schema: unknown,
  imageInputs: readonly Asset[],
  port: SeedDriverPort,
  readImage: (file: string) => Promise<Uint8Array>,
) {
  const config = oracleConfigSchema.parse(inputConfig),
    snapshot = snapshotSchema.parse(input),
    plan = buildOracleSeedPlan(config, snapshot),
    images = structuredClone(imageInputs),
    retained = seedAdminSchema.parse(schema);
  if (
    plan.issues.length ||
    typeof readImage !== "function" ||
    new Set(images.map((image) => image.file)).size !== images.length
  )
    throw new SeedDriverError("invalid-input");
  const assets = new Map(images.map((image) => [image.file, image]));
  // Check every source and branch against the retained API input contracts before any store request.
  const validate = (templates: SeedRequestTemplate[]) => {
    if (templates.some((template) => validateSeedRequestTemplate(template, retained).length))
      throw new SeedDriverError("schema-mismatch");
  };
  for (const state of plan.states)
    for (const task of state.tasks) {
      const image =
          task.resource === "image"
            ? snapshotSchema.shape.products.element.shape.images.element.parse(task.source)
            : undefined,
        asset = image ? assets.get(image.file) : undefined;
      if (
        image &&
        (!asset ||
          !Number.isSafeInteger(asset.bytes) ||
          asset.bytes < 1 ||
          asset.bytes > 32 * 1024 * 1024 ||
          !/^[a-f0-9]{64}$/.test(asset.sha256))
      )
        throw new SeedDriverError("invalid-input");
      validate(
        compileSeedTask(task, { mode: "create", ...(asset ? { imageBytes: asset.bytes } : {}) }),
      );
      const options: SeedRequestOptions = {
        mode: "update",
        ...(task.resource === "collection" ? { collectionMembers: [] } : {}),
      };
      validate(compileSeedTask(task, options));
      if (task.resource === "product") {
        validate(
          compileSeedTask(task, {
            ...options,
            newVariantIds: snapshotSchema.shape.products.element
              .parse(task.source)
              .variants.map((variant) => variant.id),
          }),
        );
      }
      if (task.resource === "product" || task.resource === "collection")
        validate([
          compileSeedPublication(
            task.resource === "product" ? "Product" : "Collection",
            task.identity[0] ?? "",
          ),
        ]);
      if (task.resource === "collection") {
        const source = snapshotSchema.shape.collections.element.parse(task.source);
        if (source.sortOrder === "manual")
          validate(
            compileSeedCollectionOrder(
              source.handle,
              [...source.products].reverse(),
              source.products,
            ),
          );
      }
    }
  let busy = false,
    closed = false;
  return {
    async runState(stateHash: string) {
      if (closed) throw new SeedDriverError("closed");
      if (busy) throw new SeedDriverError("concurrent-run");
      const state = plan.states.find((state) => state.hash === stateHash);
      if (!state) throw new SeedDriverError("invalid-state");
      busy = true;
      try {
        const bytes = new Map<string, Uint8Array>();
        let total = 0;
        for (const task of state.tasks.filter((task) => task.resource === "image")) {
          const file = task.identity[0],
            asset = file ? assets.get(file) : undefined;
          if (!file || !asset) throw new SeedDriverError("local-image-mismatch");
          let copy: Uint8Array;
          try {
            copy = new Uint8Array(await readImage(file));
          } catch {
            throw new SeedDriverError("local-image-mismatch");
          }
          total += copy.byteLength;
          if (
            total > 128 * 1024 * 1024 ||
            copy.byteLength !== asset.bytes ||
            backupDigest(copy) !== asset.sha256
          )
            throw new SeedDriverError("local-image-mismatch");
          bytes.set(file, copy);
        }
        await port.verifyStore();
        const counts = { created: 0, updated: 0, reused: 0, reordered: 0, published: 0 },
          emitted = new Set<string>();
        for (const task of state.tasks) {
          if (task.dependencies.some((dependency) => !emitted.has(dependency)))
            throw new SeedDriverError("invalid-state");
          const current = await port.describeTask(stateHash, task.key);
          if (current.status === "owned" && current.sourceHash === task.sourceHash) counts.reused++;
          else {
            const options: SeedRequestOptions = {
              mode: current.status === "owned" ? "update" : "create",
            };
            if (task.resource === "image") {
              if (current.status === "owned") throw new SeedDriverError("verification-failed"); // File bytes are immutable for this prepared fixture.
              const image = snapshotSchema.shape.products.element.shape.images.element.parse(
                  task.source,
                ),
                content = bytes.get(image.file);
              if (!content) throw new SeedDriverError("local-image-mismatch");
              options.imageBytes = content.byteLength;
              const templates = compileSeedTask(task, options),
                staged = templates[0],
                create = templates[1];
              if (!staged || !create) throw new SeedDriverError("invalid-state");
              const receipt = await port.execute({
                stateHash,
                taskKey: task.key,
                kind: "task",
                options,
                requestIndex: 0,
                bindings: bindings(staged, port),
              });
              await port.upload(receipt, content);
              await port.execute({
                stateHash,
                taskKey: task.key,
                kind: "task",
                options,
                requestIndex: 1,
                bindings: bindings(create, port),
              });
            } else {
              if (task.resource === "product" && current.status === "owned")
                options.newVariantIds = snapshotSchema.shape.products.element
                  .parse(task.source)
                  .variants.filter((variant) => !current.variantIds.includes(variant.id))
                  .map((variant) => variant.id);
              if (task.resource === "collection" && current.status === "owned")
                options.collectionMembers = [...current.collectionMembers];
              const templates = compileSeedTask(task, options);
              for (const [requestIndex, template] of templates.entries())
                await port.execute({
                  stateHash,
                  taskKey: task.key,
                  kind: "task",
                  options,
                  requestIndex,
                  bindings: bindings(template, port),
                });
            }
            if (current.status === "owned") counts.updated++;
            else counts.created++;
          }
          if (task.resource === "collection") {
            const source = snapshotSchema.shape.collections.element.parse(task.source),
              observed = await port.describeTask(stateHash, task.key);
            if (observed.status !== "owned") throw new SeedDriverError("verification-failed");
            if (source.sortOrder === "manual") {
              const order = compileSeedCollectionOrder(
                source.handle,
                observed.collectionOrder,
                source.products,
              );
              for (const template of order) {
                await port.execute({
                  stateHash,
                  taskKey: task.key,
                  kind: "collection-order",
                  options: { mode: "update" },
                  observedOrder: observed.collectionOrder,
                  bindings: bindings(template, port),
                });
                counts.reordered++;
              }
            }
          }
          await port.verifyTask(stateHash, task.key);
          if (task.resource === "product" || task.resource === "collection") {
            if (!(await port.publicationState(stateHash, task.key))) {
              const template = compileSeedPublication(
                task.resource === "product" ? "Product" : "Collection",
                task.identity[0] ?? "",
              );
              await port.execute({
                stateHash,
                taskKey: task.key,
                kind: "publication",
                options: { mode: "update" },
                bindings: bindings(template, port),
              });
              counts.published++;
            }
          }
          emitted.add(task.key);
        }
        const generated: VerifiedSeedGenerated[] = [];
        for (const task of state.tasks)
          if (["product", "collection", "page", "blog", "article"].includes(task.resource))
            generated.push(await port.observeGenerated(stateHash, task.key));
        const resourceState = await port.verifyState(stateHash);
        return { stateHash, resourceState, generated, counts, captureReady: false as const };
      } finally {
        busy = false;
      }
    },
    async close() {
      if (closed) return;
      if (busy) throw new SeedDriverError("concurrent-run");
      closed = true;
      await port.close();
    },
  };
}

/** Owns the real durable runtime exclusively. No live CLI, wipe, app/token provisioning or default authorization. */
export async function openOracleSeedStateDriver(
  inputConfig: OracleConfig,
  inputSnapshot: Snapshot,
  shopId: string,
  token: string,
  schema: unknown,
  inputImages: readonly Asset[],
  directory: string,
  dependencies: SeedRuntimeDependencies & {
    readImage(file: string): Promise<Uint8Array>;
    location: Extract<ExpectedSeedIdentity, { kind: "Location" }>;
    publication: Extract<ExpectedSeedIdentity, { kind: "Publication" }>;
  },
) {
  const config = oracleConfigSchema.parse(inputConfig),
    snapshot = snapshotSchema.parse(inputSnapshot),
    images = structuredClone(inputImages);
  // Driver construction preflights the entire retained schema before its first run can mutate anything.
  const runtime = await openOracleSeedDurableRuntime(
    config,
    snapshot,
    shopId,
    token,
    schema,
    images,
    directory,
    dependencies,
  );
  try {
    const driver = createOracleSeedStateDriver(
      config,
      snapshot,
      schema,
      images,
      runtime,
      dependencies.readImage,
    );
    await runtime.registerEnvironment(dependencies.location);
    await runtime.registerEnvironment(dependencies.publication);
    let busy = false;
    async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
      if (busy) throw new SeedDriverError("concurrent-run");
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    }
    return {
      runState: (stateHash: string) =>
        exclusive(async () => {
          const result = await driver.runState(stateHash),
            state = inspectVerifiedSeedState(result.resourceState),
            plan = buildOracleSeedPlan(config, snapshot);
          if (
            state.domain !== config.domain ||
            state.shopId !== shopId ||
            state.fixtureHash !== plan.fixtureHash ||
            state.stateHash !== stateHash
          )
            throw new SeedDriverError("verification-failed");
          for (const receipt of result.generated) {
            const generated = inspectVerifiedSeedGenerated(receipt);
            if (
              generated.domain !== config.domain ||
              generated.shopId !== shopId ||
              generated.fixtureHash !== plan.fixtureHash ||
              generated.stateHash !== stateHash
            )
              throw new SeedDriverError("verification-failed");
          }
          return result;
        }),
      observeNativeImages: (
        stateHash: string,
        taskKey: string,
        themeId: string,
        cookie: string,
        native: NativeImageDependencies,
      ) =>
        exclusive(() => runtime.observeNativeImages(stateHash, taskKey, themeId, cookie, native)),
      close: () => exclusive(() => driver.close()),
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
