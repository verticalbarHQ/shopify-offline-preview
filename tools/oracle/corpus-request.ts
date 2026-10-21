import {
  type CompleteSnapshot as Snapshot,
  completeSnapshotSchema as snapshotSchema,
} from "../../packages/data/src/schema.js";
import { inspectPreparedFilterCorpus, type PreparedFilterCorpus } from "./corpus-source.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export interface PreparedCorpusRequest {
  readonly kind: "prepared-corpus-request";
}
const requests = new WeakMap<PreparedCorpusRequest, ReturnType<typeof buildRequest>>();
function buildRequest(
  config: OracleConfig,
  shopId: string,
  original: Snapshot,
  source: PreparedFilterCorpus,
  baseCaseId: string,
  corpusCaseId: string,
) {
  const plan = buildOracleSeedPlan(config, original),
    info = inspectPreparedFilterCorpus(source),
    base = plan.requests.find((request) => request.caseId === baseCaseId),
    item = info.cases.find((item) => item.id === corpusCaseId);
  if (
    plan.issues.length ||
    !base ||
    !item ||
    item.captureContext !== true ||
    !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId)
  )
    throw new Error("Invalid corpus capture request");
  const origin = `https://${config.domain}`,
    baseUrl = new URL(base.path, origin),
    fixtureUrl = new URL(item.fixturePath, origin),
    captureUrl = new URL(item.requestPath, origin);
  const baseQuery = new URLSearchParams(baseUrl.search),
    fixtureQuery = new URLSearchParams(fixtureUrl.search);
  baseQuery.sort();
  fixtureQuery.sort();
  if (
    fixtureQuery.toString() !== baseQuery.toString() ||
    fixtureUrl.origin !== origin ||
    captureUrl.origin !== origin ||
    fixtureUrl.pathname !== baseUrl.pathname ||
    captureUrl.pathname !== baseUrl.pathname
  )
    throw new Error("Corpus request differs from its verified fixture resource");
  return {
    domain: config.domain,
    shopId,
    fixtureHash: plan.fixtureHash,
    stateHash: base.stateHash,
    baseCaseId,
    basePath: base.path,
    capturePath: item.requestPath,
    item,
    specCommit: info.spec.commit,
    manifestHash: info.manifestHash,
    filesHash: info.filesHash,
  };
}
/** Only a pinned in-memory source can add an alternate view to an already specified fixture resource. */
export function prepareCorpusRequest(
  configValue: OracleConfig,
  shopId: string,
  originalValue: Snapshot,
  source: PreparedFilterCorpus,
  baseCaseId: string,
  corpusCaseId: string,
): PreparedCorpusRequest {
  const record = buildRequest(
      oracleConfigSchema.parse(configValue),
      shopId,
      snapshotSchema.parse(originalValue),
      source,
      baseCaseId,
      corpusCaseId,
    ),
    receipt: PreparedCorpusRequest = Object.freeze({ kind: "prepared-corpus-request" });
  requests.set(receipt, record);
  return receipt;
}
export function inspectPreparedCorpusRequest(receipt: PreparedCorpusRequest) {
  const record = requests.get(receipt);
  if (!record) throw new Error("Unverified corpus capture request");
  return structuredClone(record);
}
