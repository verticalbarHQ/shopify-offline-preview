import systemTranslations from "../../../spec/src/generated/translations.json" with {
  type: "json",
};
import { parseThemeJson } from "../../../theme/src/index.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function lookup(source: unknown, key: string): unknown {
  if (record(source) && Object.hasOwn(source, key)) return source[key];
  let value = source;
  for (const name of key.split(".")) {
    if (!record(value) || !Object.hasOwn(value, name)) return;
    value = value[name];
  }
  return value;
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
export function translateFactory(
  files: Map<string, string>,
  locale: string | undefined,
  section: () => unknown,
): (key: unknown, args: unknown[], missing: (key: string) => void) => string {
  const language = locale?.split("-")[0] ?? locale;
  const defaults = [...files.keys()].filter((file) => /^locales\/[^/]+\.default\.json$/.test(file));
  if (defaults.length > 1)
    throw new Error("A theme can contain only one default storefront locale");
  const selected = [
    `locales/${locale}.json`,
    `locales/${locale}.default.json`,
    `locales/${language}.json`,
    `locales/${language}.default.json`,
    ...defaults,
  ].find((file) => files.has(file));
  const translations = selected ? parseThemeJson(files.get(selected) ?? "{}", selected) : {};
  const plural = locale === undefined ? undefined : new Intl.PluralRules(locale);
  return (input, args, missing) => {
    const key = String(input ?? "");
    if (locale === undefined) {
      missing(`shop.locale (translation ${key})`);
      return "";
    }
    const parameters: Record<string, unknown> = Object.create(null);
    for (const arg of args)
      if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === "string")
        parameters[arg[0]] = arg[1];
    const local = section();
    const localized = record(local)
      ? (local[locale] ?? (language ? local[language] : undefined))
      : undefined;
    let value =
      lookup(localized, key) ??
      lookup(translations, key) ??
      (language === "en" ? lookup(systemTranslations, key) : undefined);
    if (record(value) && Object.hasOwn(parameters, "count")) {
      const count = Number(parameters.count);
      const choice =
        count === 0 && Object.hasOwn(value, "zero") ? "zero" : (plural?.select(count) ?? "other");
      value = value[choice] ?? value.other;
    }
    if (typeof value !== "string") {
      missing(key);
      return `translation missing: ${locale}.${key}`;
    }
    const text = value.replace(
      /\{\{\s*([\w-]+)\s*\}\}|%\{([\w-]+)\}/g,
      (_match, liquid: string, ruby: string) => String(parameters[liquid || ruby] ?? ""),
    );
    return key.endsWith("_html") ? text : escapeHtml(text);
  };
}

/**
 * Resolves a `t:` key in a setting's schema default from the theme's schema locale, as Shopify does
 * when a template leaves the setting out. Unresolved keys stay as written.
 */
export function schemaDefaultFactory(
  files: Map<string, string>,
  locale: string | undefined,
  missing: (message: string) => void = () => {},
): (value: unknown) => unknown {
  const language = locale?.split("-")[0] ?? locale;
  const defaults = [...files.keys()].filter((file) =>
    /^locales\/[^/]+\.default\.schema\.json$/.test(file),
  );
  const selected = [
    `locales/${locale}.schema.json`,
    `locales/${locale}.default.schema.json`,
    `locales/${language}.schema.json`,
    `locales/${language}.default.schema.json`,
    ...defaults,
  ].find((file) => files.has(file));
  const translations = selected ? parseThemeJson(files.get(selected) ?? "{}", selected) : {};
  return (value) => {
    if (typeof value !== "string" || !value.startsWith("t:")) return value;
    if (locale === undefined) {
      missing(`shop.locale is absent; cannot resolve schema default ${value}.`);
      return undefined;
    }
    const text = lookup(translations, value.slice(2));
    return typeof text === "string" ? text : value;
  };
}
