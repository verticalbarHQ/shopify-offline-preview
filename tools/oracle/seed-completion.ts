import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  assertOracleSeedIdentity,
  type ExpectedSeedIdentity,
  readOracleSeedIdentities,
  type SeedIdentityNode,
  verifyOracleSeedImageBytes,
} from "./seed-identities.js";
import { type OracleConfig, oracleConfigSchema } from "./store-guard.js";

export class SeedCompletionError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "read-failed"
      | "store-mismatch"
      | "processing-failed"
      | "postcondition-mismatch"
      | "completion-timeout",
  ) {
    super(`Oracle seed completion failed: ${code}`);
    this.name = "SeedCompletionError";
  }
}
export interface SeedCompletionDependencies {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
  deadlineMs?: number;
}
function polling(
  config: OracleConfig,
  token: string,
  shopId: string,
  dependencies: SeedCompletionDependencies,
) {
  let pinned: OracleConfig;
  const attempts = dependencies.attempts ?? 30,
    interval = dependencies.intervalMs ?? 1000,
    deadline = dependencies.deadlineMs ?? 120000;
  try {
    pinned = oracleConfigSchema.parse(config);
    if (
      !token.trim() ||
      !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId) ||
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      attempts > 60 ||
      !Number.isInteger(interval) ||
      interval < 1000 ||
      interval > 2000 ||
      !Number.isInteger(deadline) ||
      deadline < 1 ||
      deadline > 120000
    )
      throw new Error();
  } catch {
    throw new SeedCompletionError("invalid-input");
  }
  const signal = AbortSignal.timeout(deadline),
    fetcher = dependencies.fetcher ?? fetch;
  const boundedFetch: typeof fetch = (url, init) => {
    signal.throwIfAborted();
    return fetcher(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
  };
  return {
    pinned,
    fetcher: boundedFetch,
    async run<T>(read: () => Promise<T | undefined>): Promise<T> {
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          signal.throwIfAborted();
          const result = await read();
          signal.throwIfAborted();
          if (result !== undefined) return result;
          if (attempt + 1 < attempts) {
            if (dependencies.sleep) await dependencies.sleep(interval, signal);
            else await delay(interval, undefined, { signal });
          }
        } catch (error) {
          if (signal.aborted) throw new SeedCompletionError("completion-timeout");
          if (error instanceof SeedCompletionError) throw error;
          throw new SeedCompletionError("read-failed");
        }
      }
      throw new SeedCompletionError("completion-timeout");
    },
  };
}
type Image = Extract<SeedIdentityNode, { __typename: "MediaImage" }>;

/** Read-only postcondition component. Expected bytes come from the prepared local fixture, not the server. */
export async function waitOracleSeedImage(
  config: OracleConfig,
  token: string,
  shopId: string,
  imageId: string,
  expected: { width: number; height: number; bytes: number; sha256: string },
  dependencies: SeedCompletionDependencies = {},
): Promise<Image> {
  if (
    !/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/.test(imageId) ||
    !Number.isSafeInteger(expected.width) ||
    expected.width < 1 ||
    !Number.isSafeInteger(expected.height) ||
    expected.height < 1 ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1 ||
    expected.bytes > 32 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(expected.sha256)
  )
    throw new SeedCompletionError("invalid-input");
  const wanted = structuredClone(expected),
    poll = polling(config, token, shopId, dependencies);
  return poll.run(async () => {
    const node = (
      await readOracleSeedIdentities(
        poll.pinned,
        token,
        shopId,
        "MediaImage",
        [imageId],
        poll.fetcher,
      )
    )[0];
    if (node?.__typename !== "MediaImage") throw new SeedCompletionError("postcondition-mismatch");
    if (node.fileStatus === "FAILED") throw new SeedCompletionError("processing-failed");
    if (node.fileStatus === "UPLOADED" || node.fileStatus === "PROCESSING") return undefined;
    if (node.fileStatus !== "READY" || !node.image)
      throw new SeedCompletionError("postcondition-mismatch");
    try {
      assertOracleSeedIdentity(
        {
          kind: "MediaImage",
          id: imageId,
          url: node.image.url,
          width: wanted.width,
          height: wanted.height,
        },
        node,
      );
      await verifyOracleSeedImageBytes(node, wanted, poll.fetcher);
    } catch {
      throw new SeedCompletionError("postcondition-mismatch");
    }
    return node;
  });
}

const jobId = z
  .string()
  .regex(
    /^gid:\/\/shopify\/Job\/(?:[1-9]\d*|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/,
  );
const jobResponse = z.object({
  data: z.object({
    shop: z.object({
      id: z.string(),
      myshopifyDomain: z.string(),
      plan: z.object({ partnerDevelopment: z.boolean() }),
    }),
    job: z.object({ id: jobId, done: z.boolean() }),
  }),
  errors: z.array(z.unknown()).optional(),
});

/** A completed job is insufficient: fresh exact collection membership and order must also match. */
export async function waitOracleSeedCollectionOrder(
  config: OracleConfig,
  token: string,
  shopId: string,
  job: string,
  expected: Extract<ExpectedSeedIdentity, { kind: "Collection" }>,
  dependencies: SeedCompletionDependencies = {},
): Promise<Extract<SeedIdentityNode, { __typename: "Collection" }>> {
  const wanted = structuredClone(expected);
  if (
    !jobId.safeParse(job).success ||
    wanted.kind !== "Collection" ||
    !wanted.ordered ||
    !/^gid:\/\/shopify\/Collection\/[1-9]\d*$/.test(wanted.id) ||
    wanted.members.length > 250 ||
    new Set(wanted.members.map((m) => m.id)).size !== wanted.members.length ||
    new Set(wanted.members.map((m) => m.handle)).size !== wanted.members.length
  )
    throw new SeedCompletionError("invalid-input");
  const poll = polling(config, token, shopId, dependencies);
  return poll.run(async () => {
    const response = await poll.fetcher(
      `https://${poll.pinned.domain}/admin/api/${poll.pinned.apiVersion}/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({
          query:
            "query OfflinePreviewSeedJob($id:ID!) { shop { id myshopifyDomain plan { partnerDevelopment } } job(id:$id) { id done } }",
          variables: { id: job },
        }),
      },
    );
    if (!response.ok || response.headers.get("x-shopify-api-version") !== poll.pinned.apiVersion)
      throw new SeedCompletionError("read-failed");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 65536) throw new SeedCompletionError("read-failed");
    const parsed = jobResponse.parse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
    );
    if (parsed.errors?.length || parsed.data.job.id !== job)
      throw new SeedCompletionError("read-failed");
    if (
      parsed.data.shop.id !== shopId ||
      parsed.data.shop.myshopifyDomain !== poll.pinned.domain ||
      !parsed.data.shop.plan.partnerDevelopment
    )
      throw new SeedCompletionError("store-mismatch");
    if (!parsed.data.job.done) return undefined;
    const node = (
      await readOracleSeedIdentities(
        poll.pinned,
        token,
        shopId,
        "Collection",
        [wanted.id],
        poll.fetcher,
      )
    )[0];
    if (node?.__typename !== "Collection") throw new SeedCompletionError("postcondition-mismatch");
    try {
      assertOracleSeedIdentity(wanted, node);
    } catch {
      throw new SeedCompletionError("postcondition-mismatch");
    }
    return node;
  });
}

/** Checks one explicit publication, never a total count or display-name guess. This performs no publishing. */
export async function waitOracleSeedPublication(
  config: OracleConfig,
  token: string,
  shopId: string,
  resource: Extract<ExpectedSeedIdentity, { kind: "Product" | "Collection" }>,
  publication: Extract<ExpectedSeedIdentity, { kind: "Publication" }>,
  dependencies: SeedCompletionDependencies = {},
): Promise<void> {
  const wanted = structuredClone(resource),
    channel = structuredClone(publication);
  if (
    !["Product", "Collection"].includes(wanted.kind) ||
    channel.kind !== "Publication" ||
    !new RegExp(`^gid://shopify/${wanted.kind}/[1-9]\\d*$`).test(wanted.id) ||
    !/^gid:\/\/shopify\/Publication\/[1-9]\d*$/.test(channel.id) ||
    !/^gid:\/\/shopify\/AppCatalog\/[1-9]\d*$/.test(channel.catalogId) ||
    !/^gid:\/\/shopify\/App\/[1-9]\d*$/.test(channel.appId)
  )
    throw new SeedCompletionError("invalid-input");
  const poll = polling(config, token, shopId, dependencies);
  await poll.run(async () => {
    async function identity() {
      const row = (
          await readOracleSeedIdentities(
            poll.pinned,
            token,
            shopId,
            wanted.kind,
            [wanted.id],
            poll.fetcher,
          )
        )[0],
        pub = (
          await readOracleSeedIdentities(
            poll.pinned,
            token,
            shopId,
            "Publication",
            [channel.id],
            poll.fetcher,
          )
        )[0];
      if (!row || !pub) throw new SeedCompletionError("postcondition-mismatch");
      try {
        assertOracleSeedIdentity(wanted, row);
        assertOracleSeedIdentity(channel, pub);
      } catch {
        throw new SeedCompletionError("postcondition-mismatch");
      }
    }
    await identity();
    const response = await poll.fetcher(
      `https://${poll.pinned.domain}/admin/api/${poll.pinned.apiVersion}/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({
          query: `query OfflinePreviewSeedPublication($ids:[ID!]!,$publication:ID!) { shop { id myshopifyDomain plan { partnerDevelopment } } nodes(ids:$ids) { __typename ... on ${wanted.kind} { id handle ${wanted.kind === "Product" ? "status" : ""} publishedOnPublication(publicationId:$publication) } } }`,
          variables: { ids: [wanted.id], publication: channel.id },
        }),
      },
    );
    if (!response.ok || response.headers.get("x-shopify-api-version") !== poll.pinned.apiVersion)
      throw new SeedCompletionError("read-failed");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 65536) throw new SeedCompletionError("read-failed");
    const parsed = z
      .object({
        data: z.object({
          shop: z.object({
            id: z.string(),
            myshopifyDomain: z.string(),
            plan: z.object({ partnerDevelopment: z.boolean() }),
          }),
          nodes: z
            .array(
              z.object({
                __typename: z.literal(wanted.kind),
                id: z.string(),
                handle: z.string(),
                status: z.string().optional(),
                publishedOnPublication: z.boolean(),
              }),
            )
            .length(1),
        }),
        errors: z.array(z.unknown()).optional(),
      })
      .parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
    if (parsed.errors?.length) throw new SeedCompletionError("read-failed");
    if (
      parsed.data.shop.id !== shopId ||
      parsed.data.shop.myshopifyDomain !== poll.pinned.domain ||
      !parsed.data.shop.plan.partnerDevelopment
    )
      throw new SeedCompletionError("store-mismatch");
    const node = parsed.data.nodes[0];
    if (
      !node ||
      node.id !== wanted.id ||
      node.handle !== wanted.handle ||
      (wanted.kind === "Product" && node.status !== "ACTIVE")
    )
      throw new SeedCompletionError("postcondition-mismatch");
    if (!node.publishedOnPublication) return undefined;
    await identity();
    return true;
  });
}
