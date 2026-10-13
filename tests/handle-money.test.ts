import assert from "node:assert/strict";
import { test } from "node:test";
import { handleize } from "../packages/render/src/filters/handle.js";
import { moneyAmount } from "../packages/render/src/filters/money.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("money_amount preserves native positive decimal output, cent rounding and safe precision", () => {
  for (const [input, expected] of [
    [1250, "12.5"],
    [-1250, "12.5"],
    [1250.5, "12.51"],
    ["1250", "12.5"],
    [1000, "10.0"],
    [1, "0.01"],
    [0, "0.0"],
    [Number.MAX_SAFE_INTEGER, "90071992547409.91"],
  ] as const)
    assert.equal(moneyAmount(input), expected);
  for (const input of [NaN, Infinity, "bad", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => moneyAmount(input));
});
test("handleize transliterates Latin characters while retaining other scripts and underscores", () => {
  for (const [input, expected] of [
    ["Crème Brûlée & Œufs", "creme-brulee-oeufs"],
    ["한글 中文", "한글-中文"],
    ["A_B / C.D", "a_b-c-d"],
    ['Vendor"s', "vendors"],
    [" Ł ß Ø Æ Þ ", "l-ss-o-ae-th"],
    ["a--b___c...", "a-b___c"],
    [null, ""],
  ] as const)
    assert.equal(handleize(input), expected);
});
test("handle alias and numeric filters register in the renderer without pending diagnostics", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "layout/theme.liquid": "{{content_for_layout}}",
      "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      "sections/main.liquid": "{{'Crème Brûlée'|handle}}|{{1250.5|money_amount}}",
    }),
    "/",
  );
  assert.ok(result.html.includes("creme-brulee|12.51"));
  assert.deepEqual(result.diagnostics, []);
});
