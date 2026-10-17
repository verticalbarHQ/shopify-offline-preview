import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCaptures, diffLines } from "../tools/oracle/visual-compare.js";

test("text differences list the lines found on only one side, in order", () => {
  assert.deepEqual(
    diffLines(["Home", "Shirt", "$10.00", "Add"], ["Home", "Shirt", "$12.00", "Add"]),
    {
      onlyLeft: ["$10.00"],
      onlyRight: ["$12.00"],
    },
  );
  assert.deepEqual(diffLines(["a", "b"], ["a", "b"]), { onlyLeft: [], onlyRight: [] });
});

test("section comparison reports missing, extra and moved sections", () => {
  const capture = (ids: string[]) => ({
    title: "",
    height: 100,
    sections: ids.map((id) => ({ id, top: 0, height: 10, lines: [id] })),
  });
  const result = compareCaptures(
    capture(["header", "main", "footer", "promo"]),
    capture(["header", "footer", "main", "app"]),
  );
  assert.deepEqual(result.missingRight, ["promo"]);
  assert.deepEqual(result.missingLeft, ["app"]);
  assert.equal(result.reordered, true);
  assert.deepEqual(
    result.sections.map((s) => s.id),
    ["header", "main", "footer"],
  );
});
