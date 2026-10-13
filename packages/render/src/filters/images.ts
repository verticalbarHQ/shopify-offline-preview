import type { Snapshot } from "../../../data/src/schema.js";
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
export function imageFilters(snapshot: Snapshot) {
  const images = new Map(
    [
      ...snapshot.products.flatMap((product) => product.images),
      ...snapshot.collections.flatMap((c) => (c.image ? [c.image] : [])),
      ...snapshot.blogs.flatMap((b) => b.articles.flatMap((a) => (a.image ? [a.image] : []))),
    ].map((image) => [image.file, image]),
  );
  function imageUrl(
    input: unknown,
    args: unknown[],
    unsupported: (message: string) => void,
  ): string {
    let value = input;
    if (value && typeof value === "object") {
      const keys = new Set(Reflect.ownKeys(value));
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
      throw new Error("Image input is absent from the local snapshot");
    const url = new URL(value, "https://offline.invalid");
    const file = decodeURIComponent(url.pathname.slice(12));
    const image = images.get(file);
    if (!image) throw new Error("Image input is absent from the local snapshot");
    const options = namedArgs(args);
    if (options.width === undefined && options.height === undefined)
      throw new Error("image_url requires width or height");
    for (const dimension of ["width", "height"] as const)
      if (options[dimension] !== undefined) {
        const size = Number(options[dimension]);
        if (!Number.isInteger(size) || size < 1 || size > 5760)
          throw new Error(`Invalid image ${dimension}`);
        url.searchParams.set(dimension, String(Math.min(size, image[dimension])));
      }
    for (const [key, value] of Object.entries(options))
      if (!["width", "height"].includes(key)) {
        unsupported(
          `Image transformation ${key} is not implemented; the local source file is used.`,
        );
        url.searchParams.set(key, String(value));
      }
    return url.pathname + url.search;
  }
  function imageTag(
    input: unknown,
    args: unknown[],
    unsupported: (message: string) => void,
  ): string {
    if (typeof input !== "string" || !input.startsWith("/sop/images/"))
      throw new Error("image_tag requires a local image_url result");
    const url = new URL(input, "https://offline.invalid");
    const image = images.get(decodeURIComponent(url.pathname.slice(12)));
    if (!image) throw new Error("Image input is absent from the local snapshot");
    const options = namedArgs(args);
    const ratio = Math.min(
      Number(url.searchParams.get("width") ?? image.width) / image.width,
      Number(url.searchParams.get("height") ?? image.height) / image.height,
    );
    const width = Math.max(1, Math.round(image.width * ratio)),
      height = Math.max(1, Math.round(image.height * ratio));
    const attributes: Record<string, unknown> = { src: input, alt: image.alt, width, height };
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
        if (value) unsupported("Image preload link hints are not implemented.");
        continue;
      }
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(key))
        throw new Error("Invalid image attribute name");
      if (value === null) delete attributes[key];
      else attributes[key] = value;
    }
    return `<img ${Object.entries(attributes)
      .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
      .join(" ")}>`;
  }
  return { imageUrl, imageTag };
}
