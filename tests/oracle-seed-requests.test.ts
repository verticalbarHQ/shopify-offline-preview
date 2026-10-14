import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";
import {
  compileSeedCollectionOrder,
  compileSeedPublication,
  compileSeedTask,
  resolveSeedRequest,
  type SeedRequestTemplate,
  type SeedValue,
  seedBindingKey,
} from "../tools/oracle/seed-requests.js";

const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const };
function task(resource: string, scenario = "default") {
  const plan = buildOracleSeedPlan(config, defaultFixture());
  const request = plan.requests.find((r) => r.scenario === scenario);
  const found = plan.states
    .find((s) => s.hash === request?.stateHash)
    ?.tasks.find((t) => t.resource === resource);
  assert.ok(found);
  return found;
}
function object(value: SeedValue | undefined): Record<string, SeedValue> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}
function array(value: SeedValue | undefined): SeedValue[] {
  assert.ok(Array.isArray(value));
  return value;
}
function first(resource: string, mode: "create" | "update" = "create", scenario = "default") {
  const found = compileSeedTask(task(resource, scenario), { mode, collectionMembers: [] })[0];
  assert.ok(found);
  return found;
}
/** Authored test IDs only; no Shopify requests or real store evidence. */
function fixtureBindings(template: SeedRequestTemplate): Record<string, string> {
  const values: Record<string, string> = {};
  function walk(v: SeedValue) {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v.$seedBinding === "string" && typeof v.$seedType === "string") {
      values[v.$seedBinding] =
        v.$seedType === "URL"
          ? "https://cdn.shopify.com/authored-fixture.png"
          : v.$seedType === "STAGED_URL"
            ? "https://shopify-staged-uploads.storage.googleapis.com/authored-fixture.png"
            : `gid://shopify/${v.$seedType === "ID" ? "CollectionConditionsSource" : v.$seedType}/123`;
    } else for (const item of Object.values(v)) walk(item);
  }
  for (const value of Object.values(template.variables)) walk(value);
  return values;
}
test("product creation preserves decimal prices, all options and inventory without using synthetic source IDs", () => {
  const template = first("product"),
    input = object(template.variables.input),
    variants = array(input.variants);
  assert.equal(template.operation, "productSet");
  assert.equal(array(input.productOptions).length, 3);
  assert.equal(variants.length, 8);
  const variant = object(variants[0]);
  assert.equal(variant.price, "12.50");
  assert.equal(variant.compareAtPrice, "20.00");
  assert.equal(variant.id, undefined);
  assert.equal(object(array(variant.inventoryQuantities)[0]).quantity, 10);
  assert.equal(object(object(object(variant.inventoryItem).measurement).weight).unit, "GRAMS");
  assert.equal(input.createdAt, undefined);
  assert.ok(template.calibration.includes("generated-product-timestamps"));
  assert.equal(object(template.variables.identifier).handle, "sop-matrix-needle");
});
test("updates require real product and variant bindings; new variants require explicit intent", () => {
  const template = first("product", "update");
  assert.throws(() => resolveSeedRequest(template, {}), /Missing seed binding/);
  const values = fixtureBindings(template),
    result = resolveSeedRequest(template, values);
  assert.equal(object(result.variables.identifier).id, "gid://shopify/Product/123");
  assert.equal(
    object(array(object(result.variables.input).variants)[0]).id,
    "gid://shopify/ProductVariant/123",
  );
  const explicit = compileSeedTask(task("product"), {
    mode: "update",
    newVariantIds: ["sop-main-1"],
  })[0];
  assert.ok(explicit);
  assert.equal(object(array(object(explicit.variables.input).variants)[0]).id, undefined);
  assert.throws(
    () => compileSeedTask(task("product"), { mode: "update", newVariantIds: ["unknown"] }),
    /Unknown new variant/,
  );
});
test("sold-out, single-variant and no-image requests reconcile the entire desired list", () => {
  const sold = first("product", "update", "sold-out");
  assert.ok(
    array(object(sold.variables.input).variants).every(
      (v) => object(array(object(v).inventoryQuantities)[0]).quantity === 0,
    ),
  );
  assert.equal(
    array(object(first("product", "update", "single-variant").variables.input).variants).length,
    1,
  );
  const noImage = object(first("product", "update", "no-images").variables.input);
  assert.deepEqual(noImage.files, []);
  assert.ok(array(noImage.variants).every((v) => object(v).file === null));
});
test("collection creation uses current sources and updates calculate additions and removals from observations", () => {
  const create = first("collection");
  assert.equal(create.variableTypes.collection, "CollectionCreateInput!");
  const source = object(object(array(object(create.variables.collection).sources)[0]).source);
  assert.equal(source.targetType, "PRODUCTS");
  assert.equal(array(object(source.inclusion).selections).length, 40);
  assert.throws(
    () => compileSeedTask(task("collection"), { mode: "update" }),
    /Observed collection membership/,
  );
  const remove = compileSeedTask(task("collection", "empty"), {
    mode: "update",
    collectionMembers: ["sop-matrix-needle"],
  })[0];
  assert.ok(remove);
  const inclusion = object(
    object(object(array(object(remove.variables.collection).sourcesToUpdate)[0]).condition)
      .inclusion,
  );
  assert.deepEqual(inclusion.selectionsToAdd, []);
  assert.equal(array(inclusion.selectionsToRemove).length, 1);
  assert.equal(object(remove.variables.collection).products, undefined);
});
test("manual collection reorder emits only sequentially necessary moves and requires final membership", () => {
  const templates = compileSeedCollectionOrder(
    "catalog",
    ["a", "b", "c", "d"],
    ["d", "b", "a", "c"],
  );
  const template = templates[0];
  assert.ok(template);
  const moves = array(template.variables.moves);
  assert.equal(moves.length, 2);
  assert.equal(object(moves[0]).newPosition, "0");
  assert.equal(object(moves[1]).newPosition, "1");
  assert.deepEqual(compileSeedCollectionOrder("catalog", ["a"], ["a"]), []);
  assert.throws(
    () => compileSeedCollectionOrder("catalog", ["a"], ["b"]),
    /equal collection membership/,
  );
  assert.ok(template.calibration.includes("reorder-job-completed"));
});
test("content requests map writable fields and retain generated fields as calibration requirements", () => {
  assert.equal(object(first("page").variables.page).body, defaultFixture().pages[0]?.bodyHtml);
  assert.equal(object(first("blog").variables.blog).commentPolicy, "CLOSED");
  const article = first("article"),
    input = object(article.variables.article);
  assert.deepEqual(input.author, { name: "Example Author" });
  assert.equal(input.summary, defaultFixture().blogs[0]?.articles[0]?.excerptHtml);
  assert.equal(input.createdAt, undefined);
  assert.ok(article.calibration.includes("generated-article-timestamps-and-comments"));
  assert.equal(object(first("article", "update", "without-image").variables.article).image, null);
});
test("menu and publication requests use bound resources and a verified publication", () => {
  const template = first("menu"),
    items = array(template.variables.items);
  assert.equal(object(items[0]).type, "HTTP");
  assert.equal(object(items[0]).url, "/");
  assert.equal(object(items[1]).type, "COLLECTION");
  assert.equal(object(items[1]).url, undefined);
  const publication = compileSeedPublication("Product", "sop-matrix-needle");
  assert.throws(() => resolveSeedRequest(publication, {}), /Missing seed binding/);
  assert.equal(object(array(publication.variables.input)[0]).publicationId !== undefined, true);
});
test("image preparation separates staged upload from file creation and requires verified bytes", () => {
  const image = task("image");
  assert.throws(() => compileSeedTask(image, { mode: "create" }), /byte count/);
  const templates = compileSeedTask(image, { mode: "create", imageBytes: 4096 });
  assert.deepEqual(
    templates.map((t) => t.operation),
    ["stagedUploadsCreate", "fileCreate"],
  );
  assert.equal(object(array(templates[0]?.variables.input)[0]).fileSize, "4096");
  const create = templates[1];
  assert.ok(create);
  assert.equal(object(array(create.variables.files)[0]).duplicateResolutionMode, "RAISE_ERROR");
  assert.ok(resolveSeedRequest(create, fixtureBindings(create)).query.includes("fileCreate"));
});
test("wrong-kind IDs and unsafe URLs are rejected and never reflected in errors", () => {
  const template = first("product", "update"),
    values = fixtureBindings(template);
  values[seedBindingKey("product-id", "sop-matrix-needle")] = "gid://shopify/Customer/123";
  assert.throws(() => resolveSeedRequest(template, values), /Invalid seed ID binding/);
  const article = first("article"),
    urls = fixtureBindings(article);
  urls[seedBindingKey("image-url", "pattern-01.png")] =
    "https://cdn.shopify.com@private.example/credential";
  assert.throws(() => resolveSeedRequest(article, urls), /Invalid Shopify image URL/);
  urls[seedBindingKey("image-url", "pattern-01.png")] = "http://cdn.shopify.com/credential";
  assert.throws(() => resolveSeedRequest(article, urls), /Invalid Shopify image URL/);
  urls[seedBindingKey("image-url", "pattern-01.png")] = "concealed-malformed-url";
  assert.throws(
    () => resolveSeedRequest(article, urls),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Invalid Shopify image URL binding" &&
      !Object.hasOwn(error, "input"),
  );
});
test("supplemental data without a writer is rejected instead of silently dropping source semantics", () => {
  const source = task("product");
  const p = defaultFixture().products[0];
  assert.ok(p);
  source.source = { ...p, metafields: { custom: { value: "definition-required" } } };
  assert.throws(() => compileSeedTask(source, { mode: "create" }), /metafield definitions/);
  source.source = { ...p, requiresSellingPlan: true };
  assert.throws(() => compileSeedTask(source, { mode: "create" }), /Selling-plan/);
});
