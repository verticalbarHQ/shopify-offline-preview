import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { instrumentTheme } from "./instrument-theme.js";

const themes: { name: string; path: string; commit: string }[] = JSON.parse(
  await readFile(".local/benchmark-paths.json", "utf8"),
);
const output = [];
for (const theme of themes) {
  const result = await instrumentTheme(theme.path);
  assert.ok(result.classicMarkers > 0);
  if (theme.name === "horizon") assert.equal(result.themeBlockMarkers, 95);
  output.push({ name: theme.name, commit: theme.commit, ...result });
  console.log(
    JSON.stringify({
      name: theme.name,
      classicMarkers: result.classicMarkers,
      themeBlockMarkers: result.themeBlockMarkers,
      sourceFiles: result.files,
    }),
  );
}
await writeFile(".local/results/instrumentation.json", `${JSON.stringify(output, null, 2)}\n`);
