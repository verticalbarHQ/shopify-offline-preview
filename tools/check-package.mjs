import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the tarball as a consumer, without the checkout's dependencies or source files.
const root = resolve(".");
const temporary = await mkdtemp(join(tmpdir(), "sop-package-"));
const run = (command, args, cwd = temporary) =>
  execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
let server;
try {
  const [packed] = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root),
  );
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packed.name, "@verticalbar/shopify-offline-preview");
  assert.equal(packed.version, manifest.version);
  assert.equal(manifest.publishConfig.access, "public");
  assert.ok(!manifest.private);
  for (const { path } of packed.files) {
    assert.match(
      path,
      /^(?:dist\/|schemas\/|fixtures\/default\/|package\.json$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/,
      `Unexpected file in package: ${path}`,
    );
    assert.ok(!/(?:^|\/)(?:\.local|\.env[^/]*|node_modules|HANDOFF[^/]*)(?:\/|$)/.test(path));
  }
  await writeFile(join(temporary, "package.json"), '{"private":true,"type":"module"}\n');
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    join(temporary, packed.filename),
  ]);
  const installed = join(temporary, "node_modules", packed.name);
  const cli = join(temporary, "node_modules/.bin/shopify-offline-preview");
  const theme = join(installed, "dist/playground/sample-theme");
  for (const schema of ["render", "check", "snapshot"]) {
    assert.deepEqual(
      JSON.parse(run(cli, ["schema", schema])),
      JSON.parse(await readFile(join(installed, `schemas/${schema}.schema.json`), "utf8")),
    );
  }
  const rendered = JSON.parse(run(cli, ["render", theme, "/", "--json"]));
  assert.match(rendered.html, /<!doctype html>/i);
  assert.equal(rendered.route.pageType, "index");
  assert.ok(JSON.parse(run(cli, ["check", theme, "--json"])).pages.length > 0);
  await writeFile(
    join(temporary, "consumer.ts"),
    `import { renderTheme } from "${packed.name}/render";
import { checkTheme } from "${packed.name}/check";
import { MemoryThemeFileSystem, defaultFixture, renderTheme as browserRender } from "${packed.name}/browser";
const theme = new MemoryThemeFileSystem({
  "layout/theme.liquid": "{{ content_for_layout }}",
  "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
  "sections/main.liquid": "<h1>{{ shop.name }}</h1>",
});
const result = await renderTheme(theme, "/", { snapshot: defaultFixture() });
if (!result.html.includes("<h1>")) throw new Error("Empty render");
if ((await browserRender(theme, "/")).html !== result.html) throw new Error("Browser/Node mismatch");
await checkTheme(theme);
`,
  );
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--module",
    "NodeNext",
    "--target",
    "ES2022",
    "--strict",
    "--skipLibCheck",
    "false",
    "consumer.ts",
  ]);
  run(process.execPath, ["consumer.js"]);
  server = spawn(cli, ["dev", theme, "--port", "0"], { cwd: temporary, stdio: "pipe" });
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr.on("data", (chunk) => {
    output += chunk;
  });
  server.on("error", (error) => {
    output += error.message;
  });
  const deadline = Date.now() + 15_000;
  while (!output.includes("Preview:") && server.exitCode === null && Date.now() < deadline)
    await delay(50);
  const inspector = output.match(/Inspector: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  const preview = output.match(/Preview: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(inspector && preview, `Packaged dev server did not start: ${output}`);
  const snapshot = JSON.parse(
    await readFile(join(installed, "fixtures/default/snapshot.json"), "utf8"),
  );
  for (const url of [
    `${inspector}/`,
    `${inspector}/inspector.js`,
    `${preview}/`,
    `${preview}/sop/bridge.js`,
  ]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, url);
    assert.ok((await response.arrayBuffer()).byteLength > 0, url);
  }
  const imageFile = snapshot.products[0].images[0].file;
  const image = await fetch(`${preview}/sop/images/${imageFile}`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(image.status, 200);
  assert.deepEqual(
    Buffer.from(await image.arrayBuffer()),
    await readFile(join(installed, "fixtures/default/images", imageFile)),
  );
  console.log(
    `Package check PASS: ${packed.name}@${packed.version}, ${packed.entryCount} files; installed CLI, schemas, dev assets, ESM exports and TypeScript declarations.`,
  );
  console.log(`Tarball integrity: ${packed.integrity}`);
} finally {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5_000);
    await stopped;
    clearTimeout(timeout);
  }
  await rm(temporary, { recursive: true, force: true });
}
