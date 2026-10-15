import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const theme = new MemoryThemeFileSystem({
  "layout/theme.liquid":
    "{% sections 'header-group' %}{{content_for_layout}}{% section 'position' %}",
  "sections/header-group.json": JSON.stringify({
    type: "header",
    sections: { one: { type: "position" } },
    order: ["one"],
  }),
  "templates/index.json": JSON.stringify({
    sections: {
      one: { type: "position" },
      hidden: { type: "position", disabled: true },
      two: { type: "position" },
    },
    order: ["one", "hidden", "two"],
  }),
  "sections/position.liquid":
    "[{{section.location}}:{{section.index|default:'nil'}}:{{section.index0|default:'nil'}}:{% if section.index == blank %}eager{% else %}lazy{% endif %}]",
});
test("section positions are scoped to each location and static sections remain unindexed", async () => {
  const result = await renderTheme(theme, "/");
  const positions = result.html.match(/\[[^\]]+\]/g);
  assert.deepEqual(positions, [
    "[header:1:0:lazy]",
    "[template:1:0:lazy]",
    "[template:2:1:lazy]",
    "[static:nil:nil:eager]",
  ]);
  assert.deepEqual(result.diagnostics, []);
});
test("design mode suppresses position without changing section location", async () => {
  const result = await renderTheme(theme, "/", { designMode: true });
  assert.deepEqual(result.html.match(/\[[^\]]+\]/g), [
    "[header:nil:nil:eager]",
    "[template:nil:nil:eager]",
    "[template:nil:nil:eager]",
    "[static:nil:nil:eager]",
  ]);
});
