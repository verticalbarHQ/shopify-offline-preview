import { NodeTypes, toLiquidAST, walk } from "@shopify/liquid-html-parser";
import {
  AssignTag,
  type Context,
  Liquid,
  LiquidError,
  Tag,
  TagToken,
  type Template,
  type TopLevelToken,
} from "liquidjs";
import { z } from "zod";
import type { Diagnostic } from "../../check/src/contracts.js";
import { defaultFixture } from "../../data/src/fixture.js";
import { ImageDirectory, NamedImageDrop } from "../../data/src/images.js";
import {
  imageObject,
  type LiquidRecord,
  liquidObjectKind,
  liquidObjects,
  type ObjectHooks,
  objectTracker,
  ScalarDrop,
} from "../../data/src/objects.js";
import { applyScenario, validateSnapshotReferences } from "../../data/src/scenarios.js";
import { type Snapshot, snapshotSchema } from "../../data/src/schema.js";
import { registry } from "../../spec/src/index.js";
import { parseThemeJson, type ThemeFileSystem, themePath } from "../../theme/src/index.js";
import { appendAppEmbeds, appIdentity, appMarkup } from "./apps.js";
import { ThemeAssetBundles } from "./asset-bundles.js";
import { registerBasicTags } from "./basic-tags.js";
import { ColorScheme, ColorSchemeGroup, colorPalette, colorSetting } from "./color-settings.js";
import { registerContentFor } from "./content-for.js";
import { type RenderNode, type RenderResult, renderSchema } from "./contracts.js";
import { registerCycleTag } from "./cycle-tag.js";
import { ImageUrlInputError } from "./filters/images.js";
import { registerShopifyFilters } from "./filters/index.js";
import { schemaDefaultFactory, translateFactory } from "./filters/translations.js";
import { fontSetting } from "./fonts.js";
import { registerIncludeTag } from "./include-tag.js";
import { registerSnapshotHashes } from "./json-hashes.js";
import { registerLoopTrace } from "./loop-trace.js";
import { evalNumericValue } from "./numbers.js";
import { registerPageMetadata } from "./page-metadata.js";
import { parseLiquid } from "./parse-liquid.js";
import { PreviewContext } from "./preview-context.js";
import { registerRenderTag } from "./render-tag.js";
import { resolveRoute } from "./routes.js";
import { registerShopifyTags } from "./shopify-tags.js";
import {
  type NestedBlockConfig,
  nestedBlockConfigSchema,
  type SectionConfig,
  type SectionSchema,
  sectionConfigSchema,
  sectionSchema,
  settingSchema,
  settingsDataSchema,
  templateConfig,
  themeBlockSchema,
} from "./theme-config.js";

export { type RenderNode, type RenderResult, renderSchema } from "./contracts.js";
export interface RenderOptions {
  snapshot?: Snapshot;
  scenario?: string;
  designMode?: boolean;
  inspect?: boolean;
}

class SchemaTag extends Tag {
  readonly schema: SectionSchema | z.infer<typeof themeBlockSchema>;
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
    this.schema = (token.file?.startsWith("blocks/") ? themeBlockSchema : sectionSchema).parse(
      JSON.parse(body),
    );
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

let engineObserver: ((engine: Liquid, stubbed: ReadonlySet<string>) => void) | undefined;
/** Runs `run` while reporting each render's configured engine and its stub filters. */
export async function observeEngines<T>(
  observe: (engine: Liquid, stubbed: ReadonlySet<string>) => void,
  run: () => Promise<T>,
): Promise<T> {
  const previous = engineObserver;
  engineObserver = observe;
  try {
    return await run();
  } finally {
    engineObserver = previous;
  }
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
  registerSnapshotHashes(snapshot);
  const data = new Map<string, Set<string>>();
  const tree: RenderNode[] = [];
  const stack: RenderNode[] = [];
  let location: { file: string | null; line: number | null } = { file: null, line: null };
  let serial = 0;
  const files = new Map<string, string>();
  const allPaths = new Set(await theme.listFiles());
  const route = resolveRoute(snapshot, path, (file) => allPaths.has(file));
  const diagnostics: Diagnostic[] = [...route.diagnostics];
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
  function diagnostic(
    code: string,
    message: string,
    severity: Diagnostic["severity"] = code === "shopify-server-only" ? "info" : "warning",
  ) {
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
    if (stack.length >= 100) throw new Error("Nesting too deep");
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
  interface BlockOwner {
    config: { blocks: Record<string, unknown>; block_order?: string[] | undefined };
    pointer: string;
    section: LiquidRecord;
    prefix: string;
  }
  const blockOwners = new WeakMap<object, BlockOwner>();
  const appBlocks = new WeakMap<object, { type: string; file: string; pointer: string }>();
  const classicBlocks = new WeakMap<object, { type: string; file: string; pointer: string }>();
  function object(value: unknown): value is LiquidRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function readSnapshot(dataPath: string) {
    if (!options.inspect) return;
    const id = stack.at(-1)?.id;
    if (!id) return;
    let paths = data.get(id);
    if (!paths) {
      paths = new Set();
      data.set(id, paths);
    }
    paths.add(dataPath);
  }
  const objectHooks: ObjectHooks = {
    read: readSnapshot,
    unsupportedOperation(message) {
      diagnostic("not-implemented", message);
    },
    missing(message) {
      diagnostic("missing-resource", message);
    },
    unsupported(type, property) {
      diagnostic(
        "not-implemented",
        `Object property ${type}.${property} is not available offline.`,
      );
    },
    color: (value) => colorSetting(value, (message) => diagnostic("not-implemented", message)),
    serverOnly: (message) => diagnostic("shopify-server-only", message, "info"),
  };
  // Documented objects built during rendering share the snapshot objects' diagnostics.
  const track = objectTracker(objectHooks);
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
    objectHooks,
    track,
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
  engine.registerTag(
    "assign",
    class extends AssignTag {
      override *render(context: Context) {
        try {
          return yield* super.render(context);
        } catch (error) {
          const detail = LiquidError.is(error) ? (error.originalError ?? error) : error;
          if (!(detail instanceof ImageUrlInputError)) throw error;
          // Failed image assignments leave the previous binding intact, or undefined if new.
        }
      }
    },
  );
  registerLoopTrace(
    engine,
    async (value, _token, safeRegion, render) => {
      const info = object(value) ? classicBlocks.get(value) : undefined;
      if (!info) return render();
      const entry = node("block", info.type, info.file, info.pointer);
      return inside(entry, async () => {
        const body = await render();
        if (!safeRegion) return body;
        return `<!--sop:region ${entry.id}-->${body}<!--/sop:region-->`;
      });
    },
    (error, token) =>
      liquidError(error, token.file ?? "layout/theme.liquid", token.getPosition()[0] ?? 1),
  );
  const assetBundles = new ThemeAssetBundles(files, snapshot);
  registerBasicTags(engine);
  registerCycleTag(engine);
  registerShopifyTags(engine, {
    path: route.path,
    track,
    unsupported: (message) => diagnostic("not-implemented", message),
    paginationOverlay(original, overlay) {
      const owner = blockOwners.get(original);
      if (owner)
        blockOwners.set(overlay, {
          ...owner,
          section: owner.section === original ? overlay : owner.section,
        });
      const classic = classicBlocks.get(original);
      if (classic) classicBlocks.set(overlay, classic);
      const app = appBlocks.get(original);
      if (app) appBlocks.set(overlay, app);
    },
  });
  const assetBytes = new Map<string, Promise<Uint8Array>>();
  registerShopifyFilters(engine, {
    snapshot,
    readData: readSnapshot,
    files,
    paths: allPaths,
    readAsset(path) {
      let bytes = assetBytes.get(path);
      if (!bytes) {
        bytes = theme.readBytes(path);
        assetBytes.set(path, bytes);
      }
      return bytes;
    },
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
  registerContentFor(engine, async (kind, args, context) => {
    const currentBlock: unknown = context.getSync(["block"]),
      currentSection: unknown = context.getSync(["section"]);
    const owner = object(currentBlock) ? blockOwners.get(currentBlock) : undefined;
    const parent = owner ?? (object(currentSection) ? blockOwners.get(currentSection) : undefined);
    if (!parent) throw new Error("content_for is outside a section or theme block");
    if (kind === "block") {
      if (typeof args.id !== "string" || !args.id || typeof args.type !== "string" || !args.type)
        throw new Error("Static content_for requires an id and type");
      const configured = Object.hasOwn(parent.config.blocks, args.id)
        ? parent.config.blocks[args.id]
        : undefined;
      const config = nestedBlockConfigSchema.parse(configured ?? { type: args.type });
      if (config.type !== args.type)
        throw new Error("Static block type differs from its configured type");
      return themeBlock(args.id, config, parent, context, args, configured !== undefined);
    }
    const order = parent.config.block_order ?? Object.keys(parent.config.blocks);
    if (
      new Set(order).size !== order.length ||
      order.some((id) => !Object.hasOwn(parent.config.blocks, id))
    )
      throw new Error("Invalid theme block order");
    let output = "";
    for (const id of order) {
      const config = nestedBlockConfigSchema.parse(parent.config.blocks[id]);
      if (!config.static && !config.disabled)
        output += await themeBlock(id, config, parent, context, args, true);
    }
    return output;
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
  const stubbed = new Set<string>();
  for (const name of Object.keys(registry.filters)) {
    if (Object.hasOwn(engine.filters, name)) continue;
    stubbed.add(name);
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
  registerRenderTag(
    engine,
    (name, context) => renderFile(themePath(`snippets/${name}.liquid`), context),
    () => {
      diagnostic("not-implemented", "Dynamic snippet references are not implemented.");
      return "[not implemented: dynamic render]";
    },
    (name, run) => inside(node("snippet", name, themePath(`snippets/${name}.liquid`), null), run),
    async (value) => {
      const info = object(value) ? appBlocks.get(value) : undefined;
      if (!info) return null;
      if (stack.some((n) => n.kind === "block" && n.settingsPath === info.pointer))
        return placeholder(info.type);
      return appBlock(info.type, info.file, info.pointer);
    },
  );
  registerIncludeTag(
    engine,
    (name, context) => renderFile(themePath(`snippets/${name}.liquid`), context),
    (name, run) => inside(node("snippet", name, themePath(`snippets/${name}.liquid`), null), run),
  );
  function placeholder(type: string): string {
    const names = appIdentity(type);
    diagnostic(
      "app-placeholder",
      `External app ${names?.app} / ${names?.block} is not available offline.`,
      "info",
    );
    return appMarkup(type);
  }
  async function appBlock(type: string, file: string, pointer: string | null): Promise<string> {
    const entry = node("block", "@app", file, pointer);
    return inside(
      entry,
      async () => `<!--sop:region ${entry.id}-->${placeholder(type)}<!--/sop:region-->`,
    );
  }
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
  const parsedFiles = new Map<string, Template[]>();
  function parse(file: string): Template[] {
    let parsed = parsedFiles.get(file);
    if (!parsed) {
      parsed = parseLiquid(engine, source(file), file, (error, token) => {
        liquidError(error, token.file ?? file, token.getPosition()[0] ?? 1);
      });
      parsedFiles.set(file, parsed);
    }
    return parsed;
  }
  async function renderFile(file: string, context: Context): Promise<string> {
    let parsed: Template[];
    try {
      assetBundles.use(file);
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
      if (context.breakCalled || context.continueCalled) break;
    }
    return html;
  }
  function imageSetting(value: unknown, key: string): unknown {
    if (value === null || value === undefined || value === "") return null;
    if (
      value instanceof NamedImageDrop ||
      (object(value) && typeof value.src === "string" && value.src.startsWith("/sop/images/"))
    )
      return value;
    let filename = typeof value === "string" ? value : "";
    if (filename.startsWith("shopify://shop_images/")) {
      try {
        filename = decodeURIComponent(filename.slice("shopify://shop_images/".length));
      } catch {
        filename = "";
      }
    }
    const directory = globals.images;
    const image =
      directory instanceof ImageDirectory ? directory.liquidMethodMissing(filename) : null;
    if (image instanceof NamedImageDrop) return image;
    diagnostic("missing-resource", `Setting ${key} references an image absent from the snapshot.`);
    return null;
  }
  /** Theme-editor resource URIs resolve to storefront paths; absent resources resolve to nil. */
  function urlSetting(value: unknown, key: string): unknown {
    if (typeof value !== "string" || !value.startsWith("shopify://")) return value ?? null;
    const parts = value.slice("shopify://".length).split("/");
    let decoded: string[];
    try {
      decoded = parts.map(decodeURIComponent);
    } catch {
      decoded = [];
    }
    const [namespace, handle = "", child] = decoded;
    const dictionary =
      { products: "all_products", collections: "collections", pages: "pages", blogs: "blogs" }[
        namespace ?? ""
      ] ?? null;
    if (!dictionary || decoded.length > (namespace === "blogs" ? 3 : 2)) {
      diagnostic("not-implemented", `Setting ${key} uses an unsupported resource URL ${value}.`);
      return null;
    }
    const resource =
      namespace === "blogs" && child !== undefined
        ? articleSetting(`${handle}/${child}`, key)
        : lookup(dictionary, handle);
    if (resource === null) {
      if (!(namespace === "blogs" && child !== undefined))
        diagnostic(
          "missing-resource",
          `Setting ${key} references a resource absent from the snapshot.`,
        );
      return null;
    }
    return object(resource) ? (resource.url ?? null) : null;
  }
  function lookup(dictionaryName: string, handle: string): unknown {
    const dictionary = globals[dictionaryName];
    return object(dictionary) && Object.hasOwn(dictionary, handle)
      ? Reflect.get(dictionary, handle)
      : null;
  }
  /** Article settings store `<blog handle>/<article handle>`. */
  function articleSetting(value: unknown, key: string): unknown {
    const [blogHandle = "", articleHandle, extra] =
      typeof value === "string" ? value.split("/") : [];
    const blog =
      articleHandle !== undefined && extra === undefined ? lookup("blogs", blogHandle) : null;
    const articles = object(blog) ? blog.articles : null;
    const article = Array.isArray(articles)
      ? articles.find((entry) => object(entry) && entry.handle === articleHandle)
      : undefined;
    if (article !== undefined) return article;
    diagnostic(
      "missing-resource",
      `Setting ${key} references a resource absent from the snapshot.`,
    );
    return null;
  }
  /** YouTube and Vimeo URLs expose their video `id` and `type`, and output the URL. */
  function videoUrlSetting(raw: unknown, key: string): unknown {
    if (typeof raw !== "string" || !raw) return null;
    let video: { id: string; type: string } | null = null;
    try {
      const url = new URL(raw);
      const host = url.hostname.replace(/^(?:www|m)\./, "");
      const path = url.pathname.split("/").filter(Boolean);
      if (host === "youtube.com" && path[0] === "watch" && url.searchParams.get("v"))
        video = { id: url.searchParams.get("v") ?? "", type: "youtube" };
      else if (host === "youtube.com" && ["embed", "shorts"].includes(path[0] ?? "") && path[1])
        video = { id: path[1], type: "youtube" };
      else if (host === "youtu.be" && path[0]) video = { id: path[0], type: "youtube" };
      else if (host === "vimeo.com" && /^\d+$/.test(path[0] ?? ""))
        video = { id: path[0] ?? "", type: "vimeo" };
      else if (host === "player.vimeo.com" && path[0] === "video" && /^\d+$/.test(path[1] ?? ""))
        video = { id: path[1] ?? "", type: "vimeo" };
    } catch {
      video = null;
    }
    if (!video) {
      diagnostic("not-implemented", `Setting ${key} is not a recognized YouTube or Vimeo URL.`);
      return raw;
    }
    return track(new ScalarDrop(video, raw), "video_url");
  }
  let globalSettingsContext: Context;
  const colorGroups = new Map<string, ColorSchemeGroup>();
  const schemaDefault = schemaDefaultFactory(files, snapshot.shop.locale);
  function settings(
    definitions: z.infer<typeof settingSchema>[],
    configured: LiquidRecord,
    dynamicContext?: () => Context,
    resourceContext?: () => Context,
  ): LiquidRecord {
    const result: LiquidRecord = { ...configured };
    for (const definition of definitions) {
      if (!definition.id) continue;
      const key = definition.id;
      const raw = Object.hasOwn(configured, key)
        ? configured[key]
        : schemaDefault(definition.default);
      // A `liquid` setting holds code that renders in its section or block scope when read.
      if (definition.type === "liquid" && typeof raw === "string" && raw) {
        if (!dynamicContext) {
          result[key] = null;
          diagnostic("not-implemented", `Liquid setting ${key} cannot render in this scope.`);
          continue;
        }
        // Each read renders in a child scope: assignments and loop control stay inside the
        // setting, and a reference back to it fails once nesting is impossible to resolve.
        let depth = 0;
        Object.defineProperty(result, key, {
          enumerable: true,
          configurable: true,
          get() {
            if (depth >= 3) throw new Error("Cyclic Liquid setting reference");
            depth++;
            try {
              const templates = parseLiquid(engine, raw, `settings.${key}`, (error, token) => {
                liquidError(error, token.file ?? `settings.${key}`, token.getPosition()[0] ?? 1);
              });
              return engine.render(templates, dynamicContext().spawn()).finally(() => {
                depth--;
              });
            } catch (error) {
              depth--;
              throw error;
            }
          },
        });
        continue;
      }
      if (typeof raw === "string" && raw.includes("{%")) {
        result[key] = null;
        diagnostic("not-implemented", `Liquid logic in setting ${key} is unsupported.`);
        continue;
      }
      if (typeof raw === "string" && raw.includes("{{")) {
        if (!dynamicContext || raw.includes("{%")) {
          result[key] = null;
          diagnostic(
            "not-implemented",
            `Dynamic source resolution for setting ${key} is not implemented in this scope.`,
          );
          continue;
        }
        let resolving = false;
        Object.defineProperty(result, key, {
          enumerable: true,
          configurable: true,
          get() {
            if (resolving) throw new Error("Cyclic dynamic setting reference");
            resolving = true;
            const context =
              resourceContext && ["product", "collection", "page", "blog"].includes(definition.type)
                ? resourceContext()
                : dynamicContext();
            const single = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(raw);
            const resolved = single
              ? evalNumericValue(engine, single[1] ?? "", context)
              : engine.render(
                  parseLiquid(engine, raw, `settings.${key}`, (error, token) => {
                    liquidError(
                      error,
                      token.file ?? `settings.${key}`,
                      token.getPosition()[0] ?? 1,
                    );
                  }),
                  context,
                );
            return resolved
              .then((value) =>
                definition.type === "color"
                  ? colorSetting(value, (message) => diagnostic("not-implemented", message))
                  : definition.type === "font_picker"
                    ? fontSetting(value, (message) => diagnostic("not-implemented", message))
                    : definition.type === "image_picker"
                      ? imageSetting(value, key)
                      : value,
              )
              .finally(() => {
                resolving = false;
              });
          },
        });
        continue;
      }
      if (definition.type === "color_palette") {
        result[key] = colorPalette(
          key,
          definition.default,
          Object.hasOwn(configured, key) ? configured[key] : undefined,
          (message) => diagnostic("not-implemented", message),
        );
        continue;
      }
      if (definition.type === "color_background") {
        result[key] = raw ?? "";
        continue;
      }
      if (definition.type === "color") {
        result[key] = colorSetting(raw, (message) => diagnostic("not-implemented", message));
        continue;
      }
      if (definition.type === "font_picker") {
        result[key] = fontSetting(raw, (message) => diagnostic("not-implemented", message));
        continue;
      }
      if (definition.type === "color_scheme_group") {
        result[key] = colorGroups.get(key) ?? new ColorSchemeGroup([]);
        continue;
      }
      if (definition.type === "color_scheme") {
        const groups = [...colorGroups.values()];
        const all = groups.flatMap((g) => g.valueOf());
        result[key] =
          all.find((s) => s.id === raw) ??
          all.find((s) => s.id === definition.default) ??
          all[0] ??
          null;
        continue;
      }
      if (definition.type === "image_picker") {
        result[key] = imageSetting(raw, key);
        continue;
      }
      if (definition.type === "url") {
        result[key] = urlSetting(raw, key);
        continue;
      }
      if (definition.type === "article") {
        result[key] = raw ? articleSetting(raw, key) : null;
        continue;
      }
      if (["collection_list", "product_list"].includes(definition.type)) {
        const dictionary =
          globals[definition.type === "collection_list" ? "collections" : "all_products"];
        const resources = (Array.isArray(raw) ? raw : []).flatMap((handle) => {
          if (typeof handle === "string" && object(dictionary) && Object.hasOwn(dictionary, handle))
            return [Reflect.get(dictionary, handle)];
          diagnostic(
            "missing-resource",
            `Setting ${key} references a resource absent from the snapshot.`,
          );
          return [];
        });
        result[key] = Object.defineProperty(resources, "count", { get: () => resources.length });
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
      } else if (definition.type === "video_url") result[key] = videoUrlSetting(raw, key);
      else if (["video", "metaobject", "metaobject_list"].includes(definition.type)) {
        result[key] = null;
        if (raw)
          diagnostic("not-implemented", `Setting type ${definition.type} is not implemented.`);
      } else result[key] = raw ?? null;
    }
    return result;
  }
  let settingsConfig: LiquidRecord = {};
  function closestSettings(
    definitions: z.infer<typeof settingSchema>[],
    resolved: LiquidRecord,
    inherited: unknown,
  ): LiquidRecord {
    const parent = object(inherited) ? inherited : {};
    const closest = Object.defineProperties({}, Object.getOwnPropertyDescriptors(parent));
    const assigned = new Set<string>();
    for (const definition of definitions) {
      const key = definition.id;
      const type = definition.type;
      if (!key || !["product", "collection", "page", "blog"].includes(type) || assigned.has(type))
        continue;
      assigned.add(type);
      Object.defineProperty(closest, type, {
        enumerable: true,
        configurable: true,
        get() {
          return resolved[key];
        },
      });
    }
    return closest;
  }
  let settingsPointer = "config/settings_data.json#/current";
  if (files.has("config/settings_data.json")) {
    const config = settingsDataSchema.parse(
      parseThemeJson(source("config/settings_data.json"), "config/settings_data.json"),
    );
    if (typeof config.current === "string") {
      if (!config.presets || !Object.hasOwn(config.presets, config.current))
        throw new Error("Selected settings preset is missing");
      settingsConfig = config.presets[config.current] ?? {};
      settingsPointer = `config/settings_data.json#/presets/${config.current.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    } else settingsConfig = config.current;
  }
  const definitions = files.has("config/settings_schema.json")
    ? z
        .array(z.object({ settings: z.array(settingSchema).default([]) }).passthrough())
        .parse(parseThemeJson(source("config/settings_schema.json"), "config/settings_schema.json"))
        .flatMap((group) => group.settings)
    : [];
  if (definitions.filter((d) => d.type === "color_palette").length > 1)
    throw new Error("A theme can define only one color palette");
  for (const definition of definitions) {
    if (definition.type !== "color_scheme_group" || !definition.id) continue;
    const fields = z.array(settingSchema).parse(definition.definition ?? []);
    const entries = z
      .record(
        z.string(),
        z.object({ settings: z.record(z.string(), z.unknown()).default({}) }).passthrough(),
      )
      .parse(settingsConfig[definition.id] ?? {});
    colorGroups.set(
      definition.id,
      new ColorSchemeGroup(
        Object.entries(entries).map(
          ([id, value]) =>
            new ColorScheme(
              id,
              settings(fields, value.settings, () => globalSettingsContext),
            ),
        ),
      ),
    );
  }
  globals.settings = settings(definitions, settingsConfig, () => globalSettingsContext);
  globalSettingsContext = new PreviewContext({}, engine.options, { globals });
  Object.defineProperty(globals, "content_for_header", {
    get() {
      diagnostic(
        "shopify-server-only",
        "Shopify's content_for_header scripts are omitted.",
        "info",
      );
      return assetBundles.header();
    },
  });
  const templateSuffix = route.template.slice(10, -5).split(".")[1] ?? null;
  globals.template = track(
    new ScalarDrop(
      { name: route.pageType, suffix: templateSuffix, directory: null },
      templateSuffix ? `${route.pageType}.${templateSuffix}` : route.pageType,
    ),
    "template",
  );
  globals.current_page = Number(route.query.page ?? 1);
  const systemText = translateFactory(files, snapshot.shop.locale, () => undefined);
  Object.defineProperty(globals, "powered_by_link", {
    enumerable: true,
    get() {
      if (snapshot.shop.locale.split("-")[0] !== "en")
        diagnostic(
          "not-implemented",
          "Localized Shopify marketing URLs are unavailable; the default Shopify URL is used.",
        );
      const label = systemText("shopify.links.powered_by_shopify", [], (key) =>
        diagnostic("missing-resource", `Translation ${key} is missing.`),
      );
      return `<a target="_blank" rel="nofollow" href="https://www.shopify.com?utm_campaign=poweredby&amp;utm_medium=shopify&amp;utm_source=onlinestore">${label}</a>`;
    },
  });
  registerPageMetadata(globals, snapshot, route, {
    read: readSnapshot,
    unsupported: (message) => diagnostic("not-implemented", message),
    missing: (message) => diagnostic("missing-resource", message),
    image: (value, path) => imageObject(value, path, track),
  });
  async function section(
    id: string,
    config: SectionConfig,
    configFile: string,
    groupType?: string,
    index: number | null = null,
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
      let sectionContext: Context;
      const blocks = (config.block_order ?? Object.keys(config.blocks)).flatMap((blockId) => {
        const configBlock = config.blocks[blockId];
        if (!configBlock || configBlock.disabled || configBlock.static === true) return [];
        const isApp = appIdentity(configBlock.type) !== null;
        const schemaBlock = schema.blocks.find(
          (block) => block.type === (isApp ? "@app" : configBlock.type),
        );
        const isThemeBlock = files.has(`blocks/${configBlock.type}.liquid`);
        if (!schemaBlock && !isThemeBlock && !isApp)
          diagnostic(
            "not-implemented",
            `Block type ${configBlock.type} has no classic block schema.`,
          );
        const blockData = track(
          {
            id: blockId,
            type: isApp ? "@app" : configBlock.type,
            settings: settings(
              schemaBlock?.settings ?? [],
              configBlock.settings,
              () => sectionContext,
            ),
            shopify_attributes: options.designMode
              ? `data-shopify-editor-block="${escapeHtml(JSON.stringify({ id: blockId, type: configBlock.type }))}"`
              : "",
          },
          "block",
        );
        if (!isThemeBlock)
          classicBlocks.set(blockData, {
            type: isApp ? "@app" : configBlock.type,
            file,
            pointer: `${configFile}#/sections/${pointer}/blocks/${blockId.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          });
        if (isApp)
          appBlocks.set(blockData, {
            type: configBlock.type,
            file,
            pointer: `${configFile}#/sections/${pointer}/blocks/${blockId.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          });
        return [blockData];
      });
      const sectionId = groupType
        ? `sections--0__${id}`
        : configFile.startsWith("templates/")
          ? `template--0__${id}`
          : id;
      const sectionData = track(
        {
          id: sectionId,
          settings: settings(
            schema.settings,
            config.settings,
            () => sectionContext,
            () => sectionContext.spawn({ closest: globals.closest }),
          ),
          blocks,
          index: options.designMode ? null : index,
          index0: options.designMode || index === null ? null : index - 1,
          location: groupType ?? (index === null ? "static" : "template"),
          // Undocumented, but read by themes; outside the editor it adds nothing. The editor's
          // section attributes are not reproduced, so design mode leaves it diagnosed.
          ...(options.designMode ? {} : { shopify_attributes: "" }),
        },
        "section",
      );
      const sectionGlobals = Object.defineProperties({}, Object.getOwnPropertyDescriptors(globals));
      Object.defineProperty(sectionGlobals, "section", { value: sectionData, enumerable: true });
      const closest = closestSettings(schema.settings, sectionData.settings, globals.closest);
      Object.defineProperty(sectionGlobals, "closest", {
        value: closest,
        enumerable: true,
        configurable: true,
      });
      const context = new PreviewContext({ section: sectionData }, engine.options, {
        globals: sectionGlobals,
      });
      sectionContext = context;
      blockOwners.set(sectionData, {
        config,
        pointer: `${configFile}#/sections/${pointer}`,
        section: sectionData,
        prefix: sectionId,
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
  async function themeBlock(
    id: string,
    config: NestedBlockConfig,
    parent: BlockOwner,
    caller: Context,
    args: LiquidRecord,
    configured: boolean,
  ): Promise<string> {
    if (config.disabled) return "";
    if (appIdentity(config.type))
      return appBlock(
        config.type,
        configured ? (parent.pointer.split("#")[0] ?? "") : (location.file ?? ""),
        configured
          ? `${parent.pointer}/blocks/${id.replaceAll("~", "~0").replaceAll("/", "~1")}`
          : null,
      );
    if (!/^[A-Za-z0-9_-]+$/.test(config.type)) throw new Error("Invalid theme block type");
    if (stack.filter((node) => node.kind === "block").length >= 8)
      throw new Error("Theme blocks cannot be nested beyond eight levels");
    const file = themePath(`blocks/${config.type}.liquid`);
    const pointer = id.replaceAll("~", "~0").replaceAll("/", "~1");
    const entry = node(
      "block",
      config.type,
      file,
      configured ? `${parent.pointer}/blocks/${pointer}` : null,
    );
    return inside(entry, async () => {
      let schema = themeBlockSchema.parse({});
      let schemaFailure: string | undefined;
      try {
        const values: z.infer<typeof themeBlockSchema>[] = [];
        walk(toLiquidAST(source(file)), (node, parent) => {
          if (node.type !== NodeTypes.LiquidRawTag || node.name !== "schema") return;
          if (parent?.type !== NodeTypes.Document) throw new Error("Schema tag must be top-level");
          values.push(themeBlockSchema.parse(JSON.parse(node.body.value)));
        });
        if (values.length > 1) throw new Error("More than one schema tag");
        schema = values[0] ?? schema;
      } catch (error) {
        schemaFailure = liquidError(error, file, 1);
      }
      sectionLocales.set(entry.id, schema.locales);
      const inherited: unknown = caller.getSync(["closest"]);
      const resourceParent = object(inherited)
        ? Object.defineProperties({}, Object.getOwnPropertyDescriptors(inherited))
        : {};
      // Shopify passes on a resource of any type but drops a string, number or list.
      const resource = (value: unknown) => (liquidObjectKind(value) === undefined ? null : value);
      for (const [key, value] of Object.entries(args))
        if (key.startsWith("closest."))
          Object.defineProperty(resourceParent, key.slice(8), {
            value: resource(value),
            enumerable: true,
            configurable: true,
          });
      const parameters: LiquidRecord = {};
      let blockContext: Context;
      const blockData = track(
        {
          id,
          type: config.type,
          settings: settings(
            schema.settings,
            config.settings,
            () => blockContext,
            () => blockContext.spawn({ closest: resourceParent }),
          ),
          shopify_attributes: options.designMode
            ? `data-shopify-editor-block="${escapeHtml(JSON.stringify({ id, type: config.type }))}"`
            : "",
        },
        "block",
      );
      const closest = closestSettings(schema.settings, blockData.settings, inherited);
      for (const [key, value] of Object.entries(args)) {
        if (key.startsWith("closest."))
          Object.defineProperty(closest, key.slice(8), {
            value: resource(value),
            enumerable: true,
            configurable: true,
          });
        else if (!["id", "type"].includes(key))
          Object.defineProperty(parameters, key, { value, enumerable: true });
      }
      const scope = Object.defineProperties({}, Object.getOwnPropertyDescriptors(caller.globals));
      for (const [key, value] of Object.entries({
        block: blockData,
        section: parent.section,
        closest,
      })) {
        if (Object.getOwnPropertyDescriptor(scope, key)?.configurable === false) continue;
        Object.defineProperty(scope, key, { value, enumerable: true, configurable: true });
      }
      blockContext = new PreviewContext(
        { ...parameters, block: blockData, closest },
        engine.options,
        {
          globals: scope,
        },
      );
      blockOwners.set(blockData, {
        config,
        pointer: entry.settingsPath ?? `${parent.pointer}/blocks/${pointer}`,
        section: parent.section,
        prefix: `${parent.prefix}/${id}`,
      });
      let output = schemaFailure ?? (await renderFile(file, blockContext));
      if (schema.tag !== null) {
        const tag = schema.tag ?? "div";
        if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(tag))
          throw new Error("Invalid theme block wrapper tag");
        output = `<${tag} id="shopify-block-${escapeHtml(`${parent.prefix}/${id}`)}" class="shopify-block${schema.class ? ` ${escapeHtml(schema.class)}` : ""}">${output}</${tag}>`;
      }
      return `<!--sop:region ${entry.id}-->${output}<!--/sop:region-->`;
    });
  }
  async function assembly(file: string, groupType?: string): Promise<string> {
    const config = templateConfig(source(file), file);
    let result = "";
    let index = 0;
    for (const id of config.order) {
      const configured = config.sections[id];
      if (configured && !configured.disabled)
        result += await section(id, configured, file, groupType, ++index);
    }
    return result;
  }
  engine.registerTag(
    "section",
    class extends Tag {
      async render() {
        const value: unknown = await evalNumericValue(engine, this.token.args);
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
        const value: unknown = await evalNumericValue(engine, this.token.args);
        if (typeof value !== "string") throw new Error("Sections requires a string name");
        const file = themePath(`sections/${value}.json`);
        const config = templateConfig(source(file), file);
        return inside(node("section-group", value, file, file), () =>
          assembly(file, config.type ?? value),
        );
      }
    },
  );
  engineObserver?.(engine, stubbed);
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
      return renderFile(file, new PreviewContext(globals, engine.options));
    });
  }
  if (object(settingsConfig.blocks)) {
    let embeds = "";
    for (const [id, value] of Object.entries(settingsConfig.blocks)) {
      const config = sectionConfigSchema.parse(value);
      if (!config.disabled && appIdentity(config.type))
        embeds += await appBlock(
          config.type,
          "config/settings_data.json",
          `${settingsPointer}/blocks/${id.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        );
    }
    html = appendAppEmbeds(html, embeds);
  }
  const bundled = assetBundles.finish(html);
  html = bundled.html;
  if (bundled.emitted)
    diagnostic(
      "shopify-server-only",
      "Theme CSS and deferred JavaScript are compiled locally; Shopify's generated CDN bundle URLs are omitted.",
      "info",
    );
  return renderSchema.parse({
    schemaVersion: "1.0",
    html,
    tree,
    diagnostics,
    dataUsed: Object.fromEntries([...data].map(([id, paths]) => [id, [...paths].sort()])),
    route: { path: route.path, pageType: route.pageType, template: route.template },
  });
}
