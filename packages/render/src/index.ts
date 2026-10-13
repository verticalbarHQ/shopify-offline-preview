import { NodeTypes, toLiquidAST, walk } from "@shopify/liquid-html-parser";
import {
  Context,
  type Emitter,
  Liquid,
  LiquidError,
  Tag,
  TagToken,
  type Template,
  type TopLevelToken,
  toPromise,
} from "liquidjs";
import { z } from "zod";
import type { Diagnostic } from "../../check/src/contracts.js";
import { defaultFixture } from "../../data/src/fixture.js";
import { type LiquidRecord, liquidObjects } from "../../data/src/objects.js";
import { applyScenario, validateSnapshotReferences } from "../../data/src/scenarios.js";
import { type Snapshot, snapshotSchema } from "../../data/src/schema.js";
import { registry } from "../../spec/src/index.js";
import { parseThemeJson, type ThemeFileSystem, themePath } from "../../theme/src/index.js";
import { registerBasicTags } from "./basic-tags.js";
import { type RenderNode, type RenderResult, renderSchema } from "./contracts.js";
import { registerShopifyFilters } from "./filters/index.js";
import { resolveRoute } from "./routes.js";
import { registerShopifyTags } from "./shopify-tags.js";
import {
  type SectionConfig,
  type SectionSchema,
  sectionConfigSchema,
  sectionSchema,
  settingSchema,
  settingsDataSchema,
  templateConfig,
} from "./theme-config.js";

export { type RenderNode, type RenderResult, renderSchema } from "./contracts.js";
export interface RenderOptions {
  snapshot?: Snapshot;
  scenario?: string;
  designMode?: boolean;
  inspect?: boolean;
}

class SchemaTag extends Tag {
  readonly schema: SectionSchema;
  constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid) {
    super(token, tokens, liquid);
    let body = "";
    let closed = false;
    while (tokens.length) {
      const next = tokens.shift();
      if (next instanceof TagToken && next.name === "endschema") {
        closed = true;
        break;
      }
      if (next) body += next.getText();
    }
    if (!closed) throw new Error("Unclosed schema tag");
    this.schema = sectionSchema.parse(JSON.parse(body));
  }
  render() {
    return "";
  }
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

/** Initial assembly. Shopify fidelity is pending oracle verification; diagnostics expose gaps. */
export async function renderTheme(
  theme: ThemeFileSystem,
  path: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const snapshot = applyScenario(
    snapshotSchema.parse(options.snapshot ?? defaultFixture()),
    options.scenario,
  );
  validateSnapshotReferences(snapshot);
  const route = resolveRoute(snapshot, path);
  const diagnostics: Diagnostic[] = [...route.diagnostics];
  const data = new Map<string, Set<string>>();
  const tree: RenderNode[] = [];
  const stack: RenderNode[] = [];
  let location: { file: string | null; line: number | null } = { file: null, line: null };
  let serial = 0;
  const files = new Map<string, string>();
  const allPaths = new Set(await theme.listFiles());
  const sectionLocales = new Map<string, unknown>();
  for (const file of allPaths)
    if (
      /^(?:layout|templates|sections|blocks|snippets|config|locales)\//.test(file) &&
      /\.(?:liquid|json)$/.test(file)
    )
      files.set(file, await theme.readText(file));
  function sourceFile(file: string | null): string | null {
    if (file === null || files.has(file)) return file;
    const snippet = `snippets/${file}.liquid`;
    return files.has(snippet) ? snippet : file;
  }
  function diagnostic(code: string, message: string, severity: Diagnostic["severity"] = "warning") {
    const entry: Diagnostic = {
      code,
      severity,
      ...location,
      file: sourceFile(location.file),
      nodeId: stack.at(-1)?.id ?? null,
      message,
    };
    if (!diagnostics.some((existing) => JSON.stringify(existing) === JSON.stringify(entry)))
      diagnostics.push(entry);
  }
  function node(
    kind: RenderNode["kind"],
    type: string,
    file: string,
    settingsPath: string | null,
  ): RenderNode {
    return { kind, type, file, settingsPath, id: `sop-${++serial}`, children: [] };
  }
  async function inside<T>(entry: RenderNode, callback: () => Promise<T>): Promise<T> {
    (stack.at(-1)?.children ?? tree).push(entry);
    stack.push(entry);
    const previous = location;
    location = { file: entry.file, line: 1 };
    try {
      return await callback();
    } finally {
      stack.pop();
      location = previous;
    }
  }
  const globals = liquidObjects(
    snapshot,
    {
      pageType: route.pageType,
      path: route.path,
      variant: route.query.variant,
      q: route.query.q,
      sortBy: route.query.sortBy,
      resourceHandle: route.resource?.handle ?? null,
      ...(route.resource?.blogHandle ? { blogHandle: route.resource.blogHandle } : {}),
      designMode: options.designMode ?? false,
    },
    {
      read(dataPath) {
        if (!options.inspect) return;
        const id = stack.at(-1)?.id;
        if (!id) return;
        let paths = data.get(id);
        if (!paths) {
          paths = new Set();
          data.set(id, paths);
        }
        paths.add(dataPath);
      },
      unsupported(type, property) {
        diagnostic(
          "not-implemented",
          `Object property ${type}.${property} is not available offline.`,
        );
      },
    },
  );
  const templates = Object.fromEntries(
    [...files]
      .filter(([file]) => file.startsWith("snippets/") && file.endsWith(".liquid"))
      .map(([file, text]) => [file.slice(9, -7), text]),
  );
  const engine = new Liquid({
    templates,
    globals,
    strictFilters: true,
    ownPropertyOnly: true,
    timezoneOffset: snapshot.shop.timezone,
    locale: snapshot.shop.locale,
    renderLimit: 10000,
    memoryLimit: 100_000_000,
  });
  engine.registerTag("schema", SchemaTag);
  registerBasicTags(engine, (message) => diagnostic("not-implemented", message));
  registerShopifyTags(engine, {
    path: route.path,
    unsupported: (message) => diagnostic("not-implemented", message),
  });
  registerShopifyFilters(engine, {
    snapshot,
    files,
    paths: allPaths,
    sectionLocales() {
      return [...stack]
        .reverse()
        .map((node) => sectionLocales.get(node.id))
        .find((value) => value !== undefined);
    },
    diagnostic(code, message, file, line) {
      const previous = location;
      location = { file: file ?? previous.file, line: line ?? previous.line };
      diagnostic(code, message);
      location = previous;
    },
  });
  const nativeDate = engine.filters.date;
  if (typeof nativeDate === "function")
    engine.registerFilter("date", function (value: unknown, ...args: unknown[]) {
      return nativeDate.call(
        this,
        value === "now" || value === "today" ? snapshot.meta.now : value,
        ...args,
      );
    });
  for (const name of Object.keys(registry.filters)) {
    if (Object.hasOwn(engine.filters, name)) continue;
    engine.registerFilter(name, function () {
      const previous = location;
      location = {
        file: this.token.file ?? previous.file,
        line: this.token.getPosition()[0] ?? previous.line,
      };
      diagnostic("not-implemented", `Filter ${name} is not implemented.`);
      location = previous;
      return `[not implemented: filter ${name}]`;
    });
  }
  for (const [alias, name] of Object.entries(registry.aliases)) {
    const filter = engine.filters[name];
    if (filter) engine.registerFilter(alias, filter);
  }
  const nativeRender = engine.tags.render;
  if (nativeRender)
    engine.registerTag(
      "render",
      class extends nativeRender {
        override async render(context: Context, emitter: Emitter) {
          const match = /^\s*(['"])([^'"]+)\1(?:\s|,|$)/.exec(this.token.args);
          if (!match) {
            diagnostic("not-implemented", "Dynamic snippet references are not implemented.");
            return "[not implemented: dynamic render]";
          }
          const name = match[2] ?? "";
          const file = themePath(`snippets/${name}.liquid`);
          return inside(node("snippet", name, file, null), async () => {
            try {
              // toPromise is the documented runner for public generator-based tag extensions.
              return await toPromise(nativeRender.prototype.render.call(this, context, emitter));
            } catch (error) {
              emitter.write(liquidError(error, file, this.token.getPosition()[0] ?? 1));
            }
          });
        }
      },
    );
  function liquidError(error: unknown, file: string, line: number): string {
    if (LiquidError.is(error)) {
      file = sourceFile(error.token.file ?? file) ?? file;
      line = error.token.getPosition()[0] ?? line;
    }
    const detail = LiquidError.is(error) ? (error.originalError ?? error) : error;
    const message =
      detail instanceof Error ? (detail.message.split("\n")[0] ?? "Liquid error") : "Liquid error";
    const previous = location;
    location = { file, line };
    diagnostic("liquid-error", message, "error");
    location = previous;
    return `Liquid error (${escapeHtml(file)} line ${line}): ${escapeHtml(message)}`;
  }
  function source(file: string): string {
    const text = files.get(themePath(file));
    if (text === undefined) throw new Error(`Theme file not found: ${file}`);
    return text;
  }
  function parse(file: string): Template[] {
    return engine.parse(source(file), file);
  }
  async function renderFile(file: string, context: Context): Promise<string> {
    let parsed: Template[];
    try {
      parsed = parse(file);
    } catch (error) {
      return liquidError(error, file, 1);
    }
    let html = "";
    for (const template of parsed) {
      const previous = location;
      location = { file, line: template.token.getPosition()[0] ?? 1 };
      try {
        html += await engine.render([template], context);
      } catch (error) {
        html += liquidError(error, file, location.line ?? 1);
      } finally {
        location = previous;
      }
    }
    return html;
  }
  function settings(
    definitions: z.infer<typeof settingSchema>[],
    configured: LiquidRecord,
  ): LiquidRecord {
    const result: LiquidRecord = { ...configured };
    for (const definition of definitions) {
      if (!definition.id) continue;
      const key = definition.id;
      const raw = Object.hasOwn(configured, key) ? configured[key] : definition.default;
      if (typeof raw === "string" && raw.includes("{{")) {
        result[key] = null;
        diagnostic(
          "not-implemented",
          `Dynamic source resolution for setting ${key} is not implemented.`,
        );
        continue;
      }
      const resource = {
        product: "all_products",
        collection: "collections",
        page: "pages",
        blog: "blogs",
        link_list: "linklists",
      }[definition.type];
      if (resource) {
        const dictionary = globals[resource];
        result[key] =
          typeof raw === "string" &&
          dictionary &&
          typeof dictionary === "object" &&
          Object.hasOwn(dictionary, raw)
            ? Reflect.get(dictionary, raw)
            : null;
        if (raw && result[key] === null)
          diagnostic(
            "missing-resource",
            `Setting ${key} references a resource absent from the snapshot.`,
          );
      } else if (
        [
          "image_picker",
          "video",
          "video_url",
          "font_picker",
          "product_list",
          "collection_list",
          "metaobject",
          "metaobject_list",
          "color_scheme",
          "color_scheme_group",
        ].includes(definition.type)
      ) {
        result[key] = null;
        if (raw)
          diagnostic("not-implemented", `Setting type ${definition.type} is not implemented.`);
      } else result[key] = raw ?? null;
    }
    return result;
  }
  let settingsConfig: LiquidRecord = {};
  if (files.has("config/settings_data.json")) {
    const config = settingsDataSchema.parse(
      parseThemeJson(source("config/settings_data.json"), "config/settings_data.json"),
    );
    if (typeof config.current === "string") {
      if (!config.presets || !Object.hasOwn(config.presets, config.current))
        throw new Error("Selected settings preset is missing");
      settingsConfig = config.presets[config.current] ?? {};
    } else settingsConfig = config.current;
  }
  const definitions = files.has("config/settings_schema.json")
    ? z
        .array(z.object({ settings: z.array(settingSchema).default([]) }).passthrough())
        .parse(parseThemeJson(source("config/settings_schema.json"), "config/settings_schema.json"))
        .flatMap((group) => group.settings)
    : [];
  globals.settings = settings(definitions, settingsConfig);
  Object.defineProperty(globals, "content_for_header", {
    get() {
      diagnostic(
        "shopify-server-only",
        "Shopify's content_for_header scripts are omitted.",
        "info",
      );
      return "";
    },
  });
  globals.template = {
    name: route.pageType,
    suffix: route.template.slice(10, -5).split(".")[1] ?? null,
  };
  globals.current_page = Number(route.query.page ?? 1);
  for (const property of ["page_title", "search"])
    Object.defineProperty(globals, property, {
      get() {
        diagnostic("not-implemented", `Global ${property} derivation is not implemented.`);
        return null;
      },
    });
  async function section(
    id: string,
    config: SectionConfig,
    configFile: string,
    groupType?: string,
  ): Promise<string> {
    const file = themePath(`sections/${config.type}.liquid`);
    const pointer = id.replaceAll("~", "~0").replaceAll("/", "~1");
    const entry = node("section", config.type, file, `${configFile}#/sections/${pointer}`);
    return inside(entry, async () => {
      let schema: SectionSchema = sectionSchema.parse({});
      let schemaFailure: string | undefined;
      try {
        // Schema extraction must not depend on support for the section's executable tags.
        const schemas: SectionSchema[] = [];
        walk(toLiquidAST(source(file)), (node, parent) => {
          if (node.type !== NodeTypes.LiquidRawTag || node.name !== "schema") return;
          if (parent?.type !== NodeTypes.Document) throw new Error("Schema tag must be top-level");
          schemas.push(sectionSchema.parse(JSON.parse(node.body.value)));
        });
        if (schemas.length > 1) throw new Error("More than one schema tag");
        schema = schemas[0] ?? sectionSchema.parse({});
      } catch (error) {
        schemaFailure = liquidError(error, file, 1);
      }
      sectionLocales.set(entry.id, schema.locales);
      const blocks = (config.block_order ?? Object.keys(config.blocks)).flatMap((blockId) => {
        const configBlock = config.blocks[blockId];
        if (!configBlock || configBlock.disabled) return [];
        const schemaBlock = schema.blocks.find((block) => block.type === configBlock.type);
        if (!schemaBlock)
          diagnostic(
            "not-implemented",
            `Block type ${configBlock.type} has no classic block schema.`,
          );
        // Block tree tracing is deferred until actual block execution is instrumented.
        diagnostic("not-implemented", "Classic block execution tracing is not implemented.");
        return [
          {
            id: blockId,
            type: configBlock.type,
            settings: settings(schemaBlock?.settings ?? [], configBlock.settings),
            shopify_attributes: "",
          },
        ];
      });
      const sectionId = groupType
        ? `sections--0__${id}`
        : configFile.startsWith("templates/")
          ? `template--0__${id}`
          : id;
      const sectionData = {
        id: sectionId,
        settings: settings(schema.settings, config.settings),
        blocks,
        index: null,
        location: groupType ?? "template",
      };
      const sectionGlobals = Object.defineProperties({}, Object.getOwnPropertyDescriptors(globals));
      Object.defineProperty(sectionGlobals, "section", { value: sectionData, enumerable: true });
      const context = new Context({ section: sectionData }, engine.options, {
        globals: sectionGlobals,
      });
      const body = schemaFailure ?? (await renderFile(file, context));
      const tag = schema.tag ?? "div";
      if (!/^(?:div|section|header|footer|aside|article)$/.test(tag))
        throw new Error("Unsupported section wrapper tag");
      const classes = [
        "shopify-section",
        ...(groupType ? [`shopify-section-group-${groupType}-group`] : []),
        ...(schema.class ? [schema.class] : []),
      ].join(" ");
      return `<${tag} id="shopify-section-${escapeHtml(sectionId)}" class="${escapeHtml(classes)}">${body}</${tag}>`;
    });
  }
  async function assembly(file: string, groupType?: string): Promise<string> {
    const config = templateConfig(source(file), file);
    let result = "";
    for (const id of config.order) {
      const configured = config.sections[id];
      if (configured && !configured.disabled)
        result += await section(id, configured, file, groupType);
    }
    return result;
  }
  engine.registerTag(
    "section",
    class extends Tag {
      async render() {
        const value: unknown = await engine.evalValue(this.token.args);
        if (typeof value !== "string") throw new Error("Section requires a string name");
        const configured = settingsConfig.sections;
        const record =
          configured && typeof configured === "object" && Object.hasOwn(configured, value)
            ? Reflect.get(configured, value)
            : {};
        return section(
          value,
          sectionConfigSchema.parse({
            ...(record && typeof record === "object" ? record : {}),
            type: value,
          }),
          "config/settings_data.json",
        );
      }
    },
  );
  engine.registerTag(
    "sections",
    class extends Tag {
      async render() {
        const value: unknown = await engine.evalValue(this.token.args);
        if (typeof value !== "string") throw new Error("Sections requires a string name");
        const file = themePath(`sections/${value}.json`);
        const config = templateConfig(source(file), file);
        return inside(node("section-group", value, file, file), () =>
          assembly(file, config.type ?? value),
        );
      }
    },
  );
  const config = templateConfig(source(route.template), route.template);
  let html: string;
  if (config.layout === false) html = await assembly(route.template);
  else {
    const layout = config.layout ?? "theme";
    const file = themePath(`layout/${layout}.liquid`);
    source(file); // An absent outer layout is fatal; individual section errors remain inline.
    html = await inside(node("layout", layout, file, null), async () => {
      let content: Promise<string> | undefined;
      Object.defineProperty(globals, "content_for_layout", {
        get() {
          content ??= assembly(route.template);
          return content;
        },
      });
      return renderFile(file, new Context(globals, engine.options));
    });
  }
  return renderSchema.parse({
    schemaVersion: "1.0",
    html,
    tree,
    diagnostics,
    dataUsed: Object.fromEntries([...data].map(([id, paths]) => [id, [...paths].sort()])),
    route: { path: route.path, pageType: route.pageType, template: route.template },
  });
}
