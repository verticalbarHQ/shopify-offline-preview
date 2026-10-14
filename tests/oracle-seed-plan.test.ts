import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import { buildOracleSeedPlan, readOracleSeedImages } from "../tools/oracle/seed-plan.js";

const config = { domain: "owned-demo.myshopify.com", apiVersion: "2026-10" as const };
function product(plan: ReturnType<typeof buildOracleSeedPlan>, scenario: string) {
  const request = plan.requests.find((request) => request.scenario === scenario);
  const state = plan.states.find((state) => state.hash === request?.stateHash);
  const task = state?.tasks.find((task) => task.resource === "product");
  assert.ok(task);
  return snapshotSchema.shape.products.element.parse(task.source);
}
test("full fixture plan covers all 18 requests with seven distinct persistent states and ordered dependencies", () => {
  const input = defaultFixture();
  const plan = buildOracleSeedPlan(config, input);
  assert.equal(plan.requests.length, 18);
  assert.deepEqual(
    plan.requests.map((r) => r.caseId),
    benchmarkMatrix.map((r) => r.id),
  );
  assert.equal(plan.states.length, 7);
  assert.deepEqual(plan.issues, []);
  for (const state of plan.states) {
    const seen = new Set<string>();
    for (const task of state.tasks) {
      assert.ok(task.dependencies.every((key) => seen.has(key)));
      assert.ok(!seen.has(task.key));
      seen.add(task.key);
    }
    assert.equal(state.tasks.filter((t) => t.resource === "image").length, 16);
    assert.equal(state.tasks.filter((t) => t.resource === "product").length, 40);
    assert.equal(state.tasks.filter((t) => t.resource === "article").length, 3);
  }
  assert.deepEqual(buildOracleSeedPlan(config, input), plan);
  assert.equal(plan.executionReady, false);
  assert.equal(plan.mutationsExecuted, 0);
  assert.ok(plan.calibrationRequired.includes("platform-generated-timestamps"));
});
test("scenario-specific desired states preserve options, inventory, images and long content", () => {
  const plan = buildOracleSeedPlan(config, defaultFixture());
  assert.equal(product(plan, "default").options.length, 3);
  assert.equal(product(plan, "default").variants.length, 8);
  assert.ok(
    product(plan, "sold-out").variants.every((v) => v.inventoryQuantity === 0 && !v.available),
  );
  assert.equal(product(plan, "single-variant").variants.length, 1);
  assert.deepEqual(product(plan, "single-variant").options, [
    { name: "Title", values: ["Default Title"] },
  ]);
  assert.equal(product(plan, "no-images").images.length, 0);
  assert.equal(product(plan, "long-content").images.length, 16);
  const emptyRequest = plan.requests.find((r) => r.scenario === "empty");
  const state = plan.states.find((s) => s.hash === emptyRequest?.stateHash);
  const collection = snapshotSchema.shape.collections.element.parse(
    state?.tasks.find((t) => t.resource === "collection")?.source,
  );
  assert.deepEqual(collection.products, []);
});
test("cart mutations are session instructions and do not create another persistent store state", () => {
  const plan = buildOracleSeedPlan(config, defaultFixture());
  const empty = plan.requests.find((r) => r.path === "/cart" && r.scenario === "default");
  const withItems = plan.requests.find((r) => r.scenario === "with-items");
  assert.ok(empty && withItems);
  assert.equal(empty.stateHash, withItems.stateHash);
  assert.notEqual(empty.snapshotHash, withItems.snapshotHash);
  assert.equal(empty.cart?.lines.length, 0);
  assert.equal(withItems.cart?.lines.length, 2);
  assert.ok(plan.requests.filter((r) => r.path !== "/cart").every((r) => r.cart === null));
});
test("source data and generated plan objects cannot mutate each other", () => {
  const input = defaultFixture(),
    before = structuredClone(input);
  const plan = buildOracleSeedPlan(config, input);
  const state = plan.states[0];
  assert.ok(state);
  state.shopToVerify.name = "changed";
  const desired = product(plan, "default");
  assert.equal(desired.id, input.products[0]?.id);
  assert.equal(desired.createdAt, input.products[0]?.createdAt);
  assert.deepEqual(input, before);
});
test("missing menu resources and excessive depth fail preparation while three levels remain valid", () => {
  const input = defaultFixture();
  const menu = input.menus[0];
  assert.ok(menu);
  menu.links = [
    {
      title: "One",
      url: "/",
      type: "http_link",
      resourceHandle: null,
      links: [
        {
          title: "Two",
          url: "/",
          type: "http_link",
          resourceHandle: null,
          links: [{ title: "Three", url: "/", type: "http_link", resourceHandle: null, links: [] }],
        },
      ],
    },
  ];
  assert.deepEqual(buildOracleSeedPlan(config, input).issues, []);
  const third = menu.links[0]?.links[0]?.links[0];
  assert.ok(third);
  third.links.push({
    title: "Missing",
    url: "/pages/missing",
    type: "page_link",
    resourceHandle: "missing",
    links: [],
  });
  const issues = buildOracleSeedPlan(config, input).issues.map((i) => i.code);
  assert.ok(issues.includes("menu-depth-exceeds-shopify"));
  assert.ok(issues.includes("missing-or-unordered-resource-reference"));
});
test("contradictory inventory, absent inventory metadata and duplicate variants stay explicit", () => {
  const input = defaultFixture();
  const first = input.products[0],
    second = input.products[1];
  assert.ok(first?.variants[0] && second?.variants[0]);
  first.variants[0].available = false;
  first.variants.push({ ...structuredClone(first.variants[0]), id: "duplicate-options" });
  delete second.variants[0].inventoryQuantity;
  const issues = buildOracleSeedPlan(config, input).issues.map((i) => i.code);
  assert.ok(issues.includes("inventory-availability-conflict"));
  assert.ok(issues.includes("inventory-source-required"));
  assert.ok(issues.includes("duplicate-variant-options"));
});
test("conflicting image metadata and untyped metafields cannot be silently dropped", () => {
  const input = defaultFixture();
  const first = input.products[0];
  assert.ok(first?.images[0]);
  first.images[0].alt = "different from the shared file";
  first.metafields = { custom: { value: "needs a definition" } };
  const issues = buildOracleSeedPlan(config, input).issues.map((i) => i.code);
  assert.ok(issues.includes("conflicting-image-metadata"));
  assert.ok(issues.includes("metafield-definitions-required"));
});
test("invalid scenario references are rejected before any plan can be treated as ready", () => {
  const input = defaultFixture();
  input.scenarios["sold-out"] = { products: [] };
  assert.throws(() => buildOracleSeedPlan(config, input), /Missing collection member/);
});
test("matrix resource paths must resolve to the actual desired resources", () => {
  const input = defaultFixture();
  input.pages = [];
  const issues = buildOracleSeedPlan(config, input).issues;
  assert.ok(
    issues.some((i) => i.code === "matrix-path-resource-missing" && i.resource.includes("page")),
  );
  assert.ok(issues.some((i) => i.code === "missing-or-unordered-resource-reference"));
});
test("local fixture PNG hashes and dimensions are prepared for every distinct image", async () => {
  const plan = buildOracleSeedPlan(config, defaultFixture());
  const imageDirectory = await realpath(new URL("../fixtures/default/images", import.meta.url));
  const images = await readOracleSeedImages(plan, imageDirectory);
  assert.equal(images.length, 16);
  assert.ok(
    images.every(
      (i) => i.width === 64 && i.height === 64 && i.bytes > 33 && /^[a-f0-9]{64}$/.test(i.sha256),
    ),
  );
  assert.deepEqual(await readOracleSeedImages(plan, imageDirectory), images);
  const image = plan.states[0]?.tasks.find((t) => t.resource === "image");
  assert.ok(image);
  const source = snapshotSchema.shape.products.element.shape.images.element.parse(image.source);
  image.source = { ...source, width: 100 };
  await assert.rejects(readOracleSeedImages(plan, imageDirectory), /dimensions differ/);
});
test("missing files, wrong formats and symlinked image sources fail upload preparation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sop-seed-images-")));
  try {
    const plan = buildOracleSeedPlan(config, defaultFixture());
    await assert.rejects(readOracleSeedImages(plan, root));
    await writeFile(join(root, "pattern-01.png"), "not a PNG");
    await assert.rejects(readOracleSeedImages(plan, root), /Fixture PNG required/);
    const realBytes = await readFile(
      new URL("../fixtures/default/images/pattern-01.png", import.meta.url),
    );
    await writeFile(join(root, "target.png"), realBytes);
    await rm(join(root, "pattern-01.png"));
    await symlink(join(root, "target.png"), join(root, "pattern-01.png"));
    await assert.rejects(readOracleSeedImages(plan, root), /Unsafe backup file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
