import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryThemeFileSystem, parseThemeJson } from "../packages/theme/src/index.js";
import { NodeThemeFileSystem } from "../packages/theme/src/node.js";

test("memory adapter rejects escaping paths and owns its bytes", async () => {
  for (const path of ["../secret", "/secret", "a/../b", "a\\b", "a//b"])
    assert.throws(() => new MemoryThemeFileSystem({ [path]: "bad" }));
  const bytes = new Uint8Array([65]);
  const fs = new MemoryThemeFileSystem({ "assets/a": bytes });
  bytes[0] = 66;
  (await fs.readBytes("assets/a"))[0] = 67;
  assert.equal(await fs.readText("assets/a"), "A");
  await assert.rejects(fs.readText("missing"));
});

test("Node adapter reads sorted files and rejects symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sop-fs-"));
  try {
    await mkdir(join(root, "theme"));
    await writeFile(join(root, "theme", "b"), "B");
    await writeFile(join(root, "theme", "a"), "A");
    await writeFile(join(root, "secret"), "secret");
    const fs = new NodeThemeFileSystem(join(root, "theme"));
    assert.deepEqual(await fs.listFiles(), ["a", "b"]);
    assert.equal(await fs.readText("a"), "A");
    await assert.rejects(fs.readText("../secret"));
    await symlink(join(root, "secret"), join(root, "theme", "link"));
    await assert.rejects(fs.listFiles(), /symlinks/);
    await assert.rejects(fs.readText("link"), /escapes root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSONC accepts Shopify comments and rejects invalid JSON", () => {
  assert.deepEqual(parseThemeJson('/* generated */ {"a": 1,}', "test.json"), { a: 1 });
  assert.throws(() => parseThemeJson('{"a": }', "test.json"), /test.json/);
});
