import assert from "node:assert/strict";
import { test } from "node:test";
import { Liquid } from "liquidjs";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { liquidObjects } from "../packages/data/src/objects.js";
import { applyScenario, validateSnapshotReferences } from "../packages/data/src/scenarios.js";
import { parseSnapshot } from "../packages/data/src/schema.js";

const route = {
  pageType: "product",
  path: "/",
  variant: null,
  q: "",
  sortBy: null,
  resourceHandle: "sop-matrix-needle",
  designMode: false,
};
test("catalog metadata retains IDs, false values, explicit empty arrays, rules and exact unit/quantity prices", async () => {
  const snapshot = defaultFixture(),
    product = snapshot.products[0],
    variant = product?.variants[0];
  assert.ok(product && variant);
  variant.quantityRule = { min: 2, max: 10, increment: 2 };
  variant.quantityPriceBreaks = [{ minimumQuantity: 5, price: "12.34" }];
  variant.unitPrice = "1.25";
  variant.unitPriceMeasurement = {
    measured_type: "weight",
    quantity_unit: "g",
    quantity_value: 1000,
    reference_unit: "kg",
    reference_value: 1,
  };
  variant.inventoryQuantity = -2;
  variant.inventoryPolicy = "continue";
  product.quantityPriceBreaksConfigured = true;
  product.sellingPlanGroups = [{ name: "Own plans", selling_plans: [{ name: "Own plan" }] }];
  const reads: string[] = [],
    missing: string[] = [];
  const before = JSON.stringify(snapshot);
  const objects = liquidObjects(parseSnapshot(before), route, {
    read(path) {
      reads.push(path);
    },
    unsupported(type, key) {
      missing.push(`${type}.${key}`);
    },
  });
  const source = `{% assign v=product.variants.first %}{{product.id}}|{{product.variants_count}}|{{product.gift_card?}}|{{product.requires_selling_plan}}|{{product.quantity_price_breaks_configured?}}|{{v.quantity_rule.min}}/{{v.quantity_rule.max}}/{{v.quantity_rule.increment}}|{{v.quantity_price_breaks.first.minimum_quantity}}:{{v.quantity_price_breaks.first.price}}|{{v.unit_price}}:{{v.unit_price_measurement.reference_unit}}|{{v.inventory_quantity}}:{{v.inventory_policy}}|{{v.store_availabilities.size}}|{{product.selling_plan_groups.first.selling_plans.first.name}}`;
  assert.equal(
    await new Liquid().parseAndRender(source, objects),
    "100001|8|false|false|true|2/10/2|5:1234|125:kg|-2:continue|0|Own plan",
  );
  assert.deepEqual(missing, []);
  for (const path of [
    "products[0].variants[0].quantity_rule.min",
    "products[0].variants[0].quantity_price_breaks[0].price",
    "products[0].selling_plan_groups[0].selling_plans[0].name",
  ])
    assert.ok(reads.includes(path), path);
  assert.equal(JSON.stringify(snapshot), before);
});

test("legacy inputs retain missing-property diagnostics and large IDs retain all digits", async () => {
  const snapshot = defaultFixture(),
    product = snapshot.products[0],
    variant = product?.variants[0];
  assert.ok(product && variant);
  delete product.id;
  delete product.giftCard;
  delete variant.quantityRule;
  delete variant.unitPrice;
  const missing: string[] = [];
  const hooks = {
    read() {},
    unsupported(type: string, key: string) {
      missing.push(`${type}.${key}`);
    },
  };
  await new Liquid().parseAndRender(
    "{{product.id}}{{product.gift_card?}}{{product.variants.first.quantity_rule}}{{product.variants.first.unit_price}}",
    liquidObjects(parseSnapshot(JSON.stringify(snapshot)), route, hooks),
  );
  assert.deepEqual(
    [...new Set(missing)],
    ["product.id", "product.gift_card?", "variant.quantity_rule", "variant.unit_price"],
  );
  product.id = "9007199254740993";
  assert.equal(
    await new Liquid().parseAndRender("{{product.id}}", liquidObjects(snapshot, route, hooks)),
    product.id,
  );
  variant.unitPrice = "0.001";
  assert.throws(() => liquidObjects(snapshot, route, hooks), /hundredths/);
});

test("metadata validation rejects inconsistent IDs/rules and cart unit fields derive from the chosen variant", async () => {
  const snapshot = applyScenario(defaultFixture(), "with-items"),
    product = snapshot.products[0],
    variant = product?.variants[0];
  assert.ok(product && variant && snapshot.products[1]);
  variant.unitPrice = "2.50";
  variant.unitPriceMeasurement = {
    measured_type: "volume",
    quantity_unit: "ml",
    quantity_value: 250,
    reference_unit: "ml",
    reference_value: 100,
  };
  const objects = liquidObjects(snapshot, route, { read() {}, unsupported() {} });
  assert.equal(
    await new Liquid().parseAndRender(
      "{{cart.items.first.unit_price}}|{{cart.items.first.unit_price_measurement.reference_value}}",
      objects,
    ),
    "250|100",
  );
  snapshot.products[1].id = product.id;
  assert.throws(() => validateSnapshotReferences(snapshot), /Duplicate product id/);
  snapshot.products[1].id = "100002";
  variant.quantityRule = { min: 10, max: 5, increment: 1 };
  assert.throws(() => validateSnapshotReferences(snapshot), /maximum/);
  variant.quantityRule = { min: 1, max: null, increment: 0 };
  assert.throws(() => parseSnapshot(JSON.stringify(snapshot)));
});

test("a unit price measurement keeps its quantity as a Float, as Shopify prints it", async () => {
  const snapshot = defaultFixture(),
    variant = snapshot.products[0]?.variants[0];
  assert.ok(variant);
  variant.unitPrice = "4.40";
  variant.unitPriceMeasurement = {
    measured_type: "volume",
    quantity_unit: "ml",
    quantity_value: 250,
    reference_unit: "ml",
    reference_value: 100,
  };
  const objects = liquidObjects(snapshot, route, { read() {}, unsupported() {} });
  // Measured on a development store in Germany: the quantity is a Float, the reference an Integer.
  assert.equal(
    await new Liquid().parseAndRender(
      "{% assign m = product.variants.first.unit_price_measurement %}{{m.measured_type}}|{{m.quantity_value}}|{{m.quantity_unit}}|{{m.reference_value}}|{{m.reference_unit}}|{% if m.quantity_value == 250 %}equal{% endif %}",
      objects,
    ),
    "volume|250.0|ml|100|ml|equal",
  );
});
