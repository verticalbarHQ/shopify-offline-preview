import { type Liquid, toValue } from "liquidjs";
import type { Snapshot } from "../../../data/src/schema.js";
import { parseThemeJson } from "../../../theme/src/index.js";
import { namedArgs } from "./images.js";

const english: Readonly<Record<string, string>> = {
  abbreviated_date: "%b %-d, %Y",
  basic: "%-m/%-d/%Y",
  date: "%B %-d, %Y",
  date_at_time: "%B %-d, %Y at %-l:%M %P",
  default: "%A, %B %-d, %Y at %-l:%M %P %z",
  on_date: "on %b %-d, %Y",
  short: "%d %b %H:%M",
  long: "%B %d, %Y %H:%M",
};
function escapeHtml(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function instant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.valueOf()) ? value : null;
  if (typeof value === "number" || (typeof value === "string" && /^-?\d+$/.test(value))) {
    const date = new Date(Number(value) * 1000);
    return Number.isFinite(date.valueOf()) ? date : null;
  }
  if (typeof value !== "string" || !value) return null;
  // Ruby-style timestamps become explicit ISO offsets before either runtime parses them.
  const normalized = value.replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/,
    "$1T$2$3:$4",
  );
  const date = new Date(normalized);
  return Number.isFinite(date.valueOf()) ? date : null;
}
export function registerDateFilters(
  engine: Liquid,
  snapshot: Snapshot,
  files: ReadonlyMap<string, string>,
  diagnostic: (code: string, message: string, file: string | null, line: number | null) => void,
): void {
  const native = engine.filters.date;
  if (typeof native !== "function") throw new Error("Liquid date filter is unavailable");
  const locale = snapshot.shop.locale,
    language = locale.split("-")[0] ?? locale;
  const defaults = [...files.keys()].filter((file) => /^locales\/[^/]+\.default\.json$/.test(file));
  const selected = [
    `locales/${locale}.json`,
    `locales/${locale}.default.json`,
    `locales/${language}.json`,
    `locales/${language}.default.json`,
    ...defaults,
  ].find((file) => files.has(file));
  const translations = selected ? parseThemeJson(files.get(selected) ?? "{}", selected) : {};
  const custom =
    record(translations) && record(translations.date_formats) ? translations.date_formats : {};
  function format(name: unknown, report: (message: string) => void): string {
    const key = String(name ?? "default");
    if (Object.hasOwn(custom, key) && typeof custom[key] === "string") return custom[key];
    if (language !== "en")
      report("Localized system date formats are unavailable; English patterns are used.");
    if (!Object.hasOwn(english, key)) {
      report(`Named date format ${key} is unavailable.`);
      return english.default ?? "";
    }
    return english[key] ?? "";
  }
  for (const name of ["date", "time_tag"])
    engine.registerFilter(name, function (input: unknown, ...args: unknown[]) {
      const value = toValue(input),
        source = value === "now" || value === "today" ? snapshot.meta.now : value;
      const date = instant(source);
      if (!date) return String(value ?? "");
      const options = namedArgs(args);
      const report = (message: string) =>
        diagnostic(
          "not-implemented",
          message,
          this.token.file ?? null,
          this.token.getPosition()[0] ?? null,
        );
      const positional = args.find((arg) => !Array.isArray(arg));
      const display =
        options.format !== undefined
          ? format(options.format, report)
          : typeof positional === "string"
            ? positional
            : format("default", report);
      const text = native.call(this, date, display);
      if (name === "date") return text;
      const datetime =
        options.datetime === undefined
          ? date.toISOString().replace(/\.\d{3}Z$/, "Z")
          : native.call(this, date, String(options.datetime), 0);
      const attributes = Object.entries(options).flatMap(([key, value]) => {
        if (key === "datetime" || key === "format") return [];
        if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(key))
          throw new Error("Invalid time attribute name");
        if (value === null || value === undefined || value === false) return [];
        return [` ${key}="${escapeHtml(value)}"`];
      });
      return `<time datetime="${escapeHtml(datetime)}"${attributes.join("")}>${escapeHtml(text)}</time>`;
    });
}
