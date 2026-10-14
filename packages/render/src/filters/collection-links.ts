import { type Liquid, toValue } from "liquidjs";
import { liquidObjectKind } from "../../../data/src/objects.js";
import { renderAnchor } from "./anchors.js";
import { namedArgs } from "./images.js";

function scalar(value: unknown): string {
  return String(toValue(value) ?? "");
}
function encode(value: unknown): string {
  return encodeURIComponent(scalar(value)).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
export function registerCollectionLinkFilters(engine: Liquid): void {
  for (const [kind, label] of [
    ["type", "Type"],
    ["vendor", "Vendor"],
  ]) {
    const url = (value: unknown) => `/collections/${kind}s?q=${encode(value)}`;
    engine.registerFilter(`url_for_${kind}`, url);
    engine.registerFilter(`link_to_${kind}`, (value: unknown, ...args: unknown[]) => {
      const input = toValue(value);
      if (input === false || scalar(input).trim() === "") return `Unknown ${label}`;
      const attributes = namedArgs(args);
      attributes.href = url(input);
      if (!Object.hasOwn(attributes, "title")) attributes.title = scalar(input);
      return renderAnchor(input, attributes);
    });
  }
  engine.registerFilter("within", (input: unknown, collection: unknown) => {
    const value = scalar(input);
    if (liquidObjectKind(collection) !== "collection") return value;
    return scalar(Reflect.get(Object(collection), "url")) + value;
  });
  engine.registerFilter("sort_by", (input: unknown, order: unknown) => {
    const value = toValue(input);
    if (typeof value !== "string" || /[^\x21-\x7e]|%(?![\da-f]{2})/i.test(value))
      throw new Error("bad URI input for sort_by");
    // Parse for structural errors without normalizing existing encodings or queries.
    new URL(value, "https://offline.invalid");
    const sort = toValue(order);
    if (sort === false || scalar(sort).trim() === "") return value;
    const fragment = value.indexOf("#");
    const path = fragment < 0 ? value : value.slice(0, fragment);
    const hash = fragment < 0 ? "" : value.slice(fragment);
    const delimiter = path.includes("?") ? (path.endsWith("?") ? "" : "&") : "?";
    return `${path}${delimiter}sort_by=${encode(sort)}${hash}`;
  });
}
