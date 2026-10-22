import { type Liquid, toValue } from "liquidjs";
import { liquidObjectKind, readSnapshotProperty, ScalarDrop } from "../../../data/src/objects.js";
import { namedArgs } from "./images.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
/** HTML attributes from named arguments, with Liquid booleans as valueless attributes. */
function attributes(values: Record<string, unknown>): string {
  return Object.entries(values)
    .flatMap(([name, input]) => {
      if (!/^[A-Za-z_:][A-Za-z0-9_:.-]*$/.test(name))
        throw new Error("Invalid media attribute name");
      const value: unknown = toValue(input);
      if (value === null || value === undefined || value === false) return [];
      return [value === true ? `${name}="${name}"` : `${name}="${escapeHtml(value)}"`];
    })
    .map((text) => ` ${text}`)
    .join("");
}
/** `image_size: '400x'` / `'400x300'` selects the poster size, like `image_url`. */
function poster(media: Record<string, unknown>, size: unknown): string | undefined {
  const preview = readSnapshotProperty(media, "preview_image");
  if (preview === undefined) return undefined;
  const src = record(preview) ? String(preview.src) : "";
  const match = /^(\d*)x(\d*)$/.exec(String(toValue(size) ?? ""));
  const query = new URLSearchParams();
  if (match?.[1]) query.set("width", match[1]);
  if (match?.[2]) query.set("height", match[2]);
  return query.size ? `${src}?${query}` : src;
}
function mediaOf(input: unknown, kind: string, filter: string): Record<string, unknown> {
  if (liquidObjectKind(input) !== kind || !record(input))
    throw new Error(`${filter} requires ${kind.replace("_", " ")} media`);
  return input;
}
const externalUrls = new WeakMap<object, Record<string, unknown>>();
const embed: Record<string, string> = {
  youtube: "https://www.youtube.com/embed/",
  vimeo: "https://player.vimeo.com/video/",
};

/**
 * Media filters for snapshot video, external video and 3D model media. Element structure follows
 * Shopify's documentation; attribute order and player parameters await oracle verification.
 */
export function registerMediaFilters(
  engine: Liquid,
  imageTag: (input: unknown, args: unknown[], file: string | null, line: number | null) => string,
  imageUrl: (input: unknown, args: unknown[], file: string | null, line: number | null) => unknown,
  productTitle: (media: object) => unknown,
): void {
  function videoTag(media: Record<string, unknown>, args: unknown[]): string {
    const { image_size: size, ...extra } = namedArgs(args);
    const image = poster(media, size);
    const sources = Array.isArray(media.sources) ? media.sources.filter(record) : [];
    return `<video playsinline="playsinline" preload="metadata"${attributes({ "aria-label": media.alt, poster: image, ...extra })}>${sources
      .map(
        (source) =>
          `<source src="${escapeHtml(source.url)}" type="${escapeHtml(source.mime_type)}">`,
      )
      .join("")}${image === undefined ? "" : `<img src="${escapeHtml(image)}">`}</video>`;
  }
  function externalUrl(media: Record<string, unknown>, args: unknown[]): ScalarDrop {
    const host = String(media.host);
    const base = embed[host];
    if (!base) throw new Error(`Unsupported external video host ${host}`);
    const query = new URLSearchParams(
      Object.entries(namedArgs(args)).map(([key, value]) => [key, String(toValue(value))]),
    );
    const url = new ScalarDrop(
      {},
      `${base}${encodeURIComponent(String(media.external_id))}${query.size ? `?${query}` : ""}`,
    );
    externalUrls.set(url, media);
    return url;
  }
  function externalTag(input: unknown, args: unknown[]): string {
    const media =
      input instanceof ScalarDrop
        ? externalUrls.get(input)
        : mediaOf(input, "external_video", "external_video_tag");
    if (!media) throw new Error("external_video_tag requires external video media or its URL");
    const src = input instanceof ScalarDrop ? toValue(input) : toValue(externalUrl(media, []));
    // Alt text, or the product title when the video has none.
    const title = media.alt ?? productTitle(media);
    return `<iframe frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen="allowfullscreen"${attributes({ src, title, ...namedArgs(args) })}></iframe>`;
  }
  function modelTag(media: Record<string, unknown>, args: unknown[]): string {
    const { image_size: size, ...extra } = namedArgs(args);
    const sources = Array.isArray(media.sources) ? media.sources.filter(record) : [];
    const glb = sources.find((source) => source.format === "glb") ?? sources[0];
    return `<model-viewer${attributes({ src: glb?.url, "camera-controls": true, alt: media.alt, poster: poster(media, size), ...extra })}></model-viewer>`;
  }
  // Shopify renders nothing for an unset video (nil), such as an empty video setting.
  engine.registerFilter("video_tag", (input: unknown, ...args: unknown[]) =>
    input === null || input === undefined
      ? ""
      : videoTag(mediaOf(input, "video", "video_tag"), args),
  );
  engine.registerFilter("external_video_url", (input: unknown, ...args: unknown[]) =>
    externalUrl(mediaOf(input, "external_video", "external_video_url"), args),
  );
  engine.registerFilter("external_video_tag", (input: unknown, ...args: unknown[]) =>
    externalTag(input, args),
  );
  engine.registerFilter("model_viewer_tag", (input: unknown, ...args: unknown[]) =>
    modelTag(mediaOf(input, "model", "model_viewer_tag"), args),
  );
  engine.registerFilter("media_tag", function (input: unknown, ...args: unknown[]) {
    const kind = liquidObjectKind(input);
    if (!record(input)) throw new Error("media_tag requires media");
    if (kind === "video") return videoTag(input, args);
    if (kind === "external_video") {
      // External players have no poster; the size option does not become an attribute.
      const { image_size: _size, ...extra } = namedArgs(args);
      return externalTag(externalUrl(input, []), Object.entries(extra));
    }
    if (kind === "model") return modelTag(input, args);
    if (kind === "media_image") {
      const { image_size: size, ...extra } = namedArgs(args);
      const match = /^(\d*)x(\d*)$/.exec(String(toValue(size) ?? ""));
      const sized = [
        ...(match?.[1] ? [["width", Number(match[1])]] : []),
        ...(match?.[2] ? [["height", Number(match[2])]] : []),
      ];
      // image_url's largest width; the source width is the default size.
      const sourceWidth = input.width;
      const width = sourceWidth === undefined ? undefined : Math.min(Number(sourceWidth), 5760);
      return imageTag(
        imageUrl(
          input,
          sized.length ? sized : width === undefined ? [] : [["width", width]],
          this.token.file ?? null,
          this.token.getPosition()[0] ?? null,
        ),
        Object.entries(extra),
        this.token.file ?? null,
        this.token.getPosition()[0] ?? null,
      );
    }
    throw new Error("media_tag requires media");
  });
}
