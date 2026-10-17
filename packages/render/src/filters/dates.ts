import { type Liquid, toValue } from "liquidjs";
import type { Snapshot } from "../../../data/src/schema.js";
import { parseThemeJson } from "../../../theme/src/index.js";
import { formatDate } from "./date-format.js";
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
/** A wall-clock value is interpreted in the shop zone, including DST gaps and overlaps. */
function shopInstant(wall: number, formatter: Intl.DateTimeFormat): Date {
  function offset(instant: number): number {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]),
    );
    const local = new Date(0);
    local.setUTCFullYear(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1);
    local.setUTCHours(parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, 0);
    return local.valueOf() - Math.floor(instant / 1000) * 1000;
  }
  const day = 24 * 60 * 60 * 1000;
  const offsets = new Set([offset(wall - 2 * day), offset(wall), offset(wall + 2 * day)]);
  const candidates = [...offsets].map((difference) => {
    const instant = wall - difference;
    return { instant, local: instant + offset(instant) };
  });
  // The first occurrence wins during an overlap. A nonexistent time advances across the gap.
  const exact = candidates.filter((candidate) => candidate.local === wall);
  if (exact.length) return new Date(Math.min(...exact.map((candidate) => candidate.instant)));
  const future = candidates
    .filter((candidate) => candidate.local > wall)
    .sort((a, b) => a.local - b.local || a.instant - b.instant)[0];
  if (!future) throw new Error("Date cannot be resolved in the shop timezone");
  return new Date(future.instant);
}
function instant(value: unknown, formatter: Intl.DateTimeFormat): Date | null {
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
  const explicitZone = /(?:z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|[ECMP][SD]T))\s*$/i.test(normalized);
  if (explicitZone) {
    const date = new Date(normalized);
    return Number.isFinite(date.valueOf()) ? date : null;
  }
  // Parsing as GMT obtains wall-clock components without consulting the machine's timezone.
  const wall = Date.parse(`${normalized.replace(/(\d)[Tt](?=\d)/, "$1 ")} GMT`);
  return Number.isFinite(wall) ? shopInstant(wall, formatter) : null;
}
export function registerDateFilters(
  engine: Liquid,
  snapshot: Snapshot,
  files: ReadonlyMap<string, string>,
  diagnostic: (code: string, message: string, file: string | null, line: number | null) => void,
): void {
  const native = engine.filters.date;
  if (typeof native !== "function") throw new Error("Liquid date filter is unavailable");
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: snapshot.shop.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
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
  const dateFormats = (file: string | undefined) => {
    const translations = file ? parseThemeJson(files.get(file) ?? "{}", file) : {};
    return record(translations) && record(translations.date_formats)
      ? translations.date_formats
      : {};
  };
  // The store language's formats, then the theme's default locale's.
  const customFormats = [dateFormats(selected), dateFormats(defaults[0])];
  function format(name: unknown, report: (message: string) => void): string {
    const key = String(name ?? "default");
    for (const custom of customFormats)
      if (Object.hasOwn(custom, key) && typeof custom[key] === "string") return custom[key];
    if (language !== "en")
      report("Localized system date formats are unavailable; English patterns are used.");
    if (!Object.hasOwn(english, key))
      throw new Error(`The format option '${key}' is not a supported format.`);
    return english[key] ?? "";
  }
  for (const name of ["date", "time_tag"])
    engine.registerFilter(name, function (input: unknown, ...args: unknown[]) {
      const value = toValue(input),
        keyword = typeof value === "string" ? value.toLowerCase() : null,
        source = keyword === "now" || keyword === "today" ? snapshot.meta.now : value;
      const date = instant(source, formatter);
      if (!date) return String(value ?? "");
      const options = namedArgs(args);
      const report = (message: string) =>
        diagnostic(
          "not-implemented",
          message,
          this.token.file ?? null,
          this.token.getPosition()[0] ?? null,
        );
      const positionalArgs = args.filter((arg) => !Array.isArray(arg));
      const positional = toValue(positionalArgs[0]);
      const display =
        options.format !== undefined
          ? format(options.format, report)
          : typeof positional === "string"
            ? positional
            : format("default", report);
      const passthrough =
        options.format === undefined &&
        positionalArgs.length > 0 &&
        (positional === null || positional === undefined || positional === "");
      const text = passthrough
        ? String(value ?? "")
        : formatDate(date, snapshot.shop.timezone, locale, display, this.context.memoryLimit);
      if (name === "date") return text;
      const datetime =
        options.datetime === undefined
          ? date.toISOString().replace(/\.\d{3}Z$/, "Z")
          : formatDate(date, "UTC", locale, String(options.datetime), this.context.memoryLimit);
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
