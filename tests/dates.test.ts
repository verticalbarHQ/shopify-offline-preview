import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source: string, locales: Record<string, string> = {}) {
  return new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
    ...locales,
  });
}
test("time tags format the display in shop time and their datetime in UTC", async () => {
  const snapshot = defaultFixture();
  snapshot.shop.timezone = "America/New_York";
  const result = await renderTheme(
    theme(
      "{{'2022-04-14T00:30:00Z'|time_tag:'%Y-%m-%d %H:%M %z',datetime:'%Y-%m-%d %H:%M %z'}}|{{'2022-04-14T00:30:00Z'|time_tag:format:'date'}}",
    ),
    "/",
    { snapshot },
  );
  assert.ok(
    result.html.includes('<time datetime="2022-04-14 00:30 +0000">2022-04-13 20:30 -0400</time>'),
  );
  assert.ok(result.html.includes('<time datetime="2022-04-14T00:30:00Z">April 13, 2022</time>'));
  assert.deepEqual(result.diagnostics, []);
});
test("named date patterns and custom locale formats work for date and time_tag without a host clock", async () => {
  const snapshot = defaultFixture();
  snapshot.meta.now = "2022-04-01T20:56:02Z";
  const result = await renderTheme(
    theme(
      "{{'now'|time_tag:format:'date'}}|{{'now'|date:format:'own'}}|{{'now'|time_tag:format:'own',class:'A \"name\"'}}|{{'bad'|time_tag:format:'date'}}|{{nil|time_tag:format:'date'}}",
      { "locales/en.default.json": '{"date_formats":{"own":"%Y/%m/%d"}}' },
    ),
    "/",
    { snapshot },
  );
  assert.ok(
    result.html.includes('<time datetime="2022-04-01T20:56:02Z">April 1, 2022</time>|2022/04/01'),
  );
  assert.ok(result.html.includes('class="A &quot;name&quot;">2022/04/01</time>|bad|'));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    await renderTheme(theme("{{'now'|date:format:'date'}}"), "/", { snapshot }),
    await renderTheme(theme("{{'now'|date:format:'date'}}"), "/", { snapshot }),
  );
});
test("other locales use their supplied date formats and disclose missing system formats", async () => {
  const snapshot = defaultFixture();
  snapshot.shop.locale = "fr-CA";
  const custom = await renderTheme(
    theme("{{'2022-04-01T20:56:02Z'|time_tag:format:'date'}}", {
      "locales/fr.json": '{"date_formats":{"date":"%d/%m/%Y"}}',
    }),
    "/",
    { snapshot },
  );
  assert.ok(custom.html.includes(">01/04/2022</time>"));
  assert.deepEqual(custom.diagnostics, []);
  const missing = await renderTheme(
    theme("{{'2022-04-01T20:56:02Z'|time_tag:format:'date'}}"),
    "/",
    { snapshot },
  );
  assert.ok(missing.diagnostics.some((d) => d.code === "not-implemented"));
});
