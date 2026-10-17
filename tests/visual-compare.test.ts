import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCaptures, diffLines, pageUrl } from "../tools/oracle/visual-compare.js";

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

test("a side's own query parameters reach every page URL, keeping the page's own query", () => {
  assert.equal(
    pageUrl("https://shop.example", "/search?q=chair", { preview_theme_id: "42" }),
    "https://shop.example/search?q=chair&preview_theme_id=42",
  );
  assert.equal(pageUrl("http://127.0.0.1:3001", "/", {}), "http://127.0.0.1:3001/");
});
