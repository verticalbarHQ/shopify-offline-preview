import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { checkSchema } from "../packages/check/src/contracts.js";
import { renderSchema } from "../packages/render/src/contracts.js";
import { NodeThemeFileSystem } from "../packages/theme/src/node.js";

await mkdir(".local/results", { recursive: true });
const manifest = z
  .array(z.object({ name: z.string(), path: z.string() }))
  .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")));
const dawn = manifest.find((item) => item.name === "dawn");
assert.ok(dawn);
const temp = await mkdtemp(join(tmpdir(), "sop-agent-contracts-"));
const theme = join(temp, "dawn");
const originalFs = new NodeThemeFileSystem(dawn.path);
const original = await originalFs.readText("sections/main-page.liquid");
const ajv = new Ajv2020({ strict: true });
ajv.addFormat("date-time", (value) => !Number.isNaN(Date.parse(value)));
const validateCheck = ajv.compile(JSON.parse(await readFile("schemas/check.schema.json", "utf8")));
const validateRender = ajv.compile(
  JSON.parse(await readFile("schemas/render.schema.json", "utf8")),
);
function command(args: string[], exit: number, kind: "check" | "render") {
  const run = spawnSync(process.execPath, ["dist/cli.js", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, exit, `${args[0]} expected exit ${exit}`);
  const result: unknown = JSON.parse(run.stdout);
  const validate = kind === "check" ? validateCheck : validateRender;
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  return result;
}
try {
  await cp(dawn.path, theme, { recursive: true });
  const marker = "SOP agent contract section edit 20261014";
  await writeFile(join(theme, "sections/main-page.liquid"), `<p>${marker}</p>${original}`);
  const rendered = renderSchema.parse(
    command(["render", theme, "/pages/about", "--json"], 0, "render"),
  );
  assert.ok(rendered.html.includes(marker));
  const find = (nodes: typeof rendered.tree): boolean =>
    nodes.some((node) => node.file === "sections/main-page.liquid" || find(node.children));
  assert.equal(find(rendered.tree), true);
  const needle = "sop_unknown_agent_filter";
  await writeFile(join(theme, "sections/main-page.liquid"), `{{ "x" | ${needle} }}${original}`);
  const checked = checkSchema.parse(command(["check", theme, "--json", "--strict"], 5, "check"));
  assert.ok(
    checked.pages
      .flatMap((page) => page.features)
      .some((feature) => feature.kind === "filter" && feature.name === needle && !feature.known),
  );
  command(["render", "--json"], 2, "render");
  command(["check", "--json"], 2, "check");
  command(["render", join(temp, "missing"), "/", "--json"], 3, "render");
  command(["check", join(temp, "missing"), "--json"], 3, "check");
  const fatal = join(temp, "fatal");
  await mkdir(join(fatal, "templates"), { recursive: true });
  await writeFile(join(fatal, "templates/index.json"), '{"sections":{},"order":[]}');
  command(["render", fatal, "/", "--json"], 4, "render");
  assert.equal(
    await originalFs.readText("sections/main-page.liquid"),
    original,
    "Pinned benchmark was modified",
  );
  const report = {
    status: "pass",
    scope: "CLI contracts; Shopify parity remains pending",
    noTty: true,
    jsonSchemas: true,
    sectionEditVisible: true,
    treeContainsEditedSource: true,
    unknownFilterListed: true,
    strictExit: 5,
    usageExit: 2,
    inputExit: 3,
    fatalExit: 4,
    pinnedBenchmarkUnchanged: true,
  };
  await writeFile(".local/results/agent-contracts.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await rm(temp, { recursive: true, force: true });
}
