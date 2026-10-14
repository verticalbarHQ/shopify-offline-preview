import assert from "node:assert/strict";
import { test } from "node:test";
import type { SeedRequestTemplate } from "../tools/oracle/seed-requests.js";
import { validateSeedRequestTemplate } from "../tools/oracle/seed-schema.js";

// Authored input-contract fixture for validator behavior, not live Shopify evidence.
const named = (name: string) => ({ kind: "SCALAR", name });
const required = (name: string) => ({ kind: "NON_NULL", name: null, ofType: named(name) });
const schema = {
  apiVersion: "2026-10",
  operations: [
    {
      name: "sample",
      args: [
        { name: "input", type: { kind: "INPUT_OBJECT", name: "SampleInput" }, defaultValue: null },
      ],
    },
  ],
  types: [
    {
      kind: "INPUT_OBJECT",
      name: "SampleInput",
      inputFields: [
        { name: "id", type: required("ID"), defaultValue: null },
        { name: "count", type: required("Int"), defaultValue: "1" },
        { name: "status", type: { kind: "ENUM", name: "SampleStatus" }, defaultValue: null },
        {
          name: "prices",
          type: { kind: "LIST", name: null, ofType: required("Money") },
          defaultValue: null,
        },
        { name: "url", type: named("String"), defaultValue: null },
      ],
      enumValues: null,
    },
    { kind: "ENUM", name: "SampleStatus", inputFields: null, enumValues: [{ name: "ACTIVE" }] },
    ...["ID", "Int", "String", "Money"].map((name) => ({
      kind: "SCALAR",
      name,
      inputFields: null,
      enumValues: null,
    })),
  ],
};
const template = (): SeedRequestTemplate => ({
  operation: "sample",
  variableTypes: { input: "SampleInput!" },
  variables: { input: { id: "gid://shopify/Product/1", status: "ACTIVE", prices: ["12.50"] } },
  selection: "userErrors { message }",
  calibration: [],
});

test("input-contract validator accepts nullable args with stricter variables and respects field defaults", () => {
  assert.deepEqual(validateSeedRequestTemplate(template(), schema), []);
});
test("unknown fields, invalid enums and out-of-range integers fail without reflecting values", () => {
  const value = template();
  value.variables.input = {
    id: "secret",
    unknown: "concealed payload",
    status: "PENDING",
    count: 2147483648,
  };
  const issues = validateSeedRequestTemplate(value, schema);
  assert.ok(issues.includes("input.unknown:unknown-field"));
  assert.ok(issues.includes("input.status:invalid-enum"));
  assert.ok(issues.includes("input.count:invalid-scalar"));
  assert.ok(!JSON.stringify(issues).includes("concealed payload"));
});
test("explicit null violates declared non-null variables even when the schema arg is nullable", () => {
  const value = template();
  value.variables.input = null;
  assert.deepEqual(validateSeedRequestTemplate(value, schema), ["input:required-value"]);
});
test("required nested values and non-null list elements are validated", () => {
  const value = template();
  value.variables.input = { prices: [null] };
  const issues = validateSeedRequestTemplate(value, schema);
  assert.ok(issues.includes("input.id:required-value"));
  assert.ok(issues.includes("input.prices[0]:required-value"));
});
test("unresolved binding placeholders are permitted only at compatible scalar fields", () => {
  const value = template();
  value.variables.input = {
    id: { $seedBinding: "authored-key", $seedType: "Product" },
    url: { $seedBinding: "image", $seedType: "URL" },
  };
  assert.deepEqual(validateSeedRequestTemplate(value, schema), []);
  assert.ok(
    validateSeedRequestTemplate(value, schema, false).every((issue) =>
      issue.endsWith("invalid-or-unresolved-binding"),
    ),
  );
  value.variables.input = { id: { $seedBinding: "authored-key", $seedType: "URL" } };
  assert.deepEqual(validateSeedRequestTemplate(value, schema), [
    "input.id:invalid-or-unresolved-binding",
  ]);
});
test("operation signatures and variable declarations must match the retained input contracts", () => {
  const value = template();
  value.variableTypes.input = "String!";
  assert.ok(validateSeedRequestTemplate(value, schema).includes("input:variable-type-mismatch"));
  value.variables.extra = true;
  value.variableTypes.unused = "String";
  const issues = validateSeedRequestTemplate(value, schema);
  assert.ok(issues.includes("extra:unknown-argument"));
  assert.ok(issues.includes("unused:unused-variable"));
  value.operation = "unknown";
  assert.deepEqual(validateSeedRequestTemplate(value, schema), ["unknown-operation"]);
});
