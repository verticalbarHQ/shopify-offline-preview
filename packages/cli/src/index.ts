import { readFile } from "node:fs/promises";
import { type CheckResult, checkTheme } from "../../check/src/index.js";
import { registry } from "../../spec/src/index.js";
import { NodeThemeFileSystem } from "../../theme/src/node.js";

const usage =
  "Usage: shopify-offline-preview check <theme> [--json] [--strict] | schema <render|check|snapshot>";
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
    const result = await checkTheme(new NodeThemeFileSystem(target));
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
