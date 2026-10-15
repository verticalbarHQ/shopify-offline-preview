import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { applyScenario } from "../../packages/data/src/scenarios.js";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import type { BenchmarkThemeBinding } from "./benchmark-theme.js";
import type { CapturedPage, CaptureInput } from "./capture.js";
import {
  applyOracleCaptureContext,
  type ContextCaptureDependencies,
  inspectVerifiedCaptureContext,
  type VerifiedCaptureContext,
} from "./capture-context.js";
import {
  applyOracleCart,
  inspectVerifiedOracleCart,
  type OracleCartDependencies,
  type VerifiedOracleCart,
} from "./cart-session.js";
import {
  applyOracleNativeImages,
  inspectVerifiedNativeImages,
  type VerifiedNativeImages,
} from "./image-native.js";
import { snapshotFingerprint } from "./matrix.js";
import {
  applyOracleSeedGenerated,
  inspectVerifiedSeedGenerated,
  type VerifiedSeedGenerated,
} from "./seed-generated.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import { inspectVerifiedSeedState, type VerifiedSeedState } from "./seed-state-reader.js";
import {
  inspectVerifiedOracleShopSettings,
  type VerifiedOracleShopSettings,
} from "./shop-settings.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class OracleCaseError extends Error {
  constructor(
    readonly code:
      | "invalid-case"
      | "invalid-scope"
      | "incomplete-evidence"
      | "changed-evidence"
      | "unverified-case"
      | "concurrent-operation",
  ) {
    super(`Oracle case capture failed: ${code}`);
    this.name = "OracleCaseError";
  }
}
export interface CaseEvidence {
  before: VerifiedSeedState;
  after: VerifiedSeedState;
  generated: readonly VerifiedSeedGenerated[];
  generatedAfter: readonly VerifiedSeedGenerated[];
  images: readonly VerifiedNativeImages[];
  imagesAfter: readonly VerifiedNativeImages[];
  shop: VerifiedOracleShopSettings;
  shopAfter: VerifiedOracleShopSettings;
  cart: VerifiedOracleCart;
  capture: CapturedPage;
  context: VerifiedCaptureContext;
}
export interface VerifiedOracleCase {
  readonly kind: "verified-oracle-case";
}
interface CaseRecord {
  domain: string;
  shopId: string;
  caseId: string;
  path: string;
  sourceScenario: string;
  stateHash: string;
  baseFixtureHash: string;
  snapshotHash: string;
  contextHash: string;
  rawHashes: readonly string[];
  snapshot: Snapshot;
  capture: CapturedPage;
  theme?: BenchmarkThemeBinding;
}
const cases = new WeakMap<VerifiedOracleCase, CaseRecord>();
export function inspectVerifiedOracleCase(receipt: VerifiedOracleCase): CaseRecord {
  const record = cases.get(receipt);
  if (!record) throw new OracleCaseError("unverified-case");
  return structuredClone(record);
}
function digest(html: string) {
  return createHash("sha256").update(html).digest("hex");
}
/** All inspectors require genuine in-memory receipts. This certifies assembled capture data, never theme parity or publication. */
export function assembleOracleCase(
  configValue: OracleConfig,
  originalValue: Snapshot,
  shopId: string,
  caseId: string,
  evidence: CaseEvidence,
): VerifiedOracleCase {
  const config = oracleConfigSchema.parse(configValue),
    original = snapshotSchema.parse(originalValue),
    plan = buildOracleSeedPlan(config, original),
    request = plan.requests.find((request) => request.caseId === caseId),
    state = plan.states.find((state) => state.hash === request?.stateHash);
  if (plan.issues.length || !request || !state) throw new OracleCaseError("invalid-case");
  try {
    const before = inspectVerifiedSeedState(evidence.before),
      after = inspectVerifiedSeedState(evidence.after),
      wantedTasks = state.tasks.map((task) => task.key);
    for (const record of [before, after])
      if (
        record.domain !== config.domain ||
        record.shopId !== shopId ||
        record.fixtureHash !== plan.fixtureHash ||
        record.stateHash !== state.hash ||
        !isDeepStrictEqual(record.taskKeys, wantedTasks)
      )
        throw new OracleCaseError("invalid-scope");
    const shop = inspectVerifiedOracleShopSettings(evidence.shop),
      shopAfter = inspectVerifiedOracleShopSettings(evidence.shopAfter);
    if (
      shop.domain !== config.domain ||
      shop.shopId !== shopId ||
      shop.apiVersion !== config.apiVersion ||
      !isDeepStrictEqual(shop, shopAfter) ||
      !isDeepStrictEqual(shop.shop, state.shopToVerify)
    )
      throw new OracleCaseError("invalid-scope");
    function records<T>(items: readonly T[], inspect: (item: T) => { taskKey: string }) {
      const map = new Map<string, ReturnType<typeof inspect>>();
      for (const receipt of items) {
        const record = inspect(receipt);
        if (map.has(record.taskKey)) throw new OracleCaseError("invalid-scope");
        map.set(record.taskKey, record);
      }
      return [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    }
    if (
      !isDeepStrictEqual(
        records(evidence.generated, inspectVerifiedSeedGenerated),
        records(evidence.generatedAfter, inspectVerifiedSeedGenerated),
      ) ||
      !isDeepStrictEqual(
        records(evidence.images, inspectVerifiedNativeImages),
        records(evidence.imagesAfter, inspectVerifiedNativeImages),
      )
    )
      throw new OracleCaseError("changed-evidence");
    const generated = applyOracleSeedGenerated(
      config,
      original,
      shopId,
      caseId,
      evidence.generated,
    );
    if (
      generated.missingTasks.length ||
      generated.omissions.includes("article-updated-at-unavailable")
    )
      throw new OracleCaseError("incomplete-evidence");
    const images = applyOracleNativeImages(
      config,
      original,
      shopId,
      caseId,
      generated.snapshot,
      evidence.images,
    );
    if (images.missingTasks.length) throw new OracleCaseError("incomplete-evidence");
    const cartRecord = inspectVerifiedOracleCart(evidence.cart),
      contextRecord = inspectVerifiedCaptureContext(evidence.context);
    if (
      cartRecord.path !== request.path ||
      contextRecord.requestPath !== request.path ||
      contextRecord.domain !== config.domain ||
      contextRecord.shopId !== shopId ||
      contextRecord.contexts[0].locale !== shop.shop.locale ||
      contextRecord.contexts[0].cart.currency !== shop.shop.currency
    )
      throw new OracleCaseError("invalid-scope");
    const capture = structuredClone(evidence.capture),
      rawHashes = capture.privateRawHtml.map(digest);
    if (
      !isDeepStrictEqual(rawHashes, contextRecord.rawHashes) ||
      digest(JSON.stringify(capture.publicSummary)) !== contextRecord.summaryHash ||
      digest(JSON.stringify(capture.privateSectionText)) !== contextRecord.sectionTextHash ||
      capture.capturedAt !== new Date(Number(contextRecord.contexts[0].epoch) * 1000).toISOString()
    )
      throw new OracleCaseError("invalid-scope");
    const cart = applyOracleCart(config, original, shopId, caseId, images.snapshot, evidence.cart),
      context = applyOracleCaptureContext(cart.snapshot, evidence.context),
      snapshot = context.snapshot;
    // The exact same request's summary and private section text are retained, not a caller's replacement summary.
    const receipt: VerifiedOracleCase = Object.freeze({ kind: "verified-oracle-case" });
    cases.set(receipt, {
      domain: config.domain,
      shopId,
      caseId,
      path: request.path,
      sourceScenario: request.scenario,
      stateHash: state.hash,
      baseFixtureHash: plan.fixtureHash,
      snapshotHash: snapshotFingerprint(snapshot),
      contextHash: contextRecord.snippetHash,
      rawHashes,
      snapshot,
      capture,
      ...(contextRecord.theme ? { theme: contextRecord.theme } : {}),
    });
    return receipt;
  } catch (error) {
    if (error instanceof OracleCaseError) throw error;
    throw new OracleCaseError("incomplete-evidence");
  }
}
export interface OracleCasePort {
  verifyState(hash: string): Promise<VerifiedSeedState>;
  observeGenerated(hash: string, key: string): Promise<VerifiedSeedGenerated>;
  observeImages(hash: string, key: string): Promise<VerifiedNativeImages>;
  verifyShop(expected: Snapshot["shop"]): Promise<VerifiedOracleShopSettings>;
  prepareCart(caseId: string, dependencies: OracleCartDependencies): Promise<VerifiedOracleCart>;
  captureCartContext(
    receipt: VerifiedOracleCart,
    input: Omit<CaptureInput, "config" | "path" | "cookie">,
    dependencies: Omit<ContextCaptureDependencies, "fetcher">,
  ): Promise<{ capture: CapturedPage; context: VerifiedCaptureContext }>;
}
/** One serialized, read/observe/capture transaction after explicit seeding; no provisioning, source writes, upload or publication here. */
export function createOracleCaseCapturer(
  configValue: OracleConfig,
  originalValue: Snapshot,
  shopId: string,
  port: OracleCasePort,
) {
  const config = oracleConfigSchema.parse(configValue),
    original = snapshotSchema.parse(originalValue),
    plan = buildOracleSeedPlan(config, original);
  let busy = false;
  if (plan.issues.length) throw new OracleCaseError("invalid-case");
  async function collect(hash: string) {
    const state = plan.states.find((state) => state.hash === hash);
    if (!state) throw new OracleCaseError("invalid-case");
    const generated: VerifiedSeedGenerated[] = [],
      images: VerifiedNativeImages[] = [];
    for (const task of state.tasks) {
      if (["product", "collection", "page", "blog", "article"].includes(task.resource))
        generated.push(await port.observeGenerated(hash, task.key));
      if (["product", "collection", "article"].includes(task.resource))
        images.push(await port.observeImages(hash, task.key));
    }
    return { generated, images };
  }
  return {
    async capture(
      caseId: string,
      inputValue: Omit<CaptureInput, "config" | "path" | "cookie">,
      cart: OracleCartDependencies,
      adapters: Omit<ContextCaptureDependencies, "fetcher">,
    ): Promise<VerifiedOracleCase> {
      if (busy) throw new OracleCaseError("concurrent-operation");
      const request = plan.requests.find((request) => request.caseId === caseId);
      if (!request) throw new OracleCaseError("invalid-case");
      const input = structuredClone(inputValue);
      busy = true;
      try {
        const before = await port.verifyState(request.stateHash),
          scope = inspectVerifiedSeedState(before),
          expectedShop = applyScenario(original, request.scenario).shop;
        if (
          scope.domain !== config.domain ||
          scope.shopId !== shopId ||
          scope.fixtureHash !== plan.fixtureHash ||
          scope.stateHash !== request.stateHash
        )
          throw new OracleCaseError("invalid-scope");
        const shop = await port.verifyShop(expectedShop),
          shopScope = inspectVerifiedOracleShopSettings(shop);
        if (
          shopScope.domain !== config.domain ||
          shopScope.shopId !== shopId ||
          !isDeepStrictEqual(shopScope.shop, expectedShop)
        )
          throw new OracleCaseError("invalid-scope");
        const first = await collect(request.stateHash),
          session = await port.prepareCart(caseId, cart),
          captured = await port.captureCartContext(session, input, adapters),
          last = await collect(request.stateHash),
          shopAfter = await port.verifyShop(applyScenario(original, request.scenario).shop),
          after = await port.verifyState(request.stateHash);
        return assembleOracleCase(config, original, shopId, caseId, {
          before,
          after,
          ...first,
          generatedAfter: last.generated,
          imagesAfter: last.images,
          shop,
          shopAfter,
          cart: session,
          ...captured,
        });
      } finally {
        busy = false;
      }
    },
  };
}
