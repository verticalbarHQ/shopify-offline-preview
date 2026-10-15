import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { preparePinnedBenchmarkTheme } from "../../tools/oracle/benchmark-theme.js";
/** Authored tiny tarball delivered by a mock fetcher. Never actual pinned Shopify source evidence. */
export async function authoredBenchmark(name: "dawn" | "horizon" = "dawn", unsafeLink = false) {
  const pins: { name: string; commit: string }[] = JSON.parse(
      await readFile(new URL("../../benchmarks.json", import.meta.url), "utf8"),
    ),
    pin = pins.find((pin) => pin.name === name);
  if (!pin) throw new Error();
  const root = await mkdtemp(join(tmpdir(), "sop-authored-archive-")),
    folder = `${name}-${pin.commit}`,
    source = join(root, folder),
    files: Record<string, string> = {
      "layout/theme.liquid": "<html><body>{{content_for_layout}}</body></html>",
      "sections/main.liquid": "{{shop.id}} {{'now' | date:'%s'}}",
    };
  for (const template of [
    "index",
    "product",
    "collection",
    "page",
    "search",
    "cart",
    "404",
    "blog",
    "article",
  ])
    files[`templates/${template}.json`] = '{"sections":{"main":{"type":"main"}},"order":["main"]}';
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), text);
    }
    const archive = join(root, "authored.tar.gz");
    if (unsafeLink) await symlink("/outside", join(source, "layout/escape.liquid"));
    await promisify(execFile)("tar", ["-czf", archive, "-C", root, folder]);
    const bytes = await readFile(archive);
    return preparePinnedBenchmarkTheme(name, async (url, init) => {
      if (
        String(url) !== `https://codeload.github.com/Shopify/${name}/tar.gz/${pin.commit}` ||
        init?.redirect !== "manual"
      )
        throw new Error("Unexpected authored source request");
      return new Response(bytes);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
