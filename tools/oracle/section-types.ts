import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { z } from "zod";
import { checkTheme } from "../../packages/check/src/index.js";
import { parseThemeJson, type ThemeFileSystem } from "../../packages/theme/src/index.js";

const configuration = z.object({
  sections: z.record(z.string(), z.object({ type: z.string(), disabled: z.boolean().optional() })),
  order: z.array(z.string()),
});

/** Source-driven mapping; unknown Shopify wrapper ids fail capture instead of guessing a type. */
export async function sectionTypeMap(
  fs: ThemeFileSystem,
  template: string,
): Promise<Record<string, string>> {
  const analysis = await checkTheme(fs);
  const page = analysis.pages.find((item) => item.template === template);
  if (!page) throw new Error(`Unsupported template for section mapping: ${template}`);
  if (
    analysis.diagnostics.some(
      (d) => d.severity === "error" && d.file !== null && page.files.includes(d.file),
    )
  )
    throw new Error("Theme must load without errors before oracle mapping");
  const output: Record<string, string> = {};
  const available = new Set(await fs.listFiles());
  function add(id: string, type: string): void {
    if (Object.hasOwn(output, id) && output[id] !== type)
      throw new Error(`Ambiguous section source mapping: ${id}`);
    Object.defineProperty(output, id, { value: type, enumerable: true, configurable: true });
  }
  function literalWrappers(node: DefaultTreeAdapterTypes.Node): void {
    if ("attrs" in node) {
      const id = node.attrs.find((attribute) => attribute.name === "id")?.value;
      const type = id?.startsWith("shopify-section-")
        ? id.slice("shopify-section-".length)
        : undefined;
      // Some snippets emit the wrapper of a real section used by the rendering API.
      // Bind only an exact existing section file; never infer unknown numeric ids.
      if (type && available.has(`sections/${type}.liquid`)) add(type, type);
    }
    if ("childNodes" in node) for (const child of node.childNodes) literalWrappers(child);
    if ("content" in node) literalWrappers(node.content);
  }
  for (const file of page.files) {
    if (file === template || /^sections\/[^/]+\.json$/.test(file)) {
      const data = configuration.parse(parseThemeJson(await fs.readText(file), file));
      const prefix = file === template ? "template--N" : "sections--N";
      for (const id of data.order) {
        const section = data.sections[id];
        if (!section) throw new Error(`Unknown section in order: ${file}/${id}`);
        if (!section.disabled) add(`${prefix}__${id}`, section.type);
      }
    } else if (/^sections\/[^/]+\.liquid$/.test(file))
      add(
        file.slice("sections/".length, -".liquid".length),
        file.slice("sections/".length, -".liquid".length),
      );
    if (file.endsWith(".liquid")) literalWrappers(parse(await fs.readText(file)));
  }
  return output;
}
