import { Tag, type Template, TypeGuards } from "liquidjs";
import { unboundTag } from "./range-parser.js";

/** Tags that output nothing, so a block holding only them and whitespace is blank. */
const silentTags = new Set(["assign", "capture", "comment", "#"]);

interface Branch {
  templates: Template[];
}
/** The bodies whose text Shopify drops when the whole tag is blank. */
function strippable(tag: Tag): Template[][] | undefined {
  const fields = tag as unknown as {
    branches?: Branch[];
    templates?: Template[];
    elseTemplates?: Template[];
  };
  if (["if", "unless", "case"].includes(tag.name))
    return [
      ...(fields.branches ?? []).map((branch) => branch.templates),
      ...(fields.elseTemplates ? [fields.elseTemplates] : []),
    ];
  if (tag.name === "for") {
    // The preview's loop tracing wraps the body in one template that carries the for token.
    const own = fields.templates ?? [];
    const [only] = own;
    const body = own.length === 1 && only?.token === tag.token ? children(only)[0] : own;
    return [body ?? own, fields.elseTemplates ?? []];
  }
  return undefined;
}
function children(tag: Template): Template[][] {
  const iterator = tag.children?.(false, true);
  const lists: Template[][] = [];
  if (!iterator) return lists;
  let next = iterator.next();
  while (!next.done) {
    if (Array.isArray(next.value)) lists.push(next.value);
    next = iterator.next();
  }
  if (Array.isArray(next.value)) lists.push(next.value);
  return lists;
}
function blankTemplate(bound: Template): boolean {
  const template = unboundTag(bound);
  if (TypeGuards.isHTMLToken(template.token))
    return /^[ \t\r\n\f\v]*$/.test(template.token.getText());
  if (!(template instanceof Tag)) return false;
  const bodies = strippable(template);
  if (bodies) {
    const blank = bodies.map(blankBody).every(Boolean);
    if (blank)
      for (const body of bodies) {
        const kept = body.filter((item) => !TypeGuards.isHTMLToken(item.token));
        body.splice(0, body.length, ...kept);
      }
    return blank;
  }
  const nested = children(template).map(blankBody).every(Boolean);
  if (template.name === "liquid") return nested;
  if (template.name === "raw")
    return (template as unknown as { tokens: { getText(): string }[] }).tokens.every(
      (token) => token.getText() === "",
    );
  return silentTags.has(template.name);
}
function blankBody(templates: Template[]): boolean {
  return templates.map(blankTemplate).every(Boolean);
}

/**
 * Shopify drops the text of an if, unless, case or for tag when every branch holds only
 * whitespace and tags that output nothing (assign, capture, comment, `#`, an empty raw, or such
 * blocks), as measured on a development store. LiquidJS keeps that whitespace.
 */
export function dropBlankBodyText(templates: Template[]): void {
  blankBody(templates);
}
