import { Drop } from "liquidjs";
import { focalPoint, focalPointPercent } from "./scalar-drop.js";
import type { Snapshot } from "./schema.js";

export { focalPointPercent };

export type NamedImage = NonNullable<Snapshot["images"]>[number];
type SourceImage = Snapshot["products"][number]["images"][number] &
  Partial<Pick<NamedImage, "filename">>;
/** Image hooks: absent snapshot fields are missing data; other properties are not implemented. */
export interface ImageHooks {
  read(path: string): void;
  unsupported(property: string): void;
  missing(property: string): void;
}
export function snapshotImageEntries(snapshot: Snapshot): [string, SourceImage][] {
  return [
    ...snapshot.products.flatMap((product, index) => [
      ...product.images.map((image, imageIndex): [string, SourceImage] => [
        `products[${index}].images[${imageIndex}]`,
        image,
      ]),
      ...(product.media ?? []).flatMap((media, mediaIndex): [string, SourceImage][] =>
        media.mediaType === "image" || media.previewImage === undefined
          ? []
          : [[`products[${index}].media[${mediaIndex}].previewImage`, media.previewImage]],
      ),
      ...product.options.flatMap((option, optionIndex) =>
        (option.swatches ?? []).flatMap((swatch, valueIndex): [string, SourceImage][] =>
          swatch?.image
            ? [
                [
                  `products[${index}].options[${optionIndex}].swatches[${valueIndex}].image`,
                  swatch.image,
                ],
              ]
            : [],
        ),
      ),
    ]),
    ...snapshot.collections.flatMap((collection, index): [string, SourceImage][] =>
      collection.image ? [[`collections[${index}].image`, collection.image]] : [],
    ),
    ...snapshot.blogs.flatMap((blog, index) =>
      blog.articles.flatMap((article, articleIndex): [string, SourceImage][] =>
        article.image ? [[`blogs[${index}].articles[${articleIndex}].image`, article.image]] : [],
      ),
    ),
    ...(snapshot.shop.socialSharingImage
      ? [["shop.socialSharingImage", snapshot.shop.socialSharingImage] as [string, SourceImage]]
      : []),
    ...(snapshot.images ?? []).map((image, index): [string, SourceImage] => [
      `images[${index}]`,
      image,
    ]),
  ];
}
/** Local video and 3D model source files, served next to the images. */
export function snapshotMediaFiles(snapshot: Snapshot): string[] {
  return snapshot.products.flatMap((product) =>
    (product.media ?? []).flatMap((media) =>
      media.mediaType === "video" || media.mediaType === "model"
        ? media.sources.map((source) => source.file)
        : [],
    ),
  );
}
export function snapshotImages(snapshot: Snapshot): SourceImage[] {
  return snapshotImageEntries(snapshot).map(([, image]) => image);
}
export function localImageUrl(file: string): string {
  return `/sop/images/${file.split("/").map(encodeURIComponent).join("/")}`;
}
/** Native missing image lookups are truthy empty drops, distinct from a nil picker setting. */
export class MissingImage extends Drop {
  valueOf() {
    return this;
  }
  toString() {
    return "EmptyDrop";
  }
  *[Symbol.iterator](): Generator<never> {}
  liquidMethodMissing() {
    return "";
  }
  *equals(other: unknown): Generator<unknown, boolean, unknown> {
    if (other instanceof MissingImage) return true;
    if (other instanceof Drop && typeof other.equals === "function")
      return (yield other.equals("")) === true;
    return false;
  }
}
export class NamedImageDrop extends Drop {
  #source: NamedImage;
  #path: string;
  #hooks: ImageHooks;
  #preview: boolean;
  constructor(source: NamedImage, path: string, hooks: ImageHooks, preview = false) {
    super();
    this.#source = source;
    this.#path = path;
    this.#hooks = hooks;
    this.#preview = preview;
  }
  #field(key: "file" | "alt" | "width" | "height" | "id") {
    this.#hooks.read(`${this.#path}.${key}`);
    if (!Object.hasOwn(this.#source, key)) this.#hooks.missing(key);
    return this.#source[key];
  }
  get src() {
    return localImageUrl(String(this.#field("file")));
  }
  get url() {
    return null;
  }
  get alt() {
    return this.#field("alt");
  }
  get width() {
    return this.#field("width");
  }
  get height() {
    return this.#field("height");
  }
  get aspect_ratio() {
    const width = this.width,
      height = this.height;
    return typeof width === "number" && typeof height === "number" ? width / height : undefined;
  }
  get id() {
    if (this.#preview) return null;
    const value = this.#field("id");
    if (value === null) return null;
    if (typeof value !== "string") return undefined;
    return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value;
  }
  get position() {
    return null;
  }
  get product_id() {
    return null;
  }
  get variants() {
    return null;
  }
  get "attached_to_variant?"() {
    return null;
  }
  get media_type() {
    return this.#preview ? null : "image";
  }
  get preview_image(): NamedImageDrop | null {
    return this.#preview ? null : new NamedImageDrop(this.#source, this.#path, this.#hooks, true);
  }
  get presentation() {
    if (this.#preview) return null;
    const point = this.#source.focalPoint;
    if (point === undefined) {
      this.#hooks.missing("presentation");
      return undefined;
    }
    if (point === null) this.#hooks.read(`${this.#path}.focalPoint`);
    else {
      this.#hooks.read(`${this.#path}.focalPoint.x`);
      this.#hooks.read(`${this.#path}.focalPoint.y`);
    }
    // Shopify reports the image center when no focal point is set.
    return new ImagePresentation(point ?? { x: "0.5", y: "0.5" }, (key) =>
      this.#hooks.unsupported(`presentation.${key}`),
    );
  }
  valueOf() {
    return this.src;
  }
  liquidMethodMissing(property: string) {
    this.#hooks.unsupported(property);
    return undefined;
  }
}
class ImagePresentation extends Drop {
  #point: NonNullable<NamedImage["focalPoint"]>;
  #unsupported: (key: string) => void;
  constructor(point: NonNullable<NamedImage["focalPoint"]>, unsupported: (key: string) => void) {
    super();
    this.#point = point;
    this.#unsupported = unsupported;
  }
  get focal_point() {
    return focalPoint(this.#point, (key) => this.#unsupported(`focal_point.${key}`));
  }
  valueOf() {
    return { focalPoint: this.#point };
  }
  liquidMethodMissing(key: string) {
    this.#unsupported(key);
    return undefined;
  }
}
export class ImageDirectory extends Drop {
  #images: Map<string, NamedImageDrop>;
  // LiquidJS treats ordinary empty objects as blank and nonempty strings as
  // one-item collections. An opaque iterable with its own string conversion
  // stays nonblank while yielding no entries through public Drop coercion.
  #opaque = {
    toString: () => "ImagesDrop",
    *[Symbol.iterator](): Generator<never> {},
  };
  #supplied: boolean;
  #hooks: ImageHooks;
  constructor(images: Snapshot["images"], hooks: ImageHooks) {
    super();
    this.#supplied = images !== undefined;
    this.#hooks = hooks;
    this.#images = new Map(
      (images ?? []).map((source, index) => [
        source.filename,
        new NamedImageDrop(source, `images[${index}]`, hooks),
      ]),
    );
  }
  valueOf() {
    return this.#opaque;
  }
  toString() {
    return "ImagesDrop";
  }
  *[Symbol.iterator](): Generator<never> {}
  liquidMethodMissing(filename: string | number) {
    if (typeof filename !== "string") throw new Error("Expected image filename to be a String");
    this.#hooks.read("images");
    if (!this.#supplied) this.#hooks.missing("images source metadata");
    return this.#images.get(filename) ?? new MissingImage();
  }
}
