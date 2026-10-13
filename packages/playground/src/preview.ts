import {
  defaultTreeAdapter as adapter,
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes as Tree,
} from "parse5";
import type { Snapshot } from "../../data/src/schema.js";
import { servedPreview } from "../../dev/src/view.js";
import type { RenderResult } from "../../render/src/contracts.js";
import type { BrowserFiles } from "./files.js";
import { prepareResources, rewriteModule, virtualOrigin } from "./resources.js";

/** Parse without a DOM: uploaded markup cannot start resource requests in the inspector. */
export async function playgroundPreview(
  result: RenderResult,
  snapshot: Snapshot,
  files: BrowserFiles,
  images: BrowserFiles,
  bridge: string,
  designMode: boolean,
  viewId: string,
  inspectorOrigin: string,
): Promise<string> {
  const resources = await prepareResources(files, images);
  const doc = parse(
    servedPreview(result, inspectorOrigin, {
      designMode,
      viewId,
      shopDomain: snapshot.shop.domain,
      locale: snapshot.shop.locale,
      currency: snapshot.shop.currency,
      previewOrigin: virtualOrigin,
      virtualResources: resources.urls,
    }),
  );
  const elements: Tree.Element[] = [];
  function walk(node: Tree.Node) {
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) node.childNodes.forEach(walk);
  }
  walk(doc);
  const head = elements.find((e) => e.tagName === "head");
  if (!head) throw new Error("Preview has no head");
  const attr = (e: Tree.Element, name: string) => e.attrs.find((a) => a.name === name);
  const baseHref = `${virtualOrigin}${result.route.path}`;
  function resource(value: string): string {
    try {
      const url = new URL(value, baseHref);
      return resources.urls[url.origin + url.pathname] ?? value;
    } catch {
      return value;
    }
  }
  const maps: Record<string, string> = { ...resources.imports };
  let bootstrap: Tree.Element | undefined;
  for (const e of elements) {
    if (e.tagName === "script" && attr(e, "src")?.value === "/sop/bridge.js") {
      bootstrap = e;
      continue;
    }
    if (e.tagName === "base") {
      adapter.detachNode(e);
      continue;
    }
    for (const name of ["src", "href", "poster"]) {
      const value = attr(e, name);
      if (value && !value.value.startsWith("#")) value.value = resource(value.value);
    }
    const srcset = attr(e, "srcset");
    if (srcset && !srcset.value.startsWith("data:"))
      srcset.value = srcset.value
        .split(",")
        .map((value) => {
          const [url, ...size] = value.trim().split(/\s+/);
          return [resource(url ?? ""), ...size].join(" ");
        })
        .join(", ");
    if (e.tagName === "script" && attr(e, "type")?.value === "importmap") {
      const map: unknown = JSON.parse(
        e.childNodes
          .map((node) => (adapter.isTextNode(node) ? adapter.getTextNodeContent(node) : ""))
          .join(""),
      );
      if (
        map &&
        typeof map === "object" &&
        "imports" in map &&
        map.imports &&
        typeof map.imports === "object"
      )
        for (const [key, value] of Object.entries(map.imports))
          if (typeof value === "string") maps[key] = resource(value);
      if (map && typeof map === "object" && "scopes" in map)
        throw new Error("Scoped import maps are not supported in the browser preview yet");
      adapter.detachNode(e);
    }
    if (e.tagName === "script" && attr(e, "type")?.value === "module" && !attr(e, "src")) {
      const code = await rewriteModule(
        e.childNodes
          .map((node) => (adapter.isTextNode(node) ? adapter.getTextNodeContent(node) : ""))
          .join(""),
        "assets/inline.js",
        files,
      );
      e.childNodes = [];
      adapter.insertText(e, code);
    }
    if (e.tagName === "style" || attr(e, "style")) {
      const rewrite = (text: string) =>
        text.replace(
          /url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/g,
          (original, _quote: string, value: string) => {
            const url = resource(value);
            return url === value ? original : `url("${url}")`;
          },
        );
      const style = attr(e, "style");
      if (style) style.value = rewrite(style.value);
      if (e.tagName === "style") {
        const text = rewrite(
          e.childNodes
            .map((node) => (adapter.isTextNode(node) ? adapter.getTextNodeContent(node) : ""))
            .join(""),
        );
        e.childNodes = [];
        adapter.insertText(e, text);
      }
    }
  }
  if (!bootstrap) throw new Error("Preview bridge is missing");
  bootstrap.attrs = bootstrap.attrs.filter((a) => a.name !== "src");
  adapter.insertText(bootstrap, bridge.replace(/<\/script/gi, "<\\/script"));
  const injected = parseFragment(
    `<base href="${baseHref.replaceAll('"', "&quot;")}"><script type="importmap">${JSON.stringify({ imports: maps }).replaceAll("<", "\\u003c")}</script>`,
  );
  const first = head.childNodes[0];
  for (const node of [...injected.childNodes]) {
    if (first) adapter.insertBefore(head, node, first);
    else adapter.appendChild(head, node);
  }
  return serialize(doc);
}
