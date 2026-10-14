import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function files(source: string) {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  };
}
async function output(source: string, expected: string, zone = "America/New_York") {
  const snapshot = defaultFixture();
  snapshot.shop.timezone = zone;
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/", { snapshot });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes(expected), result.html);
}
test("unqualified dates use shop time while explicit offsets identify an instant", async () => {
  await output(
    "{{'2020-06-15 14:30:45'|date:'%Y-%m-%d %H:%M %z'}}|{{'2020-06-15T14:30:45Z'|date:'%Y-%m-%d %H:%M %z'}}|{{'2020-06-15T14:30:45+09:00'|date:'%Y-%m-%d %H:%M %z'}}",
    "2020-06-15 14:30 -0400|2020-06-15 10:30 -0400|2020-06-15 01:30 -0400",
  );
});
test("date-only, ISO local timestamps and verbose dates keep their shop wall clock", async () => {
  await output(
    "{{'2020-06-15'|date:'%Y-%m-%d %H:%M %z'}}|{{'2020-06-15T14:30:45'|date:'%Y-%m-%d %H:%M %z'}}|{{'Fri Jul 16 01:00:00 2004'|date:'%Y-%m-%d %H:%M %z'}}",
    "2020-06-15 00:00 -0400|2020-06-15 14:30 -0400|2004-07-16 01:00 -0400",
  );
});
test("DST gaps advance and repeated wall-clock times select the first occurrence", async () => {
  await output(
    "{{'2020-03-08 02:30:00'|date:'%Y-%m-%d %H:%M %z'}}|{{'2020-11-01 01:30:00'|date:'%Y-%m-%d %H:%M %z'}}",
    "2020-03-08 03:30 -0400|2020-11-01 01:30 -0400",
  );
});
test("fractional timezone offsets preserve local time and default datetime uses whole seconds", async () => {
  await output(
    "{{'2020-06-15T14:30:45.125'|time_tag:'%Y-%m-%d %H:%M %z'}}",
    '<time datetime="2020-06-15T08:45:45Z">2020-06-15 14:30 +0545</time>',
    "Asia/Kathmandu",
  );
});
test("explicit empty or nil date formats preserve input text and time tag instant", async () => {
  await output(
    "{{'2020-06-15 14:30:45'|date:''}}|{{'2020-06-15 14:30:45'|date:nil}}|{{'2020-06-15 14:30:45'|time_tag:''}}|{{'2020-06-15 14:30:45'|time_tag:nil}}|{{'Today'|date:'%Y'}}|{{'NOW'|date:'%Y'}}",
    '2020-06-15 14:30:45|2020-06-15 14:30:45|<time datetime="2020-06-15T18:30:45Z">2020-06-15 14:30:45</time>|<time datetime="2020-06-15T18:30:45Z">2020-06-15 14:30:45</time>|Today|NOW',
  );
});
test("date rendering is independent of the host process timezone", () => {
  const input = files(
    "{{'2020-06-15 14:30:45'|date:'%Y-%m-%d %H:%M %z'}}|{{'2020-03-08 02:30:00'|time_tag:'%H:%M %z'}}",
  );
  const script = `import {renderTheme} from './packages/render/src/index.ts';import{MemoryThemeFileSystem}from'./packages/theme/src/index.ts';import{defaultFixture}from'./packages/data/src/fixture.ts';const snapshot=defaultFixture();snapshot.shop.timezone='America/New_York';console.log(JSON.stringify(await renderTheme(new MemoryThemeFileSystem(${JSON.stringify(input)}),'/',{snapshot})));`;
  const results = ["UTC", "Asia/Seoul", "America/Los_Angeles"].map((TZ) =>
    JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { ...process.env, TZ },
      }),
    ),
  );
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.ok(results[0].html.includes("2020-06-15 14:30 -0400"));
});
test("date parsing, DST and formatting match in Node and browser", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const snapshot = defaultFixture();
  snapshot.shop.timezone = "America/New_York";
  const input = files(
    "{{'2020-03-08 02:30:00'|time_tag:'%Y-%m-%d %H:%M %z'}}|{{'2020-11-01 01:30:00'|date:'%H:%M %z'}}|{{'2020-06-15 14:30:45'|date:nil}}",
  );
  const options = { inspect: true, snapshot };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
test("date directives preserve Ruby composites, zone names, epoch and ISO week-year", async () => {
  await output(
    "{{'2020-06-15 14:30:45'|date:'%c|%x|%X|%Z|%v|%s|%Q|%q'}}|{{'2021-01-01 00:00:00'|date:'%G-W%V-%u'}}",
    "Mon Jun 15 14:30:45 2020|06/15/20|14:30:45|EDT|15-JUN-2020|1592245845|%Q|%q|2020-W53-5",
  );
});
test("oversized date padding is bounded before allocation and reports an inline error", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(files("{{'2020-06-15'|date:'%999999999999Y'}}|After")),
    "/",
  );
  assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
  assert.ok(result.html.includes("|After"));
});
