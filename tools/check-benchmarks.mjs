import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const themes = JSON.parse(await readFile(".local/benchmark-paths.json", "utf8"));
const summaries = [];
await mkdir(".local/results", { recursive: true });
for (const theme of themes) {
  const output = execFileSync(process.execPath, ["dist/cli.js", "check", theme.path, "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const second = execFileSync(process.execPath, ["dist/cli.js", "check", theme.path, "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(output, second, `${theme.name}: nondeterministic output`);
  const result = JSON.parse(output);
  const { checkSchema } = await import("../dist/check.js");
  checkSchema.parse(result);
  assert.equal(result.supported, true);
  assert.ok(result.pages.length >= 10);
  assert.ok(result.summary.featureCount > 0);
  assert.equal(
    result.summary.unimplementedCount,
    result.summary.featureCount,
    "M0 must not claim oracle-verified implementations",
  );
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(errors, [], `${theme.name}: parse/reference errors`);
  await writeFile(`.local/results/${theme.name}-check.json`, output);
  const summary = {
    theme: theme.name,
    commit: theme.commit,
    templates: result.pages.length,
    features: result.summary.featureCount,
    complete: result.summary.complete,
    diagnostics: result.diagnostics.length,
  };
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}
await writeFile(".local/results/benchmark-summary.json", `${JSON.stringify(summaries, null, 2)}\n`);
