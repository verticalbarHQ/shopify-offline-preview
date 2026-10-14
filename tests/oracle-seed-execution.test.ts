import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import {
  createOracleSeedExecutor,
  type SeedExecutionDependencies,
  SeedExecutionError,
  type SeedExecutionStep,
} from "../tools/oracle/seed-execution.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";

// All responses, credentials and IDs below are authored mocks; no live mutation evidence.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const };
const snapshot = defaultFixture(),
  plan = buildOracleSeedPlan(config, snapshot),
  state = plan.states[0];
assert.ok(state);
const page = state.tasks.find((t) => t.resource === "page");
assert.ok(page);
const step: SeedExecutionStep = {
  stateHash: state.hash,
  taskKey: page.key,
  kind: "task",
  options: { mode: "create" },
  bindings: {},
};
const named = (name: string, kind = "SCALAR") => ({ kind, name });
const schema = {
  apiVersion: "2026-10",
  operations: [
    {
      name: "pageCreate",
      args: [
        {
          name: "page",
          type: { kind: "NON_NULL", name: null, ofType: named("PageCreateInput", "INPUT_OBJECT") },
        },
      ],
    },
  ],
  types: [
    {
      kind: "INPUT_OBJECT",
      name: "PageCreateInput",
      enumValues: null,
      inputFields: ["handle", "title", "body", "templateSuffix"]
        .map((name) => ({ name, type: named("String") }))
        .concat([
          { name: "isPublished", type: named("Boolean") },
          { name: "seo", type: named("SEOInput", "INPUT_OBJECT") },
        ]),
    },
    {
      kind: "INPUT_OBJECT",
      name: "SEOInput",
      enumValues: null,
      inputFields: ["title", "description"].map((name) => ({ name, type: named("String") })),
    },
    ...["String", "Boolean"].map((name) => ({
      kind: "SCALAR",
      name,
      inputFields: null,
      enumValues: null,
    })),
  ],
};
function response(value: unknown, status = 200, version = "2026-10") {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "x-shopify-api-version": version },
  });
}
function guard(
  marker: string | null = "true",
  scopes = ["write_content"],
  domain = config.domain,
  dev = true,
  id = "gid://shopify/Shop/1",
) {
  return response({
    data: {
      shop: {
        id,
        myshopifyDomain: domain,
        name: "Authored shop",
        currencyCode: "USD",
        ianaTimezone: "UTC",
        plan: { partnerDevelopment: dev },
        metafield: marker === null ? null : { value: marker },
      },
      currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
    },
  });
}
function success() {
  return response({
    data: { pageCreate: { page: { id: "gid://shopify/Page/1" }, userErrors: [] } },
  });
}
const ok = async () => {};
function executor(fetcher: typeof fetch, override: Partial<SeedExecutionDependencies> = {}) {
  return createOracleSeedExecutor(
    config,
    snapshot,
    "gid://shopify/Shop/1",
    "authored-test-token",
    schema,
    { authorize: ok, verifyBindings: ok, verifyResult: ok, fetcher, sleep: ok, ...override },
  );
}
const code = (expected: string) => (error: unknown) =>
  error instanceof SeedExecutionError && error.code === expected && !Object.hasOwn(error, "cause");
function query(init?: RequestInit) {
  return String(JSON.parse(String(init?.body)).query);
}

test("authorization, fresh guard, dependency verification and read-back all precede success", async () => {
  const events: string[] = [];
  const client = executor(
    async (url, init) => {
      assert.equal(String(url), `https://${config.domain}/admin/api/2026-10/graphql.json`);
      assert.equal(init?.redirect, "error");
      if (query(init).startsWith("query")) {
        events.push("guard");
        return guard();
      }
      events.push("mutation");
      return success();
    },
    {
      authorize: async () => {
        events.push("authorization");
      },
      verifyBindings: async () => {
        events.push("dependencies");
      },
      verifyResult: async (_context, result) => {
        events.push("read-back");
        assert.ok(result.page);
      },
    },
  );
  await client.execute(step);
  assert.deepEqual(events, ["authorization", "guard", "dependencies", "mutation", "read-back"]);
});
test("wrong domain, shop ID, production or marker refuse every mutation", async () => {
  for (const answer of [
    guard(null),
    guard("false"),
    guard("true", ["write_content"], "other.myshopify.com"),
    guard("true", ["write_content"], config.domain, false),
    guard("true", ["write_content"], config.domain, true, "gid://shopify/Shop/2"),
  ]) {
    let writes = 0;
    const client = executor(async (_url, init) => {
      if (query(init).startsWith("mutation")) writes++;
      return answer;
    });
    await assert.rejects(client.execute(step), code("guard-denied"));
    assert.equal(writes, 0);
  }
});
test("missing scope, operator approval or binding ownership stops before the write", async () => {
  let writes = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    if (query(init).startsWith("mutation")) writes++;
    return guard("true", []);
  };
  await assert.rejects(executor(fetcher).execute(step), code("scope-missing"));
  const secret = async () => {
    throw new Error("concealed evidence payload");
  };
  await assert.rejects(
    executor(fetcher, { authorize: secret }).execute(step),
    code("authorization-denied"),
  );
  await assert.rejects(
    executor(async () => guard(), { verifyBindings: secret }).execute(step),
    code("binding-verification-failed"),
  );
  assert.equal(writes, 0);
});
test("explicit pre-execution throttling retries with cost delay and fresh checks", async () => {
  let writes = 0,
    guards = 0,
    authorization = 0,
    dependencies = 0;
  const waits: number[] = [];
  const client = executor(
    async (_url, init) => {
      if (query(init).startsWith("query")) {
        guards++;
        return guard();
      }
      writes++;
      return writes === 1
        ? response({
            errors: [{ message: "private", extensions: { code: "THROTTLED" } }],
            extensions: {
              cost: {
                requestedQueryCost: 100,
                throttleStatus: { currentlyAvailable: 0, restoreRate: 20 },
              },
            },
          })
        : success();
    },
    {
      authorize: async () => {
        authorization++;
      },
      verifyBindings: async () => {
        dependencies++;
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  await client.execute(step);
  assert.equal(writes, 2);
  assert.equal(guards, 2);
  assert.equal(authorization, 2);
  assert.equal(dependencies, 2);
  assert.deepEqual(waits, [5000]);
});
test("a lost or invalid mutation response is never blindly replayed", async () => {
  for (const fail of [
    async () => {
      throw new Error("concealed response");
    },
    async () => response({ errors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }] }, 500),
    async () => response({ errors: [{ extensions: { code: "THROTTLED" }, path: ["pageCreate"] }] }),
    async () =>
      response({ data: { pageCreate: null }, errors: [{ extensions: { code: "THROTTLED" } }] }),
    async () => response({ data: { pageCreate: {} } }),
    async () => response({}, 200, "2027-01"),
  ]) {
    let writes = 0;
    const client = executor(async (_url, init) => {
      if (query(init).startsWith("query")) return guard();
      writes++;
      return fail();
    });
    await assert.rejects(client.execute(step), code("mutation-outcome-unknown"));
    assert.equal(writes, 1);
  }
});
test("user errors and failed read-back expose fixed codes and do not replay writes", async () => {
  let writes = 0;
  const client = executor(async (_url, init) => {
    if (query(init).startsWith("query")) return guard();
    writes++;
    return response({
      data: { pageCreate: { userErrors: [{ message: "private customer text" }] } },
    });
  });
  await assert.rejects(client.execute(step), code("user-errors"));
  assert.equal(writes, 1);
  const after = executor(
    async (_url, init) => (query(init).startsWith("query") ? guard() : success()),
    {
      verifyResult: async () => {
        throw new Error("private result");
      },
    },
  );
  await assert.rejects(after.execute(step), code("postcondition-failed"));
});
test("throttle retries are bounded and a changed marker aborts the next attempt", async () => {
  let writes = 0;
  const throttled = () => response({ errors: [{ extensions: { code: "THROTTLED" } }] }, 429);
  const client = executor(async (_url, init) => {
    if (query(init).startsWith("query")) return guard();
    writes++;
    return throttled();
  });
  await assert.rejects(client.execute(step), code("throttle-limit"));
  assert.equal(writes, 4);
  writes = 0;
  let guards = 0;
  const changed = executor(async (_url, init) => {
    if (query(init).startsWith("query")) return guard(++guards === 1 ? "true" : "false");
    writes++;
    return throttled();
  });
  await assert.rejects(changed.execute(step), code("guard-denied"));
  assert.equal(writes, 1);
});
test("concurrent execution is rejected and failure releases the executor", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = executor(
    async (_url, init) => (query(init).startsWith("query") ? guard() : success()),
    {
      authorize: async () => {
        await gate;
      },
    },
  );
  const running = client.execute(step);
  await assert.rejects(client.execute(step), code("concurrent-execution"));
  assert.ok(release);
  release();
  await running;
  await client.execute(step);
});
test("unknown steps, unresolved IDs and schema mismatches never reach the network", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return guard();
  };
  const client = executor(fetcher);
  await assert.rejects(
    client.execute({ ...step, stateHash: "unrecognized" }),
    code("invalid-step"),
  );
  await assert.rejects(
    client.execute({ ...step, options: { mode: "update" } }),
    code("schema-mismatch"),
  );
  await assert.rejects(client.execute({ ...step, requestIndex: 2 }), code("invalid-step"));
  assert.equal(calls, 0);
});
test("valid update input contracts still require concrete real resource bindings before any guard query", async () => {
  const updateSchema = {
    ...schema,
    operations: [
      ...schema.operations,
      {
        name: "pageUpdate",
        args: [
          { name: "id", type: { kind: "NON_NULL", name: null, ofType: named("ID") } },
          {
            name: "page",
            type: {
              kind: "NON_NULL",
              name: null,
              ofType: named("PageUpdateInput", "INPUT_OBJECT"),
            },
          },
        ],
      },
    ],
    types: [
      ...schema.types,
      { kind: "SCALAR", name: "ID", inputFields: null, enumValues: null },
      {
        kind: "INPUT_OBJECT",
        name: "PageUpdateInput",
        inputFields: schema.types[0]?.inputFields ?? [],
        enumValues: null,
      },
    ],
  };
  let calls = 0;
  const client = createOracleSeedExecutor(
    config,
    snapshot,
    "gid://shopify/Shop/1",
    "authored-test-token",
    updateSchema,
    {
      authorize: ok,
      verifyBindings: ok,
      verifyResult: ok,
      fetcher: async () => {
        calls++;
        return guard();
      },
    },
  );
  await assert.rejects(
    client.execute({ ...step, options: { mode: "update" } }),
    code("binding-invalid"),
  );
  assert.equal(calls, 0);
});
test("guard failures and malformed retained schemas do not expose private errors or reach mutations", async () => {
  const badGuard = executor(async () => {
    throw new Error("concealed credential value");
  });
  await assert.rejects(badGuard.execute(step), code("guard-unavailable"));
  let calls = 0;
  const badSchema = createOracleSeedExecutor(
    config,
    snapshot,
    "gid://shopify/Shop/1",
    "authored-test-token",
    { private: "concealed field" },
    {
      authorize: ok,
      verifyBindings: ok,
      verifyResult: ok,
      fetcher: async () => {
        calls++;
        return guard();
      },
    },
  );
  await assert.rejects(badSchema.execute(step), code("schema-mismatch"));
  assert.equal(calls, 0);
});
test("ordering a fixture collection with non-manual sort is refused before any request", async () => {
  const input = defaultFixture();
  const collection = input.collections[0];
  assert.ok(collection);
  collection.sortOrder = "title-ascending";
  const prepared = buildOracleSeedPlan(config, input),
    first = prepared.states[0];
  assert.ok(first);
  const task = first.tasks.find((t) => t.resource === "collection");
  assert.ok(task);
  let calls = 0;
  const client = createOracleSeedExecutor(
    config,
    input,
    "gid://shopify/Shop/1",
    "authored-test-token",
    schema,
    {
      authorize: ok,
      verifyBindings: ok,
      verifyResult: ok,
      fetcher: async () => {
        calls++;
        return guard();
      },
    },
  );
  await assert.rejects(
    client.execute({
      stateHash: first.hash,
      taskKey: task.key,
      kind: "collection-order",
      options: { mode: "update" },
      observedOrder: [...collection.products].reverse(),
      bindings: {},
    }),
    code("invalid-step"),
  );
  assert.equal(calls, 0);
});
