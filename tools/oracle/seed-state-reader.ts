import { isDeepStrictEqual } from "node:util";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import { readOracleIdentity } from "./admin-read.js";
import {
  type createOracleSeedBindingLedger,
  inspectPreparedSeedCheckpoint,
} from "./seed-binding-ledger.js";
import { readOracleSeedPublication, type SeedCompletionDependencies } from "./seed-completion.js";
import { readOracleSeedIdentities } from "./seed-identities.js";
import { buildOracleSeedPlan, type SeedTask } from "./seed-plan.js";
import { seedBindingKey } from "./seed-requests.js";
import {
  assertOracleSeedSource,
  readOracleSeedSource,
  type SeedSourceKind,
} from "./seed-source.js";
import { assertOracleStore, type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class SeedStateError extends Error {
  constructor(
    readonly code:
      | "invalid-state"
      | "scope-mismatch"
      | "unverified-task"
      | "source-mismatch"
      | "publication-unverified"
      | "store-unverified",
  ) {
    super(`Oracle seed state failed: ${code}`);
    this.name = "SeedStateError";
  }
}
export type SeedTaskStatus =
  | { status: "absent" }
  | {
      status: "owned";
      sourceHash: string;
      variantIds: string[];
      collectionMembers: string[];
      collectionOrder: string[];
    };
export interface VerifiedSeedState {
  readonly kind: "verified-seed-state";
}
interface StateObservation {
  domain: string;
  shopId: string;
  fixtureHash: string;
  stateHash: string;
  taskKeys: string[];
}
const observations = new WeakMap<VerifiedSeedState, StateObservation>();
export function inspectVerifiedSeedState(receipt: VerifiedSeedState): StateObservation {
  const result = observations.get(receipt);
  if (!result) throw new SeedStateError("unverified-task");
  return structuredClone(result);
}

/** Resource-state verification only. Shop Native settings, cart sessions and capture clock remain separate gates. */
export function createOracleSeedStateReader(
  inputConfig: OracleConfig,
  snapshot: Snapshot,
  shopId: string,
  token: string,
  ledger: ReturnType<typeof createOracleSeedBindingLedger>,
  completion: SeedCompletionDependencies = {},
) {
  const config = oracleConfigSchema.parse(inputConfig),
    plan = buildOracleSeedPlan(config, snapshot),
    fetcher = completion.fetcher ?? fetch,
    dependencies = { ...completion, fetcher };
  if (plan.issues.length) throw new SeedStateError("invalid-state");
  function taskFor(stateHash: string, taskKey: string): SeedTask {
    const task = plan.states
      .find((state) => state.hash === stateHash)
      ?.tasks.find((task) => task.key === taskKey);
    if (!task) throw new SeedStateError("invalid-state");
    return task;
  }
  async function guard() {
    try {
      const identity = await readOracleIdentity(config, token, async (url, init) => {
        const response = await fetcher(url, init);
        if (response.headers.get("x-shopify-api-version") !== config.apiVersion) throw new Error();
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 65536) throw new Error();
        return new Response(bytes, { status: response.status, headers: response.headers });
      });
      assertOracleStore(config, identity);
      if (identity.id !== shopId) throw new Error();
    } catch {
      throw new SeedStateError("store-unverified");
    }
  }
  async function source(task: SeedTask, id: string) {
    if (task.resource === "image") {
      const wanted = snapshotSchema.shape.products.element.shape.images.element.parse(task.source),
        actual = (
          await readOracleSeedIdentities(config, token, shopId, "MediaImage", [id], fetcher)
        )[0];
      if (actual?.__typename !== "MediaImage" || actual.alt !== wanted.alt) throw new Error();
      // observeOwnedTask/assertOwned additionally verify READY, dimensions and exact original bytes.
      return;
    }
    const kinds: Partial<Record<SeedTask["resource"], SeedSourceKind>> = {
        product: "Product",
        collection: "Collection",
        page: "Page",
        blog: "Blog",
        article: "Article",
        menu: "Menu",
      },
      kind = kinds[task.resource];
    if (!kind) throw new Error();
    const actual = await readOracleSeedSource(
      config,
      token,
      shopId,
      kind,
      id,
      kind === "Product" ? ledger.get(seedBindingKey("inventory-location")) : undefined,
      fetcher,
    );
    assertOracleSeedSource(task, actual, ledger.get);
    if (task.resource === "product" && actual.__typename === "Product") {
      const wanted = snapshotSchema.shape.products.element.parse(task.source),
        tuple = (options: { name: string; value: string }[]) =>
          JSON.stringify([...options].sort((a, b) => a.name.localeCompare(b.name))),
        variants = new Map(
          actual.variants.nodes.map((variant) => [tuple(variant.selectedOptions), variant.id]),
        );
      if (variants.size !== wanted.variants.length) throw new Error();
      for (const variant of wanted.variants)
        if (
          variants.get(tuple(variant.optionValues)) !==
          ledger.get(seedBindingKey("variant-id", wanted.handle, variant.id))
        )
          throw new Error();
    }
  }
  async function describe(stateHash: string, taskKey: string): Promise<SeedTaskStatus> {
    const wanted = taskFor(stateHash, taskKey),
      rootKey =
        wanted.resource === "article"
          ? seedBindingKey("article-id", ...wanted.identity)
          : seedBindingKey(`${wanted.resource}-id`, wanted.identity[0] ?? ""),
      entry = inspectPreparedSeedCheckpoint(ledger.checkpoint()).entries.find(
        (entry) => entry.key === rootKey,
      );
    if (!entry) return { status: "absent" };
    if (!entry.provenance) throw new SeedStateError("unverified-task");
    const previous = taskFor(entry.provenance.stateHash, entry.provenance.taskKey);
    if (previous.key !== taskKey || previous.sourceHash !== entry.provenance.sourceHash)
      throw new SeedStateError("scope-mismatch");
    try {
      const ownership = await ledger.observeOwnedTask(entry.provenance.stateHash, taskKey),
        expected = await ledger.assertOwned(ownership);
      await source(previous, expected.id);
      let collectionOrder: string[] = [];
      if (expected.kind === "Collection") {
        const actual = (
          await readOracleSeedIdentities(
            config,
            token,
            shopId,
            "Collection",
            [expected.id],
            fetcher,
          )
        )[0];
        if (actual?.__typename !== "Collection" || actual.products.pageInfo.hasNextPage)
          throw new Error();
        collectionOrder = actual.products.nodes.map((product) => product.handle);
      }
      await ledger.assertOwned(ownership);
      return {
        status: "owned",
        sourceHash: previous.sourceHash,
        variantIds:
          previous.resource === "product"
            ? snapshotSchema.shape.products.element
                .parse(previous.source)
                .variants.map((variant) => variant.id)
            : [],
        collectionMembers:
          expected.kind === "Collection" ? expected.members.map((product) => product.handle) : [],
        collectionOrder,
      };
    } catch {
      throw new SeedStateError("source-mismatch");
    }
  }
  async function verifyTask(stateHash: string, taskKey: string) {
    const task = taskFor(stateHash, taskKey),
      actual = await describe(stateHash, taskKey);
    if (actual.status !== "owned" || actual.sourceHash !== task.sourceHash)
      throw new SeedStateError("unverified-task");
    if (task.resource === "collection") {
      const wanted = snapshotSchema.shape.collections.element.parse(task.source);
      if (
        wanted.sortOrder === "manual" &&
        !isDeepStrictEqual(actual.collectionOrder, wanted.products)
      )
        throw new SeedStateError("source-mismatch");
    }
  }
  async function publication(stateHash: string, taskKey: string): Promise<boolean> {
    const task = taskFor(stateHash, taskKey);
    if (task.resource !== "product" && task.resource !== "collection")
      throw new SeedStateError("invalid-state");
    try {
      const ownership = await ledger.observeOwnedTask(stateHash, taskKey),
        resource = await ledger.assertOwned(ownership),
        channel = await ledger.verifyExpected(seedBindingKey("online-store-publication"));
      if (
        (resource.kind !== "Product" && resource.kind !== "Collection") ||
        channel.kind !== "Publication"
      )
        throw new Error();
      const published = await readOracleSeedPublication(
        config,
        token,
        shopId,
        resource,
        channel,
        dependencies,
      );
      if (
        !isDeepStrictEqual(await ledger.assertOwned(ownership), resource) ||
        !isDeepStrictEqual(
          await ledger.verifyExpected(seedBindingKey("online-store-publication")),
          channel,
        )
      )
        throw new Error();
      return published;
    } catch {
      throw new SeedStateError("publication-unverified");
    }
  }
  return {
    guard,
    describe,
    verifyTask,
    publication,
    async verifyState(stateHash: string): Promise<VerifiedSeedState> {
      const state = plan.states.find((state) => state.hash === stateHash);
      if (!state) throw new SeedStateError("invalid-state");
      await guard();
      for (const task of state.tasks) {
        await verifyTask(stateHash, task.key);
        if (
          (task.resource === "product" || task.resource === "collection") &&
          !(await publication(stateHash, task.key))
        )
          throw new SeedStateError("publication-unverified");
      }
      await guard();
      const receipt: VerifiedSeedState = Object.freeze({ kind: "verified-seed-state" });
      observations.set(receipt, {
        domain: config.domain,
        shopId,
        fixtureHash: plan.fixtureHash,
        stateHash,
        taskKeys: state.tasks.map((task) => task.key),
      });
      return receipt;
    },
  };
}
