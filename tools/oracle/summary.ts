import { createHash } from "node:crypto";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { z } from "zod";

export interface ComparisonNode {
  kind: "section" | "block";
  type: string;
  children: ComparisonNode[];
}
const treeNode: z.ZodType<ComparisonNode> = z.lazy(() =>
  z.strictObject({
    kind: z.enum(["section", "block"]),
    type: z.string(),
    children: z.array(treeNode),
  }),
);
export const publicSummarySchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  tree: z.array(treeNode),
  sections: z.array(
    z.strictObject({
      id: z.string(),
      textHash: z.string().regex(/^[a-f0-9]{64}$/),
      tokenCount: z.number().int().nonnegative(),
    }),
  ),
  markedBlockCount: z.number().int().nonnegative(),
});
export type PublicSummary = z.infer<typeof publicSummarySchema>;
export interface PrivateSummary {
  summary: PublicSummary;
  sectionText: Record<string, string>;
}
export interface SummaryOptions {
  sectionTypes: Readonly<Record<string, string>>;
}
type Node = DefaultTreeAdapterTypes.Node;

export function normalizeId(id: string): string {
  return id.replace(/\b(template|sections)--\d+(?=__)/g, "$1--N");
}
export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}
const ignored = new Set(["script", "style", "noscript", "template"]);
function textContent(node: Node): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if ("tagName" in node && ignored.has(node.tagName)) return "";
  return "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
}

/** Private text is returned separately; callers publish only .summary, never this whole object. */
export function summarizeHtml(html: string, options: SummaryOptions): PrivateSummary {
  const document = parse(html);
  const tree: ComparisonNode[] = [];
  const sectionText: Record<string, string> = {};
  const sections: PublicSummary["sections"] = [];
  const markers: { id: string; type: string; node: ComparisonNode; sectionId: string }[] = [];
  const seenBlocks = new Map<string, ComparisonNode>();
  const blockIds = new WeakMap<ComparisonNode, string>();
  const parentIds = new WeakMap<ComparisonNode, number>();
  let parentSerial = 0;
  let markedBlockCount = 0;
  function block(
    id: string,
    type: string,
    sectionId: string,
    parent: ComparisonNode,
    paired = false,
  ): ComparisonNode {
    if (!id || !type) throw new Error("Empty block marker id/type");
    const normalizedId = normalizeId(id);
    if (!paired && blockIds.get(parent) === normalizedId) {
      if (parent.type !== type) throw new Error(`Duplicate block marker: ${normalizedId}`);
      return parent;
    }
    let parentId = parentIds.get(parent);
    if (parentId === undefined) {
      parentId = ++parentSerial;
      parentIds.set(parent, parentId);
    }
    const key = `${sectionId}:${parentId}:${normalizeId(id)}`;
    const existing = seenBlocks.get(key);
    if (existing && existing.type !== type)
      throw new Error(`Duplicate block marker: ${normalizedId}`);
    // One classic block can mark several sibling or nested DOM roots. Its identity
    // is section + parent + id. Whole-file comment pairs still represent each render.
    if (existing && !paired) return existing;
    markedBlockCount++;
    const node: ComparisonNode = { kind: "block", type, children: [] };
    seenBlocks.set(key, node);
    blockIds.set(node, normalizedId);
    parent.children.push(node);
    return node;
  }
  function visit(node: Node, domParent?: ComparisonNode, sectionId?: string): void {
    let parent = domParent;
    let currentSection = sectionId;
    if (node.nodeName === "#comment" && "data" in node) {
      const open = /^sop:block (\S+) (\S+)$/.exec(node.data.trim());
      if (open) {
        if (!parent || !currentSection || !open[1] || !open[2])
          throw new Error("Block marker outside a section");
        const activeParent = markers.at(-1)?.node ?? parent;
        const item = block(open[1], open[2], currentSection, activeParent, true);
        markers.push({ id: open[1], type: open[2], node: item, sectionId: currentSection });
      } else if (node.data.trim() === "/sop:block") {
        if (!markers.pop()) throw new Error("Unmatched closing block marker");
      }
      return;
    }
    if ("tagName" in node) {
      if (ignored.has(node.tagName)) return;
      const attributes = new Map(node.attrs.map((a) => [a.name, a.value]));
      const id = attributes.get("id");
      if (id?.startsWith("shopify-section-")) {
        currentSection = normalizeId(id.slice("shopify-section-".length));
        if (Object.hasOwn(sectionText, currentSection))
          throw new Error(`Duplicate section: ${currentSection}`);
        const type = Object.hasOwn(options.sectionTypes, currentSection)
          ? options.sectionTypes[currentSection]
          : undefined;
        if (!type) throw new Error(`Missing source type for section: ${currentSection}`);
        parent = { kind: "section", type, children: [] };
        if (domParent) domParent.children.push(parent);
        else tree.push(parent);
        const text = normalizeText(textContent(node));
        Object.defineProperty(sectionText, currentSection, { value: text, enumerable: true });
        sections.push({
          id: currentSection,
          textHash: createHash("sha256").update(text, "utf8").digest("hex"),
          tokenCount: text ? text.split(" ").length : 0,
        });
      }
      const blockId = attributes.get("data-sop-block-id");
      const blockType = attributes.get("data-sop-block-type");
      if (blockId !== undefined || blockType !== undefined) {
        if (!parent || !currentSection || !blockId || !blockType)
          throw new Error("Incomplete block attributes or block outside a section");
        const active = markers.at(-1);
        // Theme blocks may have both whole-file comments and a root attribute pair.
        if (
          active?.id === blockId &&
          active.type === blockType &&
          active.sectionId === currentSection
        )
          parent = active.node;
        else parent = block(blockId, blockType, currentSection, active?.node ?? parent);
      }
    }
    if ("childNodes" in node)
      for (const child of node.childNodes) visit(child, parent, currentSection);
  }
  visit(document);
  if (markers.length) throw new Error("Unclosed block markers");
  if (!sections.length)
    throw new Error("No Shopify section wrappers found; refusing an empty golden");
  const summary = publicSummarySchema.parse({
    schemaVersion: "1.0",
    tree,
    sections,
    markedBlockCount,
  });
  return { summary, sectionText };
}

/** No automatic accepted-difference suppression. Any waiver must carry real evidence later. */
export function compareSummaries(
  expected: PublicSummary,
  actual: PublicSummary,
): { equal: boolean; treeEqual: boolean; textEqual: boolean } {
  publicSummarySchema.parse(expected);
  publicSummarySchema.parse(actual);
  const treeEqual =
    JSON.stringify(expected.tree) === JSON.stringify(actual.tree) &&
    expected.markedBlockCount === actual.markedBlockCount;
  const textEqual = JSON.stringify(expected.sections) === JSON.stringify(actual.sections);
  return { equal: treeEqual && textEqual, treeEqual, textEqual };
}
export function assertStableCapture(first: PublicSummary, second: PublicSummary): void {
  if (!compareSummaries(first, second).equal)
    throw new Error("Unstable oracle capture; no golden may be published");
}
