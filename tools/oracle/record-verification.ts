// Records which Shopify features a one-off comparison verified (SPEC §9.10) and writes
// packages/spec/src/verification.ts. It re-renders, offline, the pages that the comparison judged
// similar and notes every filter, tag, object and object property that ran. Documented examples
// whose output matched Shopify's exactly are added from the comparison's own record.
//
// It wraps LiquidJS internals (Context#_getFromScope, Filter#render, the renderer's template loop)
// inside this process only, so it is a maintenance tool, not part of the package.
//
//   tsx tools/oracle/record-verification.ts <config.json>
// config: { date, data, themes: [{name, path}], pages: [[path, scenario | null]], corpusMatches: [id] }
// A theme entry may carry its own data, pages and date, for a comparison on another store or day.
import { readFile, writeFile } from "node:fs/promises";
import { Context, Filter, Liquid, Tag } from "liquidjs";
import { z } from "zod";
import { liquidObjectKind } from "../../packages/data/src/objects.js";
import { applyCompleteScenario as applyScenario } from "../../packages/data/src/scenarios.js";
import { parseCompleteSnapshot as parseSnapshot } from "../../packages/data/src/schema.js";
import { renderTheme } from "../../packages/render/src/index.js";
import { rendererRegistration } from "../../packages/render/src/registration.js";
import { registry } from "../../packages/spec/src/index.js";
import { NodeThemeFileSystem } from "../../packages/theme/src/node.js";

const config = z
  .strictObject({
    date: z.iso.date(),
    data: z.string(),
    themes: z.array(
      z.strictObject({
        name: z.string().regex(/^[a-z0-9-]+$/),
        path: z.string(),
        data: z.string().optional(),
        pages: z.array(z.tuple([z.string(), z.string().nullable()])).optional(),
        date: z.iso.date().optional(),
      }),
    ),
    pages: z.array(z.tuple([z.string(), z.string().nullable()])),
    corpusMatches: z.array(z.string().regex(/^[a-z_]+\/[a-z0-9_?]+\/\d+$/)),
  })
  .parse(JSON.parse(await readFile(process.argv[2] ?? "", "utf8")));

// The preview's own drop classes and LiquidJS loop objects, by the Liquid type they stand for.
const dropTypes: Record<string, string> = {
  ForloopDrop: "forloop",
  ForloopView: "forloop",
  TablerowloopDrop: "tablerowloop",
  TableRowLoop: "tablerowloop",
  ColorValue: "color",
  ColorScheme: "color_scheme",
  ColorSchemeGroup: "color_scheme_group",
  Font: "font",
  MissingImage: "image",
  NamedImageDrop: "image",
  ImagePresentation: "image_presentation",
  Policy: "policy",
};
const ran = new Set<string>();
type Scope = { globals: unknown; environments: unknown; scopes: unknown[] };
type Reader = { readProperty(value: unknown, key: unknown): unknown };
const context = Context.prototype as unknown as Record<string, unknown>;
context._getFromScope = function* (this: Scope & Reader, scope: unknown, paths: unknown) {
  const parts = typeof paths === "string" ? paths.split(".") : (paths as unknown[]);
  const root = scope === this.globals || scope === this.environments || this.scopes.includes(scope);
  if (root && typeof parts[0] === "string") ran.add(`object:${parts[0]}`);
  // `closest` is a plain container, so its documented properties are named after it. The renderer
  // provides it in a context's environments or globals; an `assign` or a render parameter of the
  // same name lives in a local scope and is not the closest object.
  const fromRenderer = scope === this.globals || scope === this.environments;
  if (fromRenderer && parts[0] === "closest" && typeof parts[1] === "string")
    ran.add(`object-property:closest.${parts[1]}`);
  let value: unknown = scope;
  for (const [index, part] of parts.entries()) {
    const owner = value;
    value = yield this.readProperty(value, part);
    const type =
      liquidObjectKind(owner) ?? dropTypes[(owner as object | null)?.constructor?.name ?? ""];
    // Reading a property of a typed object (not of a list of them, such as its size) also shows
    // that the object type itself was in use.
    if ((index > 0 || !root) && type && typeof part === "string") {
      if (!Array.isArray(owner)) ran.add(`object:${type}`);
      ran.add(`object-property:${type}.${part}`);
    }
  }
  return value;
};
const filterRender = Filter.prototype.render;
Filter.prototype.render = function (this: Filter, ...args: Parameters<typeof filterRender>) {
  ran.add(`filter:${this.name}`);
  return filterRender.apply(this, args);
};
const renderer = Object.getPrototypeOf((new Liquid() as unknown as { renderer: object }).renderer);
const renderTemplates = renderer.renderTemplates as (
  this: unknown,
  ...args: unknown[]
) => Generator;
renderer.renderTemplates = function* (this: unknown, templates: unknown[], ...rest: unknown[]) {
  for (const template of templates)
    if (template instanceof Tag) ran.add(`tag:${(template as unknown as { name: string }).name}`);
  return yield* renderTemplates.call(this, templates, ...rest);
};

const objects = registry.objects as Record<string, { properties?: Record<string, unknown> }>;
const documented = new Set([
  ...Object.keys(registry.filters).map((n) => `filter:${n}`),
  ...Object.keys(registry.aliases).map((n) => `filter:${n}`),
  ...[...Object.keys(registry.tags), "schema"].map((n) => `tag:${n}`),
  ...Object.keys(objects).map((n) => `object:${n}`),
  ...Object.entries(objects).flatMap(([type, o]) =>
    Object.keys(o.properties ?? {}).map((key) => `object-property:${type}.${key}`),
  ),
]);
// The preview's product media image is Shopify's `image`; every media type also stands for the
// abstract `media` type that static analysis uses for a variable holding any media.
const mediaTypes = new Set(["image", "video", "model", "external_video"]);
function documentedNames(key: string): string[] {
  const object = /^object:([a-z_]+)$/.exec(key);
  if (object) {
    const type = object[1] === "media_image" ? "image" : (object[1] ?? "");
    return mediaTypes.has(type) ? [`object:${type}`, "object:media"] : [`object:${type}`];
  }
  const match = /^object-property:([a-z_]+)\.(.+)$/.exec(key);
  if (!match) return [key];
  const [, owner = "", property = ""] = match;
  const type = owner === "media_image" ? "image" : owner;
  return mediaTypes.has(type)
    ? [`object-property:${type}.${property}`, `object-property:media.${property}`]
    : [key];
}
const evidence = new Map<string, Set<string>>();
// Only features the preview provides are recorded. A stub filter, or an object or property that is
// absent offline, can still run, but that is not evidence of behaving like Shopify.
const aliases: Record<string, string> = registry.aliases;
const provided = new Set(
  (await rendererRegistration()).filter((e) => e.registered).map((e) => `${e.kind}:${e.name}`),
);
const canonical = (key: string) => {
  const [kind, name = ""] = key.split(/:(.*)/s);
  return kind === "filter" ? `filter:${aliases[name] ?? name}` : key;
};
const note = (key: string, id: string) => {
  if (!documented.has(key) || !provided.has(canonical(key))) return;
  const set = evidence.get(key) ?? new Set<string>();
  set.add(id);
  evidence.set(key, set);
};
for (const theme of config.themes) {
  ran.clear();
  const fs = new NodeThemeFileSystem(theme.path);
  const base = parseSnapshot(await readFile(`${theme.data ?? config.data}/snapshot.json`, "utf8"));
  for (const [path, scenario] of theme.pages ?? config.pages) {
    const snapshot = scenario
      ? applyScenario(structuredClone(base), scenario)
      : structuredClone(base);
    await renderTheme(fs, path, { snapshot });
  }
  for (const key of ran)
    for (const name of documentedNames(key))
      note(name, `comparison/${theme.date ?? config.date}/${theme.name}`);
}
for (const id of config.corpusMatches)
  note(`filter:${id.split("/")[1]}`, `corpus/${config.date}/${id}`);

const body = [...evidence.keys()]
  .sort()
  .map(
    (key) => `  ${JSON.stringify(key)}: ${JSON.stringify([...(evidence.get(key) ?? [])].sort())},`,
  )
  .join("\n");
await writeFile(
  "packages/spec/src/verification.ts",
  `// Generated by tools/oracle/record-verification.ts from a one-off Shopify comparison. Do not edit.

/**
 * Evidence that a feature behaves like Shopify, keyed by "kind:name". Each entry names the one-off
 * comparison it came from: a page pair judged similar in which the feature ran
 * (\`comparison/<date>/<theme>\`), or a documented example whose output matched Shopify's exactly
 * (\`corpus/<date>/<example>\`). Recorded by tools/oracle/record-verification.ts.
 */
export const shopifyVerification: Readonly<Record<string, readonly string[]>> = {
${body}
};
`,
);
console.log(`${evidence.size} verified features written to packages/spec/src/verification.ts`);
