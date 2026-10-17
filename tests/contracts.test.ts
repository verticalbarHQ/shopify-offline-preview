import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { Ajv2020 } from "ajv/dist/2020.js";
import { transform } from "esbuild";
import { checkTheme } from "../packages/check/src/index.js";
import { parseSnapshot } from "../packages/data/src/schema.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { snapshot, theme } from "./fixtures.js";

async function validator(name: string) {
  const ajv = new Ajv2020({ strict: true });
  ajv.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)));
  return ajv.compile(JSON.parse(await readFile(`schemas/${name}.schema.json`, "utf8")));
}

test("check output and render contract example validate against published JSON Schemas", async () => {
  const check = await validator("check");
  assert.equal(
    check(await checkTheme(new MemoryThemeFileSystem(theme()))),
    true,
    JSON.stringify(check.errors),
  );
  const render = await validator("render");
  assert.equal(
    render({
      schemaVersion: "1.0",
      html: "<p>example</p>",
      tree: [
        {
          kind: "section",
          id: "x",
          type: "example",
          file: "sections/example.liquid",
          settingsPath: null,
          children: [],
        },
      ],
      diagnostics: [],
      dataUsed: {},
      route: { path: "/", pageType: "index", template: "templates/index.json" },
    }),
    true,
    JSON.stringify(render.errors),
  );
  assert.equal(render({ html: "" }), false);
});

test("the published snapshot schema and the parser agree on which filters take an operator", async () => {
  const validate = await validator("snapshot");
  const cases = [
    [{ id: "filter.p.tag", type: "list", operator: "AND" }, true],
    [{ id: "filter.p.m.custom.fabric", type: "list", operator: "OR" }, true],
    [{ id: "filter.p.vendor", type: "list" }, true],
    [{ id: "filter.p.vendor", type: "list", operator: "AND" }, false],
    [{ id: "filter.p.tag", type: "boolean", operator: "AND" }, false],
  ] as const;
  for (const [filter, valid] of cases) {
    const input = snapshot();
    input.filters = [{ ...filter, label: "Filter", values: [] }];
    assert.equal(validate(input), valid, JSON.stringify(filter));
    if (valid) parseSnapshot(JSON.stringify(input));
    else assert.throws(() => parseSnapshot(JSON.stringify(input)), Error, JSON.stringify(filter));
  }
});

test("snapshot contract accepts externally prepared inputs and rejects invalid source values", async () => {
  const input = snapshot();
  input.products.push({
    handle: "sample",
    title: "Sample product",
    descriptionHtml: "<p>Example</p>",
    vendor: "Example",
    productType: "Example",
    tags: [],
    templateSuffix: null,
    options: [{ name: "Title", values: ["Default Title"] }],
    variants: [
      {
        id: "variant-1",
        optionValues: [{ name: "Title", value: "Default Title" }],
        price: "12.50",
        compareAtPrice: null,
        available: true,
        sku: "SAMPLE",
        barcode: "",
        image: "sample.png",
      },
    ],
    images: [{ file: "sample.png", alt: "Example", width: 100, height: 100 }],
    metafields: {},
  });
  input.cart.lines.push({ productHandle: "sample", variantId: "variant-1", quantity: 2 });
  const validate = await validator("snapshot");
  assert.deepEqual(parseSnapshot(JSON.stringify(input)), input);
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  assert.throws(() => parseSnapshot(JSON.stringify({ ...input, unexpected: true })));
  assert.equal(validate({ ...input, unexpected: true }), false);
  const image = input.products[0]?.images[0];
  assert.ok(image);
  for (const path of [
    "../secret",
    "/secret",
    "a/../secret",
    "a\\secret",
    "a//secret",
    "secret\0",
  ]) {
    image.file = path;
    assert.throws(() => parseSnapshot(JSON.stringify(input)));
    assert.equal(validate(input), false, `JSON Schema should reject ${JSON.stringify(path)}`);
  }
  assert.throws(() =>
    parseSnapshot(JSON.stringify({ ...input, shop: { ...input.shop, timezone: "invalid-zone" } })),
  );
});

test("CLI is non-interactive with one JSON document, strict exit 5, usage 2, load failure 3", async () => {
  const root = await mkdtemp(join(tmpdir(), "sop-cli-"));
  try {
    for (const [path, text] of Object.entries(theme())) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["dist/cli.js", ...args], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    const normal = run("check", root, "--json");
    assert.equal(normal.status, 0, normal.stderr);
    assert.equal(normal.stderr, "");
    assert.ok(!normal.stdout.includes("\u001b"));
    const validate = await validator("check");
    assert.equal(validate(JSON.parse(normal.stdout)), true);
    // A filter Shopify does not have is missing, so --strict fails.
    const header = join(root, "sections/header.liquid");
    await writeFile(header, `${await readFile(header, "utf8")}{{ 'x' | not_a_filter }}`);
    const strict = run("check", root, "--json", "--strict");
    assert.equal(strict.status, 5, strict.stderr);
    assert.equal(validate(JSON.parse(strict.stdout)), true);
    assert.equal(run("check").status, 2);
    assert.equal(run("check", root, "--bad").status, 2);
    const usageFailure = run("check", "--json");
    assert.equal(usageFailure.status, 2);
    assert.equal(validate(JSON.parse(usageFailure.stdout)), true);
    const loadFailure = run("check", join(root, "missing"), "--json");
    assert.equal(loadFailure.status, 3);
    assert.equal(validate(JSON.parse(loadFailure.stdout)), true);
    await writeFile(join(root, "templates/product.json"), "bad JSON");
    assert.equal(run("check", root, "--json").status, 3);
    for (const name of ["render", "check", "snapshot"]) {
      const result = run("schema", name);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        JSON.parse(result.stdout),
        JSON.parse(await readFile(`schemas/${name}.schema.json`, "utf8")),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser bundle executes core analysis identically to Node without filesystem access", async () => {
  // esbuild's browser platform fails the build on any Node builtin; execute its bundled exports too.
  // The generated bundle uses the source module's checked interface.
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const files = theme();
  const nodeResult = await checkTheme(new MemoryThemeFileSystem(files));
  const browserResult = await browser.checkTheme(new browser.MemoryThemeFileSystem(files));
  assert.equal(JSON.stringify(browserResult), JSON.stringify(nodeResult));
});

test("browser bundle runs without Node globals in an isolated JavaScript context", async () => {
  const source = await readFile("dist/browser.js", "utf8");
  const { code } = await transform(source, { format: "iife", globalName: "SOP", target: "es2022" });
  const context = createContext({ TextEncoder, TextDecoder });
  assert.equal(runInContext("typeof process", context), "undefined");
  assert.equal(runInContext("typeof require", context), "undefined");
  const browserResult: unknown = await runInContext(
    `${code}\nSOP.checkTheme(new SOP.MemoryThemeFileSystem(${JSON.stringify(theme())}))`,
    context,
  );
  const nodeResult = await checkTheme(new MemoryThemeFileSystem(theme()));
  assert.equal(JSON.stringify(browserResult), JSON.stringify(nodeResult));
});

test("render CLI consumes local snapshots, emits schema-valid JSON on success/failure and writes HTML separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "sop-render-cli-"));
  const files = {
    "templates/index.json": JSON.stringify({
      layout: false,
      sections: { a: { type: "text" } },
      order: ["a"],
    }),
    "sections/text.liquid": '{{shop.name}}|{{request.design_mode}}|{{"now" | date:"%Y"}}',
  };
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    await writeFile(join(root, "snapshot.json"), JSON.stringify(snapshot()));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["dist/cli.js", "render", ...args], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    const out = join(root, "out.html");
    const normal = run(root, "/", "--data", root, "--design-mode", "--json", "--out", out);
    assert.equal(normal.status, 0, normal.stderr);
    assert.equal(normal.stderr, "");
    const validate = await validator("render");
    const parsed: unknown = JSON.parse(normal.stdout);
    assert.equal(validate(parsed), true, JSON.stringify(validate.errors));
    const { renderSchema } = await import("../packages/render/src/contracts.js");
    const result = renderSchema.parse(parsed);
    assert.equal(await readFile(out, "utf8"), result.html);
    assert.match(result.html, /Example\|true/);
    for (const [args, status] of [
      [["--json"], 2],
      [[root, "/", "--json", "--bad"], 2],
      [[root, "/", "--json", "--data", join(root, "missing")], 3],
      [[root, "/", "--json", "--scenario", "absent"], 3],
      [[root, "/products/missing", "--json"], 3],
    ] as const) {
      const failure = run(...args);
      assert.equal(failure.status, status, failure.stderr);
      assert.equal(validate(JSON.parse(failure.stdout)), true, JSON.stringify(validate.errors));
    }
    await writeFile(
      join(root, "templates/index.json"),
      JSON.stringify({ sections: { a: { type: "text" } }, order: ["a"] }),
    );
    const fatal = run(root, "/", "--json");
    assert.equal(fatal.status, 4);
    assert.equal(validate(JSON.parse(fatal.stdout)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser renderer executes without Node globals and matches Node's HTML/tree/diagnostics", async () => {
  const source = await readFile("dist/browser.js", "utf8");
  const { code } = await transform(source, { format: "iife", globalName: "SOP", target: "es2022" });
  const context = createContext({ TextEncoder, TextDecoder, URL, structuredClone, performance });
  const files = {
    "templates/index.json": JSON.stringify({
      layout: false,
      sections: { a: { type: "text" } },
      order: ["a"],
    }),
    "sections/text.liquid": '{{shop.name}}|{{"now" | date:"%Y-%m-%d"}}|{{"x" | t}}',
  };
  const { renderTheme } = await import("../packages/render/src/index.js");
  const node = await renderTheme(new MemoryThemeFileSystem(files), "/", {
    snapshot: snapshot(),
    inspect: true,
  });
  const browser: unknown = await runInContext(
    `${code}\nSOP.renderTheme(new SOP.MemoryThemeFileSystem(${JSON.stringify(files)}),"/",{snapshot:${JSON.stringify(snapshot())},inspect:true})`,
    context,
  );
  assert.equal(JSON.stringify(browser), JSON.stringify(node));
});

test("the published check schema and the parser agree that a provided feature is never server-only", async () => {
  const { checkSchema } = await import("../packages/check/src/contracts.js");
  const validate = await validator("check");
  const result = (registered: boolean, serverOnly: boolean) => ({
    schemaVersion: "1.0",
    supported: true,
    specCommit: "x",
    pages: [
      {
        pageType: "product",
        template: "templates/product.json",
        files: [],
        features: [
          {
            kind: "filter",
            name: "money",
            known: true,
            registered,
            serverOnly,
            oracleCases: [],
            implemented: registered,
            verified: false,
            occurrences: [],
          },
        ],
        unimplementedCount: 0,
        complete: true,
      },
    ],
    diagnostics: [],
    summary: { featureCount: 1, unimplementedCount: 0, complete: true },
  });
  for (const [registered, serverOnly, valid] of [
    [true, false, true],
    [false, true, true],
    [false, false, true],
    [true, true, false],
  ] as const) {
    const value = result(registered, serverOnly);
    assert.equal(validate(value), valid, `${registered}/${serverOnly}`);
    assert.equal(checkSchema.safeParse(value).success, valid, `${registered}/${serverOnly}`);
  }
});
