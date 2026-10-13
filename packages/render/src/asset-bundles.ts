import { NodeTypes, toLiquidAST, walk } from "@shopify/liquid-html-parser";
import { type DefaultTreeAdapterTypes, parse } from "parse5";

interface Assets {
  stylesheet?: string;
  javascript?: string;
  error?: Error;
}
function scriptUrl(code: string) {
  const bytes = new TextEncoder().encode(code);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return `data:text/javascript;base64,${btoa(binary)}`;
}

/** Raw assets are compiled once per source file; CSS is subset to files actually rendered. */
export class ThemeAssetBundles {
  #assets = new Map<string, Assets>();
  #used = new Set<string>();
  #marker: string;
  constructor(files: ReadonlyMap<string, string>, snapshot: unknown) {
    let number = 0;
    const source = [...files.values(), JSON.stringify(snapshot)];
    while (source.some((text) => text.includes(`<!--sop:theme-assets:${number}-->`))) number++;
    this.#marker = `<!--sop:theme-assets:${number}-->`;
    for (const [file, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!/^(sections|blocks|snippets)\/.*\.liquid$/.test(file)) continue;
      const assets: Assets = {};
      try {
        walk(toLiquidAST(text, { mode: "tolerant", allowUnclosedDocumentNode: false }), (node) => {
          if (node.type !== NodeTypes.LiquidRawTag) return;
          if (node.name !== "javascript" && node.name !== "stylesheet") return;
          if (Object.hasOwn(assets, node.name))
            throw new Error(`Only one ${node.name} tag is allowed per file`);
          assets[node.name] = node.body.value;
        });
      } catch (error) {
        assets.error = error instanceof Error ? error : new Error("Invalid asset source");
      }
      this.#assets.set(file, assets);
    }
  }
  header() {
    return this.#marker;
  }
  use(file: string) {
    const assets = this.#assets.get(file);
    if (assets?.error) throw assets.error;
    this.#used.add(file);
  }
  finish(html: string): { html: string; emitted: boolean } {
    const css: string[] = [];
    const javascript = new Map<string, string[]>();
    for (const [file, assets] of this.#assets) {
      if (assets.error) continue;
      if (this.#used.has(file) && assets.stylesheet !== undefined) css.push(assets.stylesheet);
      // Shopify's JS bundles include all source files, including files absent from this page.
      if (assets.javascript !== undefined) {
        const type = file.split("/")[0] ?? "";
        let bodies = javascript.get(type);
        if (!bodies) {
          bodies = [];
          javascript.set(type, bodies);
        }
        bodies.push(
          `try { (function() {\n${assets.javascript}\n})(); } catch (error) { console.error(error); }`,
        );
      }
    }
    const markup = [
      css.length
        ? `<style data-sop-theme-styles>${css.join("\n").replace(/<\/style/gi, "<\\/style")}</style>`
        : "",
      ...["sections", "blocks", "snippets"].flatMap((type) => {
        const bodies = javascript.get(type);
        return bodies?.length
          ? [
              `<script defer data-sop-theme-scripts="${type}" src="${scriptUrl(bodies.join("\n"))}"></script>`,
            ]
          : [];
      }),
    ].join("");
    if (!markup && !html.includes(this.#marker)) return { html, emitted: false };
    let insertion: number | undefined;
    const markers: { start: number; end: number }[] = [];
    const markerText = this.#marker;
    function visit(node: DefaultTreeAdapterTypes.Node) {
      const position = node.sourceCodeLocation;
      if (
        node.nodeName === "#comment" &&
        position &&
        html.slice(position.startOffset, position.endOffset) === markerText
      )
        markers.push({ start: position.startOffset, end: position.endOffset });
      if ("tagName" in node && node.tagName === "head")
        insertion = node.sourceCodeLocation?.endTag?.startOffset;
      if ("childNodes" in node) node.childNodes.forEach(visit);
    }
    // Parse literal HTML, including raw CSS/JS containing unmatched Liquid delimiters.
    visit(parse(html, { sourceCodeLocationInfo: true }));
    if (markers.length) {
      for (let index = markers.length - 1; index >= 0; index--) {
        const marker = markers[index];
        if (marker)
          html = html.slice(0, marker.start) + (index === 0 ? markup : "") + html.slice(marker.end);
      }
    } else if (markup) {
      const offset = insertion ?? 0;
      html = html.slice(0, offset) + markup + html.slice(offset);
    }
    return { html, emitted: Boolean(markup) };
  }
}
