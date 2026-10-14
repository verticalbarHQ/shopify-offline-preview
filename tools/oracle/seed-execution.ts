import { z } from "zod";
import type { Snapshot } from "../../packages/data/src/schema.js";
import { buildOracleSeedPlan, type SeedTask } from "./seed-plan.js";
import {
  compileSeedStepTemplates,
  resolveSeedRequest,
  type SeedRequestOptions,
  type SeedRequestTemplate,
  type SeedValue,
} from "./seed-requests.js";
import { validateSeedRequestTemplate } from "./seed-schema.js";
import {
  assertOracleStore,
  type OracleConfig,
  oracleConfigSchema,
  oracleIdentitySchema,
} from "./store-guard.js";

export type SeedExecutionCode =
  | "invalid-step"
  | "schema-mismatch"
  | "binding-invalid"
  | "authorization-denied"
  | "binding-verification-failed"
  | "guard-unavailable"
  | "guard-denied"
  | "scope-missing"
  | "concurrent-execution"
  | "throttle-limit"
  | "mutation-outcome-unknown"
  | "user-errors"
  | "postcondition-failed";
export class SeedExecutionError extends Error {
  constructor(readonly code: SeedExecutionCode) {
    super(`Oracle seed execution failed: ${code}`);
    this.name = "SeedExecutionError";
  }
}
type JsonObject = Record<string, z.infer<ReturnType<typeof z.json>>>;
export interface VerifiedSeedExecution {
  readonly kind: "verified-seed-execution";
}
export interface VerifiedSeedExecutionRecord {
  context: SeedExecutionContext;
  payload: JsonObject;
  variables: JsonObject;
}
const verifiedExecutions = new WeakMap<VerifiedSeedExecution, VerifiedSeedExecutionRecord>();
/** Serialized flags or hand-built objects cannot claim completed guarded execution. */
export function inspectVerifiedSeedExecution(
  receipt: VerifiedSeedExecution,
): VerifiedSeedExecutionRecord {
  const record = verifiedExecutions.get(receipt);
  if (!record) throw new SeedExecutionError("invalid-step");
  return structuredClone(record);
}

const guardQuery = `query OfflinePreviewSeedGuard {
  shop { id myshopifyDomain name currencyCode ianaTimezone plan { partnerDevelopment }
    metafield(namespace:"sop",key:"oracle_store") { value } }
  currentAppInstallation { accessScopes { handle } }
}`;
const guardData = z.object({
  shop: oracleIdentitySchema,
  currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
});
const envelope = z.object({
  data: z.record(z.string(), z.json()).nullable().optional(),
  errors: z
    .array(
      z.object({
        extensions: z.object({ code: z.string().optional() }).optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .optional(),
  extensions: z
    .object({
      cost: z.object({
        requestedQueryCost: z.number().finite().nonnegative(),
        throttleStatus: z.object({
          currentlyAvailable: z.number().finite().nonnegative(),
          restoreRate: z.number().finite().positive(),
        }),
      }),
    })
    .optional(),
});
const scopes: Record<string, readonly string[]> = {
  productSet: ["write_products", "write_inventory", "read_locations"],
  collectionCreate: ["write_products"],
  collectionUpdate: ["write_products"],
  collectionReorderProducts: ["write_products"],
  pageCreate: ["write_content"],
  pageUpdate: ["write_content"],
  blogCreate: ["write_content"],
  blogUpdate: ["write_content"],
  articleCreate: ["write_content"],
  articleUpdate: ["write_content"],
  menuCreate: ["write_online_store_navigation"],
  menuUpdate: ["write_online_store_navigation"],
  stagedUploadsCreate: ["write_files"],
  fileCreate: ["write_files"],
  publishablePublish: ["write_publications"],
};
export interface SeedExecutionStep {
  stateHash: string;
  taskKey: string;
  kind: "task" | "publication" | "collection-order";
  options: SeedRequestOptions;
  requestIndex?: number;
  observedOrder?: readonly string[];
  bindings: Readonly<Record<string, string>>;
}
export interface SeedExecutionContext {
  domain: string;
  apiVersion: "2026-10";
  kind: SeedExecutionStep["kind"];
  options: SeedRequestOptions;
  observedOrder?: readonly string[];
  fixtureHash: string;
  stateHash: string;
  expectedShopId: string;
  task: SeedTask;
  template: SeedRequestTemplate;
}
export interface SeedExecutionDependencies {
  /** Trusted operator integration: verifies backup/restoration evidence and owner-confirmed first manual wipe. No receipt is invented here. */
  authorize(context: SeedExecutionContext): Promise<void>;
  /** Reads dependencies and proves fixture ownership, actual IDs, staged upload completion and processed-image bindings. */
  verifyBindings(
    context: SeedExecutionContext,
    bindings: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** Reads the server result back and verifies IDs, source equality and any async job completion. */
  verifyResult(
    context: SeedExecutionContext,
    payload: JsonObject,
    variables: Readonly<Record<string, SeedValue>>,
  ): Promise<void>;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** A bounded transport component. It creates no approval, app/token, wipe command or live CLI. */
export function createOracleSeedExecutor(
  config: OracleConfig,
  snapshot: Snapshot,
  expectedShopId: string,
  token: string,
  schema: unknown,
  dependencies: SeedExecutionDependencies,
) {
  const pinned = oracleConfigSchema.parse(config),
    plan = buildOracleSeedPlan(pinned, snapshot);
  if (
    !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(expectedShopId) ||
    !token.trim() ||
    plan.issues.length ||
    typeof dependencies.authorize !== "function" ||
    typeof dependencies.verifyBindings !== "function" ||
    typeof dependencies.verifyResult !== "function"
  )
    throw new SeedExecutionError("invalid-step");
  const retainedSchema: unknown = structuredClone(schema);
  const fetcher = dependencies.fetcher ?? fetch,
    sleep =
      dependencies.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    url = `https://${pinned.domain}/admin/api/${pinned.apiVersion}/graphql.json`;
  let busy = false;
  async function send(body: unknown) {
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (response.headers.get("x-shopify-api-version") !== pinned.apiVersion)
      throw new Error("Version unavailable");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("Response bound");
    const parsed = envelope.safeParse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) throw new Error("Response unavailable");
    return { status: response.status, ok: response.ok, document: parsed.data };
  }
  async function perform(input: SeedExecutionStep): Promise<VerifiedSeedExecutionRecord> {
    if (busy) throw new SeedExecutionError("concurrent-execution");
    busy = true;
    try {
      const step = structuredClone(input),
        state = plan.states.find((s) => s.hash === step.stateHash),
        task = state?.tasks.find((t) => t.key === step.taskKey);
      if (!task || !state) throw new SeedExecutionError("invalid-step");
      let template: SeedRequestTemplate;
      try {
        const templates = compileSeedStepTemplates(
          task,
          step.kind,
          step.options,
          step.observedOrder,
        );
        const selected = templates[step.requestIndex ?? 0];
        if (!selected || !Number.isInteger(step.requestIndex ?? 0) || !scopes[selected.operation])
          throw new Error("Step unavailable");
        template = selected;
      } catch {
        throw new SeedExecutionError("invalid-step");
      }
      try {
        if (validateSeedRequestTemplate(template, retainedSchema).length)
          throw new Error("Contract mismatch");
      } catch {
        throw new SeedExecutionError("schema-mismatch");
      }
      let body: ReturnType<typeof resolveSeedRequest>;
      try {
        body = resolveSeedRequest(template, step.bindings);
      } catch {
        throw new SeedExecutionError("binding-invalid");
      }
      const context = () => ({
        domain: pinned.domain,
        apiVersion: pinned.apiVersion,
        kind: step.kind,
        options: structuredClone(step.options),
        ...(step.observedOrder ? { observedOrder: structuredClone(step.observedOrder) } : {}),
        fixtureHash: plan.fixtureHash,
        stateHash: state.hash,
        expectedShopId,
        task: structuredClone(task),
        template: structuredClone(template),
      });
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await dependencies.authorize(context());
        } catch {
          throw new SeedExecutionError("authorization-denied");
        }
        let observed: z.infer<typeof guardData>;
        try {
          const result = await send({ query: guardQuery });
          if (!result.ok || result.document.errors?.length) throw new Error("Guard unavailable");
          observed = guardData.parse(result.document.data);
        } catch {
          throw new SeedExecutionError("guard-unavailable");
        }
        try {
          assertOracleStore(pinned, observed.shop);
          if (observed.shop.id !== expectedShopId) throw new Error("Shop changed");
        } catch {
          throw new SeedExecutionError("guard-denied");
        }
        const handles = new Set(observed.currentAppInstallation.accessScopes.map((s) => s.handle));
        if (scopes[template.operation]?.some((s) => !handles.has(s)))
          throw new SeedExecutionError("scope-missing");
        try {
          await dependencies.verifyBindings(context(), structuredClone(step.bindings));
        } catch {
          throw new SeedExecutionError("binding-verification-failed");
        }
        let result: Awaited<ReturnType<typeof send>>;
        try {
          result = await send(body);
        } catch {
          throw new SeedExecutionError("mutation-outcome-unknown");
        }
        const rejected =
          !result.document.data &&
          result.document.errors?.length &&
          result.document.errors.every(
            (e) => e.extensions?.code === "THROTTLED" && !e.path?.length,
          ) &&
          (result.ok || result.status === 429);
        if (rejected) {
          if (attempt === 3) throw new SeedExecutionError("throttle-limit");
          const cost = result.document.extensions?.cost;
          const wait = cost
            ? Math.max(
                1000,
                Math.ceil(
                  ((cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) /
                    cost.throttleStatus.restoreRate) *
                    1000,
                ),
              )
            : 1000 * 2 ** attempt;
          if (wait > 30000) throw new SeedExecutionError("throttle-limit");
          try {
            await sleep(wait);
          } catch {
            throw new SeedExecutionError("throttle-limit");
          }
          continue;
        }
        if (!result.ok || result.document.errors?.length)
          throw new SeedExecutionError("mutation-outcome-unknown");
        const payload = result.document.data?.[template.operation];
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          !Array.isArray(payload.userErrors)
        )
          throw new SeedExecutionError("mutation-outcome-unknown");
        if (payload.userErrors.length) throw new SeedExecutionError("user-errors");
        try {
          await dependencies.verifyResult(
            context(),
            structuredClone(payload),
            structuredClone(body.variables),
          );
        } catch {
          throw new SeedExecutionError("postcondition-failed");
        }
        return {
          context: context(),
          payload: structuredClone(payload),
          variables: structuredClone(body.variables),
        };
      }
      throw new SeedExecutionError("throttle-limit");
    } finally {
      busy = false;
    }
  }
  return {
    async execute(input: SeedExecutionStep): Promise<JsonObject> {
      return (await perform(input)).payload;
    },
    async executeVerified(input: SeedExecutionStep): Promise<VerifiedSeedExecution> {
      const result = await perform(input);
      const receipt: VerifiedSeedExecution = Object.freeze({ kind: "verified-seed-execution" });
      verifiedExecutions.set(receipt, result);
      return receipt;
    },
  };
}
