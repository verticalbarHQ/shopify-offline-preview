import {
  type LiquidExpression,
  type LiquidHtmlNode,
  NodeTypes,
  toLiquidAST,
  walk,
} from "@shopify/liquid-html-parser";
import { z } from "zod";
import {
  type FeatureKind,
  type ImplementationEvidence,
  isImplemented,
  registry,
} from "../../spec/src/index.js";
import { parseThemeJson, type ThemeFileSystem, themePath } from "../../theme/src/index.js";
import type { CheckResult, Diagnostic, Feature } from "./contracts.js";
import { variableEnvironments } from "./type-environments.js";
import { baseType, linkObjectType, lookupKey, type Symbols } from "./type-facts.js";

export { type CheckResult, checkSchema } from "./contracts.js";

const objects: Record<string, { global: boolean; properties: Record<string, string[]> }> =
  registry.objects;
const objectNames = new Set(Object.keys(objects));
const dictionaries: Record<string, string> = {
  all_products: "product",
  images: "image",
  collections: "collection",
  pages: "page",
  blogs: "blog",
  linklists: "linklist",
  metaobjects: "metaobject",
};
function propertyReturns(type: string, property: string): string[] | undefined {
  const resource = linkObjectType(type);
  if (resource !== undefined && property === "object") return [resource];
  type = baseType(type);
  const properties = objectNames.has(type) ? objects[type]?.properties : undefined;
  return properties && Object.hasOwn(properties, property) ? properties[property] : undefined;
}
const knownFilters = new Set([...Object.keys(registry.filters), ...Object.keys(registry.aliases)]);
// Section schema is an architectural tag absent from the Liquid API data:
// https://shopify.dev/docs/storefronts/themes/architecture/sections/section-schema
const knownTags = new Set([...Object.keys(registry.tags), "schema"]);
const aliases: Record<string, string> = registry.aliases;
// SPEC §9.3 page types; alternate templates of these types are included.
const pageTypes = new Set([
  "index",
  "product",
  "collection",
  "page",
  "search",
  "cart",
  "404",
  "blog",
  "article",
]);
const sectionConfig: z.ZodType<SectionConfig> = z.lazy(() =>
  z.looseObject({
    type: z.string(),
    disabled: z.boolean().optional(),
    blocks: z.record(z.string(), sectionConfig).optional(),
    block_order: z.array(z.string()).optional(),
  }),
);
interface SectionConfig {
  type: string;
  disabled?: boolean | undefined;
  blocks?: Record<string, SectionConfig> | undefined;
  block_order?: string[] | undefined;
}
const templateSchema = z.looseObject({
  layout: z.union([z.string(), z.literal(false), z.null()]).optional(),
  sections: z.record(z.string(), sectionConfig),
  order: z.array(z.string()),
});
interface Scan {
  features: Feature[];
  refs: string[];
  calls: { file: string; bindings: Symbols }[];
  diagnostics: Diagnostic[];
  complete: boolean;
  layout?: string | false | null;
}

function diagnostic(
  code: string,
  file: string | null,
  message: string,
  line: number | null = null,
): Diagnostic {
  return {
    code,
    severity: code === "liquid-parse-error" || code === "missing-file" ? "error" : "warning",
    file,
    line,
    nodeId: null,
    message,
  };
}
function location(node: LiquidHtmlNode): number {
  return node.source.slice(0, node.position.start).split("\n").length;
}
function reference(directory: string, name: string, extension: string): string {
  return themePath(`${directory}/${name}${extension}`);
}

function lookupTypes(expression: LiquidExpression, symbols: Map<string, Set<string>>): Set<string> {
  if (expression.type === NodeTypes.String) return new Set(["string"]);
  if (expression.type === NodeTypes.Number) return new Set(["number"]);
  if (expression.type === NodeTypes.Range) return new Set(["number[]"]);
  if (expression.type === NodeTypes.LiquidLiteral)
    return new Set([typeof expression.value === "boolean" ? "boolean" : "nil"]);
  if (expression.type !== NodeTypes.VariableLookup || !expression.name) return new Set(["?"]);
  let types =
    symbols.get(expression.name) ??
    (objectNames.has(expression.name) ? new Set([expression.name]) : new Set(["?"]));
  for (const [index, lookup] of expression.lookups.entries()) {
    const next = new Set<string>();
    for (const type of types) {
      if (type === "?") next.add("?");
      else if (type.endsWith("[]")) {
        if (
          lookup.type === NodeTypes.Number ||
          lookup.type === NodeTypes.VariableLookup ||
          (lookup.type === NodeTypes.String && ["first", "last"].includes(lookup.value))
        )
          next.add(type.slice(0, -2));
      } else if (lookup.type === NodeTypes.String) {
        for (const result of propertyReturns(type, lookup.value) ?? []) next.add(result);
      }
      // Shopify resource dictionaries use handles, not documented fixed properties.
      if (Object.hasOwn(dictionaries, type) && dictionaries[type]) next.add(dictionaries[type]);
    }
    const fact = lookupKey(expression, index + 1);
    types = (fact ? symbols.get(fact) : undefined) ?? next;
  }
  return types;
}

function scanLiquid(text: string, file: string, bindings: Symbols): Scan {
  const result: Scan = { features: [], refs: [], calls: [], diagnostics: [], complete: true };
  const featureMap = new Map<string, Feature>();
  function add(kind: FeatureKind, name: string, known: boolean, node: LiquidHtmlNode): void {
    const key = `${kind}:${name}`;
    const feature = featureMap.get(key) ?? {
      kind,
      name,
      known,
      registered: false,
      oracleCases: [],
      implemented: false,
      occurrences: [],
    };
    const line = location(node);
    if (!feature.occurrences.some((o) => o.line === line)) feature.occurrences.push({ file, line });
    featureMap.set(key, feature);
  }
  try {
    const ast = toLiquidAST(text, { allowUnclosedDocumentNode: false, mode: "tolerant" });
    const nodes: LiquidHtmlNode[] = [];
    const parents = new WeakMap<LiquidHtmlNode, LiquidHtmlNode>();
    walk(ast, (node, parent) => {
      nodes.push(node);
      if (parent) parents.set(node, parent);
    });
    const environments = variableEnvironments(
      ast,
      {
        lookup: lookupTypes,
        root: (name) => new Set(objectNames.has(name) ? [name] : ["?"]),
        property: propertyReturns,
      },
      bindings,
    );
    let schema: Record<string, unknown> | undefined;
    let rendersBlocks = false;
    for (const node of nodes) {
      if (node.type === NodeTypes.LiquidFilter)
        add("filter", node.name, knownFilters.has(node.name), node);
      if (
        (node.type === NodeTypes.LiquidTag || node.type === NodeTypes.LiquidRawTag) &&
        node.name &&
        node.name !== "#"
      ) {
        add("tag", node.name, knownTags.has(node.name), node);
      }
      if (node.type === NodeTypes.VariableLookup && node.name) {
        const initial =
          environments.get(node)?.get(node.name) ??
          (objectNames.has(node.name) ? new Set([node.name]) : new Set<string>());
        for (const type of initial)
          if (objectNames.has(baseType(type))) add("object", baseType(type), true, node);
        if ((!initial.size || initial.has("?")) && node.lookups.length) {
          result.complete = false;
          result.diagnostics.push(
            diagnostic(
              "unresolved-object",
              file,
              `Cannot statically resolve ${node.name}; snippet arguments and filtered aliases need runtime coverage.`,
              location(node),
            ),
          );
        }
        let types = initial;
        for (const [index, lookup] of node.lookups.entries()) {
          const next = new Set<string>();
          for (const type of types) {
            if (type === "?") {
              next.add("?");
              continue;
            }
            if (Object.hasOwn(dictionaries, type) && dictionaries[type]) {
              next.add(dictionaries[type]);
              add("object", dictionaries[type], true, node);
              continue;
            }
            if (type.endsWith("[]")) {
              if (lookup.type === NodeTypes.String && lookup.value === "size") next.add("number");
              else if (
                lookup.type === NodeTypes.Number ||
                lookup.type === NodeTypes.VariableLookup ||
                (lookup.type === NodeTypes.String && ["first", "last"].includes(lookup.value))
              )
                next.add(type.slice(0, -2));
              continue;
            }
            if (lookup.type === NodeTypes.String) {
              const returns = propertyReturns(type, lookup.value);
              if (returns) {
                add("object-property", `${baseType(type)}.${lookup.value}`, true, node);
                for (const value of returns) next.add(value);
              } else if (
                objectNames.has(baseType(type)) &&
                Object.keys(objects[baseType(type)]?.properties ?? {}).length &&
                !["settings", "metafields", "metaobject"].includes(type)
              ) {
                add("object-property", `${baseType(type)}.${lookup.value}`, false, node);
              }
            } else {
              result.complete = false;
              result.diagnostics.push(
                diagnostic(
                  "dynamic-property",
                  file,
                  `Dynamic lookup on ${type} needs runtime coverage.`,
                  location(node),
                ),
              );
            }
          }
          const key = lookupKey(node, index + 1);
          const resolved = (key ? environments.get(node)?.get(key) : undefined) ?? next;
          if (
            !resolved.size &&
            types.size &&
            ![...types].every((type) => ["string", "number", "boolean", "nil"].includes(type))
          ) {
            result.complete = false;
            result.diagnostics.push(
              diagnostic(
                "unresolved-property",
                file,
                `Cannot statically resolve this property of ${[...types].sort().join(" | ")}; runtime coverage is required.`,
                location(node),
              ),
            );
          }
          types = resolved;
        }
      }
      if (node.type === NodeTypes.LiquidRawTag && node.name === "schema") {
        schema = z.record(z.string(), z.unknown()).parse(parseThemeJson(node.body.value, file));
      }
      // Inline comments (`{% # … %}`, `# …` inside `{% liquid %}`) keep their text as markup.
      if (
        node.type === NodeTypes.LiquidTag &&
        node.name !== "#" &&
        typeof node.markup === "string" &&
        node.markup.trim()
      ) {
        result.complete = false;
        result.diagnostics.push(
          diagnostic(
            "unparsed-tag-markup",
            file,
            `Parser could not resolve markup for ${node.name}.`,
            location(node),
          ),
        );
      }
      if (node.type === NodeTypes.LiquidVariableOutput && typeof node.markup === "string") {
        result.complete = false;
        result.diagnostics.push(
          diagnostic(
            "unparsed-output",
            file,
            "Parser could not resolve this Liquid expression.",
            location(node),
          ),
        );
      }
      if (node.type === NodeTypes.RenderMarkup) {
        if (node.snippet.type === NodeTypes.String) {
          const target = reference("snippets", node.snippet.value, ".liquid");
          const parent = parents.get(node);
          if (parent?.type !== NodeTypes.LiquidTag || parent.name !== "render")
            result.refs.push(target);
          else {
            const caller = environments.get(node) ?? new Map();
            const args: Symbols = new Map();
            for (const argument of node.args) {
              const types = lookupTypes(argument.value, caller);
              args.set(argument.name, types.size ? types : new Set(["?"]));
            }
            if (node.variable) {
              let types = lookupTypes(node.variable.name, caller);
              if (node.variable.kind === "for") {
                types = new Set(
                  [...types].map((type) => (type.endsWith("[]") ? type.slice(0, -2) : type)),
                );
                args.set("forloop", new Set(["forloop"]));
              }
              args.set(
                node.alias?.value ?? node.snippet.value,
                types.size ? types : new Set(["?"]),
              );
            }
            result.calls.push({ file: target, bindings: args });
          }
        } else {
          result.complete = false;
          result.diagnostics.push(
            diagnostic(
              "dynamic-render",
              file,
              "Dynamically named snippet needs runtime coverage.",
              location(node),
            ),
          );
        }
      }
      if (
        node.type === NodeTypes.LiquidTag &&
        node.name === "sections" &&
        typeof node.markup !== "string" &&
        node.markup.type === NodeTypes.String
      )
        result.refs.push(reference("sections", node.markup.value, ".json"));
      if (node.type === NodeTypes.SectionMarkup)
        result.refs.push(reference("sections", node.name.value, ".liquid"));
      if (
        node.type === NodeTypes.LiquidTag &&
        node.name === "layout" &&
        typeof node.markup !== "string"
      ) {
        if (node.markup.type === NodeTypes.String) result.layout = node.markup.value;
        else if (node.markup.type === NodeTypes.LiquidLiteral && node.markup.value === null)
          result.layout = false;
        else {
          result.complete = false;
          result.diagnostics.push(
            diagnostic(
              "dynamic-layout",
              file,
              "Dynamically named layout needs runtime coverage.",
              location(node),
            ),
          );
        }
      }
      if (node.type === NodeTypes.ContentForMarkup) {
        if (node.contentForType.value === "blocks") rendersBlocks = true;
        if (node.contentForType.value === "block") {
          const type = node.args.find((arg) => arg.name === "type")?.value;
          if (type?.type === NodeTypes.String)
            result.refs.push(reference("blocks", type.value, ".liquid"));
          else {
            result.complete = false;
            result.diagnostics.push(
              diagnostic(
                "dynamic-block",
                file,
                "Dynamically named block needs runtime coverage.",
                location(node),
              ),
            );
          }
        }
      }
    }
    if (rendersBlocks && schema?.blocks) {
      const blocks = z.array(z.looseObject({ type: z.string() })).parse(schema.blocks);
      for (const block of blocks) {
        if (block.type === "@theme") result.refs.push("blocks/*");
        else if (block.type === "@app")
          result.diagnostics.push(
            diagnostic("app-placeholder", file, "External app blocks render as placeholders."),
          );
        else result.refs.push(reference("blocks", block.type, ".liquid"));
      }
    }
  } catch (error) {
    result.complete = false;
    result.diagnostics.push(
      diagnostic(
        "liquid-parse-error",
        file,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  result.features = [...featureMap.values()];
  return result;
}

/** No file/network access except through the supplied adapter; usable in a browser bundle. */
export async function checkTheme(
  fs: ThemeFileSystem,
  evidence: readonly ImplementationEvidence[] = [],
): Promise<CheckResult> {
  const files = await fs.listFiles();
  const available = new Set(files);
  const diagnostics: Diagnostic[] = [];
  const pages: CheckResult["pages"] = [];
  const scans = new Map<string, Promise<Scan>>();
  const implementations = new Map(evidence.map((e) => [`${e.kind}:${e.name}`, e]));
  const templates = files.filter(
    (file) =>
      /^templates\/[^/]+\.json$/.test(file) && pageTypes.has(file.slice(10).split(".")[0] ?? ""),
  );
  const vintage = files.filter(
    (file) =>
      /^templates\/[^/]+\.liquid$/.test(file) && pageTypes.has(file.slice(10).split(".")[0] ?? ""),
  );
  const supported = !vintage.length && templates.length > 0;
  for (const file of vintage)
    diagnostics.push(
      diagnostic(
        "unsupported-theme",
        file,
        "Vintage Liquid templates are outside the Online Store 2.0 scope.",
      ),
    );
  if (!templates.length)
    diagnostics.push(
      diagnostic("unsupported-theme", null, "No supported Online Store 2.0 JSON templates found."),
    );

  function contextKey(file: string, bindings: Symbols): string {
    return JSON.stringify([
      file,
      [...bindings]
        .map(([name, types]) => [name, [...types].sort()])
        .sort(([a], [b]) => String(a).localeCompare(String(b), "en")),
    ]);
  }
  async function scan(file: string, bindings: Symbols = new Map()): Promise<Scan> {
    const key = contextKey(file, bindings);
    let cached = scans.get(key);
    if (!cached) {
      cached = (async () => {
        if (file.endsWith(".liquid")) return scanLiquid(await fs.readText(file), file, bindings);
        const document = templateSchema.parse(parseThemeJson(await fs.readText(file), file));
        const result: Scan = { features: [], refs: [], calls: [], diagnostics: [], complete: true };
        if (document.layout !== undefined) result.layout = document.layout;
        function blocks(config: SectionConfig): void {
          for (const id of config.block_order ?? Object.keys(config.blocks ?? {})) {
            const block = config.blocks?.[id];
            if (!block) throw new Error(`${file}: unknown block in block_order: ${id}`);
            if (block.disabled) continue;
            if (block.type.startsWith("shopify://apps/") || block.type === "@app")
              result.diagnostics.push(
                diagnostic(
                  "app-placeholder",
                  file,
                  `External block ${block.type} renders as a placeholder.`,
                ),
              );
            else {
              const path = reference("blocks", block.type, ".liquid");
              if (available.has(path)) result.refs.push(path);
              blocks(block);
            }
          }
        }
        for (const id of document.order) {
          const section = document.sections[id];
          if (!section) throw new Error(`${file}: unknown section in order: ${id}`);
          if (section.disabled) continue;
          result.refs.push(reference("sections", section.type, ".liquid"));
          blocks(section);
        }
        return result;
      })();
      scans.set(key, cached);
    }
    return cached;
  }
  for (const template of templates) {
    const page = {
      pageType: template.slice(10).split(".")[0] ?? "",
      template,
      files: [] as string[],
      features: [] as Feature[],
      unimplementedCount: 0,
      complete: true,
    };
    const visited = new Set<string>();
    const features = new Map<string, Feature>();
    const contexts = new Map<string, Set<string>>();
    async function visit(file: string, bindings: Symbols = new Map()): Promise<void> {
      let key = contextKey(file, bindings);
      const fileContexts = contexts.get(file) ?? new Set<string>();
      if (!fileContexts.has(key) && fileContexts.size >= 256) {
        page.complete = false;
        diagnostics.push(
          diagnostic(
            "context-limit",
            file,
            "Static snippet context limit reached; runtime coverage is required.",
          ),
        );
        bindings = new Map([...bindings].map(([name]) => [name, new Set(["?"])]));
        key = contextKey(file, bindings);
      }
      if (visited.has(key)) return;
      visited.add(key);
      fileContexts.add(key);
      contexts.set(file, fileContexts);
      if (!available.has(file)) {
        page.complete = false;
        diagnostics.push(
          diagnostic("missing-file", file, `Referenced by ${template}, but not present in theme.`),
        );
        return;
      }
      if (!page.files.includes(file)) page.files.push(file);
      const item = await scan(file, bindings);
      page.complete &&= item.complete;
      diagnostics.push(...item.diagnostics);
      for (const feature of item.features) {
        const key = `${feature.kind}:${feature.name}`;
        const entry = features.get(key) ?? { ...feature, occurrences: [] };
        for (const occurrence of feature.occurrences)
          if (
            !entry.occurrences.some(
              (existing) => existing.file === occurrence.file && existing.line === occurrence.line,
            )
          )
            entry.occurrences.push(occurrence);
        features.set(key, entry);
      }
      for (const call of item.calls) await visit(call.file, call.bindings);
      for (const ref of [...new Set(item.refs)].sort()) {
        if (ref === "blocks/*") {
          for (const block of files.filter((f) => /^blocks\/[^/]+\.liquid$/.test(f)))
            await visit(block);
        } else await visit(ref);
      }
    }
    await visit(template);
    const templateScan = await scan(template);
    if (templateScan.layout !== false && templateScan.layout !== null)
      await visit(reference("layout", templateScan.layout ?? "theme", ".liquid"));
    for (const entry of features.values()) {
      const canonical = entry.kind === "filter" ? (aliases[entry.name] ?? entry.name) : entry.name;
      const implementation = implementations.get(`${entry.kind}:${canonical}`);
      entry.registered = implementation?.registered ?? false;
      entry.oracleCases = [...(implementation?.oracleCases ?? [])].sort();
      entry.implemented = isImplemented(implementation);
      entry.occurrences.sort((a, b) => a.file.localeCompare(b.file, "en") || a.line - b.line);
    }
    page.files.sort();
    page.features = [...features.values()].sort((a, b) =>
      `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`, "en"),
    );
    page.unimplementedCount = page.features.filter((f) => !f.implemented).length;
    pages.push(page);
  }
  const unique = new Map<string, Feature>();
  for (const page of pages)
    for (const feature of page.features) unique.set(`${feature.kind}:${feature.name}`, feature);
  return {
    schemaVersion: "1.0",
    supported,
    specCommit: registry.commit,
    pages,
    diagnostics: [...new Map(diagnostics.map((d) => [JSON.stringify(d), d])).values()].sort(
      (a, b) =>
        `${a.file}:${a.line}:${a.code}:${a.message}`.localeCompare(
          `${b.file}:${b.line}:${b.code}:${b.message}`,
          "en",
        ),
    ),
    summary: {
      featureCount: unique.size,
      unimplementedCount: [...unique.values()].filter((f) => !f.implemented).length,
      complete: supported && pages.every((p) => p.complete),
    },
  };
}
