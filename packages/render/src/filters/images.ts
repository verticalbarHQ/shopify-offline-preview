import { Drop, toValue } from "liquidjs";
import {
  focalPointPercent,
  NamedImageDrop,
  snapshotImageEntries,
} from "../../../data/src/images.js";
import type { Snapshot } from "../../../data/src/schema.js";
export class ImageUrlDrop extends Drop {
  #url: string;
  readonly metadata: { alt: unknown; presentation: boolean } | undefined;
  constructor(url: string, metadata?: { alt: unknown; presentation: boolean }) {
    super();
    this.#url = url;
    this.metadata = metadata;
  }
  valueOf() {
    return this.#url;
  }
  toString() {
    return this.#url;
  }
}
export class ImageUrlInputError extends Error {}
export function namedArgs(args: unknown[]): Record<string, unknown> {
  return Object.fromEntries(
    args.flatMap((arg) =>
      Array.isArray(arg) && arg.length === 2 && typeof arg[0] === "string"
        ? [[arg[0], arg[1]]]
        : [],
    ),
  );
}
function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
export function imageFilters(snapshot: Snapshot, read: (path: string) => void = () => {}) {
  const entries = snapshotImageEntries(snapshot);
  const images = new Map(entries.map(([, image]) => [image.file, image]));
  const paths = new Map(entries.map(([path, image]) => [image.file, path]));
  function observe(file: string, key: string) {
    const path = paths.get(file);
    if (path !== undefined) read(`${path}.${key}`);
  }
  function imageUrl(
    input: unknown,
    args: unknown[],
    unsupported: (message: string) => void,
  ): string | ImageUrlDrop {
    let value: unknown = toValue(input);
    let origin =
      input instanceof ImageUrlDrop
        ? input.metadata
        : input instanceof NamedImageDrop
          ? { alt: input.alt, presentation: input.media_type !== null }
          : undefined;
    if (value && typeof value === "object") {
      const keys = new Set(Reflect.ownKeys(value));
      if (keys.has("alt"))
        origin = {
          alt: Reflect.get(value, "alt"),
          presentation: !keys.has("id") || Reflect.get(value, "id") !== null,
        };
      for (const name of ["src", "image", "featured_image", "preview_image"]) {
        if (keys.has(name)) {
          value = Reflect.get(value, name);
          break;
        }
      }
      if (value && typeof value === "object" && Reflect.ownKeys(value).includes("src"))
        value = Reflect.get(value, "src");
    }
    if (typeof value !== "string" || !value.startsWith("/sop/images/"))
      throw new ImageUrlInputError("invalid url input");
    const url = new URL(value, "https://offline.invalid");
    const file = decodeURIComponent(url.pathname.slice(12));
    const image = images.get(file);
    if (!image) throw new ImageUrlInputError("invalid url input");
    observe(file, "file");
    const options = namedArgs(args);
    const region = options.crop === "region";
    for (const dimension of ["width", "height"] as const)
      if (options[dimension] !== undefined) {
        const size = Number(options[dimension]);
        if (!Number.isInteger(size) || size < 1 || size > 5760)
          throw new ImageUrlInputError(`Invalid image ${dimension}`);
        observe(file, dimension);
        url.searchParams.set(dimension, String(Math.min(size, image[dimension])));
      }
    for (const [key, value] of Object.entries(options))
      if (!["width", "height"].includes(key)) {
        if (
          key === "crop" &&
          !["top", "center", "bottom", "left", "right", "region"].includes(String(value))
        )
          throw new ImageUrlInputError("Invalid image crop mode");
        else if (
          key.startsWith("crop_") &&
          ["crop_left", "crop_top", "crop_width", "crop_height"].includes(key)
        ) {
          const number = Number(value);
          if (
            !Number.isInteger(number) ||
            number < (key === "crop_width" || key === "crop_height" ? 1 : 0)
          )
            throw new ImageUrlInputError(`Invalid image ${key}`);
        } else if (key === "format" && !["jpg", "pjpg"].includes(String(value)))
          throw new ImageUrlInputError("Invalid image format");
        else if (
          key === "quality" &&
          (!Number.isInteger(Number(value)) || Number(value) < 10 || Number(value) > 90)
        )
          throw new ImageUrlInputError("Invalid image quality");
        else if (key === "pad_color" && !/^(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})$/.test(String(value)))
          throw new ImageUrlInputError("Invalid image pad color");
        else if (
          ![
            "crop",
            "crop_left",
            "crop_top",
            "crop_width",
            "crop_height",
            "format",
            "quality",
            "pad_color",
          ].includes(key)
        )
          unsupported(`Image option ${key} is not implemented.`);
        url.searchParams.set(key, String(value));
      }
    if (
      region &&
      ["crop_left", "crop_top", "crop_width", "crop_height"].some(
        (key) => options[key] === undefined,
      )
    )
      throw new ImageUrlInputError("Region crop requires its complete rectangle");
    const result = url.pathname + url.search;
    return input instanceof ImageUrlDrop ||
      (origin && (!origin.presentation || origin.alt !== image.alt))
      ? new ImageUrlDrop(result, origin)
      : result;
  }
  function imageTag(
    input: unknown,
    args: unknown[],
    unsupported: (message: string) => void = () => {},
  ): string {
    const presentation =
      input instanceof ImageUrlDrop ? (input.metadata?.presentation ?? false) : true;
    const value = toValue(input);
    if (typeof value !== "string" || !value.startsWith("/sop/images/"))
      throw new Error("image_tag requires a local image_url result");
    const url = new URL(value, "https://offline.invalid");
    const image = images.get(decodeURIComponent(url.pathname.slice(12)));
    if (!image) throw new Error("Image input is absent from the local snapshot");
    for (const key of ["file", "alt", "width", "height"]) observe(image.file, key);
    const options = namedArgs(args);
    if (presentation && "filename" in image && !Object.hasOwn(image, "focalPoint"))
      unsupported("Uploaded image presentation metadata is absent from the snapshot.");
    const sourceWidth = Number(url.searchParams.get("crop_width") ?? image.width);
    const sourceHeight = Number(url.searchParams.get("crop_height") ?? image.height);
    const requestedWidth = url.searchParams.get("width"),
      requestedHeight = url.searchParams.get("height");
    const width = requestedWidth
      ? Number(requestedWidth)
      : requestedHeight
        ? Math.max(1, Math.round((sourceWidth * Number(requestedHeight)) / sourceHeight))
        : sourceWidth;
    const height = requestedHeight
      ? Number(requestedHeight)
      : requestedWidth
        ? Math.max(1, Math.round((sourceHeight * Number(requestedWidth)) / sourceWidth))
        : sourceHeight;
    const attributes: Record<string, unknown> = {
      src: value,
      alt: input instanceof ImageUrlDrop && input.metadata ? input.metadata.alt : image.alt,
      width,
      height,
    };
    if (presentation && image.focalPoint) {
      observe(image.file, "focalPoint.x");
      observe(image.file, "focalPoint.y");
      attributes.style = `object-position:${focalPointPercent(image.focalPoint.x)} ${focalPointPercent(image.focalPoint.y)};`;
    }
    const widths =
      options.widths === undefined
        ? [165, 360, 533, 720, 940, 1066, width]
        : String(options.widths).split(",").map(Number);
    const sizes = [
      ...new Set(widths.filter((n) => Number.isInteger(n) && n > 0 && n <= width)),
    ].sort((a, b) => a - b);
    if (options.srcset === undefined && sizes.length)
      attributes.srcset = sizes
        .map((n) => {
          const target = new URL(url);
          target.searchParams.set("width", String(n));
          target.searchParams.delete("height");
          return `${target.pathname + target.search} ${n}w`;
        })
        .join(", ");
    for (const [key, value] of Object.entries(options)) {
      if (key === "widths") continue;
      if (key === "preload") {
        continue;
      }
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(key))
        throw new Error("Invalid image attribute name");
      if (value === null) delete attributes[key];
      else attributes[key] = value;
    }
    const preload = options.preload
      ? `<link rel="preload" as="image" href="${escapeHtml(value)}"${attributes.srcset ? ` imagesrcset="${escapeHtml(attributes.srcset)}"` : ""}${attributes.sizes ? ` imagesizes="${escapeHtml(attributes.sizes)}"` : ""}>`
      : "";
    return `${preload}<img ${Object.entries(attributes)
      .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
      .join(" ")}>`;
  }
  return { imageUrl, imageTag };
}
