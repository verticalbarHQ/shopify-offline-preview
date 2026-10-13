import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { checkSchema } from "../packages/check/src/contracts.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import { renderSchema } from "../packages/render/src/contracts.js";

await mkdir("schemas", { recursive: true });
for (const [name, schema] of Object.entries({
  check: checkSchema,
  snapshot: snapshotSchema,
  render: renderSchema,
})) {
  const document = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
  const output = `${JSON.stringify(document, null, 2)}\n`;
  const target = `schemas/${name}.schema.json`;
  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8")) !== output)
      throw new Error(`JSON Schema drift: ${target}`);
  } else await writeFile(target, output);
}
console.log("JSON Schemas: check, render, snapshot");
