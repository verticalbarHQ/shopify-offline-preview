import assert from "node:assert/strict";
import { test } from "node:test";
import { hasDropConstructor } from "../tools/liquid-spec-environment.js";

test("language audit excludes both upstream Drop constructor encodings, including nested arrays", () => {
  assert.equal(hasDropConstructor({ flag: { "instantiate:BooleanDrop": { value: false } } }), true);
  assert.equal(
    hasDropConstructor({ nested: [{ number: "instantiate:NumberDrop: {value: 42}" }] }),
    true,
  );
  assert.equal(hasDropConstructor({ method: "instantiate:MethodDrop" }), true);
  assert.equal(
    hasDropConstructor({
      text: "literal instantiate:MethodDrop",
      values: [0, false, null, { type: "NumberDrop", value: 42 }],
    }),
    false,
  );
});
