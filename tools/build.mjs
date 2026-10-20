import { execFileSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  legalComments: "linked",
  mainFields: ["module", "main"],
};
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  ...shared,
  entryPoints: ["packages/cli/src/index.ts"],
  outfile: "dist/cli.js",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("dist/cli.js", 0o755);
for (const name of ["inspector", "bridge"]) {
  await build({
    ...shared,
    entryPoints: [`packages/dev/src/${name}.ts`],
    outfile: `dist/${name}.js`,
    platform: "browser",
    ...(name === "bridge" ? { format: "iife" } : {}),
  });
}
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
await build({
  ...shared,
  entryPoints: ["packages/playground/src/shell.ts"],
  outfile: "dist/playground-shell.js",
  platform: "browser",
});
await import("./build-playground.mjs");
console.log("Built CLI, check, render, browser, inspector, and playground bundles.");
