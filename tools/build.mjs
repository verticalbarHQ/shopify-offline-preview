import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  legalComments: "linked",
  mainFields: ["module", "main"],
};
await mkdir("dist", { recursive: true });
await build({
  ...shared,
  entryPoints: ["packages/cli/src/index.ts"],
  outfile: "dist/cli.js",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("dist/cli.js", 0o755);
await build({
  ...shared,
  entryPoints: ["packages/check/src/index.ts"],
  outfile: "dist/check.js",
  platform: "neutral",
  mainFields: ["module", "main"],
});
await build({
  ...shared,
  entryPoints: ["packages/render/src/index.ts"],
  outfile: "dist/render.js",
  platform: "browser",
});
const browser = await build({
  ...shared,
  entryPoints: ["packages/check/src/browser.ts"],
  outfile: "dist/browser.js",
  platform: "browser",
  metafile: true,
});
if (Object.keys(browser.metafile.inputs).some((input) => input.includes("node:")))
  throw new Error("Node dependency leaked into browser bundle");
await writeFile("dist/browser-meta.json", `${JSON.stringify(browser.metafile, null, 2)}\n`);
execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
console.log("Built CLI, check, render, and browser bundles.");
