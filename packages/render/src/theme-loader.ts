import { NodeTypes, toLiquidAST, walk } from "@shopify/liquid-html-parser";
import { parseThemeJson, type ThemeFileSystem, themePath } from "../../theme/src/index.js";
import type { RenderClock } from "./render-clock.js";

/** One render's selected dependency closure, with batched breadth-first static reads. */
export class ThemeLoader {
  readonly files = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    private readonly theme: ThemeFileSystem,
    readonly paths: ReadonlySet<string>,
    private readonly clock?: RenderClock,
  ) {}
  private io<T>(read: () => Promise<T>): Promise<T> {
    return this.clock ? this.clock.io(read) : read();
  }
  async load(paths: readonly string[]): Promise<void> {
    const missing = [...new Set(paths)].filter(
      (path) => this.paths.has(path) && !this.files.has(path) && !this.pending.has(path),
    );
    if (missing.length) {
      const request = this.io(async () => {
        const values = this.theme.readTexts
          ? await this.theme.readTexts(missing, this.clock?.signal)
          : new Map(
              await Promise.all(
                missing.map(async (path) => [path, await this.theme.readText(path)] as const),
              ),
            );
        for (const path of missing) {
          const value = values.get(path);
          if (value === undefined) throw new Error(`Theme batch omitted ${path}`);
          this.files.set(path, value);
        }
      });
      for (const path of missing) this.pending.set(path, request);
    }
    await Promise.all(paths.map((path) => this.pending.get(path)));
  }
  async closure(seeds: readonly string[]): Promise<void> {
    const visited = new Set<string>();
    let frontier = seeds.filter((path) => this.paths.has(path));
    while (frontier.length) {
      const batch = frontier.filter((path) => !visited.has(path));
      if (!batch.length) break;
      for (const path of batch) visited.add(path);
      await this.load(batch);
      frontier = batch
        .flatMap((path) => this.dependencies(path))
        .filter((path) => this.paths.has(path) && !visited.has(path));
    }
  }
  private dependencies(file: string): string[] {
    const text = this.files.get(file);
    if (text === undefined) return [];
    const result: string[] = [];
    if (file.endsWith(".liquid")) {
      // The parser identifies tags inside Liquid blocks and excludes comments/raw text.
      try {
        walk(toLiquidAST(text, { mode: "tolerant", allowUnclosedDocumentNode: false }), (node) => {
          if (node.type !== NodeTypes.LiquidTag) return;
          const markup = text.slice(node.position.start, node.position.end);
          const name = /\b(?:render|include|section|sections|layout)\s+(['"])([^'"]+)\1/.exec(
            markup,
          )?.[2];
          if (!name) return;
          if (node.name === "render" || node.name === "include")
            result.push(themePath(`snippets/${name}.liquid`));
          if (node.name === "section") result.push(themePath(`sections/${name}.liquid`));
          if (node.name === "sections") result.push(themePath(`sections/${name}.json`));
          if (node.name === "layout") result.push(themePath(`layout/${name}.liquid`));
        });
      } catch {
        // Invalid Liquid is reported by the renderer at the actual execution site.
      }
    } else if (/^(templates|sections)\//.test(file) && file.endsWith(".json")) {
      const config = parseThemeJson(text, file);
      if (config && typeof config === "object") {
        const record = config as Record<string, unknown>;
        if (file.startsWith("templates/") && record.layout !== false)
          result.push(
            themePath(
              `layout/${typeof record.layout === "string" ? record.layout : "theme"}.liquid`,
            ),
          );
        const scan = (items: unknown, section: boolean, order?: unknown) => {
          if (!items || typeof items !== "object") return;
          for (const value of Array.isArray(order)
            ? order
                .filter((key): key is string => typeof key === "string")
                .map((key) => Reflect.get(items, key))
            : Object.values(items)) {
            if (!value || typeof value !== "object") continue;
            const item = value as Record<string, unknown>;
            if (item.disabled) continue;
            if (typeof item.type === "string" && !item.type.startsWith("shopify://"))
              result.push(themePath(`${section ? "sections" : "blocks"}/${item.type}.liquid`));
            scan(item.blocks, false, item.block_order);
          }
        };
        scan(record.sections, true, record.order);
      }
    }
    return result;
  }
}
