import { NodeTypes, toLiquidHtmlAST, walk } from "@shopify/liquid-html-parser";
export function appIdentity(type: string): { app: string; block: string } | null {
  if (type === "@app") return { app: "External app", block: "Unspecified block" };
  if (!type.startsWith("shopify://apps/")) return null;
  const match = /^shopify:\/\/apps\/([^/]+)\/blocks\/([^/]+)\/([^/]+)$/.exec(type);
  if (!match?.[1] || !match[2]) throw new Error("Invalid app block URI");
  return { app: decodeURIComponent(match[1]), block: decodeURIComponent(match[2]) };
}
function escapeMarkup(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
export function appMarkup(type: string): string {
  const names = appIdentity(type);
  if (!names) throw new Error("App block type is required");
  return `<div class="sop-app-placeholder" role="note" data-sop-app="${escapeMarkup(names.app)}" data-sop-app-block="${escapeMarkup(names.block)}">External app: ${escapeMarkup(names.app)} / ${escapeMarkup(names.block)} — not available offline</div>`;
}
/** Parses HTML structure so a closing-body string inside a script cannot become the insertion point. */
export function appendAppEmbeds(html: string, markup: string): string {
  if (!markup) return html;
  let end: number | undefined;
  try {
    walk(toLiquidHtmlAST(html, { mode: "tolerant", allowUnclosedDocumentNode: true }), (node) => {
      if (
        node.type === NodeTypes.HtmlElement &&
        node.name.length === 1 &&
        node.name[0]?.type === NodeTypes.TextNode &&
        node.name[0].value.toLowerCase() === "body"
      )
        end = node.blockEndPosition.start;
    });
  } catch {
    /* A rendered fragment can still display the placeholders at its end. */
  }
  return end === undefined ? html + markup : html.slice(0, end) + markup + html.slice(end);
}
