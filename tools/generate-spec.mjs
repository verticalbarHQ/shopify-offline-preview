import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const pin = JSON.parse(await readFile("upstream.json", "utf8"));
const input = {};
const hashes = {};
for (const file of pin.files) {
  const bytes = await readFile(`vendor/theme-liquid-docs/${file}`);
  hashes[file] = createHash("sha256").update(bytes).digest("hex");
  input[file] = JSON.parse(bytes.toString());
}
const header = `// Generated from ${pin.repository}@${pin.commit}. Do not edit.\n`;
const objects = [...input["objects.json"]].sort((a, b) => a.name.localeCompare(b.name, "en"));
const aliases = { t: "translate", handle: "handleize" };
const registry = {
  repository: pin.repository,
  commit: pin.commit,
  hashes,
  aliases,
  filters: Object.fromEntries(
    input["filters.json"].map((f) => [f.name, { deprecated: f.deprecated }]),
  ),
  tags: Object.fromEntries(input["tags.json"].map((t) => [t.name, { deprecated: t.deprecated }])),
  objects: Object.fromEntries(
    objects.map((o) => [
      o.name,
      {
        global: o.access.global,
        properties: Object.fromEntries(
          (o.properties ?? []).map((p) => [
            p.name,
            p.return_type.flatMap((t) =>
              t.type === "array"
                ? t.array_value.split("|").map((name) => `${name.trim()}[]`)
                : [t.type],
            ),
          ]),
        ),
      },
    ]),
  ),
};
const names = new Set(objects.map((o) => o.name));
function typeName(name) {
  return `Liquid${name
    .split("_")
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("")}`;
}
function tsType(name) {
  if (name.includes("|"))
    return name
      .split("|")
      .map((p) => tsType(p.trim()))
      .join(" | ");
  if (["string", "number", "boolean"].includes(name)) return name;
  return names.has(name) ? typeName(name) : "unknown";
}
const types = objects
  .map((o) => {
    const properties = (o.properties ?? []).map((p) => {
      const unions = [
        ...new Set(
          p.return_type.map((t) =>
            t.type === "array" ? `ReadonlyArray<${tsType(t.array_value)}>` : tsType(t.type),
          ),
        ),
      ];
      return `  ${JSON.stringify(p.name)}?: ${unions.join(" | ") || "unknown"} | null;`;
    });
    return `export interface ${typeName(o.name)} {\n${properties.join("\n")}\n}`;
  })
  .join("\n\n");
const corpus = [];
for (const kind of ["filters", "tags", "objects"]) {
  for (const item of input[`${kind}.json`]) {
    for (const [index, example] of (item.examples ?? []).entries()) {
      if (example.raw_liquid?.trim())
        corpus.push({
          id: `${kind}/${item.name}/${index}`,
          kind,
          name: item.name,
          path: example.path,
          liquid: example.raw_liquid,
        });
    }
    for (const property of item.properties ?? []) {
      for (const [index, example] of (property.examples ?? []).entries()) {
        if (example.raw_liquid?.trim())
          corpus.push({
            id: `objects/${item.name}.${property.name}/${index}`,
            kind: "object-property",
            name: `${item.name}.${property.name}`,
            path: example.path,
            liquid: example.raw_liquid,
          });
      }
    }
  }
}
const outputs = {
  "registry.ts": `${header}export const registry = ${JSON.stringify(registry, null, 2)};\n`,
  "objects.ts": `${header}// Documentation types are optional and nullable; untyped values remain unknown.\n${types}\n\nexport interface LiquidObjectMap {\n${objects.map((o) => `  ${JSON.stringify(o.name)}: ${typeName(o.name)};`).join("\n")}\n}\n`,
  "corpus.json": `${JSON.stringify(corpus, null, 2)}\n`,
  "translations.json": `${JSON.stringify(input["shopify_system_translations.json"], null, 2)}\n`,
};
await mkdir("packages/spec/src/generated", { recursive: true });
for (const [file, output] of Object.entries(outputs)) {
  const target = `packages/spec/src/generated/${file}`;
  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8")) !== output)
      throw new Error(`Generated spec drift: ${target}`);
  } else await writeFile(target, output);
}
console.log(
  `Spec ${pin.commit}: ${Object.keys(registry.filters).length} distinct filters, ${objects.length} objects, ${Object.keys(registry.tags).length} tags, ${corpus.length} corpus inputs`,
);
