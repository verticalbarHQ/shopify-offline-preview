import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CheckResult, checkTheme } from "../../check/src/index.js";
import { defaultFixture } from "../../data/src/fixture.js";
import { applyScenario, validateSnapshotReferences } from "../../data/src/scenarios.js";
import { parseSnapshot } from "../../data/src/schema.js";
import { startDevServer } from "../../dev/src/server.js";
import { type RenderResult, renderTheme } from "../../render/src/index.js";
import { rendererRegistration } from "../../render/src/registration.js";
import { resolveRoute } from "../../render/src/routes.js";
import { templateConfig } from "../../render/src/theme-config.js";
import { registry } from "../../spec/src/index.js";
import { NodeThemeFileSystem } from "../../theme/src/node.js";

const usage =
  "Usage: shopify-offline-preview check <theme> [--json] [--strict] | render <theme> <path> [--data <directory>] [--scenario <name>] [--design-mode] [--json] [--out <file>] | dev <theme> [--data <directory>] [--scenario <name>] [--design-mode] [--port <number>] | schema <render|check|snapshot>";
async function devCommand(args: string[]): Promise<number> {
  const [target, ...flags] = args;
  const parsed = new Map<string, string | true>();
  if (!target || target.startsWith("-")) {
    console.error(usage);
    return 2;
  }
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (
      !flag ||
      parsed.has(flag) ||
      !["--data", "--scenario", "--design-mode", "--port"].includes(flag)
    ) {
      console.error(usage);
      return 2;
    }
    if (flag === "--design-mode") parsed.set(flag, true);
    else {
      const value = flags[++index];
      if (!value || value.startsWith("--")) {
        console.error(usage);
        return 2;
      }
      parsed.set(flag, value);
    }
  }
  const portValue = parsed.get("--port");
  if (typeof portValue === "string" && (!/^\d+$/.test(portValue) || Number(portValue) > 65534)) {
    console.error("Invalid port");
    return 2;
  }
  try {
    const data = parsed.get("--data");
    const scenario = parsed.get("--scenario");
    const session = await startDevServer({
      themeDirectory: target,
      ...(typeof data === "string" ? { dataDirectory: data } : {}),
      ...(typeof scenario === "string" ? { scenario } : {}),
      ...(typeof portValue === "string" ? { port: Number(portValue) } : {}),
      designMode: parsed.has("--design-mode"),
    });
    console.log(`Inspector: ${session.inspectorOrigin}/`);
    console.log(`Preview: ${session.previewOrigin}/`);
    const stop = () => {
      void session.close().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 4;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
}
function renderFailure(code: string, message: string, json: boolean): void {
  console.error(message);
  if (json) {
    const result: RenderResult = {
      schemaVersion: "1.0",
      html: "",
      tree: [],
      dataUsed: {},
      diagnostics: [{ code, severity: "error", file: null, line: null, nodeId: null, message }],
      route: { path: "", pageType: "", template: "" },
    };
    console.log(JSON.stringify(result));
  }
}
async function renderCommand(args: string[]): Promise<number> {
  const [target, path, ...flags] = args;
  const json = args.includes("--json");
  const parsed = new Map<string, string | true>();
  if (!target || target.startsWith("-") || !path || !path.startsWith("/")) {
    renderFailure("usage-error", usage, json);
    return 2;
  }
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (
      !flag ||
      parsed.has(flag) ||
      !["--data", "--scenario", "--design-mode", "--json", "--out"].includes(flag)
    ) {
      renderFailure("usage-error", usage, json);
      return 2;
    }
    if (["--design-mode", "--json"].includes(flag)) parsed.set(flag, true);
    else {
      const value = flags[++index];
      if (!value || value.startsWith("--")) {
        renderFailure("usage-error", usage, json);
        return 2;
      }
      parsed.set(flag, value);
    }
  }
  let phase = 3;
  try {
    const data = parsed.get("--data");
    const scenario = parsed.get("--scenario");
    const snapshot = applyScenario(
      typeof data === "string"
        ? parseSnapshot(await readFile(join(data, "snapshot.json"), "utf8"))
        : defaultFixture(),
      typeof scenario === "string" ? scenario : "default",
    );
    validateSnapshotReferences(snapshot);
    const theme = new NodeThemeFileSystem(target);
    const themeFiles = new Set(await theme.listFiles());
    const route = resolveRoute(snapshot, path, (file) => themeFiles.has(file));
    templateConfig(await theme.readText(route.template), route.template);
    phase = 4;
    const result = await renderTheme(theme, path, {
      snapshot,
      designMode: parsed.has("--design-mode"),
      inspect: json,
    });
    const out = parsed.get("--out");
    if (typeof out === "string") await writeFile(out, result.html);
    if (json) console.log(JSON.stringify(result));
    else {
      if (!out) process.stdout.write(result.html);
      for (const diagnostic of result.diagnostics)
        console.error(`${diagnostic.code}: ${diagnostic.file ?? "theme"}: ${diagnostic.message}`);
    }
    return 0;
  } catch (error) {
    renderFailure(
      phase === 3 ? "load-error" : "render-error",
      error instanceof Error ? error.message : String(error),
      json,
    );
    return phase;
  }
}
function reportFailure(code: string, message: string, json: boolean): void {
  console.error(message);
  if (json) {
    const result: CheckResult = {
      schemaVersion: "1.0",
      supported: false,
      specCommit: registry.commit,
      pages: [],
      diagnostics: [{ code, severity: "error", file: null, line: null, nodeId: null, message }],
      summary: { featureCount: 0, unimplementedCount: 0, complete: false },
    };
    console.log(JSON.stringify(result));
  }
}
async function main(args: string[]): Promise<number> {
  const [command, target, ...flags] = args;
  if (command === "--help" && !target) {
    console.log(usage);
    return 0;
  }
  if (command === "render") return renderCommand(args.slice(1));
  if (command === "dev") return devCommand(args.slice(1));
  if (
    command === "schema" &&
    target &&
    ["render", "check", "snapshot"].includes(target) &&
    !flags.length
  ) {
    console.log(
      (await readFile(new URL(`../schemas/${target}.schema.json`, import.meta.url), "utf8")).trim(),
    );
    return 0;
  }
  if (
    command !== "check" ||
    !target ||
    target.startsWith("-") ||
    flags.some((flag) => !["--json", "--strict"].includes(flag)) ||
    new Set(flags).size !== flags.length
  ) {
    reportFailure("usage-error", usage, command === "check" && args.includes("--json"));
    return 2;
  }
  try {
    const result = await checkTheme(new NodeThemeFileSystem(target), await rendererRegistration());
    if (flags.includes("--json")) console.log(JSON.stringify(result));
    else {
      console.log(
        `Features: ${result.summary.featureCount}, unimplemented: ${result.summary.unimplementedCount}, complete: ${result.summary.complete}`,
      );
      for (const page of result.pages)
        console.log(
          `${page.template}: ${page.files.length} files, ${page.unimplementedCount} unimplemented`,
        );
      for (const diagnostic of result.diagnostics)
        console.error(`${diagnostic.code}: ${diagnostic.file ?? "theme"}: ${diagnostic.message}`);
    }
    if (!result.supported) return 3;
    if (result.diagnostics.some((d) => d.severity === "error")) return 3;
    if (
      flags.includes("--strict") &&
      (result.summary.unimplementedCount > 0 || !result.summary.complete)
    )
      return 5;
    return 0;
  } catch (error) {
    reportFailure(
      "load-error",
      error instanceof Error ? error.message : String(error),
      flags.includes("--json"),
    );
    return 3;
  }
}
process.exitCode = await main(process.argv.slice(2));
