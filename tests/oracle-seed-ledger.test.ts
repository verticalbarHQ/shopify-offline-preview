import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import {
  createOracleSeedBindingLedger,
  SeedLedgerError,
} from "../tools/oracle/seed-binding-ledger.js";
import {
  createOracleSeedExecutor,
  inspectVerifiedSeedExecution,
  type SeedExecutionStep,
} from "../tools/oracle/seed-execution.js";
import {
  assertOracleSeedHandleAbsent,
  readOracleSeedVariants,
  SeedIdentityError,
} from "../tools/oracle/seed-identities.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";
import { seedBindingKey } from "../tools/oracle/seed-requests.js";
import { seedAdminSchema } from "../tools/oracle/seed-schema.js";

const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1";
const input = defaultFixture(),
  plan = buildOracleSeedPlan(config, input),
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
const schema: unknown = JSON.parse(
  await readFile(new URL("./fixtures/oracle-seed-input-contracts.json", import.meta.url), "utf8"),
);
const ok = async () => {};
function reply(data: unknown) {
  return Response.json({ data }, { headers: { "x-shopify-api-version": "2026-10" } });
}
const shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } };
function setup(wrongHandle = false) {
  const events: string[] = [];
  let created = false;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      query: string = body.query;
    if (query.includes("OfflinePreviewSeedAbsence")) {
      events.push("absence");
      return reply({
        shop,
        pages: {
          nodes: created ? [{ id: "gid://shopify/Page/1", handle: "about" }] : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    }
    if (query.includes("OfflinePreviewSeedIdentities")) {
      events.push("identity");
      return reply({
        shop,
        nodes: [
          {
            __typename: "Page",
            id: "gid://shopify/Page/1",
            handle: wrongHandle ? "other" : "about",
          },
        ],
      });
    }
    if (query.includes("OfflinePreviewSeedGuard")) {
      events.push("guard");
      return reply({
        shop: {
          ...shop,
          name: "Authored shop",
          currencyCode: "USD",
          ianaTimezone: "UTC",
          metafield: { value: "true" },
        },
        currentAppInstallation: { accessScopes: [{ handle: "write_content" }] },
      });
    }
    if (query.startsWith("mutation")) {
      events.push("write");
      created = true;
      return reply({
        pageCreate: { page: { id: "gid://shopify/Page/1" }, userErrors: [] },
        pageUpdate: { page: { id: "gid://shopify/Page/1" }, userErrors: [] },
      });
    }
    throw new Error("Unexpected authored query");
  };
  const ledger = createOracleSeedBindingLedger(
    config,
    input,
    shopId,
    "authored-token",
    [],
    fetcher,
  );
  const executor = createOracleSeedExecutor(config, input, shopId, "authored-token", schema, {
    authorize: ok,
    verifyBindings: ledger.verifyBindings,
    verifyResult: ok,
    fetcher,
  });
  return { events, ledger, executor };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof SeedLedgerError && error.code === expected;

test("collection job receipt updates ledger order only after fresh complete membership matches", async () => {
  const fixture = defaultFixture();
  for (const product of fixture.products) {
    product.images = [];
    for (const variant of product.variants) variant.image = null;
  }
  const first = fixture.products[0],
    second = fixture.products[1],
    desired = fixture.collections[0];
  assert.ok(first && second && desired);
  desired.products = [first.handle, second.handle];
  desired.image = null;
  desired.sortOrder = "manual";
  const prepared = buildOracleSeedPlan(config, fixture),
    initial = prepared.states[0];
  assert.ok(initial);
  const collectionTask = initial.tasks.find((t) => t.resource === "collection");
  assert.ok(collectionTask);
  const contract = seedAdminSchema.parse(schema),
    named = (name: string, kind = "SCALAR") => ({ name, kind }),
    nonnull = (type: { name: string; kind: string }) => ({
      kind: "NON_NULL",
      name: null,
      ofType: type,
    }),
    list = (name: string) => ({
      kind: "LIST",
      name: null,
      ofType: nonnull(named(name, "INPUT_OBJECT")),
    }),
    object = (name: string, inputFields: { name: string; type: object }[]) => ({
      name,
      kind: "INPUT_OBJECT",
      inputFields,
      enumValues: null,
    }),
    extra: unknown = {
      apiVersion: "2026-10",
      operations: [
        ...contract.operations,
        {
          name: "collectionCreate",
          args: [
            { name: "collection", type: nonnull(named("CollectionCreateInput", "INPUT_OBJECT")) },
          ],
        },
        {
          name: "collectionReorderProducts",
          args: [
            { name: "id", type: nonnull(named("ID")) },
            { name: "moves", type: { kind: "NON_NULL", name: null, ofType: list("MoveInput") } },
          ],
        },
      ],
      types: [
        ...contract.types,
        object("CollectionCreateInput", [
          ...["handle", "title", "descriptionHtml", "templateSuffix", "sortOrder", "image"].map(
            (name) => ({ name, type: named("String") }),
          ),
          { name: "seo", type: named("SEOInput", "INPUT_OBJECT") },
          { name: "sources", type: list("SourceCreateMock") },
        ]),
        object("SourceCreateMock", [{ name: "source", type: named("SourceMock", "INPUT_OBJECT") }]),
        object("SourceMock", [
          ...["title", "targetType"].map((name) => ({ name, type: named("String") })),
          { name: "position", type: named("Int") },
          { name: "inclusion", type: named("SelectionMock", "INPUT_OBJECT") },
        ]),
        object("SelectionMock", [{ name: "selections", type: list("ProductSelectionMock") }]),
        object("ProductSelectionMock", [{ name: "productId", type: named("ID") }]),
        object("MoveInput", [
          { name: "id", type: named("ID") },
          { name: "newPosition", type: named("String") },
        ]),
      ],
    };
  // Additional input shapes are authored mocks, not retained live API contracts.
  const locationId = "gid://shopify/Location/1",
    collectionId = "gid://shopify/Collection/1",
    sourceId = "gid://shopify/CollectionConditionsSource/1",
    jobId = "gid://shopify/Job/af3cb206-d472-4a54-902b-f34df6af4eb5",
    members = [
      { id: "gid://shopify/Product/1", handle: first.handle },
      { id: "gid://shopify/Product/2", handle: second.handle },
    ];
  let order = [...members].reverse(),
    jobs = 0,
    writes = 0,
    mismatch = false;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      query = String(body.query);
    if (query.includes("OfflinePreviewSeedGuard"))
      return reply({
        shop: {
          ...shop,
          name: "Authored shop",
          currencyCode: "USD",
          ianaTimezone: "UTC",
          metafield: { value: "true" },
        },
        currentAppInstallation: {
          accessScopes: ["write_products", "write_inventory", "read_locations"].map((handle) => ({
            handle,
          })),
        },
      });
    if (query.includes("OfflinePreviewSeedAbsence"))
      return reply({
        shop,
        products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        collections: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      });
    if (query.includes("OfflinePreviewSeedJob")) {
      jobs++;
      if (jobs > 1 && !mismatch) order = [...members];
      return reply({ shop, job: { id: jobId, done: jobs > 1 } });
    }
    if (query.includes("OfflinePreviewSeedIdentities"))
      return reply({
        shop,
        nodes: body.variables.ids.map((id: string) => {
          if (id === locationId) return { __typename: "Location", id, isActive: true };
          if (id === collectionId)
            return {
              __typename: "Collection",
              id,
              handle: desired.handle,
              sortOrder: "MANUAL",
              products: { nodes: order, pageInfo: { hasNextPage: false } },
              sources: [
                {
                  __typename: "CollectionConditionsSource",
                  id: sourceId,
                  title: "SOP fixture membership",
                  shareable: false,
                  targetType: "PRODUCTS",
                  app: { id: "gid://shopify/App/1" },
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
          const member = members.find((m) => m.id === id);
          assert.ok(member);
          return { __typename: "Product", ...member, tags: ["sop-fixture"] };
        }),
      });
    if (query.includes("OfflinePreviewSeedVariants")) {
      const product = body.variables.id === "gid://shopify/Product/1" ? first : second;
      return reply({
        shop,
        product: {
          id: body.variables.id,
          handle: product.handle,
          tags: ["sop-fixture"],
          variants: {
            nodes: product.variants.map((v, i) => ({
              __typename: "ProductVariant",
              id: `gid://shopify/ProductVariant/${i + 1}`,
              selectedOptions: v.optionValues.map((o) => ({ name: o.name, value: o.value })),
            })),
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    writes++;
    if (query.includes("productSet"))
      return reply({
        productSet: {
          product: {
            id: body.variables.input.handle === first.handle ? members[0]?.id : members[1]?.id,
          },
          userErrors: [],
        },
      });
    if (query.includes("collectionCreate"))
      return reply({ collectionCreate: { collection: { id: collectionId }, userErrors: [] } });
    return reply({ collectionReorderProducts: { job: { id: jobId }, userErrors: [] } });
  };
  const ledger = createOracleSeedBindingLedger(config, fixture, shopId, "authored", [], fetcher),
    executor = createOracleSeedExecutor(config, fixture, shopId, "authored", extra, {
      authorize: ok,
      verifyResult: ok,
      verifyBindings: ledger.verifyBindings,
      fetcher,
    });
  await ledger.registerEnvironment({ kind: "Location", id: locationId });
  for (const product of [first, second]) {
    const task = initial.tasks.find(
      (t) => t.resource === "product" && t.identity[0] === product.handle,
    );
    assert.ok(task);
    await ledger.record(
      await executor.executeVerified({
        stateHash: initial.hash,
        taskKey: task.key,
        kind: "task",
        options: { mode: "create" },
        bindings: { [seedBindingKey("inventory-location")]: locationId },
      }),
    );
  }
  const bindings = Object.fromEntries(
    members.map((m) => [seedBindingKey("product-id", m.handle), m.id]),
  );
  await ledger.record(
    await executor.executeVerified({
      stateHash: initial.hash,
      taskKey: collectionTask.key,
      kind: "task",
      options: { mode: "create" },
      bindings,
    }),
  );
  const ordered = await executor.executeVerified({
    stateHash: initial.hash,
    taskKey: collectionTask.key,
    kind: "collection-order",
    options: { mode: "update" },
    observedOrder: order.map((m) => m.handle),
    bindings: { ...bindings, [seedBindingKey("collection-id", desired.handle)]: collectionId },
  });
  mismatch = true;
  await assert.rejects(ledger.record(ordered), code("read-back-failed"));
  mismatch = false;
  await ledger.record(ordered);
  assert.equal(writes, 4);
  assert.equal(ledger.get(seedBindingKey("collection-id", desired.handle)), collectionId);
  await assert.rejects(ledger.record(ordered), code("unverified-execution"));
  order = [...members].reverse();
  // The committed order proof now rejects changed order even in a later dependency check.
  const context = inspectVerifiedSeedExecution(ordered).context;
  await assert.rejects(
    ledger.verifyBindings(context, {
      ...bindings,
      [seedBindingKey("collection-id", desired.handle)]: collectionId,
    }),
  );
});

test("JSON flags and hand-built proof objects cannot create ledger ownership", async () => {
  const { ledger } = setup();
  await assert.rejects(
    ledger.record({ kind: "verified-seed-execution" }),
    code("unverified-execution"),
  );
  assert.throws(() => ledger.get(seedBindingKey("page-id", "about")), code("binding-missing"));
});
test("guarded mock execution plus fresh read-back mints a scoped binding; serialization loses proof", async () => {
  const { ledger, executor, events } = setup();
  const proof = await executor.executeVerified(step);
  const view = inspectVerifiedSeedExecution(proof);
  view.context.fixtureHash = "tampered";
  assert.notEqual(inspectVerifiedSeedExecution(proof).context.fixtureHash, "tampered");
  await ledger.record(proof);
  assert.equal(ledger.get(seedBindingKey("page-id", "about")), "gid://shopify/Page/1");
  assert.deepEqual(events, ["guard", "absence", "write", "identity"]);
  await assert.rejects(
    ledger.record(JSON.parse(JSON.stringify(proof))),
    code("unverified-execution"),
  );
  await assert.rejects(ledger.record(proof), code("unverified-execution"));
});
test("an update rechecks the recorded real ID, and a create collision never reaches another write", async () => {
  const { ledger, executor, events } = setup();
  await ledger.record(await executor.executeVerified(step));
  await ledger.record(
    await executor.executeVerified({
      ...step,
      options: { mode: "update" },
      bindings: {
        [seedBindingKey("page-id", "about")]: ledger.get(seedBindingKey("page-id", "about")),
      },
    }),
  );
  assert.equal(events.filter((e) => e === "write").length, 2);
  await assert.rejects(executor.executeVerified(step));
  assert.equal(events.filter((e) => e === "write").length, 2);
});
test("a changed scope or failed actual identity read-back cannot leave a partial ledger entry", async () => {
  const { executor } = setup();
  const proof = await executor.executeVerified(step);
  const other = createOracleSeedBindingLedger(
    { ...config, domain: "other.myshopify.com" },
    input,
    shopId,
    "authored",
    [],
    async () => {
      throw new Error("No read allowed");
    },
  );
  await assert.rejects(other.record(proof), code("scope-mismatch"));
  const bad = setup(true),
    receipt = await bad.executor.executeVerified(step);
  await assert.rejects(bad.ledger.record(receipt), code("read-back-failed"));
  assert.throws(() => bad.ledger.get(seedBindingKey("page-id", "about")), code("binding-missing"));
});
test("handle absence traverses terminal pages and refuses collisions or stalled cursors", async () => {
  let calls = 0;
  await assertOracleSeedHandleAbsent(
    config,
    "authored",
    shopId,
    "Product",
    "new",
    async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.variables.after, calls === 1 ? null : "next");
      return reply({
        shop,
        products: {
          nodes: [{ id: `gid://shopify/Product/${calls}`, handle: `old-${calls}` }],
          pageInfo: { hasNextPage: calls === 1, endCursor: "next" },
        },
      });
    },
  );
  assert.equal(calls, 2);
  await assert.rejects(
    assertOracleSeedHandleAbsent(config, "authored", shopId, "Product", "old", async () =>
      reply({
        shop,
        products: {
          nodes: [{ id: "gid://shopify/Product/1", handle: "old" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    ),
    (e) => e instanceof SeedIdentityError && e.code === "binding-mismatch",
  );
  await assert.rejects(
    assertOracleSeedHandleAbsent(config, "authored", shopId, "Product", "new", async () =>
      reply({ shop, products: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } }),
    ),
    (e) => e instanceof SeedIdentityError && e.code === "incomplete-membership",
  );
});
test("complete actual variant lists retain parent provenance and reject truncation", async () => {
  const product = {
    id: "gid://shopify/Product/1",
    handle: "p-1",
    tags: ["sop-fixture"],
    variants: {
      nodes: [
        {
          __typename: "ProductVariant",
          id: "gid://shopify/ProductVariant/1",
          selectedOptions: [{ name: "Title", value: "Default Title" }],
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
  const rows = await readOracleSeedVariants(config, "authored", shopId, product.id, async () =>
    reply({ shop, product }),
  );
  assert.equal(rows[0]?.product.id, product.id);
  product.variants.pageInfo.hasNextPage = true;
  await assert.rejects(
    readOracleSeedVariants(config, "authored", shopId, product.id, async () =>
      reply({ shop, product }),
    ),
    (e) => e instanceof SeedIdentityError && e.code === "incomplete-membership",
  );
});
test("product read-back matches option tuples, rebinds explicitly new variants and removes deleted aliases", async () => {
  const fixture = defaultFixture();
  for (const product of fixture.products) {
    product.images = [];
    product.variants.forEach((v) => {
      v.image = null;
    });
  }
  for (const overlay of Object.values(fixture.scenarios)) {
    if (
      overlay &&
      typeof overlay === "object" &&
      !Array.isArray(overlay) &&
      "products" in overlay &&
      Array.isArray(overlay.products)
    )
      for (const value of overlay.products)
        if (value && typeof value === "object" && !Array.isArray(value)) {
          value.images = [];
          if (Array.isArray(value.variants))
            for (const variant of value.variants)
              if (variant && typeof variant === "object" && !Array.isArray(variant))
                variant.image = null;
        }
  }
  const prepared = buildOracleSeedPlan(config, fixture),
    initial = prepared.states[0];
  assert.ok(initial);
  const product = initial.tasks.find((t) => t.resource === "product");
  assert.ok(product);
  const locationId = "gid://shopify/Location/1",
    productId = "gid://shopify/Product/1";
  let actual =
    fixture.products[0]?.variants.map((v, i) => ({
      __typename: "ProductVariant",
      id: `gid://shopify/ProductVariant/${i + 1}`,
      selectedOptions: v.optionValues.map((o) => ({ name: o.name, value: o.value })),
    })) ?? [];
  const parent = { id: productId, handle: "sop-matrix-needle", tags: ["sop-fixture"] };
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      query: string = body.query;
    if (query.includes("OfflinePreviewSeedAbsence"))
      return reply({
        shop,
        products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      });
    if (query.includes("OfflinePreviewSeedGuard"))
      return reply({
        shop: {
          ...shop,
          name: "Authored shop",
          currencyCode: "USD",
          ianaTimezone: "UTC",
          metafield: { value: "true" },
        },
        currentAppInstallation: {
          accessScopes: ["write_products", "write_inventory", "read_locations"].map((handle) => ({
            handle,
          })),
        },
      });
    if (query.includes("OfflinePreviewSeedIdentities"))
      return reply({
        shop,
        nodes: body.variables.ids.map((id: string) =>
          id === locationId
            ? { __typename: "Location", id, isActive: true }
            : { __typename: "Product", ...parent },
        ),
      });
    if (query.includes("OfflinePreviewSeedVariants"))
      return reply({
        shop,
        product: {
          ...parent,
          variants: { nodes: [...actual].reverse(), pageInfo: { hasNextPage: false } },
        },
      });
    if (query.startsWith("mutation")) {
      const values: { optionValues: { optionName: string; name: string }[] }[] =
        body.variables.input.variants;
      actual = values.map((v, i) => ({
        __typename: "ProductVariant",
        id: `gid://shopify/ProductVariant/${values.length === 1 ? 99 : i + 1}`,
        selectedOptions: v.optionValues.map((o) => ({ name: o.optionName, value: o.name })),
      }));
      return reply({ productSet: { product: { id: productId }, userErrors: [] } });
    }
    throw new Error("Unexpected authored query");
  };
  const ledger = createOracleSeedBindingLedger(config, fixture, shopId, "authored", [], fetcher);
  await ledger.registerEnvironment({ kind: "Location", id: locationId });
  const executor = createOracleSeedExecutor(config, fixture, shopId, "authored", schema, {
    authorize: ok,
    verifyResult: ok,
    verifyBindings: ledger.verifyBindings,
    fetcher,
  });
  const locationKey = seedBindingKey("inventory-location");
  await ledger.record(
    await executor.executeVerified({
      stateHash: initial.hash,
      taskKey: product.key,
      kind: "task",
      options: { mode: "create" },
      bindings: { [locationKey]: locationId },
    }),
  );
  assert.equal(
    ledger.get(seedBindingKey("variant-id", "sop-matrix-needle", "sop-main-1")),
    "gid://shopify/ProductVariant/1",
  );
  const request = prepared.requests.find((r) => r.scenario === "single-variant");
  assert.ok(request);
  const single = prepared.states.find((s) => s.hash === request.stateHash),
    next = single?.tasks.find((t) => t.resource === "product");
  assert.ok(single && next);
  await ledger.record(
    await executor.executeVerified({
      stateHash: single.hash,
      taskKey: next.key,
      kind: "task",
      options: { mode: "update", newVariantIds: ["sop-main-1"] },
      bindings: {
        [locationKey]: locationId,
        [seedBindingKey("product-id", "sop-matrix-needle")]: productId,
      },
    }),
  );
  assert.equal(
    ledger.get(seedBindingKey("variant-id", "sop-matrix-needle", "sop-main-1")),
    "gid://shopify/ProductVariant/99",
  );
  assert.throws(
    () => ledger.get(seedBindingKey("variant-id", "sop-matrix-needle", "sop-main-2")),
    code("binding-missing"),
  );
});
