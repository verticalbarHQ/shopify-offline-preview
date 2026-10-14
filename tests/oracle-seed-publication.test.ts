import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { createOracleSeedBindingLedger } from "../tools/oracle/seed-binding-ledger.js";
import { SeedCompletionError, waitOracleSeedPublication } from "../tools/oracle/seed-completion.js";
import {
  createOracleSeedExecutor,
  inspectVerifiedSeedExecution,
} from "../tools/oracle/seed-execution.js";
import type { ExpectedSeedIdentity } from "../tools/oracle/seed-identities.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";
import { createOracleSeedPostconditions } from "../tools/oracle/seed-postconditions.js";
import { seedBindingKey } from "../tools/oracle/seed-requests.js";
import { seedAdminSchema } from "../tools/oracle/seed-schema.js";

// Authored test responses. No channel selection, owner approval or live publishing evidence.
const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1",
  product: Extract<ExpectedSeedIdentity, { kind: "Product" }> = {
    kind: "Product",
    id: "gid://shopify/Product/1",
    handle: "owned",
    requiredTag: "sop-fixture",
  },
  publication: Extract<ExpectedSeedIdentity, { kind: "Publication" }> = {
    kind: "Publication",
    id: "gid://shopify/Publication/1",
    catalogId: "gid://shopify/AppCatalog/1",
    appId: "gid://shopify/App/1",
  },
  shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } },
  sleep = async () => {},
  reply = (data: unknown, version = "2026-10") =>
    Response.json({ data }, { headers: { "x-shopify-api-version": version } }),
  code = (value: string) => (error: unknown) =>
    error instanceof SeedCompletionError && error.code === value;
function pub() {
  return {
    __typename: "Publication",
    id: publication.id,
    catalog: {
      __typename: "AppCatalog",
      id: publication.catalogId,
      apps: { nodes: [{ id: publication.appId }], pageInfo: { hasNextPage: false } },
    },
  };
}
function fetcherFor(
  read: (call: number) => Record<string, unknown>,
  changeIdentity?: () => unknown,
) {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      query = String(body.query);
    assert.ok(query.startsWith("query "));
    assert.ok(!query.includes("mutation"));
    if (query.includes("OfflinePreviewSeedPublication")) {
      assert.deepEqual(body.variables.ids, [product.id]);
      assert.equal(body.variables.publication, publication.id);
      return reply({
        shop,
        nodes: [
          {
            __typename: "Product",
            id: product.id,
            handle: product.handle,
            status: "ACTIVE",
            ...read(++calls),
          },
        ],
      });
    }
    return reply({
      shop,
      nodes:
        body.variables.ids[0] === publication.id
          ? [changeIdentity?.() ?? pub()]
          : [
              {
                __typename: "Product",
                id: product.id,
                handle: product.handle,
                tags: ["sop-fixture"],
              },
            ],
    });
  };
  return { fetcher, calls: () => calls };
}
test("only the exact selected publication becoming visible completes the bounded readonly wait", async () => {
  const s = fetcherFor((call) => ({ publishedOnPublication: call === 2 }));
  await waitOracleSeedPublication(config, "authored", shopId, product, publication, {
    fetcher: s.fetcher,
    sleep,
  });
  assert.equal(s.calls(), 2);
});
test("draft resource, wrong ID/handle or changed catalog/app cannot masquerade as channel publication", async () => {
  for (const failure of ["draft", "id", "handle", "catalog", "app"]) {
    const s = fetcherFor(
      () => ({
        publishedOnPublication: true,
        ...(failure === "draft"
          ? { status: "DRAFT" }
          : failure === "id"
            ? { id: "gid://shopify/Product/2" }
            : failure === "handle"
              ? { handle: "other" }
              : {}),
      }),
      () => {
        const p = pub();
        if (failure === "catalog") p.catalog.id = "gid://shopify/AppCatalog/2";
        if (failure === "app") p.catalog.apps.nodes = [{ id: "gid://shopify/App/2" }];
        return p;
      },
    );
    await assert.rejects(
      waitOracleSeedPublication(config, "authored", shopId, product, publication, {
        fetcher: s.fetcher,
        sleep,
      }),
      code("postcondition-mismatch"),
    );
    assert.ok(s.calls() <= 1);
  }
});
test("pending publication times out without sending writes and API failures never replay", async () => {
  const s = fetcherFor(() => ({ publishedOnPublication: false }));
  await assert.rejects(
    waitOracleSeedPublication(config, "authored", shopId, product, publication, {
      fetcher: s.fetcher,
      sleep,
      attempts: 2,
    }),
    code("completion-timeout"),
  );
  assert.equal(s.calls(), 2);
  await assert.rejects(
    waitOracleSeedPublication(config, "authored", shopId, product, publication, {
      fetcher: async () => {
        throw new Error("private API detail");
      },
      sleep,
    }),
    (e) => code("read-failed")(e) && !String(e).includes("private"),
  );
});
test("channel identity is reread after success, so a reassigned publication fails", async () => {
  let identities = 0;
  const s = fetcherFor(
    () => ({ publishedOnPublication: true }),
    () => {
      const value = pub();
      if (++identities === 2) value.catalog.apps.nodes = [];
      return value;
    },
  );
  await assert.rejects(
    waitOracleSeedPublication(config, "authored", shopId, product, publication, {
      fetcher: s.fetcher,
      sleep,
    }),
    code("postcondition-mismatch"),
  );
  assert.equal(s.calls(), 1);
});
test("collection publication verifies its complete owned membership and conditions source", async () => {
  const expected: Extract<ExpectedSeedIdentity, { kind: "Collection" }> = {
    kind: "Collection",
    id: "gid://shopify/Collection/1",
    handle: "catalog",
    sourceId: "gid://shopify/CollectionConditionsSource/1",
    sourceAppId: null,
    members: [],
    ordered: true,
  };
  let flags = 0;
  await waitOracleSeedPublication(config, "authored", shopId, expected, publication, {
    sleep,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("OfflinePreviewSeedPublication")) {
        flags++;
        return reply({
          shop,
          nodes: [
            {
              __typename: "Collection",
              id: expected.id,
              handle: expected.handle,
              publishedOnPublication: true,
            },
          ],
        });
      }
      return reply({
        shop,
        nodes:
          body.variables.ids[0] === publication.id
            ? [pub()]
            : [
                {
                  __typename: "Collection",
                  id: expected.id,
                  handle: expected.handle,
                  sortOrder: "MANUAL",
                  products: { nodes: [], pageInfo: { hasNextPage: false } },
                  sources: [
                    {
                      __typename: "CollectionConditionsSource",
                      id: expected.sourceId,
                      title: "SOP fixture membership",
                      shareable: false,
                      targetType: "PRODUCTS",
                      app: null,
                      inclusion: {
                        conditions: [],
                        selections: { nodes: [], pageInfo: { hasNextPage: false } },
                      },
                      exclusion: null,
                    },
                  ],
                },
              ],
      });
    },
  });
  assert.equal(flags, 1);
});

test("executor postcondition receives isolated copies of the actual sent IDs and prevents a receipt before verified publication", async () => {
  const snapshot = defaultFixture();
  for (const p of snapshot.products) {
    p.images = [];
    for (const v of p.variants) v.image = null;
  }
  const source = snapshot.products[0];
  assert.ok(source);
  const plan = buildOracleSeedPlan(config, snapshot),
    state = plan.states[0];
  assert.ok(state);
  const task = state.tasks.find((t) => t.resource === "product");
  assert.ok(task);
  const retained = seedAdminSchema.parse(
      JSON.parse(
        await readFile(
          new URL("./fixtures/oracle-seed-input-contracts.json", import.meta.url),
          "utf8",
        ),
      ),
    ),
    schema: unknown = {
      ...retained,
      operations: [
        ...retained.operations,
        {
          name: "publishablePublish",
          args: [
            {
              name: "id",
              type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "ID" } },
            },
            {
              name: "input",
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: {
                  kind: "LIST",
                  name: null,
                  ofType: {
                    kind: "NON_NULL",
                    name: null,
                    ofType: { kind: "INPUT_OBJECT", name: "PublicationInput" },
                  },
                },
              },
            },
          ],
        },
      ],
      types: [
        ...retained.types,
        {
          name: "PublicationInput",
          kind: "INPUT_OBJECT",
          enumValues: null,
          inputFields: [{ name: "publicationId", type: { kind: "SCALAR", name: "ID" } }],
        },
      ],
    };
  let writes = 0,
    published = false;
  const locationId = "gid://shopify/Location/1",
    parent = { id: product.id, handle: source.handle, tags: source.tags };
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      query = String(body.query);
    if (query.includes("OfflinePreviewSeedGuard"))
      return reply({
        shop: {
          ...shop,
          name: "Authored",
          currencyCode: "USD",
          ianaTimezone: "UTC",
          metafield: { value: "true" },
        },
        currentAppInstallation: {
          accessScopes: [
            "write_products",
            "write_inventory",
            "read_locations",
            "write_publications",
          ].map((handle) => ({ handle })),
        },
      });
    if (query.includes("OfflinePreviewSeedAbsence"))
      return reply({
        shop,
        products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      });
    if (query.includes("OfflinePreviewSeedIdentities"))
      return reply({
        shop,
        nodes: body.variables.ids.map((id: string) =>
          id === publication.id
            ? pub()
            : id === locationId
              ? { __typename: "Location", id, isActive: true }
              : { __typename: "Product", ...parent },
        ),
      });
    if (query.includes("OfflinePreviewSeedVariants"))
      return reply({
        shop,
        product: {
          ...parent,
          variants: {
            nodes: source.variants.map((v, index) => ({
              __typename: "ProductVariant",
              id: `gid://shopify/ProductVariant/${index + 1}`,
              selectedOptions: v.optionValues,
            })),
            pageInfo: { hasNextPage: false },
          },
        },
      });
    if (query.includes("OfflinePreviewSeedPublication"))
      return reply({
        shop,
        nodes: [
          { __typename: "Product", ...parent, status: "ACTIVE", publishedOnPublication: published },
        ],
      });
    writes++;
    if (query.includes("productSet"))
      return reply({ productSet: { product: { id: product.id }, userErrors: [] } });
    assert.equal(body.variables.id, product.id);
    assert.deepEqual(body.variables.input, [{ publicationId: publication.id }]);
    return reply({ publishablePublish: { userErrors: [] } });
  };
  const ledger = createOracleSeedBindingLedger(config, snapshot, shopId, "authored", [], fetcher);
  await ledger.registerEnvironment({ kind: "Location", id: locationId });
  await ledger.registerEnvironment(publication);
  const verifyPublication = createOracleSeedPostconditions(
      config,
      snapshot,
      shopId,
      "authored",
      ledger,
      [],
      { fetcher, sleep, attempts: 1 },
    ),
    executor = createOracleSeedExecutor(config, snapshot, shopId, "authored", schema, {
      authorize: async () => {},
      verifyBindings: ledger.verifyBindings,
      fetcher,
      verifyResult: async (context, payload, variables) => {
        if (context.kind === "publication") {
          await verifyPublication(context, payload, variables);
          Reflect.set(variables, "id", "changed callback copy");
        }
      },
    }),
    base = {
      stateHash: state.hash,
      taskKey: task.key,
      kind: "task" as const,
      options: { mode: "create" as const },
      bindings: { [seedBindingKey("inventory-location")]: locationId },
    };
  await ledger.record(await executor.executeVerified(base));
  const step = {
    ...base,
    kind: "publication" as const,
    bindings: {
      [seedBindingKey("product-id", source.handle)]: product.id,
      [seedBindingKey("online-store-publication")]: publication.id,
    },
  };
  await assert.rejects(executor.executeVerified(step), (e) =>
    String(e).includes("postcondition-failed"),
  );
  assert.equal(writes, 2);
  // A separate authored authorized attempt, not a transport replay of the failed publish call.
  published = true;
  const receipt = await executor.executeVerified(step);
  assert.equal(inspectVerifiedSeedExecution(receipt).variables.id, product.id);
  assert.equal(writes, 3);
});
