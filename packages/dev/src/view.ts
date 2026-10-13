import type { DefaultTreeAdapterTypes } from "parse5";
import { defaultTreeAdapter, parse, parseFragment, serialize } from "parse5";
import type { RenderNode, RenderResult } from "../../render/src/index.js";

interface Region {
  nodeId: string;
  domId?: string;
  markerId?: string;
}
export function previewRegions(tree: RenderNode[]): Region[] {
  const result: Region[] = [];
  function walk(nodes: RenderNode[]) {
    for (const node of nodes) {
      if (node.kind === "block") result.push({ nodeId: node.id, markerId: node.id });
      if (node.kind === "section" && node.settingsPath) {
        const [file, pointer] = node.settingsPath.split("#/sections/");
        const id = pointer?.replaceAll("~1", "/").replaceAll("~0", "~");
        if (id !== undefined)
          result.push({
            nodeId: node.id,
            domId: `shopify-section-${file?.startsWith("templates/") ? "template--0__" : file?.startsWith("sections/") ? "sections--0__" : ""}${id}`,
          });
      }
      walk(node.children);
    }
  }
  walk(tree);
  return result;
}
export function servedPreview(
  result: RenderResult,
  inspectorOrigin: string,
  context: {
    designMode?: boolean;
    shopDomain?: string;
    locale?: string;
    currency?: string;
    viewId?: string;
    previewOrigin?: string;
    virtualResources?: Record<string, string>;
  } = {},
): string {
  const config = JSON.stringify({
    inspectorOrigin,
    regions: previewRegions(result.tree),
    diagnostics: result.diagnostics,
    path: result.route.path,
    ...context,
  }).replaceAll("<", "\\u003c");
  const document = parse(result.html);
  let head: DefaultTreeAdapterTypes.Element | undefined;
  function find(node: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in node && node.tagName === "head") head = node;
    if ("childNodes" in node) node.childNodes.forEach(find);
  }
  find(document);
  if (!head) throw new Error("Preview document has no head");
  const fragment = parseFragment(
    `<script id="sop-bridge-config" type="application/json">${config}</script><script src="/sop/bridge.js"></script>`,
  );
  const first = head.childNodes[0];
  for (const child of [...fragment.childNodes]) {
    if (first) defaultTreeAdapter.insertBefore(head, child, first);
    else defaultTreeAdapter.appendChild(head, child);
  }
  return serialize(document);
}
