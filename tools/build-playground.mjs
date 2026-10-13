import { cp, mkdir, writeFile } from "node:fs/promises";
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
const { inspectorHtml } = await import("../dist/playground-shell.js");
await writeFile("dist/playground/index.html", inspectorHtml);
console.log("Built the static playground; no benchmark theme files included.");
