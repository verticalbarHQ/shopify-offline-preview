import { init, parse } from "es-module-lexer";
import { missingImageSvg } from "../../dev/src/missing-image.js";
import type { BrowserFiles } from "./files.js";

const virtualOrigin = "https://sop-preview.invalid";
export function resourceUrl(file: string): string {
  return `${virtualOrigin}/sop/${file.startsWith("assets/") ? `assets/${file.slice(7)}` : `images/${file}`}`;
}
export function mime(file: string): string {
  const extension = file.split(".").pop()?.toLowerCase() ?? "";
  return (
    (
      {
        js: "text/javascript",
        mjs: "text/javascript",
        css: "text/css",
        json: "application/json",
        svg: "image/svg+xml",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        avif: "image/avif",
        gif: "image/gif",
        woff: "font/woff",
        woff2: "font/woff2",
        ttf: "font/ttf",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}
export function dataUrl(bytes: Uint8Array, type: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${type};base64,${btoa(binary)}`;
}
function localFile(specifier: string, file: string): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/sop/assets/")) return;
  const url = new URL(specifier, resourceUrl(file));
  if (url.origin !== virtualOrigin || !url.pathname.startsWith("/sop/assets/")) return;
  return `assets/${decodeURIComponent(url.pathname.slice(12))}`;
}
/** Stable import-map names preserve module cycles without fetching uploaded code. */
export async function rewriteModule(
  text: string,
  file: string,
  files: BrowserFiles,
): Promise<string> {
  await init();
  const [imports] = parse(text, file);
  for (const item of [...imports].reverse()) {
    if (!item.specifier) continue;
    const target = localFile(item.specifier, file);
    if (!target || !Object.hasOwn(files, target)) continue;
    const value = `sop-asset:${target}`;
    text =
      text.slice(0, item.start) +
      (item.type === "dynamic" ? JSON.stringify(value) : value) +
      text.slice(item.end);
  }
  return text;
}
export interface BrowserResources {
  urls: Record<string, string>;
  imports: Record<string, string>;
}
export async function prepareResources(
  files: BrowserFiles,
  images: BrowserFiles,
  declared: readonly { file: string; width: number; height: number }[] = [],
): Promise<BrowserResources> {
  const urls: Record<string, string> = Object.create(null);
  const imports: Record<string, string> = Object.create(null);
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  for (const [file, bytes] of Object.entries(images))
    urls[resourceUrl(file)] = dataUrl(bytes, mime(file));
  // Like the dev server, a snapshot image without its file shows a placeholder.
  for (const image of declared)
    if (!Object.hasOwn(images, image.file))
      urls[resourceUrl(image.file)] ??= dataUrl(
        encoder.encode(missingImageSvg(image.width, image.height)),
        "image/svg+xml",
      );
  for (const [file, bytes] of Object.entries(files))
    if (file.startsWith("assets/") && !/\.(css|m?js)$/.test(file))
      urls[resourceUrl(file)] = dataUrl(bytes, mime(file));
  const css = new Set<string>();
  function cssUrl(file: string): string {
    const key = resourceUrl(file);
    if (urls[key]) return urls[key];
    if (css.has(file)) throw new Error(`Circular CSS import: ${file}`);
    const bytes = files[file];
    if (!bytes) throw new Error(`Missing CSS asset: ${file}`);
    css.add(file);
    const text = decoder
      .decode(bytes)
      .replace(
        /url\(\s*(['"]?)([^'"\s)]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g,
        (original, _quote: string, value: string, _importQuote: string, importValue: string) => {
          const target = localFile(value || importValue, file);
          if (!target || !Object.hasOwn(files, target)) return original;
          const href = target.endsWith(".css") ? cssUrl(target) : urls[resourceUrl(target)];
          return href ? (value ? `url("${href}")` : `@import "${href}"`) : original;
        },
      );
    css.delete(file);
    urls[key] = dataUrl(encoder.encode(text), "text/css");
    return urls[key];
  }
  for (const file of Object.keys(files).filter(
    (f) => f.startsWith("assets/") && f.endsWith(".css"),
  ))
    cssUrl(file);
  for (const [file, bytes] of Object.entries(files))
    if (file.startsWith("assets/") && /\.m?js$/.test(file)) {
      const text = await rewriteModule(decoder.decode(bytes), file, files);
      const href = dataUrl(encoder.encode(text), "text/javascript");
      urls[resourceUrl(file)] = href;
      imports[`sop-asset:${file}`] = href;
    }
  return { urls, imports };
}
export { virtualOrigin };
