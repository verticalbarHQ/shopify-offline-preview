import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { buildOracleSeedPlan, type SeedTask } from "../tools/oracle/seed-plan.js";
import {
  compileSeedTask,
  type SeedRequestTemplate,
  type SeedValue,
} from "../tools/oracle/seed-requests.js";
import { validateSeedRequestTemplate } from "../tools/oracle/seed-schema.js";
import {
  assertOracleSeedSource,
  readOracleSeedSource,
  seedSourceSelections,
} from "../tools/oracle/seed-source.js";

const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1",
  snapshot = defaultFixture();
const state = buildOracleSeedPlan(config, snapshot).states[0];
assert.ok(state);
const schema: unknown = JSON.parse(
  await readFile(
    new URL("./fixtures/oracle-seed-all-input-contracts.json", import.meta.url),
    "utf8",
  ),
);
test("content create/update payloads use actual MetafieldInput contracts and omit unsupported SEOInput fields", () => {
  for (const resource of ["page", "blog", "article"]) {
    const task: SeedTask | undefined = state.tasks.find(
      (candidate) => candidate.resource === resource,
    );
    assert.ok(task);
    for (const mode of ["create", "update"] as const) {
      const template: SeedRequestTemplate | undefined = compileSeedTask(task, { mode })[0];
      assert.ok(template);
      const value: SeedValue | undefined = template.variables[resource];
      assert.ok(value && typeof value === "object" && !Array.isArray(value));
      assert.equal(Object.hasOwn(value, "seo"), false);
      assert.deepEqual(value.metafields, [
        {
          namespace: "global",
          key: "description_tag",
          type: "single_line_text_field",
          value:
            resource === "page"
              ? snapshot.pages[0]?.seo?.description
              : resource === "blog"
                ? snapshot.blogs[0]?.seo?.description
                : snapshot.blogs[0]?.articles[0]?.seo?.description,
        },
      ]);
      assert.deepEqual(validateSeedRequestTemplate(template, schema), []);
    }
  }
});
function raw() {
  const p = snapshot.pages[0];
  assert.ok(p);
  return {
    __typename: "Page",
    id: "gid://shopify/Page/1",
    handle: p.handle,
    title: p.title,
    templateSuffix: p.templateSuffix,
    body: p.bodyHtml,
    isPublished: true,
    seoTitle: null,
    seoDescription: { value: p.seo?.description, type: "single_line_text_field" },
  };
}
async function read(value: unknown) {
  return readOracleSeedSource(
    config,
    "authored",
    shopId,
    "Page",
    "gid://shopify/Page/1",
    undefined,
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.ok(body.query.includes('seoTitle: metafield(namespace:"global", key:"title_tag")'));
      assert.ok(
        body.query.includes('seoDescription: metafield(namespace:"global", key:"description_tag")'),
      );
      assert.equal(/\bseo\s*\{/.test(seedSourceSelections.Page), false);
      return Response.json(
        {
          data: {
            shop: {
              id: shopId,
              myshopifyDomain: config.domain,
              plan: { partnerDevelopment: true },
            },
            nodes: [value],
          },
        },
        { headers: { "x-shopify-api-version": "2026-10" } },
      );
    },
  );
}
test("content readback distinguishes absent SEO from exact typed values and refuses old fabricated wire fields", async () => {
  for (const kind of ["Page", "Blog", "Article"] as const) {
    assert.ok(seedSourceSelections[kind].includes('key:"title_tag"'));
    assert.equal(/\bseo\s*\{/.test(seedSourceSelections[kind]), false);
  }
  const source = await read(raw()),
    task = state.tasks.find((task) => task.resource === "page");
  assert.ok(task && source.__typename === "Page");
  assert.deepEqual(source.seo, { title: null, description: snapshot.pages[0]?.seo?.description });
  assertOracleSeedSource(task, source, () => {
    throw new Error("No binding expected");
  });
  const changed = structuredClone(source);
  changed.seo.title = "Existing title must not be silently treated as cleared";
  assert.throws(() => assertOracleSeedSource(task, changed, () => ""), { code: "source-mismatch" });
  for (const value of [
    { ...raw(), seoTitle: undefined },
    { ...raw(), seoDescription: { value: "5", type: "number_integer" } },
  ])
    await assert.rejects(read(value), { code: "read-failed" });
});
