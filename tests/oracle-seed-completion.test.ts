import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  SeedCompletionError,
  waitOracleSeedCollectionOrder,
  waitOracleSeedImage,
} from "../tools/oracle/seed-completion.js";
import type { ExpectedSeedIdentity } from "../tools/oracle/seed-identities.js";

// All server responses below are authored mocks, not Shopify capture evidence.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1",
  imageId = "gid://shopify/MediaImage/1",
  jobId = "gid://shopify/Job/af3cb206-d472-4a54-902b-f34df6af4eb5",
  bytes = new Uint8Array([1, 2, 3]),
  expectedImage = {
    width: 10,
    height: 20,
    bytes: 3,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  },
  shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } },
  code = (value: string) => (error: unknown) =>
    error instanceof SeedCompletionError && error.code === value,
  sleep = async (ms: number) => {
    assert.equal(ms, 1000);
  },
  expected: Extract<ExpectedSeedIdentity, { kind: "Collection" }> = {
    kind: "Collection",
    id: "gid://shopify/Collection/1",
    handle: "catalog",
    sourceId: "gid://shopify/CollectionConditionsSource/1",
    sourceAppId: "gid://shopify/App/1",
    ordered: true,
    members: [
      { id: "gid://shopify/Product/2", handle: "p2" },
      { id: "gid://shopify/Product/1", handle: "p1" },
    ],
  };
function reply(data: unknown, version = "2026-10") {
  return Response.json({ data }, { headers: { "x-shopify-api-version": version } });
}
function image(status: string) {
  return {
    __typename: "MediaImage",
    id: imageId,
    fileStatus: status,
    image:
      status === "READY"
        ? { url: "https://cdn.shopify.com/image.png", width: 10, height: 20 }
        : null,
    originalSource:
      status === "READY"
        ? { url: "https://cdn.shopify.com/original.png?authored-signature=mock", fileSize: 3 }
        : null,
  };
}
function collection(members = expected.members) {
  return {
    __typename: "Collection",
    id: expected.id,
    handle: "catalog",
    sortOrder: "MANUAL",
    products: { nodes: members, pageInfo: { hasNextPage: false } },
    sources: [
      {
        __typename: "CollectionConditionsSource",
        id: expected.sourceId,
        title: "SOP fixture membership",
        shareable: false,
        targetType: "PRODUCTS",
        app: { id: expected.sourceAppId },
        inclusion: {
          conditions: [],
          selections: {
            nodes: members.map((product) => ({ product, variantIds: [] })),
            pageInfo: { hasNextPage: false },
          },
        },
        exclusion: null,
      },
    ],
  };
}
test("image polling accepts only READY with exact dimensions and credential-free original-byte verification", async () => {
  let reads = 0,
    downloads = 0;
  const node = await waitOracleSeedImage(config, "authored-token", shopId, imageId, expectedImage, {
    sleep,
    fetcher: async (url, init) => {
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      if (init?.method === "GET") {
        downloads++;
        assert.equal(init.headers, undefined);
        assert.equal(String(url), "https://cdn.shopify.com/original.png?authored-signature=mock");
        return new Response(bytes);
      }
      const body = JSON.parse(String(init?.body));
      assert.ok(body.query.startsWith("query "));
      assert.deepEqual(body.variables.ids, [imageId]);
      return reply({
        shop,
        nodes: [image(["UPLOADED", "PROCESSING", "READY"][reads++] ?? "UNKNOWN")],
      });
    },
  });
  assert.equal(node.fileStatus, "READY");
  assert.equal(reads, 3);
  assert.equal(downloads, 1);
});
test("failed or unknown image processing stops; ready dimension/hash mismatches cannot be retried into success", async () => {
  for (const failure of ["FAILED", "UNKNOWN", "dimensions", "hash"]) {
    let reads = 0;
    await assert.rejects(
      waitOracleSeedImage(config, "authored-token", shopId, imageId, expectedImage, {
        sleep,
        fetcher: async (_url, init) => {
          if (init?.method === "GET") return new Response(new Uint8Array([1, 2, 4]));
          reads++;
          const node = image(failure === "dimensions" || failure === "hash" ? "READY" : failure);
          if (failure === "dimensions" && node.image) node.image.width = 11;
          return reply({ shop, nodes: [node] });
        },
      }),
      code(failure === "FAILED" ? "processing-failed" : "postcondition-mismatch"),
    );
    assert.equal(reads, 1);
  }
});
test("pending processing is bounded by attempts and transport errors are not blind retries", async () => {
  let reads = 0,
    sleeps = 0;
  await assert.rejects(
    waitOracleSeedImage(config, "authored-token", shopId, imageId, expectedImage, {
      attempts: 3,
      sleep: async () => {
        sleeps++;
      },
      fetcher: async () => {
        reads++;
        return reply({ shop, nodes: [image("PROCESSING")] });
      },
    }),
    code("completion-timeout"),
  );
  assert.equal(reads, 3);
  assert.equal(sleeps, 2);
  reads = 0;
  await assert.rejects(
    waitOracleSeedImage(config, "authored-token", shopId, imageId, expectedImage, {
      sleep,
      fetcher: async () => {
        reads++;
        throw new Error("private signed URL");
      },
    }),
    code("read-failed"),
  );
  assert.equal(reads, 1);
});
test("job polling supports actual UUID IDs and checks fresh exact collection order after done", async () => {
  const events: string[] = [];
  let jobs = 0;
  const node = await waitOracleSeedCollectionOrder(
    config,
    "authored-token",
    shopId,
    jobId,
    expected,
    {
      sleep,
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.ok(body.query.startsWith("query "));
        assert.ok(!body.query.includes("mutation"));
        if (body.query.includes("OfflinePreviewSeedJob")) {
          events.push("job");
          assert.equal(body.variables.id, jobId);
          return reply({ shop, job: { id: jobId, done: ++jobs === 2 } });
        }
        events.push("collection");
        return reply({ shop, nodes: [collection()] });
      },
    },
  );
  assert.deepEqual(events, ["job", "job", "collection"]);
  assert.deepEqual(node.products.nodes, expected.members);
});
test("done alone cannot validate wrong order, changed membership, truncation or another conditions source", async () => {
  for (const failure of ["order", "members", "truncated", "source"]) {
    let reads = 0;
    await assert.rejects(
      waitOracleSeedCollectionOrder(config, "authored-token", shopId, jobId, expected, {
        sleep,
        fetcher: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          if (body.query.includes("OfflinePreviewSeedJob"))
            return reply({ shop, job: { id: jobId, done: true } });
          reads++;
          const node = collection(
            failure === "order"
              ? [...expected.members].reverse()
              : failure === "members"
                ? expected.members.slice(1)
                : expected.members,
          );
          if (failure === "truncated") node.products.pageInfo.hasNextPage = true;
          if (failure === "source") {
            const source = node.sources[0];
            assert.ok(source);
            source.id = "gid://shopify/CollectionConditionsSource/2";
          }
          return reply({ shop, nodes: [node] });
        },
      }),
      code("postcondition-mismatch"),
    );
    assert.equal(reads, 1);
  }
});
test("job null, mismatched ID, wrong API version and changed store are terminal read failures", async () => {
  for (const failure of ["null", "id", "version", "store", "errors"]) {
    let calls = 0;
    await assert.rejects(
      waitOracleSeedCollectionOrder(config, "authored-token", shopId, jobId, expected, {
        sleep,
        fetcher: async () => {
          calls++;
          const data = {
            shop: failure === "store" ? { ...shop, id: "gid://shopify/Shop/2" } : shop,
            job:
              failure === "null"
                ? null
                : { id: failure === "id" ? "gid://shopify/Job/2" : jobId, done: true },
          };
          return failure === "errors"
            ? Response.json(
                { data, errors: [{ message: "private API detail" }] },
                { headers: { "x-shopify-api-version": "2026-10" } },
              )
            : reply(data, failure === "version" ? "2026-07" : "2026-10");
        },
      }),
      code(failure === "store" ? "store-mismatch" : "read-failed"),
    );
    assert.equal(calls, 1);
  }
});
test("invalid poll bounds and unordered or duplicate expectations fail before a read", async () => {
  let reads = 0;
  const fetcher: typeof fetch = async () => {
    reads++;
    return new Response();
  };
  for (const options of [
    { attempts: 0 },
    { attempts: 61 },
    { intervalMs: 999 },
    { intervalMs: 2001 },
    { deadlineMs: 120001 },
  ])
    await assert.rejects(
      waitOracleSeedImage(config, "authored-token", shopId, imageId, expectedImage, {
        ...options,
        fetcher,
      }),
      code("invalid-input"),
    );
  const member = expected.members[0];
  assert.ok(member);
  for (const bad of [
    { ...expected, ordered: false },
    { ...expected, members: [member, member] },
  ])
    await assert.rejects(
      waitOracleSeedCollectionOrder(config, "authored-token", shopId, jobId, bad, { fetcher }),
      code("invalid-input"),
    );
  assert.equal(reads, 0);
});
test("one deadline applies to in-flight requests and prevents a late success", async () => {
  let calls = 0;
  await assert.rejects(
    waitOracleSeedImage(config, "authored-token", shopId, imageId, expectedImage, {
      deadlineMs: 1,
      fetcher: async (_url, init) => {
        calls++;
        assert.ok(init?.signal);
        await delay(20);
        assert.equal(init.signal.aborted, true);
        return reply({ shop, nodes: [image("READY")] });
      },
    }),
    code("completion-timeout"),
  );
  assert.equal(calls, 1);
});
