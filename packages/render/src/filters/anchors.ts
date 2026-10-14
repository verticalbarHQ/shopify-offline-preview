import { toValue } from "liquidjs";

/** Shared anchor serialization for general and catalog links. */
export function renderAnchor(value: unknown, attributes: Record<string, unknown>): string {
  const boolean = new Set([
    "allowfullscreen",
    "async",
    "autofocus",
    "autoplay",
    "checked",
    "controls",
    "defer",
    "disabled",
    "formnovalidate",
    "hidden",
    "ismap",
    "itemscope",
    "loop",
    "multiple",
    "muted",
    "nomodule",
    "novalidate",
    "open",
    "playsinline",
    "readonly",
    "required",
    "reversed",
    "selected",
  ]);
  const output = Object.entries(attributes).flatMap(([name, input]) => {
    if (!/^[A-Za-z_:][A-Za-z0-9_:.-]*$/.test(name)) throw new Error("Invalid link attribute name");
    const scalar = toValue(input);
    if (scalar === null || scalar === undefined || scalar === false) return [];
    return [
      `${name}="${escapeAttribute(scalar === true && boolean.has(name.toLowerCase()) ? name : scalar)}"`,
    ];
  });
  return `<a ${output.join(" ")}>${String(toValue(value) ?? "")}</a>`;
}
function escapeAttribute(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
