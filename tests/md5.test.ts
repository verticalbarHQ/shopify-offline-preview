import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { md5 } from "../packages/render/src/filters/md5.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("browser-safe MD5 matches standard empty, Unicode, padding boundaries and multi-block vectors", () => {
  for (const value of [
    "",
    "a",
    "abc",
    "message digest",
    "abcdefghijklmnopqrstuvwxyz",
    "한국어 🌿",
    ...Array.from({ length: 140 }, (_, i) => "x".repeat(i)),
    "multi".repeat(20000),
  ])
    assert.equal(md5(value), createHash("md5").update(value).digest("hex"));
});
test("the Liquid MD5 filter accepts strings and nil without Node-only dependencies", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "layout/theme.liquid": "{{content_for_layout}}",
      "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      "sections/main.liquid": "{{'abc'|md5}}|{{nil|md5}}",
    }),
    "/",
  );
  assert.ok(
    result.html.includes("900150983cd24fb0d6963f7d28e17f72|d41d8cd98f00b204e9800998ecf8427e"),
  );
  assert.deepEqual(result.diagnostics, []);
});
