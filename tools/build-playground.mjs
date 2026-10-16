import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/playground", { recursive: true });
await build({
  entryPoints: ["packages/playground/src/index.ts"],
  outdir: "dist/playground",
  entryNames: "playground",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  legalComments: "linked",
  mainFields: ["module", "main"],
});
await cp("dist/bridge.js", "dist/playground/bridge.js");
await cp("fixtures/default/images", "dist/playground/images", { recursive: true });
// The original MIT sample theme is served as static files and listed in a manifest.
await rm("dist/playground/sample-theme", { recursive: true, force: true });
await cp("fixtures/sample-theme", "dist/playground/sample-theme", { recursive: true });
const sampleFiles = (
  await readdir("fixtures/sample-theme", { recursive: true, withFileTypes: true })
)
  .filter((entry) => entry.isFile())
  .map((entry) =>
    `${entry.parentPath.slice("fixtures/sample-theme".length + 1)}/${entry.name}`.replace(
      /^\//,
      "",
    ),
  )
  .sort();
await writeFile(
  "dist/playground/sample-theme/manifest.json",
  `${JSON.stringify(sampleFiles, null, 2)}\n`,
);
const { inspectorHtml } = await import("../dist/playground-shell.js");
await writeFile("dist/playground/index.html", inspectorHtml);
console.log(
  `Built the static playground with the ${sampleFiles.length}-file sample theme; no benchmark theme files included.`,
);
